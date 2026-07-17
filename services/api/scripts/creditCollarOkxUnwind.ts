#!/usr/bin/env tsx
/**
 * OKX live UNWIND — the agreed early-close path. Closes BOTH legs of an okx_live position on screen
 * (short leg FIRST), verifies flat, applies credit vesting/clawback (voluntary_early_close), books an
 * early-close settlement row into the normal ledger, and removes the position from the open book.
 *
 * FAIL-SAFE: if the short-leg buy-back cannot execute, NOTHING else is touched — the position stays a
 * complete hedged collar and rides to expiry (the documented policy). A long-leg residue is bounded
 * risk and is flagged for manual completion.
 *
 * NOTE: unwinding is a SAFETY action — it is deliberately NOT gated on LIVE_ENABLED (the kill-switch
 * stops NEW positions, never flattening). Real-money mode still requires OKX_LIVE_CONFIRM.
 *
 *   npm --silent --workspace services/api run okx:unwind -- list
 *   npm --silent --workspace services/api run okx:unwind -- close <ref>
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { unwindLiveCollar } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveUnwind";
import { raiseLiveAlert } from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";
import { computeVestedCredit } from "../src/singleSide/twoSided/creditCollar/creditVesting";
import { loadOpenPositions, saveOpenPositions, appendSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import type { SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import { LIVE_CONFIRM_PHRASE } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";

const round2 = (x: number) => +x.toFixed(2);

const list = (): void => {
  const live = loadOpenPositions().filter((p) => p.venue === "okx_live");
  if (live.length === 0) {
    console.log("no open okx_live positions");
    return;
  }
  for (const p of live) {
    console.log(
      `${p.ref} · ${p.side} · put ${p.putStrike} / call ${p.callStrike} · ${p.liveMeta?.contracts ?? "?"} contracts · net credit $${p.foxifyCreditUsdc} · expires ${new Date(p.expiresAtMs).toISOString()} · mode ${p.liveMeta?.mode ?? "?"}`
    );
  }
};

const close = async (ref: string): Promise<void> => {
  const open = loadOpenPositions();
  const pos = open.find((p) => p.ref === ref);
  if (!pos) throw new Error(`${ref} not found in the open book`);
  if (pos.venue !== "okx_live" || !pos.liveMeta) throw new Error(`${ref} is not a live OKX position (venue ${pos.venue})`);

  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) throw new Error("missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
  const mode: OkxMode = pos.liveMeta.mode;
  if (mode === "live" && process.env.OKX_LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new Error(`position was opened with REAL money — set OKX_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} to close it`);
  }
  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });

  const idx = await client.getIndexPrice("BTC-USD");
  const spotNow = Number(idx.data?.[0]?.idxPx ?? 0);
  if (!(spotNow > 0)) throw new Error("no index price — refusing to unwind blind");

  console.error(`[okx-unwind] closing ${ref} (${pos.side}, ${pos.liveMeta.contracts} contracts) at spot ≈ $${spotNow.toFixed(0)} — short leg first`);
  const rep = await unwindLiveCollar(
    client,
    { side: pos.side, putInstId: pos.liveMeta.putInstId, callInstId: pos.liveMeta.callInstId, contracts: pos.liveMeta.contracts, ctValBtc: pos.liveMeta.ctValBtc },
    { spotUsd: spotNow, clOrdPrefix: `uw${Date.now().toString(36)}` }
  );
  process.stdout.write(JSON.stringify(rep, null, 2) + "\n");

  if (rep.outcome === "rides_to_expiry") {
    console.error("[okx-unwind] short-leg buy-back failed — position UNTOUCHED, still fully hedged, rides to expiry (fail-safe). Nothing booked.");
    process.exit(7);
  }
  if (!rep.complete) {
    raiseLiveAlert({ tsMs: Date.now(), level: "critical", code: "unwind_incomplete", message: `unwind of ${ref} incomplete (${rep.outcome}) — ${rep.notes.join("; ")}`, data: rep });
    console.error("[okx-unwind] ⚠️ unwind INCOMPLETE — see alert. Long residue is bounded risk; complete manually, then re-run to verify flat.");
  }

  // Vesting: voluntary early close vests the credit by time held (linear; no extra penalty by default).
  const now = Date.now();
  const heldMs = now - pos.openedAtMs;
  const tenorMs = Math.max(1, pos.expiresAtMs - pos.openedAtMs);
  const vest = computeVestedCredit({ fullCreditUsdc: pos.foxifyCreditUsdc, tenorMs }, heldMs, "voluntary_early_close");
  console.error(`[okx-unwind] credit vesting: held ${(heldMs / 3.6e6).toFixed(1)}h of ${(tenorMs / 3.6e6).toFixed(1)}h ⟹ vested $${vest.realizedCreditUsdc} (clawback $${vest.clawbackUsdc})`);

  // Book the early close through the normal settlement ledger (marked venue okx_live, early-close meta).
  const contractsBtc = pos.liveMeta.contracts * pos.liveMeta.ctValBtc;
  const movePct = (spotNow - pos.spotAtEntry) / pos.spotAtEntry;
  const outcome: SettlementOutcome = {
    ref: pos.ref,
    side: pos.side,
    notionalUsdc: pos.notionalUsdc,
    spotAtEntry: pos.spotAtEntry,
    settlePriceUsd: spotNow,
    movePct: +movePct.toFixed(6),
    putIntrinsicUsd: round2(Math.max(0, pos.putStrike - spotNow) * contractsBtc),
    callIntrinsicUsd: round2(Math.max(0, spotNow - pos.callStrike) * contractsBtc),
    payoutToFoxifyUsdc: rep.unwindValueUsdc ?? 0,   // realized on-screen collar value, passed through back-to-back
    foxifyCreditUsdc: vest.realizedCreditUsdc,      // vested portion only; the rest clawed back
    netToFoxifyUsdc: round2((rep.unwindValueUsdc ?? 0) + vest.realizedCreditUsdc),
    serviceFeeUsdc: pos.serviceFeeUsdc,
    floorBreached: pos.side === "long" ? spotNow < pos.putStrike : spotNow > pos.callStrike,
    capBreached: pos.side === "long" ? spotNow > pos.callStrike : spotNow < pos.putStrike,
    oracleVerified: false,                          // early close settles on the SCREEN, not the oracle fixing
    openedAtMs: pos.openedAtMs,
    settledAtMs: now,
    heldMs,
    hedgeReceiptUsdc: rep.unwindValueUsdc ?? 0,
    atticusOptionNetUsdc: 0,
    shortLegMarginUsdc: 0,
    capitalCostUsdc: 0,
    optionFeesUsdc: round2((pos.openFeeUsdc ?? 0) + Math.abs((rep.fundingClose.feeBtc + rep.protectiveClose.feeBtc) * spotNow)),
    atticusNetAfterCapitalUsdc: pos.serviceFeeUsdc,
    atticusNetAfterFeesAndCapitalUsdc: pos.serviceFeeUsdc,
    fundingLegPremiumUsdc: pos.fundingLegPremiumUsdc,
    protectiveLegPremiumUsdc: pos.protectiveLegPremiumUsdc,
    venue: "okx_live",
    quoteMeta: { rfqRef: `${pos.quoteMeta?.rfqRef ?? pos.ref}-early-close`, quotedNetUsdc: rep.unwindValueUsdc ?? 0, modelNetUsdc: pos.quoteMeta?.modelNetUsdc ?? pos.foxifyCreditUsdc, quotedAtIso: new Date(now).toISOString() },
    liveMeta: pos.liveMeta
  };
  appendSettlements([outcome]);
  saveOpenPositions(open.filter((p) => p.ref !== ref));
  console.error(`[okx-unwind] ✅ ${ref} closed + booked: unwind value $${rep.unwindValueUsdc}, vested credit $${vest.realizedCreditUsdc}, net to client $${outcome.netToFoxifyUsdc}. Verified flat: ${rep.verifiedFlat}.`);
};

const main = async (): Promise<void> => {
  const [cmd, ref] = process.argv.slice(2);
  if (cmd === "list") return list();
  if (cmd === "close" && ref) return close(ref);
  console.log("usage: list | close <ref>");
};

main().catch((e) => {
  console.error("[okx-unwind]", (e as Error).message);
  process.exit(1);
});
