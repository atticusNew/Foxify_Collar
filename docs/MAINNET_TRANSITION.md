# Testnet-to-Mainnet Transition Guide

This guide is for the lead engineer transitioning the Atticus/Foxify pilot from Bullish SimNext testnet to Bullish mainnet.

## Prerequisites
- All pilot validation completed on SimNext testnet
- Two live testnet fills confirmed (order IDs 960800137131065345 and 960813609927573505)
- Premium validated at $11/1k flat rate across all tiers
- 148+ passing tests (13 IBKR-deprecated failures expected)
- Admin dashboard functional
- Foxify CEO walkthrough completed

## Step-by-Step Transition

### Step 1: Obtain Bullish Mainnet API Credentials
- Generate new ECDSA key pair for mainnet (do NOT reuse testnet keys)
- Register key with Bullish mainnet account
- Record: account ID, trading account ID, public key, private key
- **Expected outcome**: Credentials in hand, not yet configured

### Step 2: Update Environment Variables
Change these env vars in Render dashboard:
```
PILOT_BULLISH_REST_BASE_URL=https://api.exchange.bullish.com    (was: api.simnext.bullish-test.com)
PILOT_BULLISH_WS_PUBLIC_URL=wss://api.exchange.bullish.com/...  (update host)
PILOT_BULLISH_WS_PRIVATE_URL=wss://api.exchange.bullish.com/... (update host)
PILOT_BULLISH_ECDSA_PRIVATE_KEY=<mainnet private key>
PILOT_BULLISH_ECDSA_PUBLIC_KEY=<mainnet public key>
PILOT_BULLISH_ACCOUNT_ID=<mainnet account ID>
PILOT_BULLISH_TRADING_ACCOUNT_ID=<mainnet trading account ID>
PILOT_BULLISH_ENABLE_EXECUTION=false    (keep disabled until step 9)
```
- **Expected outcome**: API points to mainnet, execution disabled

### Step 3: Run Credential Validation
```bash
npm run -s pilot:bullish:key-check
```
- **Expected outcome**: All ECDSA fields present and parseable. No errors.

### Step 4: Run Auth Test
```bash
npm run -s pilot:bullish:auth-debug
```
- **Expected outcome**: `publicPrivateMatch: true`, JWT generated successfully, auth handshake complete

### Step 5: Run Smoke Test
```bash
npm run -s pilot:bullish:smoke -- --symbol BTCUSDC
```
- **Expected outcome**: `status: ok`, trading accounts listed, account balances visible, no errors

### Step 6: Verify Option Chain
- Confirm BTC options (puts and calls) available on mainnet
- Check chain depth: expect 200+ instruments
- Verify symbol format matches: `BTC-USDC-YYYYMMDD-STRIKE-P`
- **Expected outcome**: Options chain populated, put strikes available near current spot

### Step 7: Run One Quote (No Execution)
- Keep `PILOT_BULLISH_ENABLE_EXECUTION=false`
- Request a quote via API:
```bash
curl -X POST https://<api>/pilot/protections/quote \
  -H "Content-Type: application/json" \
  -d '{"protectedNotional": 2500, "foxifyExposureNotional": 2500, "tierName": "Pro (Bronze)", "drawdownFloorPct": 0.20, "protectionType": "long"}'
```
- **Expected outcome**: Quote returned with: instrument selected, premium calculated, spread positive, quote ID generated
- **Watch for**: Mainnet spreads should be TIGHTER than testnet (better pricing)

### Step 8: Verify Quote Economics
- Confirm premium is in expected range ($11/1k → ~$27.50 for $2.5k Bronze)
- Confirm selected option strike is near trigger price
- Confirm spread is positive (venue cost < client premium)
- **Expected outcome**: Economics match testnet validation

### Step 9: Enable Execution
```
PILOT_BULLISH_ENABLE_EXECUTION=true
PILOT_ACTIVATION_ENABLED=true
```
- **Expected outcome**: System ready to place real orders

### Step 10: Run One Small Test Order
- Open position via frontend (Bronze, $2,500 notional)
- Or via API:
```bash
curl -X POST https://<api>/pilot/protections/activate \
  -H "Content-Type: application/json" \
  -d '{"quoteId": "<from step 7>", "protectedNotional": 2500, "foxifyExposureNotional": 2500, "entryPrice": <current>, "tierName": "Pro (Bronze)", "drawdownFloorPct": 0.20, "autoRenew": false, "protectionType": "long"}'
```
- **Expected outcome**: Order placed, fill confirmed via WebSocket

### Step 11: Verify Fill
- Check admin dashboard for new protection
- Verify `pilot_venue_executions` has fill record
- Confirm order ID, fill price, quantity, fees
- Check WebSocket fill confirmation (or REST fallback)
- **Expected outcome**: Fill recorded with positive spread

### Step 12: Confirm Ledger
- Check `pilot_ledger_entries` for `premium_due` entry
- Check `pilot_price_snapshots` for entry price snapshot
- Check `pilot_venue_quotes` for consumed quote record
- **Expected outcome**: All ledger entries correctly recorded

## Things to Watch
- **Mainnet spreads**: Will be tighter than testnet. Prices should be better, making the $11/1k rate even more profitable.
- **Real capital at stake**: Every order uses real USDC from the trading account. Monitor account balance.
- **Option expiry**: Mainnet options expire and settle automatically (cash-settled). Bullish credits USDC for ITM options.
- **Volume**: Mainnet may have different volume profiles than testnet. Monitor fill rates and slippage.

## Rollback Procedure
1. Set `PILOT_BULLISH_ENABLE_EXECUTION=false` in Render dashboard
2. This instantly prevents all new hedge orders
3. Existing protections continue monitoring (trigger detection still works)
4. Existing hedges remain open on Bullish (they do NOT get cancelled)
5. To fully revert to testnet: restore testnet env vars
6. Review any mainnet fills and reconcile manually

## Post-Transition Checklist
- [ ] Mainnet credentials configured
- [ ] Auth validation passed
- [ ] Smoke test passed
- [ ] Option chain verified
- [ ] Quote economics validated
- [ ] Test order filled
- [ ] Ledger entries confirmed
- [ ] Admin dashboard shows fill
- [ ] No errors in logs
- [ ] Treasury balance adequate
- [ ] Monitoring alerts configured
