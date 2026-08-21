/**
 * RFQ BOOK-LEVEL NETTING (decision 7: "RFQ in, screen out") — planning calculator.
 *
 * RFQ/block trades have minimum sizes single retail wraps never reach, so RFQ is a BOOK-level
 * tool: aggregate the book's hedge needs, let longs offset shorts and same-strike wraps combine,
 * and send only the NET deltas that clear the block minimum as RFQs. Everything else stays on the
 * order book. ENTRIES ONLY — knockout unwinds are urgent and always execute on the screen (that
 * urgency is why the per-strike concentration cap exists).
 *
 * The block minimum defaults to $50k notional per leg (EP_RFQ_BLOCK_MIN_NOTIONAL) — CONFIRM the
 * exact OKX options block minimums with the BD rep before relying on it.
 *
 * Pure planning module: wrap intents in, net legs + routing out. Execution wiring stays in the
 * existing RFQ-first runner lane.
 */

import { OKX_OPTION_LOT_BTC, type DemoWrapRecord } from "./demoWrap";
import type { PerpSide } from "./creditCollarPricer";

const round2 = (x: number) => +x.toFixed(2);

export type HedgeIntent = {
  ref: string; // wrap id
  side: PerpSide;
  lots: number;
  putStrike: number;
  callStrike: number;
  expiryMs: number;
};

/** The hedge legs one wrap needs: long wraps sell the call / buy the put; shorts mirror. */
export const intentLegs = (i: HedgeIntent): Array<{ key: string; optType: "C" | "P"; strike: number; expiryMs: number; signedLots: number }> => {
  const legs =
    i.side === "long"
      ? [
          { optType: "C" as const, strike: i.callStrike, signedLots: -i.lots }, // sell call (cap)
          { optType: "P" as const, strike: i.putStrike, signedLots: +i.lots } // buy put (floor)
        ]
      : [
          { optType: "P" as const, strike: i.putStrike, signedLots: -i.lots }, // sell put (cap)
          { optType: "C" as const, strike: i.callStrike, signedLots: +i.lots } // buy call (floor)
        ];
  return legs.map((l) => ({ ...l, expiryMs: i.expiryMs, key: `${l.optType}:${l.strike}:${i.expiryMs}` }));
};

export type NetLeg = {
  key: string;
  optType: "C" | "P";
  strike: number;
  expiryMs: number;
  /** Net lots after book-level offsetting: + = the book BUYS, − = the book SELLS. */
  netLots: number;
  grossLots: number; // total lots before netting (what naive per-wrap execution would trade)
  notionalUsdc: number;
  route: "rfq_block" | "order_book";
};

export type NettingPlan = {
  legs: NetLeg[];
  blockLegs: NetLeg[];
  screenLegs: NetLeg[];
  /** Lots that cancelled out entirely — trades the book never has to place. */
  nettedAwayLots: number;
  blockMinNotionalUsdc: number;
};

/**
 * Net the book's aggregate hedge needs and route each net leg: RFQ block when it clears the
 * minimum, order book otherwise. Legs that net to zero disappear (pure savings).
 */
export const buildNettingPlan = (intents: HedgeIntent[], spotUsd: number, blockMinNotionalUsdc: number, lotBtc = OKX_OPTION_LOT_BTC): NettingPlan => {
  const acc = new Map<string, { optType: "C" | "P"; strike: number; expiryMs: number; net: number; gross: number }>();
  for (const i of intents) {
    for (const leg of intentLegs(i)) {
      const cur = acc.get(leg.key) ?? { optType: leg.optType, strike: leg.strike, expiryMs: leg.expiryMs, net: 0, gross: 0 };
      cur.net += leg.signedLots;
      cur.gross += Math.abs(leg.signedLots);
      acc.set(leg.key, cur);
    }
  }
  const legs: NetLeg[] = [...acc.entries()]
    .filter(([, v]) => Math.abs(v.net) > 1e-9)
    .map(([key, v]) => {
      const notionalUsdc = round2(Math.abs(v.net) * lotBtc * spotUsd);
      return {
        key,
        optType: v.optType,
        strike: v.strike,
        expiryMs: v.expiryMs,
        netLots: v.net,
        grossLots: v.gross,
        notionalUsdc,
        route: notionalUsdc >= blockMinNotionalUsdc ? ("rfq_block" as const) : ("order_book" as const)
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const grossAll = [...acc.values()].reduce((s, v) => s + v.gross, 0);
  const netAll = legs.reduce((s, l) => s + Math.abs(l.netLots), 0);
  return {
    legs,
    blockLegs: legs.filter((l) => l.route === "rfq_block"),
    screenLegs: legs.filter((l) => l.route === "order_book"),
    nettedAwayLots: grossAll - netAll,
    blockMinNotionalUsdc
  };
};

/** Convenience: derive intents from the store's OPEN wraps (planning view of the current book). */
export const intentsFromWraps = (wraps: DemoWrapRecord[]): HedgeIntent[] =>
  wraps
    .filter((w) => (w.status === "active" || w.status === "executing") && w.quote != null && (w.hedge?.contracts ?? 0) > 0)
    .map((w) => ({
      ref: w.id,
      side: w.position.side,
      lots: w.hedge!.contracts!,
      putStrike: w.quote!.putStrike,
      callStrike: w.quote!.callStrike,
      expiryMs: w.vesting?.endMs ?? 0
    }));
