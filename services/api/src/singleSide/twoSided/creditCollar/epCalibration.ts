/**
 * CREDIT CALIBRATION (Phase 3 gate) — measure realized per-lot credit before ANYTHING is promised.
 *
 * Approved rule: live fills to date came in far below theory (1-lot minimums, thin weekend strikes,
 * tick floor), so trader-facing credit expectations may be published ONLY after a full week of
 * market hours has been measured. This module turns the wrap store into that measurement: realized
 * per-lot gross credit bucketed by UTC hour, by cap distance, and by execution lane — plus an
 * explicit publish gate that says NOT ENOUGH DATA until the coverage bar is met.
 */

import type { DemoWrapRecord } from "./demoWrap";

const round4 = (x: number) => +x.toFixed(4);

export type CalibrationSample = {
  wrapId: string;
  tsMs: number;
  hourUtc: number;
  lane: string; // paper | okx_demo | okx_live
  lots: number;
  grossCreditUsdc: number;
  perLotUsdc: number;
  capDistancePct: number; // sold-wing distance from spot at quote time
  conclusion: string; // active|expiry|knockout|early_close|failed (status-derived)
};

/** Extract one measurable sample per wrap that actually PRICED (quote + hedge lots present). */
export const calibrationSamples = (wraps: DemoWrapRecord[]): CalibrationSample[] =>
  wraps
    .filter((w) => w.quote != null && w.hedge?.contracts != null && w.hedge.contracts > 0)
    .map((w) => {
      const gross = w.economics?.grossCreditUsdc ?? w.hedge?.netCreditUsdc ?? w.quote!.creditUsdc;
      const lots = w.hedge!.contracts!;
      const conclusion =
        w.status === "knocked_out"
          ? "knockout"
          : w.status === "concluded"
            ? w.concludedAtMs != null && w.vesting != null && w.concludedAtMs >= w.vesting.endMs
              ? "expiry"
              : "early_close"
            : w.status;
      return {
        wrapId: w.id,
        tsMs: w.createdAtMs,
        hourUtc: new Date(w.createdAtMs).getUTCHours(),
        lane: w.hedge!.mode,
        lots,
        grossCreditUsdc: gross,
        perLotUsdc: round4(gross / lots),
        capDistancePct: round4(w.quote!.capPct),
        conclusion
      };
    });

export type BucketStats = { n: number; meanUsdc: number; medianUsdc: number; minUsdc: number; maxUsdc: number };

const stats = (xs: number[]): BucketStats => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, meanUsdc: round4(mean), medianUsdc: round4(median), minUsdc: round4(s[0]), maxUsdc: round4(s[s.length - 1]) };
};

