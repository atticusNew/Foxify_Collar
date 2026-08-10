/**
 * Partner signal OUTBOX — transport-agnostic. Every signal the platform owes the partner's bot is
 * appended here (append-only JSONL); the delivery skin — the partner polling our authenticated
 * endpoint, or a webhook push to their bot — reads from this store and is decided separately
 * (pending the partner-CTO transport call). The FLOW does not change with the transport:
 *
 *   day_signal    → the day's intent (CALM pair · ELEVATED directional proposal · no-open notice)
 *   green_light   → hedge FILLED at the venue; final terms attached; partner opens perps NOW
 *   close_signal  → watcher-permitted unwind EXECUTED; partner closes the perp within the SLA
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";
import type { PerpSide } from "../creditCollarPricer";

export const DEFAULT_PARTNER_SIGNAL_PATH = process.env.LIVE_PARTNER_SIGNAL_PATH ?? "./logs/live-partner-signals.jsonl";

export type PartnerSignal =
  | {
      kind: "day_signal";
      tsMs: number;
      dayUtc: string;
      regime: "calm" | "elevated" | "halt";
      /** pair = confirm to open the matched pair · directional_proposal = take/pass (side yours) · no_open = notice only. */
      intent: "pair" | "directional_proposal" | "no_open";
      trendSide: PerpSide | null; // our trend read on elevated days (partner may override)
    }
  | {
      kind: "green_light";
      tsMs: number;
      dayUtc: string;
      positions: Array<{ ref: string; side: PerpSide; notionalUsdc: number; putStrike: number; callStrike: number; creditUsdc: number; expiresAtMs: number }>;
    }
  | {
      kind: "close_signal";
      tsMs: number;
      ref: string;
      side: PerpSide;
      barrier: "floor" | "ceiling";
      barrierPriceUsd: number;
      vestedCreditUsdc: number;
    };

export const appendPartnerSignal = (sig: PartnerSignal, path = DEFAULT_PARTNER_SIGNAL_PATH): void => {
  try {
    appendFileSync(resolveWritablePath(path), JSON.stringify(sig) + "\n", "utf8");
  } catch (e) {
    console.error(`[partner-signal] append failed: ${(e as Error).message}`);
  }
};

export const loadPartnerSignals = (path = DEFAULT_PARTNER_SIGNAL_PATH): PartnerSignal[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: PartnerSignal[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PartnerSignal);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
};

/** Has a day_signal already been emitted for this day? (The outbox emits ONE ask per day, not 96.) */
export const daySignalEmitted = (dayUtc: string, path = DEFAULT_PARTNER_SIGNAL_PATH): boolean =>
  loadPartnerSignals(path).some((s) => s.kind === "day_signal" && s.dayUtc === dayUtc);
