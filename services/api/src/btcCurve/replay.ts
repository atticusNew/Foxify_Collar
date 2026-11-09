/**
 * Static vs dynamic hedge, replayed on real hourly contracts as they happen.
 *
 * For each hourly Kalshi ladder the collector sees, the engine takes the at-the-money strike
 * at first sight and follows one $1 digital liability (the writer sold YES at the venue mid)
 * to settlement two ways, from the same snapshots:
 *
 *   static   — buy the listed call spread bracketing the strike on the nearest option expiry
 *              at the offer, hold, unwind at the settlement instant at the bid (the expiry is
 *              not aligned with the hourly close, so the position is sold back, not exercised)
 *   dynamic  — hold the option-implied digital delta in spot, rebalance every snapshot, pay
 *              `feeBps` of traded notional each time
 *
 * Everything is per $1 of contract, in USD. The result is three numbers per event: the naked
 * outcome, the static-hedged outcome and the dynamic-hedged outcome. Nothing is traded; it is
 * arithmetic over observed prices, and the report says so.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { buildSmiles, digitalDelta, nearestSmile } from "./model";
import type { Ladder, OptionRow } from "./types";

export interface ReplayEvent {
  id: string;
  settlesAt: string;
  settlesAtMs: number;
  /** inclusive threshold the digital pays at or above */
  strike: number;
  bucketKey: string;
  openedAt: string;
  openSpot: number;
  /** venue mid at open, cents of $1 */
  premiumCents: number;
  staticHedge: {
    expiry: string;
    loInstrument: string;
    hiInstrument: string;
    widthUsd: number;
    /** USD per $1 digital, paid at open (offer side) */
    entryUsd: number;
    /** USD per $1 digital, received at settlement (bid side); set on close */
    unwindUsd?: number;
  } | null;
  dynamicHedge: {
    delta: number;
    pnlUsd: number;
    feesUsd: number;
    rebalances: number;
    lastSpot: number;
    /** sum of |Δdelta|·spot, USD per $1 digital */
    turnoverUsd: number;
  };
  steps: number;
  done?: {
    settledAt: string;
    settleValue: number;
    payout: 0 | 1;
    nakedUsd: number;
    staticUsd: number | null;
    dynamicUsd: number;
  };
}

interface State {
  open: ReplayEvent[];
  done: ReplayEvent[];
}

export interface ReplaySummary {
  n: number;
  open: number;
  /** mean outcome per $1 digital, USD (negative = writer lost) */
  meanNaked: number | null;
  meanStatic: number | null;
  meanDynamic: number | null;
  /** p90 of |outcome − premium| i.e. how far the hedged book strayed from the premium it kept */
  p90AbsNaked: number | null;
  p90AbsStatic: number | null;
  p90AbsDynamic: number | null;
  /** mean up-front static cost vs mean realised dynamic cost (fees + hedge slippage), USD per $1 */
  meanStaticEntryUsd: number | null;
  meanDynamicCostUsd: number | null;
  recent: ReplayEvent[];
}

/** A replay opens only with between 20 minutes and 2 hours to the close, so the sample is one horizon. */
export const MIN_HORIZON_MS = 20 * 60_000;
export const MAX_HORIZON_MS = 2 * 60 * 60_000;

function yearsBetween(fromMs: number, toMs: number): number {
  return Math.max(1 / (365.25 * 24 * 60), (toMs - fromMs) / (365.25 * 86_400_000));
}

/** Call spread bracketing `strike` on the option expiry nearest the settlement instant. Exported for tests. */
export function bracketCalls(rows: OptionRow[], strike: number, settlesAtMs: number): { lo: OptionRow; hi: OptionRow } | null {
  const calls = rows.filter((r) => r.type === "C" && r.forward > 0);
  if (!calls.length) return null;
  const expiries = [...new Set(calls.map((c) => c.expiryMs))];
  let expiry = expiries[0];
  let best = Number.POSITIVE_INFINITY;
  for (const e of expiries) {
    const d = e >= settlesAtMs ? e - settlesAtMs : (settlesAtMs - e) * 4; // prefer an expiry after the close
    if (d < best) {
      best = d;
      expiry = e;
    }
  }
  const chain = calls.filter((c) => c.expiryMs === expiry).sort((a, b) => a.strike - b.strike);
  let lo: OptionRow | null = null;
  let hi: OptionRow | null = null;
  for (const c of chain) {
    if (c.strike <= strike) lo = c;
    if (c.strike > strike) {
      hi = c;
      break;
    }
  }
  return lo && hi ? { lo, hi } : null;
}

