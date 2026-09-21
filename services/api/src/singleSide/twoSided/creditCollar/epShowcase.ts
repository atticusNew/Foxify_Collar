/**
 * SHOWCASE (watch mode) — live public wallets from Hyperliquid's leaderboard, displayed as
 * "watch it work" chips. Everything here is public data; the service validates candidates
 * against live positions and NEVER allows actions on a showcased address.
 *
 * The leaderboard file is ~36MB of JSON. Parsing it into an object graph would spike memory
 * hundreds of MB on a small instance, so candidates are extracted with a streaming regex over
 * the raw text instead — we only need (address, accountValue) pairs.
 */

export type LeaderboardCandidate = { address: string; accountValueUsd: number; /** traded volume over the last day, USD (absent on the top-N parse) */ dayVolumeUsd?: number };

/** Extract the top-N leaderboard addresses by account value from the RAW leaderboard JSON text. */
export const parseLeaderboardTop = (rawJsonText: string, n: number): LeaderboardCandidate[] => {
  const out: LeaderboardCandidate[] = [];
  const re = /"ethAddress":\s*"(0x[0-9a-fA-F]{40})",\s*"accountValue":\s*"([0-9.eE+-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawJsonText)) !== null) {
    const v = Number(m[2]);
    if (Number.isFinite(v) && v > 0) out.push({ address: m[1].toLowerCase(), accountValueUsd: v });
  }
  return out.sort((a, b) => b.accountValueUsd - a.accountValueUsd).slice(0, Math.max(0, n));
};

/** One wallet on display: the position summary a chip renders. */
export type ShowcaseWallet = { address: string; side: "long" | "short"; szBase: number; notionalUsdc: number };

/** Parse EP_SHOWCASE_ADDRESSES (comma-separated) — a curated override for the leaderboard. */
export const parseShowcaseOverride = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));

// ── Three buckets, longs only, one hero an hour ─────────────────────────────
// The retail landing is a LONG position (the product's home case: a floor under a long, paid
// for). The set holds one live public long per size bucket so the hero varies — small, medium,
// large — and the hour picks which one is up, deterministically, so every visitor in the same
// hour sees the same wallet and a restart changes nothing.

export type SizeBucket = "small" | "medium" | "large";

/** USD bounds of the buckets (half-open; the shadow's size classes use the same lines). */
export const SIZE_BUCKETS: Record<SizeBucket, { minUsd: number; maxUsd: number }> = {
  small: { minUsd: 5_000, maxUsd: 25_000 },
  medium: { minUsd: 25_000, maxUsd: 150_000 },
  large: { minUsd: 150_000, maxUsd: 750_000 },
};
export const BUCKET_ORDER: SizeBucket[] = ["small", "medium", "large"];

/** The bucket a notional falls in, or null when it is outside every band (dust, or a nine-figure whale). */
export const bucketOf = (notionalUsd: number): SizeBucket | null => {
  for (const b of BUCKET_ORDER) {
    const { minUsd, maxUsd } = SIZE_BUCKETS[b];
    if (notionalUsd >= minUsd && notionalUsd < maxUsd) return b;
  }
  return null;
};

export type BucketedWallet = ShowcaseWallet & { bucket: SizeBucket | null };

export interface PickShowcaseOptions {
  /** sides allowed on the landing; default long only */
  sides?: Array<"long" | "short">;
}

/**
 * From candidates (in leaderboard order) keep the first LONG in each bucket, ordered small → large.
 * When no bucket fills at all, the first three in-side positions are the fallback so the landing
 * never goes dark; they carry `bucket: null` and the card says nothing about size.
 */
