#!/usr/bin/env tsx
/**
 * LIVE UNWIND (venue-aware) — the agreed early-close path. Dispatches on the position's venue tag:
 *
 *   falconx_live  Quote + execute the REVERSE structure as ONE trade (atomic — no leg-ordering
 *                 hazard at all). If it can't fill, the position rides to expiry fully hedged.
 *   okx_live      Close both CLOB legs, SHORT leg FIRST; a failed short buy-back aborts before the
 *                 long leg is touched (position rides, fully hedged). Long residue = bounded risk.
 *
 * Either way: verify flat, apply credit vesting/clawback (voluntary_early_close), book an
 * early-close settlement row into the normal ledger, remove the position from the open book.
 *
 * NOTE: unwinding is a SAFETY action — deliberately NOT gated on LIVE_ENABLED (the kill-switch
 * stops NEW positions, never flattening). Real-money venues still require the confirm phrase.
 *
 *   npm --silent --workspace services/api run live:unwind -- list
 *   npm --silent --workspace services/api run live:unwind -- close <ref>
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { unwindLiveCollar } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveUnwind";
import { FalconxClient } from "../src/singleSide/twoSided/creditCollar/execution/falconxClient";
import { unwindFalconxCollar } from "../src/singleSide/twoSided/creditCollar/execution/falconxLiveRunner";
import { raiseLiveAlert } from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";
import { computeVestedCredit } from "../src/singleSide/twoSided/creditCollar/creditVesting";
import { loadOpenPositions, saveOpenPositions, appendSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import type { OpenPosition, SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import { LIVE_CONFIRM_PHRASE } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";

const round2 = (x: number) => +x.toFixed(2);
const LIVE_VENUES = ["falconx_live", "okx_live"];

const list = (): void => {
  const live = loadOpenPositions().filter((p) => LIVE_VENUES.includes(p.venue ?? ""));
  if (live.length === 0) {
    console.log("no open live positions");
    return;
  }
  for (const p of live) {
    console.log(
      `${p.ref} · ${p.venue} · ${p.side} · put ${p.putStrike} / call ${p.callStrike} · qty ${p.liveMeta?.contracts ?? "?"}×${p.liveMeta?.ctValBtc ?? "?"} BTC · net credit $${p.foxifyCreditUsdc} · expires ${new Date(p.expiresAtMs).toISOString()}`
    );
  }
};

/** Fetch a spot anchor for USD conversion / intrinsic bookkeeping (public OKX index — read-only). */
const fetchSpot = async (): Promise<number> => {
  const r = (await (await fetch("https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USD", { signal: AbortSignal.timeout(8000) })).json()) as { data?: Array<{ idxPx?: string }> };
  return Number(r.data?.[0]?.idxPx ?? 0);
};

type UnwindOutcome = { complete: boolean; unwindValueUsdc: number | null; feesUsdc: number; notes: string[]; ridesToExpiry: boolean; verifiedFlat: boolean | null };

const unwindOkx = async (pos: OpenPosition, spotNow: number): Promise<UnwindOutcome> => {
  const lm = pos.liveMeta!;
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) throw new Error("missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
  const mode: OkxMode = lm.mode;
  if (mode === "live" && process.env.OKX_LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new Error(`position was opened with REAL money — set OKX_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} to close it`);
  }
  const client = new OkxExecutionClient({ apiKey: k, secret: s, passphrase: p, mode });
  const rep = await unwindLiveCollar(
    client,
    { side: pos.side, putInstId: lm.putInstId, callInstId: lm.callInstId, contracts: lm.contracts, ctValBtc: lm.ctValBtc },
    { spotUsd: spotNow, clOrdPrefix: `uw${Date.now().toString(36)}` }
  );
  process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
  return {
    complete: rep.complete,
    unwindValueUsdc: rep.unwindValueUsdc,
    feesUsdc: round2(Math.abs((rep.fundingClose.feeBtc + rep.protectiveClose.feeBtc) * spotNow)),
    notes: rep.notes,
    ridesToExpiry: rep.outcome === "rides_to_expiry",
    verifiedFlat: rep.verifiedFlat
  };
};

const unwindFalconx = async (pos: OpenPosition): Promise<UnwindOutcome> => {
  const { FALCONX_API_KEY: k, FALCONX_SECRET: s, FALCONX_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) throw new Error("missing FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE");
  if (process.env.FALCONX_LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new Error(`FalconX unwinds are REAL money — set FALCONX_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} to close`);
  }
  const client = new FalconxClient({ apiKey: k, secret: s, passphrase: p });
  const rep = await unwindFalconxCollar(client, pos);
  process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
  return {
    complete: rep.complete,
    unwindValueUsdc: rep.unwindValueUsdc,
    feesUsdc: 0, // all-in RFQ pricing
    notes: rep.notes,
    ridesToExpiry: !rep.complete && rep.unwindValueUsdc == null,
    verifiedFlat: rep.complete
  };
};

