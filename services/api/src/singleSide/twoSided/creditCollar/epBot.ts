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

// All bot copy is HTML parse-mode (Markdown breaks on addresses with underscores) and follows the
// venue-affiliated brand line: "Earn & Protect · for Hyperliquid — by Atticus".

export const BOT_COMMANDS = [
  { command: "positions", description: "Your positions with protect buttons" },
  { command: "status", description: "Protection state + credits paid" },
  { command: "help", description: "How it works" }
];

export const WELCOME_TEXT = [
  "🛡 <b>Earn &amp; Protect</b> · <i>for Hyperliquid — by Atticus</i>",
  "",
  "One toggle puts a <b>hard floor</b> under your position — and <b>pays you</b> a credit, funded by the live options market. Never upfront, never fake: paid at each daily cycle's close.",
  "",
  "<b>Getting started</b>",
  "1️⃣  Paste your Hyperliquid address (<code>0x…</code>) — read-only: no keys, no signing, no deposits",
  "2️⃣  Tap 🛡 next to a position to protect it",
  "3️⃣  Credits unlock through the day and land automatically",
  "",
  "⚡ If price touches your cap, that cycle ends early — you keep your position, every gain to the cap, and the unlocked credit. Protection re-arms on its own while the toggle stays on.",
  "",
  "<i>Honest by design: when the market can't fund a credit, we refuse and tell you why.</i>"
].join("\n");

export const HELP_TEXT = [
  "🛡 <b>Earn &amp; Protect</b> — commands",
  "",
  "<code>0x…</code> — connect your Hyperliquid address (read-only)",
  "/positions — your positions with protect buttons",
  "/status — protection state + credits paid",
  "",
  "<b>The mechanics, honestly</b>",
  "• A hard floor under your position; a cap above it funds your credit",
  "• Credit unlocks through the day, pays at the cycle's close",
  "• Cap touched ⟹ cycle ends: keep gains to the cap + unlocked credit; auto re-arms",
  "• Toggle off anytime: keep what's unlocked, the rest returns to the market",
  "• When the market can't fund a credit, we refuse and say why"
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
  if (/verify_required/i.test(s)) return "Verify your wallet once in the app first — one signature, then Telegram works too";
  if (/close_locked/i.test(s)) return "Only the device that turned protection on can turn it off — it pays out on its own either way";
  if (/tos_required|Terms of Service/i.test(s)) return "Please accept the Terms first — tap the button above";
  if (/waitlisted|in line/i.test(s)) { const m = s.match(/#(\d+) in line/); return m ? "Founding cohort full — you're #" + m[1] + " in line" : "Founding cohort full — you're on the waitlist"; }
  if (/geo_blocked|not available in your region|verify your location/i.test(s)) return "Not available in your region";
  if (/kill switch|demo disabled|paused/i.test(s)) return "Protection paused";
  return "Couldn't complete · nothing opened";
};

/** Inline ToS acceptance prompt (Phase 3): shown after address connect until the current version is accepted. */
export const tosPrompt = (version: string, baseUrl: string): { text: string; keyboard: InlineButton[][] } => ({
  text: [
    "📋 <b>One step before protection</b> — please review and accept the Terms of Service.",
    `${baseUrl.replace(/\/$/, "")}/tos (version ${version})`,
    "<i>Recorded once per wallet per version.</i>"
  ].join("\n"),
  keyboard: [[{ text: `✅ I accept the Terms (${version})`, callback_data: "tos" }]]
});

// ── Inline keyboards ──────────────────────────────────────────────────────────

export type BotPosition = { coin: string; side: string; szBase: number; notionalUsdc: number; wrappable: boolean };
export type InlineButton = { text: string; callback_data?: string; web_app?: { url: string } };

/**
 * One row per position: wrappable coins get the protect/unprotect action; others a disabled note.
 * callback_data is `wrap` | `close` (the API is account-scoped — the chat's stored address).
 * When a Mini App URL is configured, a launch row opens the full branded app inside Telegram with
 * the chat's account handed off in the URL.
 */
export const positionsKeyboard = (positions: BotPosition[], protectionOn: boolean, miniAppUrl?: string | null): InlineButton[][] => {
  const rows: InlineButton[][] = positions
    .filter((p) => p.wrappable)
    .map((p) => [
      protectionOn
        ? { text: `✋ Unprotect ${p.side.toUpperCase()} ${p.szBase} ${p.coin} (keep vested)`, callback_data: "close" }
        : { text: `🛡 Earn & Protect ${p.side.toUpperCase()} ${p.szBase} ${p.coin} (${fmt$(p.notionalUsdc)})`, callback_data: "wrap" }
    ]);
  if (miniAppUrl) rows.push([{ text: "📱 Open the app", web_app: { url: miniAppUrl } }]);
  return rows;
};

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const positionsText = (positions: BotPosition[]): string => {
  if (positions.length === 0) return "No open perp positions on this address.";
  return [
    "📊 <b>Your positions</b>",
    "",
    ...positions.map(
      (p) =>
        `${p.side === "long" ? "🟢" : "🔴"} <b>${p.side.toUpperCase()}</b> ${p.szBase} ${escHtml(p.coin)} · ${fmt$(p.notionalUsdc)}${p.wrappable ? "" : " · <i>coming soon</i>"}`
    ),
    "",
    "<i>Tap a button below to protect / unprotect.</i>"
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