const groupBy = <K extends string | number>(samples: CalibrationSample[], key: (s: CalibrationSample) => K): Record<string, BucketStats> => {
  const groups = new Map<K, number[]>();
  for (const s of samples) {
    const k = key(s);
    groups.set(k, [...(groups.get(k) ?? []), s.perLotUsdc]);
  }
  return Object.fromEntries([...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en", { numeric: true })).map(([k, v]) => [String(k), stats(v)]));
};

/** Cap-distance bucket label in 0.25% steps ("1.50–1.75%"). */
export const capDistanceBucket = (capPct: number): string => {
  const lo = Math.floor(capPct / 0.0025) * 0.25;
  return `${lo.toFixed(2)}–${(lo + 0.25).toFixed(2)}%`;
};

export type PublishGateConfig = {
  /** Live-lane samples required (EP_CALIBRATION_MIN_WRAPS, default 30). */
  minLiveWraps: number;
  /** Distinct UTC hours that must be covered (EP_CALIBRATION_MIN_HOURS, default 18). */
  minDistinctHours: number;
  /** Measurement window that must be spanned (EP_CALIBRATION_MIN_SPAN_MS, default 7 days). */
  minSpanMs: number;
};

export const parsePublishGateFromEnv = (env: Record<string, string | undefined>): PublishGateConfig => {
  const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minLiveWraps: num(env.EP_CALIBRATION_MIN_WRAPS, 30),
    minDistinctHours: num(env.EP_CALIBRATION_MIN_HOURS, 18),
    minSpanMs: num(env.EP_CALIBRATION_MIN_SPAN_MS, 7 * 86_400_000)
  };
};

export type CalibrationReport = {
  generatedAtMs: number;
  totalSamples: number;
  liveSamples: number;
  overall: BucketStats | null;
  liveOverall: BucketStats | null;
  byLane: Record<string, BucketStats>;
  byHourUtc: Record<string, BucketStats>;
  byCapDistance: Record<string, BucketStats>;
  byConclusion: Record<string, BucketStats>;
  publishGate: { passed: boolean; reasons: string[] };
};

/**
 * Build the full report. The publish gate ONLY counts okx_live samples — paper and demo lanes
 * inform shape, never a promise to a trader.
 */
export const buildCalibrationReport = (wraps: DemoWrapRecord[], gate: PublishGateConfig, nowMs: number): CalibrationReport => {
  const samples = calibrationSamples(wraps);
  const live = samples.filter((s) => s.lane === "okx_live");
  const reasons: string[] = [];
  if (live.length < gate.minLiveWraps) reasons.push(`only ${live.length}/${gate.minLiveWraps} live wraps measured`);
  const hours = new Set(live.map((s) => s.hourUtc));
  if (hours.size < gate.minDistinctHours) reasons.push(`only ${hours.size}/${gate.minDistinctHours} distinct market hours covered`);
  const span = live.length ? Math.max(...live.map((s) => s.tsMs)) - Math.min(...live.map((s) => s.tsMs)) : 0;
  if (span < gate.minSpanMs) reasons.push(`measurement span ${(span / 86_400_000).toFixed(1)}d < ${(gate.minSpanMs / 86_400_000).toFixed(0)}d`);
  return {
    generatedAtMs: nowMs,
    totalSamples: samples.length,
    liveSamples: live.length,
    overall: samples.length ? stats(samples.map((s) => s.perLotUsdc)) : null,
    liveOverall: live.length ? stats(live.map((s) => s.perLotUsdc)) : null,
    byLane: groupBy(samples, (s) => s.lane),
    byHourUtc: groupBy(samples, (s) => `${String(s.hourUtc).padStart(2, "0")}:00`),
    byCapDistance: groupBy(samples, (s) => capDistanceBucket(s.capDistancePct)),
    byConclusion: groupBy(samples, (s) => s.conclusion),
    publishGate: { passed: reasons.length === 0, reasons }
  };
};

const table = (title: string, rows: Record<string, BucketStats>): string =>
  [
    `### ${title}`,
    "",
    "| bucket | n | mean $/lot | median $/lot | min | max |",
    "|---|---|---|---|---|---|",
    ...Object.entries(rows).map(([k, s]) => `| ${k} | ${s.n} | ${s.meanUsdc} | ${s.medianUsdc} | ${s.minUsdc} | ${s.maxUsdc} |`),
    ""
  ].join("\n");

export const renderCalibrationMarkdown = (r: CalibrationReport): string =>
  [
    "# Earn & Protect — credit calibration report",
    "",
    `Generated ${new Date(r.generatedAtMs).toISOString()} · ${r.totalSamples} priced wraps (${r.liveSamples} live)`,
    "",
    r.publishGate.passed
      ? `**PUBLISH GATE: PASSED** — live per-lot credit: mean $${r.liveOverall?.meanUsdc}, median $${r.liveOverall?.medianUsdc} (n=${r.liveSamples}). Trader-facing expectations may cite these numbers.`
      : `**PUBLISH GATE: NOT ENOUGH DATA — do not publish credit expectations.** ${r.publishGate.reasons.join("; ")}. Interim copy stays: "typically cents to a few dollars per day, paid daily, scaling with size and volatility."`,
    "",
    table("By execution lane", r.byLane),
    table("By UTC hour (wrap open)", r.byHourUtc),
    table("By cap distance (sold wing % from spot)", r.byCapDistance),
    table("By conclusion", r.byConclusion)
  ].join("\n");
