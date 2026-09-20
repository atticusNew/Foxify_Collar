/**
 * UNWIND QUEUE — the writer's own exit, decoupled from the trader's settlement (item 3, 2026-09-20).
 *
 * WHY. Before this, an early close on a live lane ran the IOC unwind FIRST and settled the trader
 * from whatever those fills were; a bad fill was the trader's problem and an unfilled leg refused
 * the close. That couples two things that have nothing to do with each other: what the collar is
 * WORTH (the book, right now) and how well WE execute (our craft, our clock). Here:
 *
 *   1. The trader settles at MARK-TO-MARKET the moment they close: floor leg at its bid, cap leg
 *      at its ask, fees off (closeValueFromBooks). Instant, book-priced, nothing to wait for.
 *   2. Our hedge legs go on this queue and are worked PASSIVE FIRST: a post-only order at the
 *      book's mid on each leg (a sell never under the bid, a buy never at the ask), re-priced as
 *      the mid walks, for `passiveMs`; then whatever is left goes through the existing IOC unwind
 *      (venue truth first, so a passive fill is never closed twice). Every step is a receipt.
 *   3. RECYCLE: a new wrap that needs the same instrument on the opposite side takes the leg from
 *      the queue at mid instead of both sides crossing the spread. Full-or-nothing per wrap (every
 *      lot of both legs), so the new wrap's hedge record is one clean fill, not a merge.
 *
 * P&L IDENTITY (re-derived under the founder's rule; this changes WHO settles WHEN, never the
 * payoff). At an early close at time t, with both legs marked on the book:
 *     trader = vested credit + MTM(collar at t) − take         (settled now, from the book)
 *     writer = take + (realized unwind − MTM)                  (our execution vs the book: passive
 *                                                               fills and recycles make it positive,
 *                                                               a market IOC makes it negative)
 *     venue  = fees + spreads actually crossed
 *   Under the pricing measure E[realized − MTM] = 0 at the mid, negative at the ask/bid, so the
 *   queue exists to move our line from "−spread" toward zero. The trader's line is unchanged by
 *   how we execute — that is the point.
 *
 * Flag-guarded: EP_UNWIND_QUEUE=1. Off, the previous path runs (IOC first, refuse on failure).
 */

import { OKX_OPTION_LOT_BTC } from "../demoWrap";
import { legFeeUsdc } from "../capRelease";
import type { LiveExecClient } from "./okxLiveCollarExecutor";

export type UnwindAction = "buy" | "sell";

export type UnwindLeg = {
  instId: string;
  /** the CLOSING action: sell the long floor leg, buy back the short cap leg */
  action: UnwindAction;
  contracts: number;
  /** contracts closed so far, by any path (recycle, passive, IOC) */
  filledContracts: number;
  /** volume-weighted price of what filled, BTC per BTC */
  avgPxBtc: number | null;
  /** fees paid on this leg so far, USDC */
  feeUsdc: number;
  working: { ordId: string; pxBtc: number; contracts: number; restedAtMs: number; /** fills of THIS order already folded into the leg */ filledSeen: number } | null;
};

export type UnwindReceiptKind =
  | "queued"
  | "recycled"
  | "passive_rested"
  | "passive_repriced"
  | "passive_filled"
  | "passive_recalled"
  | "ioc_closed"
  | "ioc_incomplete"
  | "done"
  | "failed";

export type UnwindReceipt = {
  atMs: number;
  kind: UnwindReceiptKind;
  instId?: string;
  contracts?: number;
  pxBtc?: number | null;
  usdc?: number | null;
  note: string;
};

export type UnwindPhase = "passive" | "ioc" | "done" | "failed";

export type UnwindJob = {
  id: string;
  wrapId: string;
  account: string;
  createdAtMs: number;
  /** what the trader was settled at: the collar's book value at the close, USDC (null ⟹ unvalued, nothing charged) */
  mtmValueUsdc: number | null;
  spotUsd: number;
  legs: UnwindLeg[];
  phase: UnwindPhase;
  passiveUntilMs: number;
  iocAttempts: number;
  /** what our exit actually realized once done: sells − buys − fees, USDC */
  realizedUsdc: number | null;
  /** realized − MTM: positive means our execution beat the book the trader was settled at */
  executionEdgeUsdc: number | null;
  updatedAtMs: number;
  receipts: UnwindReceipt[];
};

