/**
 * SHOWCASE (watch mode) — live public wallets from Hyperliquid's leaderboard, displayed as
 * "watch it work" chips. Everything here is public data; the service validates candidates
 * against live positions and NEVER allows actions on a showcased address.
 *
 * The leaderboard file is ~36MB of JSON. Parsing it into an object graph would spike memory
 * hundreds of MB on a small instance, so candidates are extracted with a streaming regex over
 * the raw text instead — we only need (address, accountValue) pairs.
 */

export type LeaderboardCandidate = { address: string; accountValueUsd: number };

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
