# Foxify Integration Spec — Layer 6 Trader Binding (X-Foxify-Trader-ID Header)

> **Audience:** Foxify engineering team
> **Purpose:** Add a single signed HTTP header to all protection-related API calls so the Atticus platform can enforce per-trader anti-bot rules
> **Effort estimate (Foxify side):** 2–4 hours of dev work
> **Trader UX impact:** Zero — completely invisible to traders
> **Status:** Ask from Atticus during Foxify Pilot v2 planning, 2026-05-13

---

## TL;DR

Foxify already knows which trader is making each protection request (because the trader is logged into Foxify). Right now Foxify doesn't tell us — we just see "a trader from Foxify wants this." Without that information, we can't prevent the same trader from opening contradictory positions across different browser sessions (the bot pattern your CEO flagged: open long + short perp + 2% protection on each, collect on whichever direction triggers).

**The ask:** add one HTTP header to existing protection API calls (`/pilot/protections/quote` and `/pilot/protections/activate`) carrying a stable Foxify trader identifier, signed with a shared HMAC secret so we can verify it actually came from Foxify (not a spoofed claim).

That's it. The trader sees nothing different. Atticus enforces per-trader rules. Bot strategy becomes structurally non-viable.

---

## What we want Foxify to send

Two new HTTP headers on every call to Atticus protection APIs:

```
X-Foxify-Trader-ID: <stable-trader-id>
X-Foxify-Trader-Signature: <hmac-sha256-signature>
```

### `X-Foxify-Trader-ID`
- A stable identifier for the Foxify trader
- Format: any opaque string, ≤ 256 chars, URL-safe characters only
- Suggestion: hash of Foxify's internal trader account ID (so we don't see the raw trader account, just a stable opaque token)
- Must be the SAME value across all of that trader's sessions (different browsers, devices, IPs)
- Examples:
  - `fxy_a8b3c9d1e7f0...` (hash of trader_id)
  - `fxy_acct_12345` (raw account ID, if Foxify is comfortable sharing)
- Rotation: should NOT rotate per session; should rotate only if Foxify rotates internally (e.g., trader closes account)

### `X-Foxify-Trader-Signature`
- HMAC-SHA256 of a canonical signing string, signed with a shared secret between Foxify and Atticus
- Canonical signing string: `${X-Foxify-Trader-ID}:${X-Foxify-Timestamp}:${request-method}:${request-path}`
- Encoded as hex (lowercase)
- Atticus verifies on every request

### `X-Foxify-Timestamp`
- Unix timestamp in seconds when the request was signed
- Must be within ±5 minutes of Atticus server time (replay attack prevention)
- Atticus rejects requests with timestamps outside this window

### Example request

```http
POST /pilot/protections/quote HTTP/1.1
Host: <atticus-api-host>
Content-Type: application/json
X-Foxify-Trader-ID: fxy_a8b3c9d1e7f0a8b3c9d1e7f0a8b3c9d1
X-Foxify-Timestamp: 1747094822
X-Foxify-Trader-Signature: 3a8d29c7b3f1e8a7c5d3b2a1f4e6c9b8a7e5d3f1a8b9c7d6e4f3a2b1c8d9e7f5

{
  "protectedNotional": 50000,
  "foxifyExposureNotional": 50000,
  "entryPrice": 81194,
  "tierName": "SL 2%",
  "slPct": 2,
  "protectionType": "long",
  ...
}
```

### Atticus signature verification (pseudocode)

```python
def verify_foxify_trader_signature(headers, request_method, request_path):
    trader_id = headers["X-Foxify-Trader-ID"]
    timestamp = int(headers["X-Foxify-Timestamp"])
    signature = headers["X-Foxify-Trader-Signature"]

    # Replay protection
    if abs(time.time() - timestamp) > 300:
        return False, "timestamp_out_of_window"

    # Compute expected signature
    canonical = f"{trader_id}:{timestamp}:{request_method}:{request_path}"
    expected = hmac.new(
        FOXIFY_SHARED_SECRET.encode(),
        canonical.encode(),
        hashlib.sha256
    ).hexdigest()

    # Constant-time compare
    if not hmac.compare_digest(signature, expected):
        return False, "invalid_signature"

    return True, trader_id
```

---

## Shared secret rotation

- Atticus and Foxify each hold a copy of `FOXIFY_SHARED_SECRET` (a 256-bit random value)
- Distributed via secure channel during integration (1Password share, encrypted email, in-person handoff)
- Atticus stores in `PILOT_FOXIFY_SHARED_SECRET` env var on Render
- Foxify stores in their equivalent secret manager
- Rotation: scheduled annually OR immediately if either side suspects compromise
- During rotation: Atticus accepts BOTH old and new secret for 24 hours, then drops old

---

## Backwards-compatibility (graceful degradation)

If Foxify can't ship Layer 6 immediately, Atticus continues to function — we just fall back to browser fingerprinting (which catches ~80% of the same patterns).