export type UnwindQueueConfig = {
  enabled: boolean;
  /** how long the passive orders work before the IOC takes what is left */
  passiveMs: number;
  /** re-price a resting order when the mid has moved by at least this many ticks */
  repriceTicks: number;
  /** IOC attempts before the job is marked failed and left to the operator */
  maxIocAttempts: number;
  /** minimum gap between IOC attempts */
  iocRetryMs: number;
};

export const DEFAULT_UNWIND_QUEUE: UnwindQueueConfig = {
  enabled: false,
  passiveMs: 10 * 60_000,
  repriceTicks: 2,
  maxIocAttempts: 6,
  iocRetryMs: 5 * 60_000,
};

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** EP_UNWIND_QUEUE=1 turns it on; EP_UNWIND_PASSIVE_MS, EP_UNWIND_REPRICE_TICKS, EP_UNWIND_IOC_ATTEMPTS, EP_UNWIND_IOC_RETRY_MS. */
export const unwindQueueConfigFromEnv = (env: NodeJS.ProcessEnv): UnwindQueueConfig => ({
  enabled: /^(1|true|on|yes)$/i.test(env.EP_UNWIND_QUEUE ?? ""),
  passiveMs: numEnv(env.EP_UNWIND_PASSIVE_MS, DEFAULT_UNWIND_QUEUE.passiveMs),
  repriceTicks: Math.max(1, Math.round(numEnv(env.EP_UNWIND_REPRICE_TICKS, DEFAULT_UNWIND_QUEUE.repriceTicks))),
  maxIocAttempts: Math.max(1, Math.round(numEnv(env.EP_UNWIND_IOC_ATTEMPTS, DEFAULT_UNWIND_QUEUE.maxIocAttempts))),
  iocRetryMs: numEnv(env.EP_UNWIND_IOC_RETRY_MS, DEFAULT_UNWIND_QUEUE.iocRetryMs),
});

// OKX BTC option tick (BTC per BTC of underlying); off-tick prices are rejected outright.
export const TICK_BTC = 0.0001;
const round8 = (x: number): number => +x.toFixed(8);
const round2 = (x: number): number => +x.toFixed(2);
export const floorTick = (px: number): number => Math.max(TICK_BTC, round8(Math.floor(px / TICK_BTC + 1e-9) * TICK_BTC));
export const ceilTick = (px: number): number => Math.max(TICK_BTC, round8(Math.ceil(px / TICK_BTC - 1e-9) * TICK_BTC));

export type Book = { bidBtc: number | null; askBtc: number | null };

/**
 * The passive price for a closing order: the mid on a tick, never crossing. A buy sits at or
 * under the mid and always under the ask; a sell at or over the mid and always over the bid.
 * Null when the side we need to trade against is not there (no ask to buy under, no bid to sell
 * over) — nothing rests against an empty book.
 */
export const passivePxBtc = (action: UnwindAction, book: Book): number | null => {
  const bid = book.bidBtc != null && book.bidBtc > 0 ? book.bidBtc : null;
  const ask = book.askBtc != null && book.askBtc > 0 ? book.askBtc : null;
  if (action === "buy") {
    if (ask == null) return null;
    const belowAsk = Math.max(TICK_BTC, round8(ceilTick(ask) - TICK_BTC)); // the highest tick strictly under the ask
    if (bid == null || bid >= ask) return belowAsk;
    return Math.min(floorTick((bid + ask) / 2), belowAsk);
  }
  if (bid == null) return null;
  const aboveBid = round8(floorTick(bid) + TICK_BTC); // the lowest tick strictly over the bid
  if (ask == null || ask <= bid) return aboveBid;
  return Math.max(ceilTick((bid + ask) / 2), aboveBid);
};

export const remaining = (leg: UnwindLeg): number => Math.max(0, leg.contracts - leg.filledContracts);