const close = async (ref: string): Promise<void> => {
  const open = loadOpenPositions();
  const pos = open.find((p) => p.ref === ref);
  if (!pos) throw new Error(`${ref} not found in the open book`);
  if (!LIVE_VENUES.includes(pos.venue ?? "") || !pos.liveMeta) throw new Error(`${ref} is not a live position (venue ${pos.venue})`);

  const spotNow = await fetchSpot();
  if (!(spotNow > 0)) throw new Error("no index price — refusing to unwind blind");
  console.error(`[live-unwind] closing ${ref} (${pos.venue}, ${pos.side}) at spot ≈ $${spotNow.toFixed(0)}`);

  const rep = pos.venue === "falconx_live" ? await unwindFalconx(pos) : await unwindOkx(pos, spotNow);

  if (rep.ridesToExpiry) {
    console.error("[live-unwind] unwind could not execute — position UNTOUCHED, still fully hedged, rides to expiry (fail-safe). Nothing booked.");
    process.exit(7);
  }
  if (!rep.complete) {
    raiseLiveAlert({ tsMs: Date.now(), level: "critical", code: "unwind_incomplete", message: `unwind of ${ref} incomplete — ${rep.notes.join("; ")}`, data: rep });
    console.error("[live-unwind] ⚠️ unwind INCOMPLETE — see alert. Complete manually, then re-run to verify flat.");
  }

  // Vesting: voluntary early close vests the credit by time held (linear; no extra penalty by default).
  const now = Date.now();
  const heldMs = now - pos.openedAtMs;
  const tenorMs = Math.max(1, pos.expiresAtMs - pos.openedAtMs);
  const vest = computeVestedCredit({ fullCreditUsdc: pos.foxifyCreditUsdc, tenorMs }, heldMs, "voluntary_early_close");
  console.error(`[live-unwind] credit vesting: held ${(heldMs / 3.6e6).toFixed(1)}h of ${(tenorMs / 3.6e6).toFixed(1)}h ⟹ vested $${vest.realizedCreditUsdc} (clawback $${vest.clawbackUsdc})`);

  // Book the early close through the normal settlement ledger (venue tag preserved, early-close meta).
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
    oracleVerified: false,                          // early close settles on the SCREEN/desk, not the oracle fixing
    openedAtMs: pos.openedAtMs,
    settledAtMs: now,
    heldMs,
    hedgeReceiptUsdc: rep.unwindValueUsdc ?? 0,
    atticusOptionNetUsdc: 0,
    shortLegMarginUsdc: 0,
    capitalCostUsdc: 0,
    optionFeesUsdc: round2((pos.openFeeUsdc ?? 0) + rep.feesUsdc),
    atticusNetAfterCapitalUsdc: pos.serviceFeeUsdc,
    atticusNetAfterFeesAndCapitalUsdc: pos.serviceFeeUsdc,
    fundingLegPremiumUsdc: pos.fundingLegPremiumUsdc,
    protectiveLegPremiumUsdc: pos.protectiveLegPremiumUsdc,
    venue: pos.venue,
    quoteMeta: { rfqRef: `${pos.quoteMeta?.rfqRef ?? pos.ref}-early-close`, quotedNetUsdc: rep.unwindValueUsdc ?? 0, modelNetUsdc: pos.quoteMeta?.modelNetUsdc ?? pos.foxifyCreditUsdc, quotedAtIso: new Date(now).toISOString() },
    liveMeta: pos.liveMeta
  };
  appendSettlements([outcome]);
  saveOpenPositions(open.filter((p) => p.ref !== ref));
  console.error(`[live-unwind] ✅ ${ref} closed + booked: unwind value $${rep.unwindValueUsdc}, vested credit $${vest.realizedCreditUsdc}, net to client $${outcome.netToFoxifyUsdc}. Verified flat: ${rep.verifiedFlat}.`);
};

const main = async (): Promise<void> => {
  const [cmd, ref] = process.argv.slice(2);
  if (cmd === "list") return list();
  if (cmd === "close" && ref) return close(ref);
  console.log("usage: list | close <ref>");
};

main().catch((e) => {
  console.error("[live-unwind]", (e as Error).message);
  process.exit(1);
});