export function pickShowcaseSet(candidates: ShowcaseWallet[], opts: PickShowcaseOptions = {}): BucketedWallet[] {
  const sides = new Set(opts.sides ?? ["long"]);
  const byBucket = new Map<SizeBucket, BucketedWallet>();
  const fallback: BucketedWallet[] = [];
  for (const w of candidates) {
    if (!sides.has(w.side)) continue;
    const bucket = bucketOf(w.notionalUsdc);
    if (bucket && !byBucket.has(bucket)) byBucket.set(bucket, { ...w, bucket });
    else if (fallback.length < 3) fallback.push({ ...w, bucket: null });
    if (byBucket.size === BUCKET_ORDER.length) break;
  }
  const picked = BUCKET_ORDER.map((b) => byBucket.get(b)).filter((w): w is BucketedWallet => !!w);
  return picked.length > 0 ? picked : fallback;
}

/** Every bucket still missing after a pick (so the scan knows whether to keep reading candidates). */
export const missingBuckets = (set: BucketedWallet[]): SizeBucket[] => BUCKET_ORDER.filter((b) => !set.some((w) => w.bucket === b));

/** Which wallet is the hour's hero: the UTC hour index modulo the set size. */
export const heroIndex = (count: number, nowMs: number): number => (count > 0 ? Math.floor(nowMs / 3_600_000) % count : 0);

/** The top of the next UTC hour: when the hero rotates. */
export const nextRotationIso = (nowMs: number): string => new Date((Math.floor(nowMs / 3_600_000) + 1) * 3_600_000).toISOString();

// ── Finding relatable wallets ────────────────────────────────────────────────
// The top of the leaderboard by account value is whales, and most of them hold no BTC perp at
// all (a live probe: 300 top accounts, 2 in-band longs). Relatable positions live in the middle
// of the table, so each bucket draws its candidates from an ACCOUNT-VALUE band that tends to
// carry positions of that size, in a seeded order that changes by the day and holds within it.

/** Account-value bands whose BTC positions tend to land in each bucket. */
export const ACCOUNT_BANDS_USD: Record<SizeBucket, { minUsd: number; maxUsd: number }> = {
  small: { minUsd: 5_000, maxUsd: 60_000 },
  medium: { minUsd: 30_000, maxUsd: 400_000 },
  large: { minUsd: 200_000, maxUsd: 3_000_000 },
};

/**
 * Every (address, accountValue, day volume) in the raw leaderboard text, unsorted. Same streaming
 * regex as the top-N parse (the file is ~38MB); the day window's volume rides along because an
 * account that traded today is the one likely to be holding a position now (a live probe: 4% of
 * random in-band accounts held BTC; among today's traders it is several times that).
 */
export const parseLeaderboardAll = (rawJsonText: string): LeaderboardCandidate[] => {
  const out: LeaderboardCandidate[] = [];
  const re = /"ethAddress":\s*"(0x[0-9a-fA-F]{40})",\s*"accountValue":\s*"([0-9.eE+-]+)"(?:,\s*"windowPerformances":\s*\[\s*\[\s*"day",\s*\{[^}]*?"vlm":\s*"([0-9.eE+-]+)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawJsonText)) !== null) {
    const v = Number(m[2]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const vlm = m[3] == null ? undefined : Number(m[3]);
    out.push(vlm == null || !Number.isFinite(vlm) ? { address: m[1].toLowerCase(), accountValueUsd: v } : { address: m[1].toLowerCase(), accountValueUsd: v, dayVolumeUsd: vlm });
  }
  return out;
};

const hash32 = (key: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * Up to `n` candidates for a bucket: accounts inside its band that traded today (when the parse
 * carries volume), in an order seeded by `dayKey` (the UTC day), so the scan reads the same
 * wallets all day and different ones tomorrow.
 */
export function candidatesForBucket(all: LeaderboardCandidate[], bucket: SizeBucket, dayKey: string, n: number): string[] {
  const { minUsd, maxUsd } = ACCOUNT_BANDS_USD[bucket];
  return all
    .filter((c) => c.accountValueUsd >= minUsd && c.accountValueUsd < maxUsd && (c.dayVolumeUsd == null || c.dayVolumeUsd > 0))
    .map((c) => ({ c, k: hash32(`${dayKey}:${bucket}:${c.address}`) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, Math.max(0, n))
    .map((x) => x.c.address);
}

/** `2026-09-21`: the candidate order's seed. */
export const dayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);