/** Build the job from a wrap's legs: sell the floor leg, buy back whatever of the cap leg is still held. */
export const planUnwindJob = (input: {
  wrapId: string;
  account: string;
  nowMs: number;
  spotUsd: number;
  mtmValueUsdc: number | null;
  floorInstId: string | null;
  capInstId: string | null;
  contracts: number;
  cappedContracts: number;
  cfg: Pick<UnwindQueueConfig, "passiveMs">;
}): UnwindJob | null => {
  const legs: UnwindLeg[] = [];
  const mk = (instId: string, action: UnwindAction, contracts: number): UnwindLeg => ({ instId, action, contracts, filledContracts: 0, avgPxBtc: null, feeUsdc: 0, working: null });
  if (input.floorInstId && input.contracts > 0) legs.push(mk(input.floorInstId, "sell", input.contracts));
  if (input.capInstId && input.cappedContracts > 0) legs.push(mk(input.capInstId, "buy", input.cappedContracts));
  if (legs.length === 0) return null;
  return {
    id: `uw-${input.wrapId}`,
    wrapId: input.wrapId,
    account: input.account,
    createdAtMs: input.nowMs,
    mtmValueUsdc: input.mtmValueUsdc,
    spotUsd: input.spotUsd,
    legs,
    phase: "passive",
    passiveUntilMs: input.nowMs + input.cfg.passiveMs,
    iocAttempts: 0,
    realizedUsdc: null,
    executionEdgeUsdc: null,
    updatedAtMs: input.nowMs,
    receipts: [
      {
        atMs: input.nowMs,
        kind: "queued",
        usdc: input.mtmValueUsdc,
        note: `trader settled at the book (${input.mtmValueUsdc == null ? "unvalued" : `$${input.mtmValueUsdc}`}); ${legs.map((l) => `${l.action} ${l.contracts} ${l.instId}`).join(", ")} to work passive first`,
      },
    ],
  };
};

/** Fold a fill into a leg (volume-weighted price, contracts, fee). */
export const applyFill = (leg: UnwindLeg, contracts: number, pxBtc: number, feeUsdc: number): void => {
  if (!(contracts > 0)) return;
  const prev = leg.filledContracts;
  const prevPx = leg.avgPxBtc ?? 0;
  leg.avgPxBtc = round8((prevPx * prev + pxBtc * contracts) / (prev + contracts));
  leg.filledContracts = prev + contracts;
  leg.feeUsdc = round2(leg.feeUsdc + feeUsdc);
};

/** What the closing fills so far are worth: sells in, buys out, fees off. */
export const realizedUsdc = (job: Pick<UnwindJob, "legs" | "spotUsd">): number => {
  let v = 0;
  for (const l of job.legs) {
    if (l.avgPxBtc == null || l.filledContracts <= 0) continue;
    const usd = l.avgPxBtc * l.filledContracts * OKX_OPTION_LOT_BTC * job.spotUsd;
    v += (l.action === "sell" ? usd : -usd) - l.feeUsdc;
  }
  return round2(v);
};

export const isOpen = (job: Pick<UnwindJob, "phase">): boolean => job.phase === "passive" || job.phase === "ioc";

const finish = (job: UnwindJob, nowMs: number): void => {
  job.phase = "done";
  job.realizedUsdc = realizedUsdc(job);
  job.executionEdgeUsdc = job.mtmValueUsdc == null ? null : round2(job.realizedUsdc - job.mtmValueUsdc);
  job.updatedAtMs = nowMs;
  job.receipts.push({
    atMs: nowMs,
    kind: "done",
    usdc: job.realizedUsdc,
    note: `flat; realized $${job.realizedUsdc}${job.executionEdgeUsdc == null ? "" : ` vs the $${job.mtmValueUsdc} the trader was settled at (${job.executionEdgeUsdc >= 0 ? "+" : ""}$${job.executionEdgeUsdc} to the writer)`}`,
  });
};

// ── Recycle ─────────────────────────────────────────────────────────────────

export type RecycleNeed = { instId: string; action: UnwindAction; contracts: number };