/** Spread value in USD per $1 digital: (long leg price − short leg price) · spot / width. */
function spreadUsd(longPx: number, shortPx: number, spot: number, width: number): number {
  return ((longPx - shortPx) * spot) / width;
}

export class ReplayEngine {
  private state: State = { open: [], done: [] };
  constructor(
    private readonly statePath: string,
    private readonly logPath: string,
    private readonly feeBps = 2,
  ) {
    if (existsSync(statePath)) {
      try {
        this.state = JSON.parse(readFileSync(statePath, "utf8")) as State;
      } catch {
        this.state = { open: [], done: [] };
      }
    }
    // Only hourly-horizon events belong in this sample. An earlier reader could open a replay on
    // the series' next-day 5 PM contract; drop any such in-flight event rather than settle it.
    this.state.open = this.state.open.filter((e) => e.settlesAtMs - Date.parse(e.openedAt) <= MAX_HORIZON_MS);
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state));
  }

  getOpen(): ReplayEvent[] {
    return this.state.open;
  }
  getDone(): ReplayEvent[] {
    return this.state.done;
  }

  /**
   * One collector cycle: open a replay for a newly seen hourly ladder, step every open replay
   * with this cycle's spot and option chain.
   */
  observe(hourly: Ladder | null, spotUsd: number, options: OptionRow[], nowMs: number): void {
    const smiles = buildSmiles(options);
    let openedNow: string | null = null;
    if (hourly && !this.state.open.some((e) => e.id === hourly.id) && !this.state.done.some((e) => e.id === hourly.id)) {
      const settlesAtMs = Date.parse(hourly.settlesAt);
      const above = hourly.buckets.filter((b) => b.kind === "above" && b.level !== undefined);
      const atm = above.sort((a, b) => Math.abs((a.level ?? 0) - spotUsd) - Math.abs((b.level ?? 0) - spotUsd))[0];
      const q = atm ? hourly.quotes.find((x) => x.venue === "kalshi" && x.bucketKey === atm.key) : undefined;
      const horizonMs = settlesAtMs - nowMs;
      const hourlyHorizon = horizonMs >= MIN_HORIZON_MS && horizonMs <= MAX_HORIZON_MS;
      if (atm && q && q.bidCents > 0 && q.askCents > 0 && q.askCents <= 99 && hourlyHorizon) {
        const strike = atm.level ?? 0;
        const br = bracketCalls(options, strike, settlesAtMs);
        const smile = nearestSmile(smiles, settlesAtMs);
        const delta = smile ? digitalDelta({ ...smile, forward: spotUsd }, strike, yearsBetween(nowMs, settlesAtMs)) : 0;
        const ev: ReplayEvent = {
          id: hourly.id,
          settlesAt: hourly.settlesAt,
          settlesAtMs,
          strike,
          bucketKey: atm.key,
          openedAt: new Date(nowMs).toISOString(),
          openSpot: spotUsd,
          premiumCents: (q.bidCents + q.askCents) / 2,
          staticHedge: br
            ? {
                expiry: br.lo.expiry,
                loInstrument: br.lo.instrument,
                hiInstrument: br.hi.instrument,
                widthUsd: br.hi.strike - br.lo.strike,
                entryUsd: spreadUsd(br.lo.askPrice || br.lo.markPrice, br.hi.bidPrice || br.hi.markPrice, spotUsd, br.hi.strike - br.lo.strike),
              }
            : null,
          dynamicHedge: {
            delta,
            pnlUsd: 0,
            feesUsd: (Math.abs(delta) * spotUsd * this.feeBps) / 10_000,
            rebalances: 1,
            lastSpot: spotUsd,
            turnoverUsd: Math.abs(delta) * spotUsd,
          },
          steps: 1,
        };
        this.state.open.push(ev);
        openedNow = ev.id;
      }
    }
    for (const ev of this.state.open) {
      if (ev.id === openedNow) continue;
      if (nowMs >= ev.settlesAtMs) continue; // waits for settle()
      const d = ev.dynamicHedge;
      d.pnlUsd += d.delta * (spotUsd - d.lastSpot);
      const smile = nearestSmile(smiles, ev.settlesAtMs);
      const next = smile ? digitalDelta({ ...smile, forward: spotUsd }, ev.strike, yearsBetween(nowMs, ev.settlesAtMs)) : d.delta;
      const traded = Math.abs(next - d.delta) * spotUsd;
      d.feesUsd += (traded * this.feeBps) / 10_000;
      d.turnoverUsd += traded;
      d.rebalances += 1;
      d.delta = next;
      d.lastSpot = spotUsd;
      ev.steps += 1;
    }
    this.persist();
  }

  /** Events past their settlement instant that still need a settlement value. */
  dueForSettlement(nowMs: number, graceMs = 90_000): ReplayEvent[] {
    return this.state.open.filter((e) => nowMs >= e.settlesAtMs + graceMs);
  }

  /** Close one replay with the index settlement value and the option chain / spot at that instant. */
  settle(id: string, settleValue: number, spotAtSettle: number, optionsAtSettle: OptionRow[], nowMs: number): ReplayEvent | null {
    const i = this.state.open.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const ev = this.state.open[i];
    const payout: 0 | 1 = settleValue >= ev.strike ? 1 : 0;
    const premium = ev.premiumCents / 100;
    const d = ev.dynamicHedge;
    d.pnlUsd += d.delta * (spotAtSettle - d.lastSpot);
    d.feesUsd += (Math.abs(d.delta) * spotAtSettle * this.feeBps) / 10_000; // flatten
    d.turnoverUsd += Math.abs(d.delta) * spotAtSettle;
    d.lastSpot = spotAtSettle;
    let staticUsd: number | null = null;
    if (ev.staticHedge) {
      const lo = optionsAtSettle.find((r) => r.instrument === ev.staticHedge?.loInstrument);
      const hi = optionsAtSettle.find((r) => r.instrument === ev.staticHedge?.hiInstrument);
      if (lo && hi) {
        ev.staticHedge.unwindUsd = spreadUsd(lo.bidPrice || lo.markPrice, hi.askPrice || hi.markPrice, spotAtSettle, ev.staticHedge.widthUsd);
        staticUsd = premium - payout + (ev.staticHedge.unwindUsd - ev.staticHedge.entryUsd);
      }
    }
    ev.done = {
      settledAt: new Date(nowMs).toISOString(),
      settleValue,
      payout,
      nakedUsd: premium - payout,
      staticUsd,
      dynamicUsd: premium - payout + d.pnlUsd - d.feesUsd,
    };
    this.state.open.splice(i, 1);
    this.state.done.push(ev);
    if (this.state.done.length > 500) this.state.done = this.state.done.slice(-500);
    appendFileSync(this.logPath, `${JSON.stringify(ev)}\n`);
    this.persist();
    return ev;
  }

  summary(): ReplaySummary {
    const done = this.state.done.filter((e) => e.done);
    const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : null);
    const p90 = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return Math.round(s[Math.min(s.length - 1, Math.round((s.length - 1) * 0.9))] * 10000) / 10000;
    };
    const naked = done.map((e) => e.done!.nakedUsd);
    const stat = done.filter((e) => e.done!.staticUsd !== null).map((e) => e.done!.staticUsd as number);
    const dyn = done.map((e) => e.done!.dynamicUsd);
    const stray = (e: ReplayEvent, v: number | null) => (v === null ? null : Math.abs(v - e.premiumCents / 100));
    return {
      n: done.length,
      open: this.state.open.length,
      meanNaked: mean(naked),
      meanStatic: mean(stat),
      meanDynamic: mean(dyn),
      p90AbsNaked: p90(done.map((e) => stray(e, e.done!.nakedUsd) as number)),
      p90AbsStatic: p90(done.filter((e) => e.done!.staticUsd !== null).map((e) => stray(e, e.done!.staticUsd) as number)),
      p90AbsDynamic: p90(done.map((e) => stray(e, e.done!.dynamicUsd) as number)),
      meanStaticEntryUsd: mean(done.filter((e) => e.staticHedge).map((e) => e.staticHedge!.entryUsd)),
      meanDynamicCostUsd: mean(done.map((e) => e.dynamicHedge.feesUsd)),
      recent: done.slice(-12).reverse(),
    };
  }
}
