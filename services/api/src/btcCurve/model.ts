/**
 * Option-implied probabilities for the ladder buckets.
 *
 * The listed option market (Deribit, BTC inverse options) gives a mark IV per strike
 * per expiry. We interpolate that smile in log-moneyness, price calls under Black-76
 * on the expiry's forward, and read the risk-neutral distribution off the call curve:
 *
 *   P(S_T > K) = −∂C/∂K        (numerically, so the skew is in the digital)
 *   P(A ≤ S_T ≤ B) = P(S_T > A) − P(S_T > B)
 *
 * Horizon mismatch: the venue bucket settles at `settlesAt`; the smile comes from the
 * expiry closest to it. We keep the smile's IV and use the bucket's own time to
 * settlement for T (the usual practice when the exact expiry is not listed).
 *
 * One-touch buckets use the reflection-principle hit probability for a driftless
 * (risk-neutral, zero rate) lognormal with the smile's IV at the barrier. That is a
 * model, not a market, and the report labels it as one.
 *
 * Nothing here is a trading signal. It is the "fair value" column next to two venues'
 * executable prices, so a reader can see where each venue sits relative to the option
 * market and to the other venue.
 */

import type { Bucket, ModelPoint, OptionRow } from "./types";

const SQRT2 = Math.SQRT2;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |err| < 1.5e-7). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x) / SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = x >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/** Black-76 call on forward F, zero rate (price in units of the numeraire = USD). */
export function black76Call(F: number, K: number, iv: number, T: number): number {
  if (T <= 0 || iv <= 0) return Math.max(F - K, 0);
  const s = iv * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * s * s) / s;
  const d2 = d1 - s;
  return F * normCdf(d1) - K * normCdf(d2);
}

export interface Smile {
  expiry: string;
  expiryMs: number;
  forward: number;
  /** sorted by strike; iv decimal per year */
  points: Array<{ strike: number; iv: number }>;
}

/**
 * One smile per expiry from the chain rows. Per strike we take the IV of the
 * out-of-the-money side (the liquid one): puts below the forward, calls above.
 */
export function buildSmiles(rows: OptionRow[]): Smile[] {
  const byExpiry = new Map<string, OptionRow[]>();
  for (const r of rows) {
    if (!(r.markIv > 0) || !(r.forward > 0) || !(r.strike > 0)) continue;
    const list = byExpiry.get(r.expiry) ?? [];
    list.push(r);
    byExpiry.set(r.expiry, list);
  }
  const smiles: Smile[] = [];
  for (const [expiry, list] of byExpiry) {
    const forward = list[0].forward;
    const byStrike = new Map<number, { put?: number; call?: number }>();
    for (const r of list) {
      const e = byStrike.get(r.strike) ?? {};
      if (r.type === "P") e.put = r.markIv;
      else e.call = r.markIv;
      byStrike.set(r.strike, e);
    }
    const points: Smile["points"] = [];
    for (const [strike, e] of byStrike) {
      const otm = strike < forward ? e.put ?? e.call : e.call ?? e.put;
      if (otm && otm > 0) points.push({ strike, iv: otm });
    }
    points.sort((a, b) => a.strike - b.strike);
    if (points.length >= 3) smiles.push({ expiry, expiryMs: list[0].expiryMs, forward, points });
  }
  return smiles.sort((a, b) => a.expiryMs - b.expiryMs);
}

/** IV at any strike: linear in log-moneyness between listed strikes, flat beyond the wings. */
export function ivAt(smile: Smile, strike: number): number {
  const pts = smile.points;
  if (strike <= pts[0].strike) return pts[0].iv;
  const last = pts[pts.length - 1];
  if (strike >= last.strike) return last.iv;
  const x = Math.log(strike);
  for (let i = 1; i < pts.length; i += 1) {
    if (strike <= pts[i].strike) {
      const x0 = Math.log(pts[i - 1].strike);
      const x1 = Math.log(pts[i].strike);
      const w = (x - x0) / (x1 - x0);
      return pts[i - 1].iv * (1 - w) + pts[i].iv * w;
    }
  }
  return last.iv;
}