/**
 * Can the queue supply EVERY lot of a new wrap's legs from what it is about to close? The new
 * wrap BUYS its floor leg and SELLS its cap leg; a queued job SELLS a floor leg and BUYS a cap
 * leg back — the same instrument, opposite side. Full-or-nothing: partial recycles would leave the
 * new wrap's hedge record a merge of two fills. Pure: returns the plan, changes nothing.
 */
export const recyclePlan = (
  jobs: Iterable<UnwindJob>,
  needs: RecycleNeed[],
): { jobId: string; instId: string; contracts: number }[] | null => {
  if (needs.length === 0) return null;
  const all = [...jobs];
  const plan: { jobId: string; instId: string; contracts: number }[] = [];
  for (const need of needs) {
    if (!(need.contracts > 0)) return null;
    let got = false;
    for (const job of all) {
      if (!isOpen(job)) continue;
      const leg = job.legs.find((l) => l.instId === need.instId && l.action !== need.action && l.working == null && remaining(l) >= need.contracts);
      if (leg) {
        plan.push({ jobId: job.id, instId: need.instId, contracts: need.contracts });
        got = true;
        break;
      }
    }
    if (!got) return null;
  }
  return plan;
};

/** Apply a recycle plan: the queued legs fill at the mid with no fee; the receipt names the wrap that took them. */
export const applyRecycle = (
  jobs: Map<string, UnwindJob>,
  plan: { jobId: string; instId: string; contracts: number }[],
  mids: Record<string, number>,
  takerWrapId: string,
  nowMs: number,
): void => {
  for (const p of plan) {
    const job = jobs.get(p.jobId);
    const leg = job?.legs.find((l) => l.instId === p.instId);
    const mid = mids[p.instId];
    if (!job || !leg || !(mid > 0)) continue;
    applyFill(leg, p.contracts, mid, 0);
    job.updatedAtMs = nowMs;
    job.receipts.push({ atMs: nowMs, kind: "recycled", instId: p.instId, contracts: p.contracts, pxBtc: mid, usdc: round2(mid * p.contracts * OKX_OPTION_LOT_BTC * job.spotUsd), note: `${p.contracts} taken by ${takerWrapId} at the mid — no spread crossed on either side` });
    if (job.legs.every((l) => remaining(l) === 0)) finish(job, nowMs);
  }
};

// ── Passive phase ───────────────────────────────────────────────────────────

export type PassiveDecision =
  | { kind: "none"; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "rest"; pxBtc: number; contracts: number; reason: string }
  | { kind: "replace"; pxBtc: number; contracts: number; reason: string };

/** Pure: what to do with one leg's resting order this tick, given the book. */
export const passiveDecision = (leg: UnwindLeg, book: Book | null, cfg: Pick<UnwindQueueConfig, "repriceTicks">): PassiveDecision => {
  const left = remaining(leg);
  if (left <= 0) return { kind: "none", reason: "leg flat" };
  const px = book ? passivePxBtc(leg.action, book) : null;
  if (!leg.working) {
    if (px == null) return { kind: "none", reason: `no ${leg.action === "buy" ? "ask" : "bid"} to price against` };
    return { kind: "rest", pxBtc: px, contracts: left, reason: `rest ${leg.action} ${left} at the mid ${px}` };
  }
  if (px != null && Math.abs(px - leg.working.pxBtc) >= cfg.repriceTicks * TICK_BTC - 1e-9) {
    return { kind: "replace", pxBtc: px, contracts: left, reason: `mid walked ${leg.working.pxBtc} → ${px}` };
  }
  return { kind: "hold", reason: "resting at the mid" };
};