Atticus behavior when header is missing:
- Quote/activate succeeds normally
- Falls back to browser fingerprint + IP + session ID for per-trader rules
- Logs `fingerprint_only_fallback` for ops visibility
- Anti-bot defenses still apply, just with weaker per-trader resolution

This means: **Foxify can roll out Layer 6 at their own pace.** Atticus doesn't block on it. But the sooner Foxify ships, the sooner the platform has full Sybil resistance.

---

## What Atticus does with the trader ID

Once we have the stable trader ID, we enforce these rules per-trader (instead of per-fingerprint):

1. **No simultaneous opposite-side 2% protection.** If trader has an active long-side 2% protection on BTC, they can't open a short-side 2% protection until the first one expires/closes (or vice versa). Bypass: trader closes the existing one first.

2. **Trigger cooldown.** If a trader's protection triggers, they cannot open a new same-tier protection on the same asset for 4 hours. Different tier (e.g., 5% instead of 2%) is allowed.

3. **Quote/activate ratio surveillance.** If a trader's quote-to-activate ratio is > 50:1 over 100 quotes, we surcharge their next protection by 50%.

4. **Concurrent protection cap.** Each trader can have at most 1 active 2% protection per asset.

5. **Premium surcharge on suspicious patterns.** Detected via combination of (a) rapid open/close cycles < 60s, (b) more than 3 protections opened within 1 hour, (c) attempts to bypass rules 1-4.

These rules are independently testable; we can dry-run them on Atticus side and show Foxify the behavior before going live.

---

## What Atticus does NOT do with the trader ID

- We do NOT log the trader ID alongside identifiable PII
- We do NOT share trader IDs with any third party (Bullish, Deribit, anyone)
- We do NOT publish trader IDs in responses (admin-only)
- We do NOT use the trader ID for marketing or analytics
- We do NOT correlate trader IDs across chains or other Atticus customer integrations (Foxify trader IDs only used for Foxify pilot)

---

## Privacy / regulatory considerations

- The trader ID is opaque to Atticus — we don't know the underlying Foxify account, just that "trader X is a stable identity"
- No personal information (name, address, KYC data) is transferred
- Storage: Atticus stores trader IDs only in operational tables for anti-bot rule enforcement; not in long-term audit data
- Retention: trader IDs purged 90 days after last activity
- Disclosure: covered under Foxify's existing privacy policy clause about third-party anti-fraud services

If Foxify legal needs a DPA (data processing agreement) for this, Atticus is happy to sign one.

---

## Suggested rollout for Foxify

1. **Week 0:** Foxify dev reads this spec, asks questions
2. **Week 0:** Atticus generates `FOXIFY_SHARED_SECRET`, shares via secure channel
3. **Week 1:** Foxify implements signing in their request middleware (estimated 2–4 hours)
4. **Week 1:** Foxify deploys to staging; Atticus verifies signature parsing on staging
5. **Week 2:** Coordinated production rollout — Atticus enables Layer 6 enforcement when Foxify confirms shipping
6. **Week 2+:** Atticus monitors `fingerprint_only_fallback` log volume to confirm Foxify is sending headers consistently

---

## Open questions for Foxify

1. **What format do you want for `X-Foxify-Trader-ID`?** Hash of internal account ID, raw account ID, or something else?
2. **Shared secret distribution channel?** 1Password share, encrypted email, in-person?
3. **Timestamp tolerance — is 5 minutes acceptable?** (We can tighten to 1-2 minutes if you prefer; trades off clock-drift tolerance for replay-attack defense.)
4. **Do you want Atticus to expose a debug endpoint** (`POST /pilot/admin/foxify-signature-test`) so Foxify dev can test their signing implementation against ours before production rollout?
5. **Are you comfortable with the per-trader rules in §"What Atticus does with the trader ID"?** If you want any adjusted (e.g., longer trigger cooldown, allowing simultaneous opposite-side trades), we can negotiate before go-live.
6. **DPA needed?** Yes/no.

---

## Atticus contacts for this integration

[Operator name + Atticus engineering contact email goes here when you forward this to Foxify]

---

## Why this matters (one paragraph for Foxify business team)

The Atticus protection product is currently structurally exposed to a sophisticated bot strategy: open paired long+short positions, buy 2% protection on each, collect $1,000 payout whenever BTC moves 2% in either direction within tenor. With our current pricing, this strategy is roughly break-even — but in trending or whipsaw markets it becomes profitable to the bot at the platform's expense, eventually making the pilot unsustainable. Adding Layer 6 (this header) shuts the strategy at the root because the bot can no longer pretend to be 5 different anonymous browsers — they would need 5 separate Foxify accounts, each with KYC and capital, which is cost-prohibitive. Same browser fingerprinting we already do catches ~80% of the same patterns; Layer 6 closes the remaining 20%. Net effect: protects trader experience for honest traders (no one wants to share an exchange with bots that distort pricing), and protects Atticus's ability to keep the protection product live and growing on Foxify.

---

*End of spec. Questions to [Atticus contact]; happy to do a 30-min call to walk through the implementation.*
