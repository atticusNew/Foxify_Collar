/**
 * Strike Selector — port of kal_v3_demo/services/hedging/strike_selector.py.
 *
 * In the live demo, this selects from the actual Deribit/OKX option chain
 * (only strikes with bid > 0 and ask > 0). In this backtest we don't have
 * historical chain snapshots, so we synthesize a chain by quantizing strikes
 * to typical Deribit BTC option granularity:
 *
 *   $1k strikes for short-dated weekly options (≤ 14 DTE)
 *   $5k strikes for monthly options
 *
 * This is a backtest approximation. When the demo's live chain is wired
 * up to the backtest (Phase 3), this synthetic generator is replaced by
 * the real chain pull and the rest of this module is unchanged.
 *
 * SPECIFICATION (from demo, applied identically):
 *   For "loss above barrier" (need CALL spread):
 *     instrument=call: pick first two call strikes ≥ barrier
 *   For "loss below barrier" (need PUT spread):
 *     instrument=put:  pick two highest put strikes ≤ barrier (returned low→high)
 *
 * Offset ladder (0..7) widens the spread when the narrowest spread fails
 * a downstream economic-validity check. Same ladder as the demo:
 *   0 → adjacent (narrowest)
 *   1 → next adjacent
 *   2 → skip one (1×wider)
 *   3 → skip two
 *   ...
 *   7 → first to last (widest available)
 */

export type SyntheticChain = {
  strikes: number[];          // sorted ascending, in USD
  expiryDays: number;
};

/**
 * Generate a synthetic Deribit-style strike ladder around `spot`.
 * Returns strikes spaced at `gridStepUsd` USD over a [-50%, +100%] window.
 */
export function buildSyntheticChain(spot: number, expiryDays: number): SyntheticChain {
  const gridStepUsd = expiryDays <= 14 ? 1_000 : 5_000;
  const lo = Math.max(gridStepUsd, Math.floor((spot * 0.5) / gridStepUsd) * gridStepUsd);
  const hi = Math.ceil((spot * 2.0) / gridStepUsd) * gridStepUsd;
  const strikes: number[] = [];
  for (let k = lo; k <= hi; k += gridStepUsd) strikes.push(k);
  return { strikes, expiryDays };
}

/**
 * Find first two strikes ≥ barrier with optional offset (call-spread case).
 * Returns [K_long, K_short] with K_long < K_short.
 */
export function findCallSpreadStrikes(
  chain: SyntheticChain,
  barrier: number,
  offset = 0,
): { K_long: number; K_short: number } | null {
  const above = chain.strikes.filter(s => s >= barrier);
  if (above.length < 2) return null;
  return pickOffsetPair(above, offset, /*reverse=*/ false);
}

/**
 * Find two highest strikes ≤ barrier with optional offset (put-spread case).
 * Returns [K_long, K_short] with K_long > K_short (long the higher-strike put).
 */
export function findPutSpreadStrikes(
  chain: SyntheticChain,
  barrier: number,
  offset = 0,
): { K_long: number; K_short: number } | null {
  const below = chain.strikes.filter(s => s <= barrier);
  if (below.length < 2) return null;
  // Use the offset ladder on the *reversed* (highest-first) list, then map back.
  const reversed = [...below].reverse(); // highest-first
  const pair = pickOffsetPair(reversed, offset, /*reverse=*/ false);
  if (!pair) return null;
  // For puts, K_long is the higher strike, K_short the lower.
  // pickOffsetPair returns (first, second); on reversed-list those are
  // (highest, second-highest) when offset=0 — that's exactly K_long > K_short.
  return { K_long: pair.K_long, K_short: pair.K_short };
}

/**
 * Helper: from an ordered list, pick two strikes per the demo's offset ladder.
 * Returns the pair as { K_long, K_short } where K_long is the first selected.
 */
function pickOffsetPair(
  ordered: number[],
  offset: number,
  reverse: boolean,
): { K_long: number; K_short: number } | null {
  // Each offset step yields a different (i, j) index pair.
  // Spec from demo (paraphrased):
  //   0 → (0, 1)        narrowest adjacent
  //   1 → (1, 2)        next adjacent
  //   2 → (0, 2)        skip one
  //   3 → (0, 3)        skip two
  //   4 → (0, 4)        skip three
  //   5 → (0, 5)
  //   6 → (0, 6) or fall through to (0, last)
  //   7 → (0, last)     widest available
  const n = ordered.length;
  let i: number, j: number;
  switch (offset) {
    case 0: i = 0; j = 1; break;
    case 1: i = 1; j = 2; break;
    case 2: i = 0; j = 2; break;
    case 3: i = 0; j = 3; break;
    case 4: i = 0; j = 4; break;
    case 5: i = 0; j = 5; break;
    case 6: i = 0; j = Math.min(6, n - 1); break;
    case 7: i = 0; j = n - 1; break;
    default:
      if (offset + 1 < n) { i = offset; j = offset + 1; }
      else { i = 0; j = n - 1; }
  }
  if (j >= n || i === j) return null;
  const a = ordered[i];
  const b = ordered[j];
  return reverse ? { K_long: b, K_short: a } : { K_long: a, K_short: b };
}
