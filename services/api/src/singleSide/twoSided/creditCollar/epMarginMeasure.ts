/**
 * PM MARGIN MEASUREMENT (Phase 3) — the number that recalibrates EVERY cap.
 *
 * The caps module (decision 4) runs on ONE measured input: margin consumed per $1 of wrapped
 * notional under OKX portfolio margin (launch estimate 12%). This module turns OKX's
 * position-builder (what-if margin simulator) and the live account state into that measurement:
 *
 *   builder mode — simulate the two collar legs (long protective, short funding) as ONE portfolio
 *                  and read the netted-spread IMR: zero capital risk, works pre-launch
 *   live mode    — realized IMR across the option book ÷ open wrapped notional: the ground truth
 *                  during the week-one run
 *
 * Output feeds EP_MARGIN_RATE. Both parsers are defensive: an unreadable venue response returns
 * null, never a guessed margin number.
 */

const round4 = (x: number) => +x.toFixed(4);

/**
 * Parse the IMR (USD) out of an OKX position-builder response payload. The endpoint returns one
 * row with portfolio-margin fields; `imr` arrives in USD for cross-margin what-ifs. Null when the
 * shape is not recognizably a margin number.
 */
export const parsePositionBuilderImrUsd = (data: unknown): number | null => {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const imr = Number(row.imr ?? (row.marginRequirement as Record<string, unknown> | undefined)?.imr);
  return Number.isFinite(imr) && imr >= 0 ? imr : null;
};

/** Sum IMR (already USD under PM cross) across live option positions. Null when nothing is readable. */
export const sumLivePositionsImrUsd = (positions: Array<{ instId?: string; imr?: string; mmr?: string }>): number | null => {
  const vals = positions.map((p) => Number(p.imr)).filter((x) => Number.isFinite(x) && x >= 0);
  if (vals.length === 0) return null;
  return round4(vals.reduce((a, b) => a + b, 0));
};

export type MarginMeasurement = {
  mode: "builder" | "live";
  imrUsd: number;
  notionalUsd: number;
  /** THE number: margin per $1 wrapped. Feeds EP_MARGIN_RATE. */
  marginRate: number;
  /** What the book cap becomes at the given capital/headroom with this measured rate. */
  impliedBookCapUsdc: number;
  measuredAtMs: number;
};

/** Turn a measured IMR into the rate + the recalibrated book cap. Null on degenerate inputs. */
export const measureMarginRate = (
  mode: "builder" | "live",
  imrUsd: number,
  notionalUsd: number,
  capitalUsdc: number,
  headroomPct: number,
  nowMs: number
): MarginMeasurement | null => {
  if (!(imrUsd >= 0) || !(notionalUsd > 0)) return null;
  const marginRate = round4(imrUsd / notionalUsd);
  const usable = capitalUsdc * (1 - headroomPct);
  return {
    mode,
    imrUsd: round4(imrUsd),
    notionalUsd: round4(notionalUsd),
    marginRate,
    impliedBookCapUsdc: marginRate > 0 ? +((usable / marginRate).toFixed(2)) : 0,
    measuredAtMs: nowMs
  };
};

export const renderMarginRecommendation = (m: MarginMeasurement, currentRate: number): string =>
  [
    `[margin-probe] ${m.mode} measurement: IMR $${m.imrUsd} on $${m.notionalUsd} wrapped ⟹ margin rate ${(m.marginRate * 100).toFixed(2)}%`,
    `[margin-probe] current EP_MARGIN_RATE=${currentRate} ⟹ ${m.marginRate > currentRate ? "TIGHTEN" : "may relax"}: set EP_MARGIN_RATE=${m.marginRate} (book cap becomes $${m.impliedBookCapUsdc})`,
    `[margin-probe] every cap re-derives from this one number (decision 4) — update the env and restart`
  ].join("\n");
