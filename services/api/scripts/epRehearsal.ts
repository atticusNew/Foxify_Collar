#!/usr/bin/env tsx
/**
 * EARN & PROTECT — LIVE REHEARSAL (okx_demo lane).
 *
 * Drives a RUNNING demo service through the whole holder journey over its own HTTP API and prints
 * a PASS/FAIL checklist with the receipts: arm state → wallet verification → preview → wrap (real
 * OKX demo-environment legs) → hedge_locked → optional early close → the unwind queue working our
 * legs (passive, then IOC) to done. It is the dress rehearsal the runbook (docs/EARN_PROTECT_LIVE_RUNBOOK.md)
 * calls for before the lane is ever flipped to okx_live.
 *
 * Refuses to run against an okx_live lane unless EP_REHEARSAL_ALLOW_LIVE=I_UNDERSTAND_REAL_MONEY is
 * set — the same confirmation convention as every live rail in this repo.
 *
 * Usage (service already up, e.g. DEMO_EXECUTION=okx_demo LIVE_ENABLED=true OKX_* set, EP_UNWIND_QUEUE=1):
 *   EP_BASE=http://127.0.0.1:8787 EP_ADMIN_TOKEN=… EP_ACCOUNT=0x… \
 *   [EP_REHEARSAL_SIGNER_KEY=0x…]   # the TEST wallet's key, only when the lane needs a first verification
 *   npx tsx services/api/scripts/epRehearsal.ts [--close] [--timeout-s 180]
 *
 *   --close        after hedge_locked, turn protection off: the holder settles at the book's mark-to-market
 *                  at once; our legs go on the unwind queue and are watched to done/failed.
 *   --settle-owed  a previous cycle on this wallet left a balance "settled from gains" (plain collar:
 *                  gains above the cap / a release beyond the credit). On the exchange that is a ledger
 *                  entry; in the standalone demo it gates new protection until the operator marks it
 *                  settled. This flag does that first (POST /api/admin/owed/settle, ref=rehearsal).
 *   --timeout-s    how long to wait for hedge_locked and for the unwind queue (default 180).
 *
 * Exit code 0 when every step passed; 1 otherwise. Nothing here is a test double: every call is the
 * same HTTP the app and the bot make.
 */

import { privateKeyToAccount } from "viem/accounts";

const BASE = (process.env.EP_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN = process.env.EP_ADMIN_TOKEN ?? "";
const ACCOUNT = process.env.EP_ACCOUNT ?? "";
const SIGNER_KEY = process.env.EP_REHEARSAL_SIGNER_KEY ?? "";
const ALLOW_LIVE = process.env.EP_REHEARSAL_ALLOW_LIVE === "I_UNDERSTAND_REAL_MONEY";
const argv = process.argv.slice(2);
const CLOSE = argv.includes("--close");
const SETTLE_OWED = argv.includes("--settle-owed");
const TIMEOUT_MS = (() => {
  const i = argv.indexOf("--timeout-s");
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return (Number.isFinite(v) && v > 0 ? v : 180) * 1000;
})();

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const pass = (name: string, detail: string) => {
  steps.push({ name, ok: true, detail });
  console.log(`  PASS  ${name} — ${detail}`);
};
const fail = (name: string, detail: string) => {
  steps.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name} — ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (v: number | null | undefined) => (v == null ? "–" : `$${v.toFixed(2)}`);

const adminHeaders: Record<string, string> = ADMIN ? { "x-admin-token": ADMIN } : {};

async function call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, opts: { admin?: boolean; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", ...(opts.admin ? adminHeaders : {}), ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = { raw: text } as unknown as T;
  }
  return { status: res.status, body };
}

type Wrap = {
  id: string;
  status: string;
  failReason: string | null;
  stages: Array<{ stage: string; tsMs: number; note?: string }>;
  legs: Array<{ role: string; instId: string | null; orderId: string | null; premiumUsdc: number; real: boolean }>;
  quote: { creditUsdc: number; floorStrike?: number; capStrike?: number; putStrike: number; callStrike: number; floorPct: number; capPct: number; tenor?: string } | null;
  hedge: { venue: string; mode: string; netCreditUsdc: number | null; venueFeeUsdc: number | null; contracts: number | null } | null;
  unwind?: { id: string; phase: string; realizedUsdc: number | null; executionEdgeUsdc: number | null; mtmValueUsdc: number | null; receipts: Array<{ kind: string; note: string; atMs: number }> } | null;
};

