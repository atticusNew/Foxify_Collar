/**
 * RETAIL VIEW — what a non-admin caller of the Earn & Protect API is allowed to see.
 *
 * The trader's surface needs exactly the product: net credit, floor, cap, expiry, status, vesting,
 * payouts, and a human sentence when something is refused. Everything else that used to ride the
 * same JSON — hedge venue and instrument ids, leg roles and order refs, gross credit and our take,
 * capital and margin formulas, execution-mode words, pricing-rule internals, raw venue errors and
 * environment-variable names — is operator information. It stays behind the admin token (and on
 * the institutional skin, where counterparties want the receipt).
 *
 * Two mechanisms, applied to every non-admin JSON response on the retail skin:
 *   1. redaction  — a deep walk that drops a fixed set of keys wherever they appear (so a new
 *                   internal field nested three levels down is never one forgotten `delete` away),
 *                   and lifts the one operator field a retail card needs (coverage note);
 *   2. refusal copy — every `error` code and `message` / `failReason` string is mapped to a retail
 *                   code and a retail sentence server-side; the raw engine string never leaves.
 *
 * Honesty is kept, not traded: the sentence says what happened to the trader ("nothing opened",
 * "you're still protected") — it just does not say which venue, which key, or which rule.
 * `isSimulated` still travels (true on paper / demo-venue lanes) so the card can carry its one
 * honesty label without naming the lane.
 */

/** Keys removed anywhere in a retail response. Order is documentation, not logic. */
export const RETAIL_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  // hedge venue / instruments / legs
  "legs",
  "hedge",
  "instId",
  "orderId",
  "callInstId",
  "putInstId",
  "unwind",
  "preTouch",
  "knockout",
  "venueErrors",
  "clientVenue",
  "source",
  // economics: gross vs net, our take, the fee rule
  "economics",
  "grossCreditUsdc",
  "atticusTakeUsdc",
  "takeRatePct",
  "takeRule",
  "founding",
  "foundingRank",
  "foundingWallets",
  "foundingTakeRatePct",
  "walletsJoined",
  "waitlistLength",
  "waitlistPosition",
  "showCohortCount",
  "netCreditUsdc",
  "venueFeeUsdc",
  "premiumUsdc",
  "feeUsdc",
  // capital / risk formulas
  "subAccountCapitalUsdc",
  "marginPerWrapRate",
  "usableMarginUsdc",
  "bookCapUsdc",
  "perStrikeCapPct",
  "maxBookNotionalUsdc",
  "maxActiveWraps",
  "maxWrapsPerDay",
  "cooldownMs",
  "maxPositionNotionalUsdc",
  "book",
  // pricing-rule internals + the perp's funding (not ours to show on the card)
  "capExceedProb",
  "capRule",
  "capRuleApplied",
  "floorRule",
  "floorRuleApplied",
  "floorPctUsed",
  "tenorDays",
  "funding",
  "fundingUsdc",
  "unwindValueUsdc",
  // lane words and plumbing
  "executionMode",
  "idempotencyKey",
  "positionError",
  "note",
  "stores"
]);

/** Keys that survive even though a parent walk might otherwise treat them as internal. */
const KEEP_AS_IS: ReadonlySet<string> = new Set(["controlToken", "coverageNote", "sizeNote"]);

/**
 * Error codes the retail client keys behaviour on (which card to reveal, whether to retry). Every
 * other code collapses to one of the generic retail codes below.
 */
const CLIENT_CODES: ReadonlySet<string> = new Set([
  "tos_required",
  "verify_required",
  "close_locked",
  "release_locked",
  "price_moved",
  "already_released",
  "rate_limited",
  "account_refused",
  "no_position",
  "nothing_active",
  "showcase_wallet",
  "geo_blocked",
  "invalid_size",
  "owed_outstanding",
  "in_flight",
  "busy",
  "not_found",
  "no_price",
  "bad_signature"
]);

export type RetailRefusal = { error: string; message: string };

/**
 * The retail sentence for an engine refusal. Codes first (exact), then the raw string's shape
 * (wrap records carry free-text `failReason`s), then a safe default. Never echoes the raw string.
 */
