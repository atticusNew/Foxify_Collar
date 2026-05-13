# Fingerprinting from Our Side (without Foxify integration)

> **Short answer:** Yes. We can implement a robust fingerprint on our side without Foxify integration. The trader doesn't have to do anything — the browser provides the fingerprint automatically when they load our protection widget. Effectiveness is ~60–80% of full Foxify trader binding (Layer 6 in plan §3). Recommend shipping both: ours immediately, request Foxify trader binding as a parallel ask.

---

## 1. Three layers of identity we can capture from our side

### Layer A — Browser fingerprint  *(automatic, no trader action required)*

When the trader loads the protection widget (a page on Foxify's site or an iframe Foxify embeds), our JavaScript runs in their browser. We can extract dozens of small browser characteristics that, hashed together, produce a unique "fingerprint" identifying that browser.

**What gets captured:**
- Canvas rendering (subtle differences in font rendering across hardware)
- WebGL renderer info (GPU model)
- Audio context fingerprint
- Installed fonts, plugins
- Screen resolution, color depth, timezone
- Browser language settings
- User-Agent + browser version
- Hardware concurrency (CPU cores)

Tools: open-source `FingerprintJS` library (free version), `ClientJS`, or our own implementation. Library is ~30 KB, adds ~50ms to page load.

**Output:** a 64–256 bit hash like `fp_a8b3c9d1e7f0...` that's stable for the same browser/device combination.

**Effectiveness:**
- Two real traders on different devices: ~99.5% chance of distinct fingerprints
- Same trader, same browser, multiple visits: ~95% chance of stable fingerprint (small drift from browser updates)
- Same trader switching browsers (Chrome → Firefox): different fingerprints
- Same trader incognito + VPN: different fingerprint
- Sophisticated bot using `puppeteer-extra-plugin-stealth` + fingerprint randomization: can rotate fingerprints

### Layer B — Persistent session ID  *(automatic, survives page reloads)*

We set a cryptographically signed cookie or `localStorage` value when the trader first loads the widget. It persists across visits.

**What gets captured:**
- A unique session ID (UUID) tied to that browser
- HMAC-signed so we can verify it wasn't tampered with
- Survives tab close, browser restart
- Cleared if trader manually clears cookies/storage or uses incognito

**Effectiveness:**
- Catches the same trader returning over multiple sessions
- Cleared by anyone who deliberately wipes cookies — bots usually do this between attacks

### Layer C — Server-side network fingerprint  *(automatic, requires no client cooperation)*

The TLS handshake and HTTP request pattern reveal device characteristics that are hard to spoof.

**What gets captured:**
- TLS fingerprint (JA3) — ciphers, extensions, curves the client supports
- IP address + ASN (network provider)
- TCP fingerprint (packet timings)
- HTTP/2 settings frame
- Accept-Language, Sec-CH-UA-Platform headers

**Effectiveness:**
- Hard for browser-side rotation to defeat (TLS stack is OS-level)
- Defeated by sophisticated proxy chains
- Combines well with browser fingerprint — bot would need to match BOTH to evade

### Combined fingerprint strength

```
Layer A (browser):  ~60% defense (defeated by stealth bot rotation)
Layer A + B:         ~70% (cookie persistence catches casual evasion)
Layer A + B + C:    ~80% (server-side fingerprint adds independent signal)
+ Foxify trader binding (Layer 6):  ~98% (Sybil resistance via KYC'd accounts)
```

---

## 2. How fingerprinting flows in our system (from trader's perspective)

The trader sees nothing. Their UX is identical. Behind the scenes:

```
1. Trader loads Foxify page with embedded Atticus widget
2. Widget JS computes browser fingerprint (Layer A)  ← invisible, ~50ms
3. Widget reads/sets persistent session cookie (Layer B)  ← invisible
4. Trader clicks "Quote protection"
5. Widget POSTs /pilot/protections/quote with three headers:
     X-Atticus-Browser-Fingerprint: fp_a8b3c9d1e7f0...
     X-Atticus-Session-ID: sess_e7d2f9b1a3c8...
     (TLS/IP fingerprint captured server-side automatically)
6. Our backend computes a combined fingerprint:
     combined_fp = SHA256(browser_fp + session_id + ja3 + ip_subnet)
7. Throttle store keyed on combined_fp
8. Trader continues normally — quote, activate, etc.
9. Anti-bot rules enforced against combined_fp:
     - Layer 1 from plan: "no opposite-side 2% protection within window"
     - Layer 2: random-jitter activation cooldown
     - Layer 3: 4h cooldown after trigger
     - Layer 4: surcharge on suspicious patterns
```

The trader does NOTHING different. Foxify does NOTHING different. We add the JS to the widget; we add the header parsing on the backend. Both small changes, both on our side.

---

## 3. Where the fingerprint actually lives (the trader doesn't "have" one)

To answer your specific question — **the trader doesn't put a fingerprint on anything, and we don't pull from a Foxify endpoint**. The flow is:

> Their browser PROVIDES enough information about itself (display, hardware, fonts, IP, TLS handshake) that we can MAKE a fingerprint *about* their browser. We do this on every request automatically. The trader never sees it, never types it, never approves it.

It's like recognizing someone by their voice on a phone call — you don't ask them to "send their voice"; you just hear it when they speak. Browser fingerprinting is the same — when they make a request, the request itself reveals enough characteristics that we can identify the browser.

---

## 4. Comparison: ours-only vs Foxify trader binding

| Capability | Browser fingerprinting (us only) | Foxify trader binding (Layer 6) |
|---|---|---|
| Trader UX impact | Zero | Zero |
| Implementation effort | Small (us) | Small (us + Foxify) |
| Foxify cooperation needed | No | Yes (one HTTP header) |
| Catches same browser, multiple visits | ✓ | ✓ |
| Catches incognito | Partial (server-side TLS fingerprint helps) | ✓ |
| Catches different browsers (Chrome + Firefox) | ✗ (different fingerprints) | ✓ |
| Catches IP rotation | Partial (browser FP is independent of IP) | ✓ |
| Catches stealth bot with FP randomization | ✗ | ✓ (different Foxify accounts needed) |
| Sybil attack cost | Low (browser swap) | High (Foxify KYC + capital) |
| Time to ship | 1-2 days | 3-5 days (depends on Foxify) |

### When ours-only is enough
- Pilot duration is 28 days; sophisticated bot adaptations take longer to build
- At 2 trades/day position cap, even an undefended bot would only siphon a few hundred dollars/week
- At P3 pricing, the bot strategy is structurally negative anyway (see plan §3 and backtest projection §3.1)

### When Foxify trader binding is worth waiting for
- Post-pilot scale (10× or 100× volume)
- Multi-tenant production where each user is materially valuable
- If pilot data shows fingerprint evasion is happening (we'll see it in the throttle bypass logs)

---

## 5. Recommended approach for the pilot

**Ship fingerprinting from our side immediately as part of WS#3 (anti-bot).** Specifically:

1. **Day 5 of execution** (existing WS#3 timeline): add browser-side `FingerprintJS` to the widget; add server-side header parsing + JA3/IP combination
2. **Combined fingerprint** = SHA256(browser_fp + session_id + truncated_ja3 + ip_subnet)
3. **Use it for** Layers 1-4 of the opposing-perp defense (per plan §3)
4. **In parallel: ask Foxify** to add `X-Foxify-Trader-ID` header for stronger long-term defense (Layer 6 of plan); ship if they agree, no blocker if they don't
5. **Monitor effectiveness** via new admin endpoint `/pilot/admin/diagnostics/fingerprint-stats` — show distinct fingerprint count, throttle hits per fingerprint, suspected evasion patterns

### Required code changes (plan only, not built yet)

1. `apps/web/src/PilotApp.tsx` — install `@fingerprintjs/fingerprintjs` (free version), call once on widget mount, store in state, attach as header on all API calls
2. `services/api/src/pilot/fingerprint.ts` (new module) — parse browser fingerprint header, compute JA3 hash from TLS data, derive combined fingerprint
3. `services/api/src/pilot/throttleStore.ts` (new module from WS#3) — key all throttle decisions on combined fingerprint instead of just IP
4. `services/api/src/pilot/routes.ts` — wire fingerprint computation into quote and activate handlers; enforce Layer 1-4 rules
5. New admin endpoint `/pilot/admin/diagnostics/fingerprint-stats` for visibility

Total effort: ~2 days additional on top of WS#3 (which already plans throttle store + fingerprint scaffold).

### Privacy & disclosure

Browser fingerprinting is widely used (Cloudflare, Stripe Radar, every major fraud-prevention vendor) but should be disclosed in the privacy/T&C. For the pilot embedded in Foxify, this would be covered under Foxify's existing T&C clause about anti-fraud measures. Recommend a one-line addition: *"Atticus uses browser-derived identifiers to detect and prevent abusive trading patterns. No personal information is collected or shared."* No regulatory issue at pilot scale.

---

## 6. Bottom line

| Question | Answer |
|---|---|
| Can we add fingerprinting on our side? | Yes |
| Does the trader have to do anything? | No |
| Does Foxify have to do anything? | No (for browser fingerprinting); Yes for Layer 6 trader binding |
| Where does the fingerprint come from? | The trader's browser provides it automatically when they load the widget; their browser characteristics + their network connection are the inputs |
| How effective vs Foxify Layer 6? | ~80% of Layer 6 effectiveness; sufficient for a 28-day pilot |
| Should we wait for Foxify Layer 6? | No — ship ours now, request Foxify Layer 6 in parallel as a parallel ask |
| When does this ship? | Day 5 of execution (folded into WS#3); ~2 days incremental effort |

**Recommend:** ship browser fingerprinting from our side as part of WS#3 in cutover; treat Foxify Layer 6 as a stretch goal for week 2-3 of pilot.

Updated plan rev 5 will fold this into WS#3 deliverables.