/** The smile whose expiry is nearest the settlement instant. */
export function nearestSmile(smiles: Smile[], settlesAtMs: number): Smile | null {
  let best: Smile | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of smiles) {
    const d = Math.abs(s.expiryMs - settlesAtMs);
    if (d < bestDiff) {
      best = s;
      bestDiff = d;
    }
  }
  return best;
}

/**
 * P(S_T > K) with the smile in the digital: −∂C/∂K by central difference. The step h is
 * capped at a fifth of one standard deviation of the terminal move, so that minutes before
 * a close (when the digital is nearly a step) the difference quotient does not smear it.
 */
export function probAbove(smile: Smile, K: number, T: number): number {
  if (T <= 0) return smile.forward > K ? 1 : 0;
  const sT = ivAt(smile, K) * Math.sqrt(T);
  const h = Math.max(1, Math.min(K * 0.0025, 0.2 * K * sT));
  const call = (k: number) => black76Call(smile.forward, k, ivAt(smile, k), T);
  const p = -(call(K + h) - call(K - h)) / (2 * h);
  return Math.min(1, Math.max(0, p));
}

/**
 * P(max S_t ≥ H before T) for a driftless lognormal with vol σ (reflection principle;
 * with the −σ²/2 Itô drift the exact GBM form is used). For a down barrier mirror S and H.
 */
export function probTouch(forward: number, H: number, iv: number, T: number, up: boolean): number {
  if (T <= 0 || iv <= 0) return up ? (forward >= H ? 1 : 0) : forward <= H ? 1 : 0;
  if (up && forward >= H) return 1;
  if (!up && forward <= H) return 1;
  const s = iv * Math.sqrt(T);
  // Work in the "up" frame: for a down barrier mirror log S, which flips the Itô drift's sign.
  const h = up ? Math.log(H / forward) : Math.log(forward / H); // > 0
  const mu = up ? -0.5 * iv * iv : 0.5 * iv * iv;
  const a = normCdf((-h + mu * T) / s);
  const b = Math.exp((2 * mu * h) / (iv * iv)) * normCdf((-h - mu * T) / s);
  return Math.min(1, Math.max(0, a + b));
}

/** Model point for one bucket, or null when there is no usable smile. */
export function modelBucket(smiles: Smile[], bucket: Bucket, nowMs: number): ModelPoint | null {
  const settlesMs = Date.parse(bucket.settlesAt);
  if (!Number.isFinite(settlesMs)) return null;
  const smile = nearestSmile(smiles, settlesMs);
  if (!smile) return null;
  const T = Math.max(0, (settlesMs - nowMs) / (365.25 * 86_400_000));
  switch (bucket.kind) {
    case "range": {
      if (bucket.lower === undefined || bucket.upper === undefined) return null;
      const p = probAbove(smile, bucket.lower, T) - probAbove(smile, bucket.upper, T);
      return { p: Math.max(0, p), expiry: smile.expiry, iv: ivAt(smile, (bucket.lower + bucket.upper) / 2) };
    }
    case "above": {
      if (bucket.level === undefined) return null;
      return { p: probAbove(smile, bucket.level, T), expiry: smile.expiry, iv: ivAt(smile, bucket.level) };
    }
    case "below": {
      if (bucket.level === undefined) return null;
      return { p: 1 - probAbove(smile, bucket.level, T), expiry: smile.expiry, iv: ivAt(smile, bucket.level) };
    }
    case "touch_up":
    case "touch_down": {
      if (bucket.level === undefined) return null;
      const iv = ivAt(smile, bucket.level);
      const p = probTouch(smile.forward, bucket.level, iv, T, bucket.kind === "touch_up");
      return { p, expiry: smile.expiry, iv };
    }
    default:
      return null;
  }
}

/** Sensitivity of P(S_T > K) to spot, per $1 of spot (for the cost-of-latency table). */
export function digitalDelta(smile: Smile, K: number, T: number): number {
  const sT = ivAt(smile, K) * Math.sqrt(Math.max(T, 0));
  const dS = Math.max(1, Math.min(smile.forward * 0.0005, 0.1 * smile.forward * sT));
  const up: Smile = { ...smile, forward: smile.forward + dS };
  const dn: Smile = { ...smile, forward: smile.forward - dS };
  return (probAbove(up, K, T) - probAbove(dn, K, T)) / (2 * dS);
}
