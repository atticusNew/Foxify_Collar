# Atticus Earn & Protect — demo toggle (browser extension)

Demo-only. Renders the **"Earn & Protect" toggle into the live Hyperliquid positions UI** so the
integration's placement can be shown on a real venue. The toggle is the **only staged pixel** —
everything behind it is the live engine (real position reads, live OKX options pricing, and, in
okx modes, real hedge orders through the production execution path).

> Disclosure line for any published recording: *"Toggle rendered locally to show placement —
> Hyperliquid is not (yet) a partner. Everything behind it is live."*

## Setup

1. Start the demo service (from the repo root):

   ```bash
   DEMO_HL_ADDRESS=0xYourHlAccount npx tsx services/api/scripts/creditCollarDemoService.ts
   ```

   Default lane is **paper** (model quote off the live OKX book, no venue orders). For real hedge
   legs use `DEMO_EXECUTION=okx_demo` (OKX demo env) or `DEMO_EXECUTION=okx_live` (real money —
   requires the full arming chain: `LIVE_ENABLED=true OKX_EXECUTION_MODE=live
   OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY` + OKX API credentials).

2. Load the extension: Chrome → `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select this folder (`demo/hl-protect-extension`).

3. Open [app.hyperliquid.xyz](https://app.hyperliquid.xyz) with an open BTC position. The toggle
   appears in the position row (or as a docked pill bottom-right if the row layout changed).

4. The Atticus control room — the second surface for the recording — is at
   `http://localhost:8788/demo`.

## Toggle semantics

- **ON** — wraps the live position: real position read → collar priced off the live OKX book →
  hedge (paper or real, per lane) → credit starts vesting linearly over the tenor.
- **OFF** — voluntary early close: the client collects the credit **vested so far**, the unvested
  remainder is clawed back, and the hedge unwinds. (This mirrors the product's anti-farming
  vesting: open-and-grab vests nothing.)
- **Reset demo** (control room) — clears all takes for a fresh rehearsal.

## Safety rails (all fail-closed, enforced server-side)

- `DEMO_ENABLED` kill switch (set `false` to refuse all wraps)
- hard micro cap on wrapped notional: `DEMO_MAX_NOTIONAL_USDC` (default $1,000)
- one wrap at a time · `DEMO_MAX_WRAPS_PER_DAY` (default 6) · cooldown between wraps
- okx_live additionally requires the same live-arming chain as the canary

## Recording checklist

1. Rehearse in paper mode first; `POST /demo/api/reset` (or the control-room button) clears takes.
2. One continuous take; timestamps visible; real HL UI on the left, control room on the right.
3. Flip the toggle → show the timeline fire → cut to OKX order history for the real fills (okx
   modes) → let the vesting bar move → settlement.
4. Show execution in real time (the "it just fired, for real" beat); timelapse only the vesting.
5. Include the disclosure line above in the caption or on-screen.