const parsePx = (v: string | undefined | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Read a resting order's fills (venue truth) and fold anything new into the leg. */
const syncWorking = async (client: LiveExecClient, leg: UnwindLeg, spotUsd: number, nowMs: number, receipts: UnwindReceipt[]): Promise<void> => {
  if (!leg.working) return;
  const q = await client.getOrder(leg.instId, leg.working.ordId).catch(() => null);
  const snap = q?.data?.[0];
  if (!snap) return;
  const acc = Number(snap.accFillSz);
  const fresh = Number.isFinite(acc) ? Math.min(acc - leg.working.filledSeen, remaining(leg)) : 0;
  if (fresh > 0) {
    const px = parsePx(snap.avgPx) ?? leg.working.pxBtc;
    const fee = legFeeUsdc(fresh * OKX_OPTION_LOT_BTC * spotUsd, px * fresh * OKX_OPTION_LOT_BTC * spotUsd);
    applyFill(leg, fresh, px, fee);
    leg.working.filledSeen += fresh;
    receipts.push({ atMs: nowMs, kind: "passive_filled", instId: leg.instId, contracts: fresh, pxBtc: px, usdc: round2(px * fresh * OKX_OPTION_LOT_BTC * spotUsd), note: `${fresh} filled at the mid` });
  }
  if (snap.state === "filled" || snap.state === "canceled" || remaining(leg) === 0) leg.working = null;
};

const recall = async (client: LiveExecClient, leg: UnwindLeg, spotUsd: number, nowMs: number, receipts: UnwindReceipt[], why: string): Promise<void> => {
  if (!leg.working) return;
  const w = leg.working;
  await client.cancelOrder(leg.instId, w.ordId).catch(() => null);
  await syncWorking(client, leg, spotUsd, nowMs, receipts);
  leg.working = null;
  receipts.push({ atMs: nowMs, kind: "passive_recalled", instId: leg.instId, pxBtc: w.pxBtc, note: why });
};

const rest = async (client: LiveExecClient, leg: UnwindLeg, pxBtc: number, contracts: number, nowMs: number, receipts: UnwindReceipt[], kind: "passive_rested" | "passive_repriced", jobId: string): Promise<void> => {
  const res = await client.placeOrder({
    instId: leg.instId,
    side: leg.action,
    ordType: "post_only",
    px: String(pxBtc),
    sz: String(contracts),
    tdMode: "cross",
    reduceOnly: true,
    clOrdId: `uw${nowMs.toString(36)}${jobId.slice(-6).replace(/[^a-zA-Z0-9]/g, "")}`,
  });
  const ordId = res.data?.[0]?.ordId;
  if (!res.ok || !ordId) {
    receipts.push({ atMs: nowMs, kind, instId: leg.instId, pxBtc, contracts, note: `REJECTED ${res.code} ${res.data?.[0]?.sMsg ?? res.msg}` });
    return;
  }
  leg.working = { ordId, pxBtc, contracts, restedAtMs: nowMs, filledSeen: 0 };
  receipts.push({ atMs: nowMs, kind, instId: leg.instId, pxBtc, contracts, note: `${leg.action} ${contracts} resting at ${pxBtc}` });
};

export type IocRunner = (legs: UnwindLeg[], spotUsd: number) => Promise<{ complete: boolean; fills: Array<{ instId: string; contracts: number; avgPxBtc: number | null; feeUsdc: number }>; note: string }>;

/**
 * One tick of work on a job. Passive phase: sync fills, rest / re-price / hold each leg; when the
 * window ends, recall everything and hand the remainder to the IOC. IOC phase: run it (venue truth
 * first), fold fills, finish or count the attempt. Never throws — a queue failure is a receipt.
 */
export const stepUnwindJob = async (
  job: UnwindJob,
  deps: { client: LiveExecClient; readBook: (instId: string) => Promise<Book | null>; ioc: IocRunner; nowMs: number; cfg: UnwindQueueConfig },
): Promise<void> => {
  const { client, nowMs, cfg } = deps;
  if (!isOpen(job)) return;
  try {
    if (job.phase === "passive") {
      for (const leg of job.legs) await syncWorking(client, leg, job.spotUsd, nowMs, job.receipts);
      if (job.legs.every((l) => remaining(l) === 0)) {
        finish(job, nowMs);
        return;
      }
      if (nowMs >= job.passiveUntilMs) {
        for (const leg of job.legs) await recall(client, leg, job.spotUsd, nowMs, job.receipts, "passive window over — the IOC takes what is left");
        job.phase = job.legs.every((l) => remaining(l) === 0) ? "done" : "ioc";
        if (job.phase === "done") finish(job, nowMs);
        job.updatedAtMs = nowMs;
        return;
      }
      for (const leg of job.legs) {
        if (remaining(leg) === 0) continue;
        const book = await deps.readBook(leg.instId);
        const d = passiveDecision(leg, book, cfg);
        if (d.kind === "rest") await rest(client, leg, d.pxBtc, d.contracts, nowMs, job.receipts, "passive_rested", job.id);
        else if (d.kind === "replace") {
          await recall(client, leg, job.spotUsd, nowMs, job.receipts, d.reason);
          if (remaining(leg) > 0) await rest(client, leg, d.pxBtc, remaining(leg), nowMs, job.receipts, "passive_repriced", job.id);
        }
      }
      job.updatedAtMs = nowMs;
      return;
    }
    // IOC phase
    const last = [...job.receipts].reverse().find((r) => r.kind === "ioc_incomplete");
    if (last && nowMs - last.atMs < cfg.iocRetryMs) return;
    const open = job.legs.filter((l) => remaining(l) > 0);
    const r = await deps.ioc(open, job.spotUsd);
    for (const f of r.fills) {
      const leg = job.legs.find((l) => l.instId === f.instId);
      if (leg && f.contracts > 0 && f.avgPxBtc != null) applyFill(leg, Math.min(f.contracts, remaining(leg)), f.avgPxBtc, f.feeUsdc);
    }
    job.iocAttempts += 1;
    if (r.complete && job.legs.every((l) => remaining(l) === 0)) {
      job.receipts.push({ atMs: nowMs, kind: "ioc_closed", note: r.note });
      finish(job, nowMs);
      return;
    }
    if (r.complete) {
      // the venue says flat but our count disagrees: trust the venue, close the book at what we saw
      for (const leg of job.legs) if (remaining(leg) > 0) leg.contracts = leg.filledContracts;
      job.receipts.push({ atMs: nowMs, kind: "ioc_closed", note: `${r.note} (venue flat; contracts reconciled to fills)` });
      finish(job, nowMs);
      return;
    }
    job.receipts.push({ atMs: nowMs, kind: "ioc_incomplete", note: `attempt ${job.iocAttempts}: ${r.note}` });
    if (job.iocAttempts >= cfg.maxIocAttempts) {
      job.phase = "failed";
      job.receipts.push({ atMs: nowMs, kind: "failed", note: `${cfg.maxIocAttempts} IOC attempts; left to the operator — the trader is already settled, this is our leg` });
    }
    job.updatedAtMs = nowMs;
  } catch (e) {
    job.receipts.push({ atMs: nowMs, kind: job.phase === "passive" ? "passive_recalled" : "ioc_incomplete", note: `step failed: ${(e as Error).message}` });
    job.updatedAtMs = nowMs;
  }
};

export type UnwindQueueSummary = {
  open: number;
  passive: number;
  ioc: number;
  failed: number;
  done: number;
  /** sum of (realized − MTM) over finished jobs: what working our own exit has earned or cost the writer */
  executionEdgeUsdc: number;
  recycledContracts: number;
};

export const summarizeUnwindQueue = (jobs: Iterable<UnwindJob>): UnwindQueueSummary => {
  const s: UnwindQueueSummary = { open: 0, passive: 0, ioc: 0, failed: 0, done: 0, executionEdgeUsdc: 0, recycledContracts: 0 };
  for (const j of jobs) {
    if (j.phase === "passive") s.passive += 1;
    if (j.phase === "ioc") s.ioc += 1;
    if (isOpen(j)) s.open += 1;
    if (j.phase === "failed") s.failed += 1;
    if (j.phase === "done") {
      s.done += 1;
      s.executionEdgeUsdc += j.executionEdgeUsdc ?? 0;
    }
    for (const r of j.receipts) if (r.kind === "recycled") s.recycledContracts += r.contracts ?? 0;
  }
  s.executionEdgeUsdc = round2(s.executionEdgeUsdc);
  return s;
};
