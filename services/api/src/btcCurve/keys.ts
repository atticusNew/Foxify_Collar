/**
 * Bucket keys shared by the venue readers so same-bounds buckets line up.
 * Thresholds normalise to the inclusive side: "strictly above 149,999.99" and
 * "at or above 150,000" are the same contract and both get `above:150000`.
 */

export function aboveKey(level: number, inclusive: boolean): string {
  const t = inclusive ? level : Math.round((level + 0.01) * 100) / 100;
  return `above:${t}`;
}

export function belowKey(level: number, inclusive: boolean): string {
  const t = inclusive ? level : Math.round((level - 0.01) * 100) / 100;
  return `below:${t}`;
}

/** Inclusive threshold back out of a key (the number after the colon). */
export function keyLevel(key: string): number {
  const n = Number(key.split(":")[1]?.split("-")[0]);
  return Number.isFinite(n) ? n : 0;
}