async function main(): Promise<void> {
  console.log(`\nEarn & Protect rehearsal · ${BASE} · account ${ACCOUNT || "(none)"} · ${new Date().toISOString()}\n`);
  if (!ACCOUNT) {
    fail("inputs", "EP_ACCOUNT is required (the test wallet with an open Hyperliquid position)");
    return;
  }
  if (!ADMIN) console.log("  note  EP_ADMIN_TOKEN not set: operator views (admin status, full wrap records) will be refused; the holder path still runs\n");

  // 1) The lane and its arming state, from the operator's status view.
  const st = await call<Record<string, unknown>>("GET", "/api/admin/status", { admin: true });
  if (st.status !== 200) {
    fail("admin status", `HTTP ${st.status} ${JSON.stringify(st.body).slice(0, 200)}`);
  } else {
    const mode = String(st.body.executionMode);
    const paused = st.body.paused === true;
    const uq = (st.body.unwindQueue as { config?: { enabled: boolean; passiveMs: number } } | undefined)?.config;
    if (mode === "okx_live" && !ALLOW_LIVE) {
      fail("lane", "the service is on okx_live — this rehearsal refuses real money without EP_REHEARSAL_ALLOW_LIVE=I_UNDERSTAND_REAL_MONEY");
      return;
    }
    if (mode === "paper") console.log("  note  lane is PAPER: legs are model quotes off the live book, no venue orders. The rehearsal still runs; the point of it is the okx_demo lane.\n");
    (paused ? fail : pass)("lane", `${mode}${paused ? " · PAUSED" : ""} · cap mode ${String(st.body.capMode)} · unwind queue ${uq?.enabled ? `ON (passive ${Math.round((uq.passiveMs ?? 0) / 1000)}s)` : "off"} · open wraps ${String(st.body.openWraps)}`);
    if (CLOSE && !uq?.enabled) console.log("  note  --close with the unwind queue off: the previous IOC-first close path will run\n");
  }

  // 2) Wallet verification (forced on for every non-paper lane): one EIP-191 signature, stored server-side.
  const v = await call<{ ok: boolean; required: boolean; verified: boolean; message: string; error?: string }>("GET", `/api/verify?account=${ACCOUNT}`);
  if (v.status !== 200) {
    fail("verify", `HTTP ${v.status} ${String((v.body as { message?: string }).message ?? v.body.error ?? "")}`);
    return;
  }
  if (!v.body.required) pass("verify", "signature gate off on this lane (paper)");
  else if (v.body.verified) pass("verify", "wallet already verified for the current ToS version");
  else if (!SIGNER_KEY) {
    fail("verify", "the wallet is not verified and EP_REHEARSAL_SIGNER_KEY is not set — sign once in the app, or provide the TEST wallet's key");
    return;
  } else {
    const signer = privateKeyToAccount(SIGNER_KEY as `0x${string}`);
    if (signer.address.toLowerCase() !== ACCOUNT.toLowerCase()) {
      fail("verify", `EP_REHEARSAL_SIGNER_KEY controls ${signer.address}, not ${ACCOUNT}`);
      return;
    }
    const signature = await signer.signMessage({ message: v.body.message });
    const pv = await call<{ ok: boolean; message?: string }>("POST", `/api/verify?account=${ACCOUNT}&signature=${signature}`);
    (pv.status === 200 && pv.body.ok ? pass : fail)("verify", pv.status === 200 ? "signed and stored" : `HTTP ${pv.status} ${pv.body.message ?? ""}`);
    if (pv.status !== 200) return;
  }

  // 3) The position, read from Hyperliquid through the service (the same read the app makes).
  const s0 = await call<{ position?: { coin: string; side: "long" | "short"; szBase: number; markPx: number; notionalUsdc: number } | null; positionError?: string | null }>("GET", `/api/state?account=${ACCOUNT}`, { admin: true });
  const pos = s0.status === 200 ? s0.body.position ?? null : null;
  if (!pos) {
    fail("position", s0.status !== 200 ? `HTTP ${s0.status}` : `no open position on ${ACCOUNT}${s0.body.positionError ? ` (${s0.body.positionError})` : ""}`);
    return;
  }
  pass("position", `${pos.side} ${pos.szBase} ${pos.coin} @ mark $${pos.markPx.toFixed(1)} (≈ $${pos.notionalUsdc.toFixed(2)})`);

  // 4) Preview: the terms the holder would see before the tap, for THIS position's side, sized to
  //    what the wrap will actually cover (the per-wallet cap, in whole OKX lots) — never a bigger number
  //    than the tap delivers.
  let pv = await call<Record<string, unknown>>("GET", `/api/preview?account=${ACCOUNT}&side=${pos.side}&sizeBtc=${pos.szBase}`, { admin: true });
  if (pv.status === 200 && pv.body.exceedsCurrentCap === true && Number(pv.body.perWalletCapUsdc) > 0) {
    console.log(`  note  position ($${pos.notionalUsdc.toFixed(2)}) is above the per-wallet cap ($${Number(pv.body.perWalletCapUsdc).toFixed(0)}); previewing the covered slice\n`);
    pv = await call<Record<string, unknown>>("GET", `/api/preview?account=${ACCOUNT}&side=${pos.side}&usd=${Number(pv.body.perWalletCapUsdc)}`, { admin: true });
  }
  if (pv.status !== 200) {
    fail("preview", `HTTP ${pv.status} ${String((pv.body as { error?: string }).error ?? "")}: ${String((pv.body as { message?: string }).message ?? "")}`);
    return;
  }
  pass(
    "preview",
    `${pos.side} · credit ${usd(pv.body.creditUsdc as number)} on $${Number(pv.body.protectedUsd ?? 0).toFixed(2)} protected · floor ${String(pv.body.floorStrike ?? "–")} · cap ${String(pv.body.capStrike ?? "–")} · ${String(pv.body.tenor ?? "")} · floor rule ${String(pv.body.floorRule ?? "–")} · cap rule ${String(pv.body.capRule ?? "–")}${pv.body.capExceedProb != null ? ` (${(Number(pv.body.capExceedProb) * 100).toFixed(0)}% odds past cap)` : ""}`,
  );

  // 5) A balance from a previous cycle gates new protection (plain collar). Clear it as the exchange
  //    ledger would, when asked; otherwise the wrap below reports it honestly.
  if (SETTLE_OWED && st.status === 200) {
    const items = ((st.body.owed as { items?: Array<{ wrapId: string; account: string; amountUsdc: number }> } | undefined)?.items ?? []).filter((o) => o.account.toLowerCase() === ACCOUNT.toLowerCase());
    for (const o of items) {
      const r = await call<{ ok: boolean; error?: string }>("POST", `/api/admin/owed/settle?wrap=${o.wrapId}&status=settled&ref=rehearsal`, { admin: true });
      (r.status === 200 ? pass : fail)("settle owed", `${usd(o.amountUsdc)} on ${o.wrapId} ${r.status === 200 ? "marked settled (ref rehearsal)" : `HTTP ${r.status} ${r.body.error ?? ""}`}`);
    }
    if (!items.length) pass("settle owed", "nothing outstanding on this wallet");
  }

  // 6) Wrap: the tap. Real legs on okx lanes, through the same production path as the canary.
  const idem = `rehearsal-${Date.now()}`;
  const w = await call<Record<string, unknown> & { controlToken?: string; wrap?: Wrap; id?: string }>("POST", `/api/wrap?account=${ACCOUNT}`, { admin: true, headers: { "idempotency-key": idem } });
  if (w.status !== 200 || w.body.ok !== true) {
    fail("wrap", `HTTP ${w.status} ${String(w.body.error ?? "")}: ${String(w.body.message ?? "")}`);
    return;
  }
  const controlToken = w.body.controlToken ?? "";
  const wrapId = (w.body.wrap as Wrap | undefined)?.id ?? (w.body.id as string | undefined) ?? "";
  pass("wrap", `accepted · wrap ${wrapId || "(id in state)"} · control token ${controlToken ? "issued" : "none"} · idempotency ${idem}`);

  // 7) hedge_locked: poll the account's state until the newest wrap has its legs.
  const findWrap = async (): Promise<Wrap | null> => {
    const s = await call<{ wraps?: Wrap[] }>("GET", `/api/state?account=${ACCOUNT}`, { admin: true });
    const wraps = s.body.wraps ?? [];
    const mine = wrapId ? wraps.find((x) => x.id === wrapId) : undefined;
    return mine ?? wraps.slice().sort((a, b) => (b.stages[0]?.tsMs ?? 0) - (a.stages[0]?.tsMs ?? 0))[0] ?? null;
  };
  const t0 = Date.now();
  let wrap: Wrap | null = null;
  let locked = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    wrap = await findWrap();
    if (!wrap) {
      await sleep(2000);
      continue;
    }
    if (wrap.status === "failed") break;
    if (wrap.stages.some((s) => s.stage === "hedge_locked")) {
      locked = true;
      break;
    }
    await sleep(2000);
  }
  if (!wrap) {
    fail("hedge_locked", "no wrap record visible in /api/state");
    return;
  }
  if (!locked) {
    fail("hedge_locked", wrap.status === "failed" ? `wrap failed: ${wrap.failReason ?? "(no reason)"}` : `not locked after ${Math.round(TIMEOUT_MS / 1000)}s (status ${wrap.status})`);
    for (const s of wrap.stages) console.log(`        ${new Date(s.tsMs).toISOString()}  ${s.stage}${s.note ? `  ${s.note}` : ""}`);
    return;
  }
  const realLegs = wrap.legs.filter((l) => l.real);
  pass(
    "hedge_locked",
    `${wrap.hedge?.venue ?? "?"} · ${wrap.legs.length} legs (${realLegs.length} real, ${realLegs.filter((l) => l.orderId).length} with order ids) · net credit ${usd(wrap.hedge?.netCreditUsdc)} · venue fee ${usd(wrap.hedge?.venueFeeUsdc)} · holder credit ${usd(wrap.quote?.creditUsdc)}`,
  );
  for (const l of wrap.legs) console.log(`        ${l.role.padEnd(15)} ${String(l.instId ?? "–").padEnd(28)} ${l.orderId ? `order ${l.orderId}` : "(no order)"}  ${l.premiumUsdc >= 0 ? "+" : ""}${l.premiumUsdc.toFixed(2)}`);
  for (const s of wrap.stages) console.log(`        ${new Date(s.tsMs).toISOString()}  ${s.stage}${s.note ? `  ${s.note}` : ""}`);

  if (!CLOSE) {
    console.log("\n  note  --close not given: protection stays on; the wrap concludes and pays at the cycle's close (auto-renew as configured).");
    return;
  }

  // 8) Early close: the holder settles at once; our legs go on the unwind queue.
  const c = await call<Record<string, unknown>>("POST", `/api/close?account=${ACCOUNT}`, { admin: true, headers: controlToken ? { "x-ep-control": controlToken } : {} });
  if (c.status !== 200 || c.body.ok !== true) {
    fail("close", `HTTP ${c.status} ${String(c.body.error ?? "")}: ${String(c.body.message ?? "")}`);
    return;
  }
  const vested = c.body.vested as { vestedUsdc: number; fullCreditUsdc: number; fraction: number } | null;
  const closed = c.body.wrap as (Wrap & { closeValue?: { valueUsdc: number | null; source: string } | null }) | undefined;
  pass(
    "close",
    `concluded · vested ${usd(vested?.vestedUsdc)} of ${usd(vested?.fullCreditUsdc)} (${vested ? (vested.fraction * 100).toFixed(1) : "–"}%) · collar valued at ${usd(closed?.closeValue?.valueUsdc)} (${closed?.closeValue?.source ?? "–"})`,
  );

  // 9) The unwind queue works OUR legs to done (passive first, then IOC), every step a receipt.
  const t1 = Date.now();
  let job: Wrap["unwind"] | null = null;
  let seen = 0;
  while (Date.now() - t1 < TIMEOUT_MS) {
    const cur = await findWrap();
    job = cur?.unwind ?? null;
    if (job) {
      for (const r of job.receipts.slice(seen)) console.log(`        ${new Date(r.atMs).toISOString()}  ${r.kind.padEnd(16)} ${r.note}`);
      seen = job.receipts.length;
      if (job.phase === "done" || job.phase === "failed") break;
    } else if (cur && cur.stages.some((s) => s.stage === "concluded") && !cur.unwind) {
      // no queue on this lane (paper, or EP_UNWIND_QUEUE off): the IOC-first path already concluded
      pass("unwind", "concluded on the direct path (no unwind queue on this lane)");
      return;
    }
    await sleep(3000);
  }
  if (!job) {
    fail("unwind", "no unwind job appeared on the wrap record");
    return;
  }
  if (job.phase === "done") {
    pass("unwind", `done · holder settled at MTM ${usd(job.mtmValueUsdc)} · our exit realized ${usd(job.realizedUsdc)} · execution edge ${job.executionEdgeUsdc == null ? "–" : `${job.executionEdgeUsdc >= 0 ? "+" : ""}${job.executionEdgeUsdc.toFixed(2)}`} · ${job.receipts.length} receipts`);
  } else if (job.phase === "failed") {
    fail("unwind", `FAILED — a leg would not fill: this is OUR problem (operator closes it by hand), never the holder's; last receipt: ${job.receipts[job.receipts.length - 1]?.note ?? "–"}`);
  } else {
    fail("unwind", `still ${job.phase} after ${Math.round(TIMEOUT_MS / 1000)}s — raise --timeout-s past EP_UNWIND_PASSIVE_MS, or check the venue`);
  }
}

main()
  .catch((err) => fail("rehearsal", String(err instanceof Error ? err.message : err)))
  .finally(() => {
    const failed = steps.filter((s) => !s.ok);
    console.log(`\n${failed.length ? `${failed.length} step(s) FAILED` : `all ${steps.length} steps passed`} · ${new Date().toISOString()}\n`);
    process.exit(failed.length ? 1 : 0);
  });
