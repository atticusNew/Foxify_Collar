/**
 * Smile model fit (PR C1).
 *
 * Fits a polynomial to Deribit mark_iv across multiple strikes to enable
 * accurate IV at ANY strike (not just the anchored ones). Captures the BTC
 * put-skew dynamic — puts are richer than equivalent-moneyness calls.
 *
 * Model: quadratic in log-moneyness k = log(strike / spot).
 *   iv(k) = a0 + a1·k + a2·k²
 *
 * Pure functions — no I/O. Caller provides observation samples.
 */

export type SmileObservation = {
  strike: number;
  ivAnnual: number; // mark_iv decimal (e.g. 0.30 for 30%)
};

export type SmileFit = {
  a0: number;      // ATM-ish IV (k=0)
  a1: number;      // skew (linear term)
  a2: number;      // smile curvature (quadratic)
  spot: number;
  rSquared: number;
  observationCount: number;
};

/** Simple least-squares quadratic fit. Returns null if <3 observations. */
export const fitSmile = (observations: SmileObservation[], spot: number): SmileFit | null => {
  if (observations.length < 3) return null;
  const valid = observations.filter((o) => o.strike > 0 && o.ivAnnual > 0 && Number.isFinite(o.ivAnnual));
  if (valid.length < 3) return null;

  // Build design matrix X = [[1, k, k²], ...] and y = [iv, ...]
  const ks = valid.map((o) => Math.log(o.strike / spot));
  const ys = valid.map((o) => o.ivAnnual);
  const n = valid.length;

  // Sums for normal equations
  let sk0 = 0, sk1 = 0, sk2 = 0, sk3 = 0, sk4 = 0;
  let sy0 = 0, sy1 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    const k = ks[i];
    const y = ys[i];
    sk0 += 1; sk1 += k; sk2 += k*k; sk3 += k*k*k; sk4 += k*k*k*k;
    sy0 += y; sy1 += y*k; sy2 += y*k*k;
  }

  // Normal equations matrix:
  //   [sk0 sk1 sk2] [a0]   [sy0]
  //   [sk1 sk2 sk3] [a1] = [sy1]
  //   [sk2 sk3 sk4] [a2]   [sy2]
  const A = [
    [sk0, sk1, sk2],
    [sk1, sk2, sk3],
    [sk2, sk3, sk4]
  ];
  const b = [sy0, sy1, sy2];
  const coefs = solve3x3(A, b);
  if (!coefs) return null;
  const [a0, a1, a2] = coefs;

  // Compute R²
  const yMean = sy0 / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yHat = a0 + a1 * ks[i] + a2 * ks[i] * ks[i];
    ssRes += (ys[i] - yHat) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  const rSquared = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;

  return { a0, a1, a2, spot, rSquared, observationCount: n };
};

/** Evaluate the fitted smile at any strike. Returns null if fit invalid. */
export const evaluateSmile = (fit: SmileFit | null, strike: number): number | null => {
  if (!fit) return null;
  const k = Math.log(strike / fit.spot);
  const iv = fit.a0 + fit.a1 * k + fit.a2 * k * k;
  return iv > 0 && iv < 5 ? iv : null; // sanity range
};

/** Fallback: flat smile at single observation. */
export const flatSmile = (ivAnnual: number, spot: number): SmileFit => ({
  a0: ivAnnual,
  a1: 0,
  a2: 0,
  spot,
  rSquared: 0,
  observationCount: 1
});

/** Bid-ask spread model — captures venue microstructure cost. */
export type SpreadObservation = {
  strike: number;
  optionType: "put" | "call";
  bidUsdcPerBtc: number;
  askUsdcPerBtc: number;
  midUsdcPerBtc: number;
};

export const spreadAsPct = (obs: SpreadObservation): number => {
  if (obs.midUsdcPerBtc <= 0) return 0;
  return (obs.askUsdcPerBtc - obs.bidUsdcPerBtc) / obs.midUsdcPerBtc;
};

// ────── 3x3 linear solver (Gauss-Jordan) ──────

const solve3x3 = (A: number[][], b: number[]): [number, number, number] | null => {
  const m = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]]
  ];
  for (let i = 0; i < 3; i++) {
    // Find pivot
    let maxRow = i;
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(m[j][i]) > Math.abs(m[maxRow][i])) maxRow = j;
    }
    [m[i], m[maxRow]] = [m[maxRow], m[i]];
    const pivot = m[i][i];
    if (Math.abs(pivot) < 1e-12) return null; // singular
    for (let j = 0; j < 4; j++) m[i][j] /= pivot;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const factor = m[k][i];
      for (let j = 0; j < 4; j++) m[k][j] -= factor * m[i][j];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
};