export const retailRefusal = (code: string | undefined | null, raw: string | undefined | null): RetailRefusal => {
  const c = String(code ?? "").trim();
  const s = String(raw ?? "");
  const cd = s.match(/cooldown[^0-9]*(\d+)s/i);
  if (cd) return { error: "cooldown", message: `Next protection in ${cd[1]}s` };
  switch (c) {
    case "tos_required":
      return { error: c, message: "Please accept the Terms first." };
    case "verify_required":
      return { error: c, message: "Verify your wallet first · one signature, one time." };
    case "close_locked":
      return { error: c, message: "Turn off from the device that turned protection on · it pays out on its own either way." };
    case "release_locked":
      return { error: c, message: "Release from the device that turned protection on." };
    case "price_moved":
      return { error: c, message: "The release price moved · confirm the new price." };
    case "already_released":
      return { error: c, message: "Cap already released · every gain is yours." };
    case "rate_limited":
      return { error: c, message: "Slow down a moment." };
    case "account_refused":
      return { error: c, message: "This address isn't enabled yet." };
    case "no_position":
      return { error: c, message: "No open position to protect." };
    case "nothing_active":
      return { error: c, message: "Nothing to turn off right now." };
    case "showcase_wallet":
      return { error: c, message: "Public address · watching only. Connect your own to protect it." };
    case "geo_blocked":
      return { error: c, message: "Not available in your region." };
    case "invalid_size":
      return { error: c, message: "Preview sizes up to $500M · try a smaller amount." };
    case "in_flight":
    case "busy":
      return { error: c, message: "Already in progress · one moment." };
    case "not_found":
      return { error: c, message: "Not found." };
    case "no_price":
      return { error: c, message: "Live price unavailable · try again in a moment." };
    case "bad_signature":
      return { error: c, message: "That signature didn't verify · try again." };
    case "owed_outstanding": {
      const m = s.match(/\$([0-9][0-9,]*\.?[0-9]*)/);
      return { error: c, message: (m ? `$${m[1]} settles` : "Your last cycle settles") + " from your last cycle\u2019s gains first." };
    }
    case "below_min_lot":
    case "not_wrappable":
      return { error: "not_wrappable", message: "Below the 0.01 BTC minimum." };
    case "wallet_cap":
      return { error: "wallet_cap", message: "Your capacity is in use this cycle · it frees at the cycle\u2019s close." };
    case "strike_concentration":
      return { error: "try_later", message: "That level is crowded right now · try again shortly." };
    case "credit_below_take":
    case "listed_credit_nonpositive":
    case "listed_book_empty":
    case "credit_infeasible":
    case "not_priceable":
    case "cap_too_close":
    case "model_mid_invalid":
    case "no_credit":
      return { error: "no_credit", message: "No honest credit right now · nothing opened." };
    case "close_unwind_failed":
    case "close_unplanned":
      return { error: "close_retry", message: "Couldn\u2019t turn off cleanly right now · you\u2019re still protected · try again shortly." };
    case "release_unpriced":
    case "release_unfilled":
      return { error: "release_retry", message: "Couldn\u2019t price the release right now · still protected · try again shortly." };
    case "paused":
    case "not_armed":
      return { error: "paused", message: "Protection is paused right now." };
    default:
      break;
  }
  // Free-text reasons (wrap records, permit refusals) by shape.
  if (/kill switch|demo disabled|paused/i.test(s)) return { error: "paused", message: "Protection is paused right now." };
  if (/quota reached|daily limit/i.test(s)) return { error: "daily_limit", message: "Daily limit reached · try again tomorrow." };
  if (/hard cap|book notional cap|book is full|above the current cap/i.test(s)) return { error: "capacity", message: "Above the current capacity · nothing opened." };
  if (/minimum one lot|0\.01 BTC lots/i.test(s)) return { error: "not_wrappable", message: "Below the 0.01 BTC minimum." };
  if (/capacity.*in use/i.test(s)) return { error: "wallet_cap", message: "Your capacity is in use this cycle · it frees at the cycle\u2019s close." };
  if (/already carries|unwindable|strike.*concentration/i.test(s)) return { error: "try_later", message: "That level is crowded right now · try again shortly." };
  if (/listed_credit_nonpositive|listed_book_empty|credit_infeasible|not_priceable|no executable|cap_too_close|under the minimum take|nothing wider pays/i.test(s))
    return { error: "no_credit", message: "No honest credit right now · nothing opened." };
  if (/aborted_no_fill|aborted_unwound|pair unwound|did not fill|hedge_not_filled|hedge did not fill/i.test(s))
    return { error: "no_fill", message: "Couldn\u2019t fill at our quote · nothing opened." };
  if (/already active|in flight|being processed/i.test(s)) return { error: "in_flight", message: "Already in progress · one moment." };
  if (/no open .* position|no live position|position is gone|underlying/i.test(s)) return { error: "no_position", message: "No open position to protect." };
  if (/settles from gains|still owed/i.test(s)) {
    const m = s.match(/\$([0-9][0-9,]*\.?[0-9]*)/);
    return { error: "owed_outstanding", message: (m ? `$${m[1]} settles` : "Your last cycle settles") + " from your last cycle\u2019s gains first." };
  }
  if (/Terms of Service|tos_required/i.test(s)) return { error: "tos_required", message: "Please accept the Terms first." };
  if (/verify_required/i.test(s)) return { error: "verify_required", message: "Verify your wallet first · one signature, one time." };
  if (/not available in your region|geo_blocked/i.test(s)) return { error: "geo_blocked", message: "Not available in your region." };
  // Everything else is ours: credentials, venue errors, arming, timeouts, internal faults.
  return { error: CLIENT_CODES.has(c) ? c : "unavailable", message: "Our issue, not yours · nothing opened." };
};

