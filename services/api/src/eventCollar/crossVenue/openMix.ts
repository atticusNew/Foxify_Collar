/**
 * OPEN MIX — keeps the track record from becoming a crypto record.
 *
 * The scanner admits at most two crypto rows per scan, but Kalshi's crypto strike markets roll
 * over every hour while a game keeps one ticker all day. Opening one position per ticker, ever,
 * therefore fills the book with Bitcoin and Ethereum strikes (three of every four opens on the
 * first book). That is the scanner's liquidity ranking showing, not what a user of a prediction
 * market would protect.
 *
 * The rule: over a trailing window, crypto may be at most `cryptoShareMax` of what was opened,
 * with an allowance of `cryptoFloorPerDay` opens so an overnight book with no games still records
 * something. A crypto row that would breach the share is skipped, not refused: its quote was
 * sound, the book just has enough of its kind. If the ticker is still quotable on a later scan
 * and the share has room, it opens then.
 */

export interface OpenMixRule {
  /** ceiling on crypto's share of opens inside the window, 0..1 */
  cryptoShareMax: number;
  /** crypto opens allowed inside the window regardless of share */
  cryptoFloorPerDay: number;
  /** trailing window the share is measured over, ms */
  windowMs: number;
}

export const DEFAULT_OPEN_MIX: OpenMixRule = {
  cryptoShareMax: 0.5,
  cryptoFloorPerDay: 4,
  windowMs: 24 * 3_600_000,
};

export function openMixRuleFromEnv(env: NodeJS.ProcessEnv): OpenMixRule {
  const num = (v: string | undefined, dflt: number, lo: number, hi: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    cryptoShareMax: num(env.EVENT_SHADOW_CRYPTO_SHARE_MAX, DEFAULT_OPEN_MIX.cryptoShareMax, 0, 1),
    cryptoFloorPerDay: Math.round(num(env.EVENT_SHADOW_CRYPTO_FLOOR_PER_DAY, DEFAULT_OPEN_MIX.cryptoFloorPerDay, 0, 1_000)),
    windowMs: DEFAULT_OPEN_MIX.windowMs,
  };
}

export interface OpenMixDecision {
  allowed: boolean;
  cryptoInWindow: number;
  totalInWindow: number;
}

/** Would opening one more crypto position now keep the window inside the rule? */
export function cryptoOpenAllowed(
  opened: ReadonlyArray<{ kind: "sports" | "crypto"; at: string }>,
  nowMs: number,
  rule: OpenMixRule = DEFAULT_OPEN_MIX,
): OpenMixDecision {
  const since = nowMs - rule.windowMs;
  let cryptoInWindow = 0;
  let totalInWindow = 0;
  for (const p of opened) {
    const t = Date.parse(p.at);
    if (!Number.isFinite(t) || t < since || t > nowMs) continue;
    totalInWindow += 1;
    if (p.kind === "crypto") cryptoInWindow += 1;
  }
  const underFloor = cryptoInWindow < rule.cryptoFloorPerDay;
  const underShare = cryptoInWindow + 1 <= rule.cryptoShareMax * (totalInWindow + 1);
  return { allowed: underFloor || underShare, cryptoInWindow, totalInWindow };
}
