# Kalshi Demo V2

Clean rebuild of Kalshi demo with correct hedge logic, multi-venue optimization, and institutional-grade performance.

## Features

- ✅ **Top 4 BTC Events**: Fetches how high, how low, when will, will BTC price events by volume
- ✅ **Correct Hedge Logic**: 2-leg spreads with strike-specific logic per specification
- ✅ **Premium ≤ Max Payout**: Always enforced, scales notional accordingly
- ✅ **Multi-Venue**: Deribit + OKX parallel queries, selects best 1-3 hedges
- ✅ **No Mock Data**: All real market data from exchanges
- ✅ **Fast & Efficient**: Caching, parallel queries, optimized critical path

## Architecture

```
kalshi_demo_v2/
├── api/              # FastAPI server
├── connectors/       # Exchange connectors (Deribit, OKX, Kalshi)
├── services/
│   ├── kalshi/      # Event fetcher, parser, adapter
│   ├── hedging/     # Strike selector, spread builder, premium calc, venue optimizer
│   └── option_chains/ # Chain service, cache
├── configs/         # Configuration files
└── utils/           # Utilities
```

## Setup

1. **Install dependencies:**
```bash
pip install -r requirements.txt
```

2. **Configure environment:**
- Set `KALSHI_PRIVATE_KEY` or `KALSHI_PRIVATE_KEY_PATH` environment variable
- Or place private key at `configs/kalshi_private_key.pem`

3. **Run server:**
```bash
python api/main.py
```

Or with uvicorn:
```bash
uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

## API Endpoints

### `GET /events`
Get top 4 BTC events by volume.

**Response:**
```json
{
  "events": [
    {
      "event_ticker": "KXBTCMAXY-25-DEC31-130000",
      "title": "How high will Bitcoin get this year?",
      "series_ticker": "KXBTCMAXY",
      "threshold_price": 130000,
      "settlement_date": "2025-12-31",
      "volume": 50000.0
    }
  ]
}
```

### `POST /hedge/quote`
Get hedge quote for event + direction.

**Request:**
```json
{
  "event_ticker": "KXBTCMAXY-25-DEC31-130000",
  "direction": "yes",
  "stake_usd": 100.0,
  "hedge_budget_usd": 20.0
}
```

**Response:**
```json
{
  "hedges": [
    {
      "label": "Standard protection",
      "premium_usd": 24.50,
      "max_payout_usd": 80.00,
      "venue": "Deribit",
      "legs": [
        {"type": "call", "strike": 85000, "side": "long", "notional_btc": 0.012},
        {"type": "call", "strike": 95000, "side": "short", "notional_btc": 0.012}
      ],
      "description": "If BTC finishes above 130k and your 'How high' bet loses, this call spread can pay up to $80."
    }
  ]
}
```

## Key Differences from V1

- **Simplified Architecture**: Clean, focused modules
- **Correct Hedge Logic**: 2-leg spreads per specification
- **Premium Enforcement**: Premium ≤ max_payout always guaranteed
- **Multi-Venue Optimization**: Parallel queries, best venue selection
- **No Over-Engineering**: Simple, direct implementation

## Testing

Test endpoints:
```bash
# Get events
curl http://localhost:8000/events

# Get hedge quote
curl -X POST http://localhost:8000/hedge/quote \
  -H "Content-Type: application/json" \
  -d '{
    "event_ticker": "KXBTCMAXY-25-DEC31-130000",
    "direction": "yes",
    "stake_usd": 100.0
  }'
```

## Notes

- All API keys and secrets should be configured correctly
- No hardcoded or mock data
- Optimized for speed without sacrificing accuracy
- Institutional-grade code quality

