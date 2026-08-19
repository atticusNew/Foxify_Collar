/**
 * EARN & PROTECT TELEGRAM BOT — pure logic (decision 8, second thin client).
 *
 * Everything money- or copy-relevant lives here, testable without a network: command parsing,
 * inline keyboards, honest refusal copy, and the cycle-event differ that turns state polls into
 * push notifications ("Credit paid: $2.10", "Cap touched — protection re-armed", …). The runner
 * script (scripts/earnProtectTelegramBot.ts) only moves JSON between Telegram and the local API.
 */

const fmt$ = (x: number | null | undefined): string => (x == null ? "—" : `${x < 0 ? "−$" : "$"}${Math.abs(x).toFixed(2)}`);

// ── Command parsing ───────────────────────────────────────────────────────────

export type BotCommand =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "positions" }
  | { kind: "status" }
  | { kind: "address"; address: string }
  | { kind: "unknown"; text: string };

export const parseBotMessage = (text: string): BotCommand => {
  const t = (text ?? "").trim();
  if (/^\/start\b/i.test(t)) return { kind: "start" };
  if (/^\/help\b/i.test(t)) return { kind: "help" };
  if (/^\/positions\b/i.test(t)) return { kind: "positions" };
  if (/^\/status\b/i.test(t)) return { kind: "status" };
  const addr = t.match(/^(0x[0-9a-fA-F]{40})$/);
  if (addr) return { kind: "address", address: addr[1] };
  return { kind: "unknown", text: t };
};

export const WELCOME_TEXT = [
  "*Atticus — Earn & Protect*",
  "",
  "One toggle puts a hard floor under your Hyperliquid position — and PAYS you a credit, funded by the live options market.",
  "",
  "Paste your Hyperliquid address (0x…) to begin. We only *read* positions — no signing, no deposits, no keys.",
  "",
  "Credits vest through each daily cycle and pay at its close. If price touches your cap, the cycle ends: you keep every gain to the cap plus the vested credit, and protection re-arms while the toggle stays on."
].join("\n");

export const HELP_TEXT = [
  "*Commands*",
  "`0x…` — connect your Hyperliquid address (read-only)",
  "/positions — your open positions with protect buttons",
  "/status — current protection + payout history",
  "",
  "Protection is honest: when the market can't fund a credit, we refuse and say why."
].join("\n");

// ── Honest refusal copy (same rules as the web chip; Markdown-safe) ───────────

export const humanRefusal = (raw: string | null | undefined): string => {
  const s = String(raw ?? "");
  const cd = s.match(/cooldown[^0-9]*(\d+)s/i);
  if (cd) return `Next wrap in ${cd[1]}s`;
  if (/50\d{3}|51\d{3}|OK-ACCESS|API key|passphrase|network error|position_read_failed/i.test(s)) return "Our issue, not yours · nothing opened";
  if (/listed_credit_nonpositive|listed_book_empty|credit_infeasible|not_priceable|no executable/i.test(s)) return "No honest credit right now · nothing opened";
  if (/aborted_no_fill|aborted_unwound|pair unwound|did not fill|hedge_not_filled/i.test(s)) return "Couldn't fill at our quote · nothing opened";
  if (/minimum one lot|0\.01 BTC lots|below_min_lot/i.test(s)) return "Below the 0.01 BTC minimum";
  if (/waitlist|founding cohort/i.test(s)) return "Founding cohort full · you're on the waitlist";
  if (/capacity.*in use|wallet_cap/i.test(s)) return "Your capacity is in use this cycle";
  if (/strike_concentration|already carries|unwindable|strike.*concentration/i.test(s)) return "That strike is crowded · try again shortly";
  if (/quota reached/i.test(s)) return "Daily limit reached";
  if (/hard cap|book notional cap|book is full/i.test(s)) return "Above the current cap · nothing opened";
  if (/already active|in flight|in_flight|being processed/i.test(s)) return "Already protected";
  if (/no open .* position|no live position|no_position/i.test(s)) return "No open position to protect";
  if (/allow-list|account_refused|not an address/i.test(s)) return "Account not enabled yet";
  if (/kill switch|demo disabled|paused/i.test(s)) return "Protection paused";
  return "Couldn't complete · nothing opened";
};

// ── Inline keyboards ──────────────────────────────────────────────────────────

export type BotPosition = { coin: string; side: string; szBase: number; notionalUsdc: number; wrappable: boolean };
export type InlineButton = { text: string; callback_data: string };

/**
 * One row per position: wrappable coins get the protect/unprotect action; others a disabled note.
 * callback_data is `wrap` | `close` (the API is account-scoped — the chat's stored address).
 */