/** The retail sentence for a wrap record's free-text `failReason` (no code travels with it). */
export const retailReason = (raw: string | null | undefined): string | null => (raw == null || raw === "" ? null : retailRefusal(null, raw).message);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep-copy `body`, dropping every hidden key. Applied to the whole response so nesting never
 * matters. Special handling: a wrap record's hedge `sizeNote` becomes a top-level `coverageNote`
 * (the one operator field the retail card needs), `failReason` is rewritten to its retail
 * sentence, and a top-level `{ ok:false, error, message }` is rewritten through retailRefusal.
 */
export const retailRedact = <T>(body: T): T => {
  const walk = (v: unknown, parentKey: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, parentKey));
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    // Lift the coverage note before the hedge block is dropped.
    const hedge = v.hedge;
    if (isPlainObject(hedge) && typeof hedge.sizeNote === "string" && hedge.sizeNote && v.coverageNote == null) out.coverageNote = hedge.sizeNote;
    for (const [k, val] of Object.entries(v)) {
      if (KEEP_AS_IS.has(k)) {
        out[k] = val;
        continue;
      }
      if (RETAIL_HIDDEN_KEYS.has(k)) continue;
      if (k === "failReason") {
        out[k] = retailReason(val as string | null);
        continue;
      }
      out[k] = walk(val, k);
    }
    return out;
  };
  const cleaned = walk(body, null) as Record<string, unknown>;
  if (isPlainObject(cleaned) && cleaned.ok === false) {
    const src = body as unknown as Record<string, unknown>;
    const r = retailRefusal(typeof src.error === "string" ? src.error : null, typeof src.message === "string" ? src.message : null);
    cleaned.error = r.error;
    cleaned.message = r.message;
  }
  return cleaned as T;
};

/**
 * Strings that must never appear in a retail response. Used by tests and by the boot-time
 * self-check; kept here so the list lives next to the keys it guards.
 */
export const RETAIL_FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "OKX",
  "okx_",
  "BTC-USD-",
  "Deribit",
  "Bullish",
  "FalconX",
  "instId",
  "orderId",
  "grossCredit",
  "takeRate",
  "founding",
  "waitlist",
  "cohort",
  "capExceedProb",
  "subAccountCapital",
  "bookCap",
  "marginPerWrap",
  "executionMode",
  "paper",
  "EP_",
  "DEMO_",
  "OKX_",
  "API key",
  "passphrase",
  "kill switch"
];

/** True when a serialized retail body carries none of the forbidden strings (case-sensitive by design). */
export const retailClean = (body: unknown): { ok: true } | { ok: false; hit: string } => {
  const s = JSON.stringify(body);
  for (const needle of RETAIL_FORBIDDEN_SUBSTRINGS) if (s.includes(needle)) return { ok: false, hit: needle };
  return { ok: true };
};