export const positionsKeyboard = (positions: BotPosition[], protectionOn: boolean): InlineButton[][] =>
  positions
    .filter((p) => p.wrappable)
    .map((p) => [
      protectionOn
        ? { text: `✋ Unprotect ${p.side.toUpperCase()} ${p.szBase} ${p.coin} (keep vested)`, callback_data: "close" }
        : { text: `🛡 Earn & Protect ${p.side.toUpperCase()} ${p.szBase} ${p.coin} (${fmt$(p.notionalUsdc)})`, callback_data: "wrap" }
    ]);

export const positionsText = (positions: BotPosition[]): string => {
  if (positions.length === 0) return "No open perp positions on this address.";
  return [
    "*Your positions*",
    ...positions.map(
      (p) => `${p.side.toUpperCase()} ${p.szBase} ${p.coin} · ${fmt$(p.notionalUsdc)}${p.wrappable ? "" : " · protection coming soon"}`
    )
  ].join("\n");
};

// ── Cycle-event differ (state poll → push notifications) ─────────────────────

export type ChatSnapshot = {
  /** wrapId → last seen status. */
  wrapStatuses: Record<string, string>;
  /** payout ids already announced as paid. */
  announcedPayoutIds: string[];
};

export type EpStateWrap = {
  id: string;
  status: string;
  failReason?: string | null;
  quote?: { creditUsdc: number; floorStrike?: number; capStrike?: number; putStrike: number; callStrike: number } | null;
  knockout?: { capStrike: number; markPx: number } | null;
  vestingStatus?: { vestedUsdc: number; fullCreditUsdc: number; fullyVested: boolean } | null;
  stages?: Array<{ stage: string; note?: string }>;
};

export type EpStatePayout = { id: string; amountUsdc: number; reason: string; status: string; txHash: string | null };

/**
 * Diff one state poll against the last snapshot → the messages this chat should receive.
 * Announce-once semantics live in the returned snapshot (persisted by the runner).
 * The FIRST poll (prev == null) announces nothing — connecting must not replay history.
 */
export const diffCycleEvents = (
  prev: ChatSnapshot | null,
  wraps: EpStateWrap[],
  payouts: EpStatePayout[]
): { events: string[]; next: ChatSnapshot } => {
  const next: ChatSnapshot = {
    wrapStatuses: Object.fromEntries(wraps.map((w) => [w.id, w.status])),
    announcedPayoutIds: prev ? [...prev.announcedPayoutIds] : payouts.filter((p) => p.status === "paid" || p.status === "confirmed").map((p) => p.id)
  };
  if (!prev) return { events: [], next };

  const events: string[] = [];
  for (const w of wraps) {
    const before = prev.wrapStatuses[w.id];
    if (before === w.status) continue;
    const isNew = before == null;
    const q = w.quote;
    const floor = q?.floorStrike ?? q?.putStrike;
    const cap = q?.capStrike ?? q?.callStrike;
    if (w.status === "active") {
      const renewal = (w.stages ?? []).some((s) => /auto-renewal/i.test(s.note ?? ""));
      events.push(
        `${renewal ? "🔄 Renewed" : "🛡 Protection live"} — floor $${floor ?? "?"} / cap $${cap ?? "?"} · credit ${fmt$(q?.creditUsdc)} (pays at the cycle's close)`
      );
    } else if (w.status === "knocked_out") {
      const ko = w.knockout;
      events.push(
        `⚡ Cap $${ko?.capStrike ?? cap ?? "?"} touched${ko ? ` at $${ko.markPx}` : ""} — protection ended for this cycle. You keep every gain to the cap` +
          `${w.vestingStatus ? ` plus ${fmt$(w.vestingStatus.vestedUsdc)} vested credit` : ""}. Re-arms at the new price while the toggle is on.`
      );
    } else if (w.status === "concluded") {
      const v = w.vestingStatus;
      if (v?.fullyVested) events.push(`✅ Cycle complete — ${fmt$(v.fullCreditUsdc)} earned in full.`);
      else if (v) events.push(`✋ Closed early — kept ${fmt$(v.vestedUsdc)} of ${fmt$(v.fullCreditUsdc)} vested.`);
      else events.push("✅ Cycle concluded.");
    } else if (w.status === "failed" && !isNew) {
      events.push(`🚫 ${humanRefusal(w.failReason)}`);
    }
  }
  for (const p of payouts) {
    const paid = p.status === "paid" || p.status === "confirmed";
    if (paid && !next.announcedPayoutIds.includes(p.id)) {
      next.announcedPayoutIds.push(p.id);
      events.push(`💰 Credit paid: ${fmt$(p.amountUsdc)} (${p.reason.replace("_", " ")})${p.txHash && /^0x/.test(p.txHash) ? ` · https://arbiscan.io/tx/${p.txHash}` : ""}`);
    }
  }
  return { events, next };
};
