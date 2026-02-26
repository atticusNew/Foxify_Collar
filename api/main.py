"""
FastAPI server for Kalshi Demo V2
Simplified, clean implementation focused on hedge quotes
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from decimal import Decimal
from datetime import date
from contextlib import asynccontextmanager

from services.kalshi.event_fetcher import EventFetcher
from services.kalshi.event_parser import EventParser
from services.kalshi.adapter import KalshiAdapter
from services.hedging.strike_selector import StrikeSelector
from services.hedging.spread_builder import SpreadBuilder
from services.hedging.premium_calculator import PremiumCalculator
from services.hedging.venue_optimizer import VenueOptimizer
from services.option_chains.chain_service import OptionChainService
from services.option_chains.chain_cache import get_chain_cache
from connectors import get_exchange_registry
from utils.logging import get_logger, setup_logging

# Setup logging
setup_logging(log_level="INFO", json_output=False)
logger = get_logger(__name__)

# Initialize services
event_fetcher = EventFetcher()
event_parser = EventParser()
kalshi_adapter = KalshiAdapter()
strike_selector = StrikeSelector()
spread_builder = SpreadBuilder()
premium_calculator = PremiumCalculator()
venue_optimizer = VenueOptimizer()
option_chain_service = OptionChainService()
chain_cache = get_chain_cache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan context manager."""
    # Startup
    logger.info("Starting Kalshi Demo V2 API")
    
    # Initialize exchange registry
    registry = get_exchange_registry()
    
    # Initialize Deribit and OKX connectors
    try:
        await registry.initialize_exchange('deribit')
        logger.info("Deribit connector initialized")
    except Exception as e:
        logger.warning("Failed to initialize Deribit", error=str(e))
    
    try:
        await registry.initialize_exchange('okx')
        logger.info("OKX connector initialized")
    except Exception as e:
        logger.warning("Failed to initialize OKX", error=str(e))
    
    # Initialize Kalshi connector
    try:
        await registry.initialize_exchange('kalshi')
        logger.info("Kalshi connector initialized")
    except Exception as e:
        logger.warning("Failed to initialize Kalshi", error=str(e))
    
    yield
    
    # Shutdown
    logger.info("Shutting down Kalshi Demo V2 API")


app = FastAPI(
    title="Kalshi Demo V2 API",
    description="Hedge quotes for Kalshi BTC events",
    version="2.0.0",
    lifespan=lifespan
)

# Initialize state for caching BTC events
app.state.btc_events = []

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response models
class HedgeQuoteRequest(BaseModel):
    """Hedge quote request."""
    event_ticker: str
    direction: str  # 'yes' or 'no'
    stake_usd: Decimal = Decimal('100')
    hedge_budget_usd: Optional[Decimal] = None
    choice_ticker: Optional[str] = None  # For "how" events - specific choice ticker
    choice_threshold: Optional[Decimal] = None  # For "how" events - specific threshold price


class HedgeLeg(BaseModel):
    """Hedge leg."""
    type: str  # 'call' or 'put'
    strike: Decimal
    side: str  # 'long' or 'short'
    notional_btc: Decimal


class HedgeQuote(BaseModel):
    """Hedge quote."""
    label: str
    premium_usd: Decimal  # Charged premium (after markup) - kept for backward compatibility
    raw_premium_usd: Optional[Decimal] = None  # Raw premium before markup
    charged_premium_usd: Optional[Decimal] = None  # Charged premium after markup
    markup_usd: Optional[Decimal] = None  # Markup amount
    max_payout_usd: Decimal
    venue: str
    legs: List[HedgeLeg]
    description: str


class HedgeQuoteResponse(BaseModel):
    """Hedge quote response."""
    hedges: List[HedgeQuote]


# Root route fallback - will be set later if frontend not found
# We'll define this AFTER checking for frontend to avoid route conflicts

@app.get("/api")
async def api_root():
    """API root endpoint."""
    return {"message": "Kalshi Demo V2 API", "version": "2.0.0"}


@app.post("/cache/clear")
async def clear_cache():
    """Clear option chain cache (for debugging/rate limit recovery)."""
    await chain_cache.clear()
    logger.info("Option chain cache cleared manually")
    return {"status": "cache_cleared", "message": "Option chain cache has been cleared"}


@app.get("/events")
async def get_events():
    """
    Get top 4 BTC events by volume.
    
    Returns top 4 events:
    1. How high (KXBTCMAXY)
    2. How low (KXBTCMINY)
    3. When will hit $150k (KXBTCMAX150)
    4. Will BTC price above $100k (KXBTC2025100)
    """
    try:
        events = await event_fetcher.get_top_4_btc_events()
        
        # Format events for response
        formatted_events = []
        for event in events:
            formatted_events.append({
                "event_ticker": event.get('ticker', '') or event.get('event_ticker', ''),
                "title": event.get('title', ''),
                "series_ticker": event.get('ticker', '').split('-')[0] if '-' in event.get('ticker', '') else '',
                "threshold_price": float(event.get('threshold_price', 0)) if event.get('threshold_price') else None,
                "settlement_date": event.get('expected_expiration_time', '') or event.get('settlement_date', ''),
                "volume": float(event.get('volume', 0)) if event.get('volume') else 0.0
            })
        
        return {"events": formatted_events}
    except Exception as e:
        logger.error("Failed to fetch events", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to fetch events: {str(e)}")


@app.get("/events/btc/top-volume")
async def get_btc_top_volume_events(limit: int = 10):
    """
    Get top BTC events by volume (frontend-compatible endpoint).
    
    Args:
        limit: Maximum number of events to return (default: 10)
    
    Returns:
        Response matching frontend expected format
    """
    try:
        events = await event_fetcher.get_top_4_btc_events()
        
        # Group events by series - show one event per series with choices
        events_by_series = {}
        for event in events:
            ticker = event.get('ticker', '') or event.get('event_ticker', '')
            series_ticker = ticker.split('-')[0] if '-' in ticker else ''
            
            if series_ticker in ['KXBTCMAXY', 'KXBTCMINY', 'KXBTCMAX150']:
                # Group "how" and "when will" events by series
                if series_ticker not in events_by_series:
                    events_by_series[series_ticker] = []
                events_by_series[series_ticker].append(event)
            else:
                # Other events: add directly
                events_by_series[ticker] = [event]
        
        # Format events for frontend (matching expected format)
        formatted_events = []
        series_count = 0
        
        for series_key, series_events in events_by_series.items():
            if series_count >= limit:
                break
            
            # Use first event as base, collect all as choices for "how" events
            base_event = series_events[0]
            ticker = base_event.get('ticker', '') or base_event.get('event_ticker', '')
            series_ticker = ticker.split('-')[0] if '-' in ticker else ''
            
            # Extract threshold from base event ticker
            threshold_price = None
            if ticker:
                parts = ticker.split('-')
                if len(parts) >= 4:
                    try:
                        threshold_price = float(parts[-1])
                    except ValueError:
                        pass
            
            # Get market data for YES/NO prices from base event (already fetched in event_fetcher)
            market_id = base_event.get('market_id', '') or ticker
            yes_price = base_event.get('yes_price', 0.5)  # Real price from Kalshi API
            no_price = base_event.get('no_price', 0.5)  # Real price from Kalshi API
            
            # Create choices based on event type
            choices = []
            if series_ticker in ['KXBTCMAXY', 'KXBTCMINY']:
                # For "how" events, create choices from top 2 events in same series
                top_2_events = sorted(series_events, key=lambda e: float(e.get('volume', 0) or 0), reverse=True)[:2]
                for choice_event in top_2_events:
                    choice_ticker = choice_event.get('ticker', '') or choice_event.get('event_ticker', '')
                    choice_threshold = None
                    if choice_ticker:
                        parts = choice_ticker.split('-')
                        if len(parts) >= 4:
                            try:
                                choice_threshold = float(parts[-1])
                            except ValueError:
                                pass
                    
                    choice_yes = choice_event.get('yes_price', 0.5)
                    choice_no = choice_event.get('no_price', 0.5)
                    
                    # Create choice label
                    if choice_threshold:
                        if series_ticker == 'KXBTCMAXY':
                            choice_label = f"${choice_threshold:,.0f} or above"
                        else:
                            choice_label = f"Below ${choice_threshold:,.0f}"
                    else:
                        choice_label = choice_event.get('title', '')
                    
                    choices.append({
                        "label": choice_label,
                        "market_ticker": choice_ticker,
                        "event_ticker": series_ticker,
                        "price_threshold": choice_threshold,
                        "yes_percentage": f"{round(choice_yes * 100, 1)}%",
                        "no_percentage": f"{round(choice_no * 100, 1)}%",
                        "yes_probability": round(choice_yes * 100, 1),
                        "no_probability": round(choice_no * 100, 1),
                        "volume": choice_event.get('volume', 0)
                    })
            elif series_ticker == 'KXBTCMAX150':
                # For "when will" events, create date choices from top 2 date variants
                top_date_events = sorted(series_events, key=lambda e: float(e.get('volume', 0) or 0), reverse=True)[:2]
                for choice_event in top_date_events:
                    choice_ticker = choice_event.get('ticker', '') or choice_event.get('event_ticker', '')
                    settlement_date_str = choice_event.get('expected_expiration_time', '') or choice_event.get('settlement_date', '')
                    
                    # Extract date from ticker (format: KXBTCMAX150-25-26FEB28-149999.99)
                    date_from_ticker = None
                    choice_label = None
                    
                    if choice_ticker:
                        parts = choice_ticker.split('-')
                        if len(parts) >= 3:
                            date_part = parts[2]  # e.g., "26FEB28"
                            # Parse YYMMMDD format
                            try:
                                import re
                                match = re.match(r'(\d{2})([A-Z]{3})(\d{2})', date_part)
                                if match:
                                    year_suffix = int(match.group(1))
                                    month_abbr = match.group(2)
                                    day = int(match.group(3))
                                    year = 2000 + year_suffix
                                    month_map = {
                                        'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                                        'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                                    }
                                    month = month_map.get(month_abbr.upper())
                                    if month:
                                        from datetime import date
                                        date_from_ticker = date(year, month, day)
                                        choice_label = f"By {date_from_ticker.strftime('%b %d, %Y')}"
                            except Exception as e:
                                logger.debug(f"Failed to parse date from ticker: {choice_ticker}, error: {e}")
                    
                    # Fallback to settlement_date if ticker parsing failed
                    if not choice_label:
                        if settlement_date_str:
                            try:
                                from datetime import datetime
                                dt = datetime.fromisoformat(settlement_date_str.replace('Z', '+00:00'))
                                choice_label = f"By {dt.strftime('%b %d, %Y')}"
                            except:
                                choice_label = "By " + settlement_date_str[:10] if settlement_date_str else choice_event.get('title', '')
                        else:
                            choice_label = choice_event.get('title', '')
                    
                    choice_yes = choice_event.get('yes_price', 0.5)
                    choice_no = choice_event.get('no_price', 0.5)
                    
                    choices.append({
                        "label": choice_label,
                        "market_ticker": choice_ticker,
                        "event_ticker": series_ticker,
                        "date_threshold": settlement_date_str,
                        "yes_percentage": f"{round(choice_yes * 100, 1)}%",
                        "no_percentage": f"{round(choice_no * 100, 1)}%",
                        "yes_probability": round(choice_yes * 100, 1),
                        "no_probability": round(choice_no * 100, 1),
                        "volume": choice_event.get('volume', 0)
                    })
            
            # Calculate total volume for series (sum of all choices)
            total_volume = sum(float(e.get('volume', 0) or 0) for e in series_events)
            
            formatted_events.append({
                "event_ticker": ticker if series_ticker not in ['KXBTCMAXY', 'KXBTCMINY'] else series_ticker,  # Use series ticker for "how" events
                "market_id": market_id,
                "title": base_event.get('title', ''),
                "series_ticker": series_ticker,
                "category": "Crypto",
                "yes_probability": round(yes_price * 100, 1) if yes_price else None,
                "no_probability": round(no_price * 100, 1) if no_price else None,
                "yes_percentage": f"{round(yes_price * 100, 1)}%" if yes_price else None,
                "no_percentage": f"{round(no_price * 100, 1)}%" if no_price else None,
                "volume_24h_usd": f"${total_volume:,.0f}",
                "volume_millions": f"${total_volume / 1_000_000:.1f}M" if total_volume >= 1_000_000 else f"${total_volume / 1_000:.1f}K",
                "settlement_date": base_event.get('expected_expiration_time', '') or base_event.get('settlement_date', ''),
                "days_until_settlement": None,
                "threshold_price": threshold_price,
                "choices": choices,
                "is_how_event": series_ticker in ['KXBTCMAXY', 'KXBTCMINY'],
                "is_when_event": series_ticker == 'KXBTCMAX150'
            })
            
            series_count += 1
        
        # Cache formatted events (with choices) for hedge quote matching
        app.state.btc_events = formatted_events
        logger.info("Cached formatted BTC events for hedge matching", count=len(formatted_events))
        
        return {
            "status": "success",
            "count": len(formatted_events),
            "events": formatted_events
        }
    except Exception as e:
        logger.error("Failed to fetch BTC top volume events", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch events: {str(e)}")


@app.post("/hedge/quote", response_model=HedgeQuoteResponse)
async def get_hedge_quote(request: HedgeQuoteRequest):
    """
    Get hedge quote for event + direction.
    
    Returns 1-3 hedge quotes with premium ≤ max_payout guaranteed.
    """
    try:
        # 1. Fetch events to find the requested one
        events = await event_fetcher.get_top_4_btc_events()
        
        # Find matching event
        event_dict = None
        
        # If choice_ticker provided, match by choice ticker
        if request.choice_ticker:
            for e in events:
                ticker = e.get('ticker', '') or e.get('event_ticker', '') or e.get('market_id', '')
                if ticker == request.choice_ticker:
                    event_dict = e
                    break
        else:
            # Match by event_ticker or series_ticker
            for e in events:
                ticker = e.get('ticker', '') or e.get('event_ticker', '') or e.get('market_id', '')
                series_ticker = e.get('series_ticker', '') or (ticker.split('-')[0] if '-' in ticker else ticker)
                
                # Match by full ticker, market_id, or series_ticker
                if (ticker == request.event_ticker or 
                    e.get('market_id') == request.event_ticker or
                    series_ticker == request.event_ticker or
                    ticker.startswith(request.event_ticker + '-') or
                    request.event_ticker in ticker):
                    event_dict = e
                    break
        
        if not event_dict:
            raise HTTPException(
                status_code=404,
                detail=f"Event not found: {request.event_ticker or request.choice_ticker}"
            )
        
        # 2. Parse event
        # If choice_threshold provided, use it instead of parsing from event
        canonical_event = event_parser.parse(event_dict)
        
        # Override threshold if choice_threshold provided
        if request.choice_threshold:
            canonical_event.threshold_price = request.choice_threshold
        
        # 3. Create hedge request
        hedge_request = kalshi_adapter.create_hedge_request(
            event=canonical_event,
            direction=request.direction,
            stake_usd=request.stake_usd,
            hedge_budget_usd=request.hedge_budget_usd
        )
        
        # 4. Fetch option chains from Deribit and OKX (parallel)
        import asyncio
        
        # Fetch chains with caching
        # For "when will" events or very short-term events, use more flexible expiry matching
        days_to_expiry = (canonical_event.expiry_date - date.today()).days
        if days_to_expiry <= 30:
            # Very short-term: allow up to 30 days flexibility
            min_days = max(1, days_to_expiry - 30)
            max_days = days_to_expiry + 30
        else:
            # Standard: ±14 days flexibility
            min_days = max(1, days_to_expiry - 14)
            max_days = days_to_expiry + 14
        
        cache_key = f"expiry-{canonical_event.expiry_date.isoformat()}-flex{min_days}-{max_days}"
        
        async def fetch_chains():
            chains = await option_chain_service.get_option_chains(
                underlying='BTC',
                expiry_date=canonical_event.expiry_date,
                min_days_to_expiry=min_days,
                max_days_to_expiry=max_days
            )
            return chains
        
        chains = await chain_cache.get(cache_key, fetch_chains, ttl_seconds=180)  # Increased cache TTL to 180s for better performance
        
        if not chains:
            # For "when will" events, provide more helpful error message
            if canonical_event.event_type == 'HIT':
                raise HTTPException(
                    status_code=503,
                    detail=f"No option chains available for expiry {canonical_event.expiry_date}. "
                           f"Searched for expiries between {min_days} and {max_days} days from today. "
                           f"Try a different date or check available option expiries."
                )
            else:
                raise HTTPException(
                    status_code=503,
                    detail=f"Option chains for expiry {canonical_event.expiry_date} not available"
                )
        
        # Group chains by venue
        chains_by_venue: Dict[str, List] = {}
        for chain in chains:
            venue = chain.exchange.lower()
            if venue not in chains_by_venue:
                chains_by_venue[venue] = []
            chains_by_venue[venue].append(chain)
        
        # 5. Build candidates for each venue (parallelize for better performance)
        candidates_by_venue = {}
        
        # Get spot price (use first chain's underlying price)
        spot_price = chains[0].underlying_price if chains else Decimal('100000')
        
        # Process venues in parallel for better performance
        async def build_candidate_for_venue(venue: str, venue_chains: List):
            """Build candidate for a single venue."""
            candidate = None
            # Try up to 8 alternative strikes (including wider spreads)
            # offset 0-1: Narrow spreads (adjacent strikes)
            # offset 2-3: Wider spreads (skip strikes for better ratio)
            # offset 4-7: Even wider spreads (prioritize by spread width for better ratios)
            for attempt in range(8):  # Increased to 8 to try even wider spreads
                strikes = strike_selector.find_strikes(
                    event_type=hedge_request['event_type'],
                    direction=hedge_request['direction'],
                    barrier=hedge_request['barrier'],
                    chains=venue_chains,
                    expiry_date=canonical_event.expiry_date,
                    try_alternatives=(attempt > 0),
                    alternative_offset=attempt
                )
                
                if not strikes:
                    break  # No more strikes to try
                
                K1, K2 = strikes
                
                # Build spread
                spread = spread_builder.build_spread(
                    K1=K1,
                    K2=K2,
                    option_type=hedge_request['insurance_type'],
                    chains=venue_chains,
                    expiry_date=canonical_event.expiry_date
                )
                
                if not spread:
                    continue  # Try next alternative
                
                # Calculate premium
                candidate = premium_calculator.calculate_and_scale(
                    spread=spread,
                    spot_price=spot_price,
                    user_budget=hedge_request['user_hedge_budget_usd'],
                    user_stake=hedge_request['user_stake_usd']
                )
                
                if candidate:
                    # Found valid candidate with good ratio
                    break  # Success, stop trying alternatives
            
            return venue, candidate
        
        # Process all venues in parallel
        venue_tasks = [build_candidate_for_venue(venue, venue_chains) for venue, venue_chains in chains_by_venue.items()]
        venue_results = await asyncio.gather(*venue_tasks, return_exceptions=True)
        
        for result in venue_results:
            if isinstance(result, Exception):
                logger.debug("Failed to build candidate for venue", error=str(result))
                continue
            venue, candidate = result
            if candidate:
                candidates_by_venue[venue] = candidate
        
        if not candidates_by_venue:
            return HedgeQuoteResponse(hedges=[])
        
        # 6. Optimize across venues
        optimized = venue_optimizer.optimize(candidates_by_venue)
        
        # 7. Format response
        hedges = []
        for opt in optimized:
            spread = opt['spread']
            raw_premium = opt.get('raw_premium_usd', opt.get('premium_usd', Decimal('0')))
            charged_premium = opt.get('charged_premium_usd', opt.get('premium_usd', Decimal('0')))
            markup = opt.get('markup_usd', Decimal('0'))
            legs = []
            
            for leg_data in spread['legs']:
                legs.append(HedgeLeg(
                    type=leg_data['type'],
                    strike=leg_data['strike'],
                    side=leg_data['side'],
                    notional_btc=opt['notional_btc']
                ))
            
            # Create description
            event_type = hedge_request['event_type']
            direction = hedge_request['direction']
            barrier = hedge_request['barrier']
            
            if event_type == 'BELOW':
                if direction == 'yes':
                    description = f"If BTC finishes above ${barrier:,.0f} and your 'Below ${barrier:,.0f}' bet loses, this call spread can pay up to ${opt['max_payout_usd']:,.2f}."
                else:
                    description = f"If BTC finishes at or below ${barrier:,.0f} and your 'Below ${barrier:,.0f}' bet loses, this put spread can pay up to ${opt['max_payout_usd']:,.2f}."
            elif event_type == 'ABOVE':
                if direction == 'yes':
                    description = f"If BTC finishes below ${barrier:,.0f} and your 'Above ${barrier:,.0f}' bet loses, this put spread can pay up to ${opt['max_payout_usd']:,.2f}."
                else:
                    description = f"If BTC finishes at or above ${barrier:,.0f} and your 'Above ${barrier:,.0f}' bet loses, this call spread can pay up to ${opt['max_payout_usd']:,.2f}."
            else:  # HIT
                description = f"If BTC {'hits' if direction == 'no' else 'does not hit'} ${barrier:,.0f} and your bet loses, this call spread can pay up to ${opt['max_payout_usd']:,.2f}."
            
            hedges.append(HedgeQuote(
                label=opt['label'],
                premium_usd=charged_premium,  # Charged premium for backward compatibility
                raw_premium_usd=raw_premium,
                charged_premium_usd=charged_premium,
                markup_usd=markup,
                max_payout_usd=opt['max_payout_usd'],
                venue=opt['venue'],
                legs=legs,
                description=description
            ))
        
        return HedgeQuoteResponse(hedges=hedges)
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get hedge quote", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get hedge quote: {str(e)}")


@app.get("/kalshi/hedge-quote")
async def get_kalshi_hedge_quote(
    event_id: str,
    direction: str,
    stake: float = 100.0
):
    """
    Get hedge quote endpoint matching frontend expectations.
    
    Frontend calls this endpoint and expects:
    - status: 'available' or 'hedge_unavailable'
    - candidates: array of hedge options with tier, premium_usd, max_payout_usd
    """
    try:
        # Add comprehensive logging
        logger.info("Received hedge quote request", event_id=event_id, direction=direction, stake=stake)
        
        # CRITICAL: Ensure cache is ALWAYS populated before processing
        # This prevents failures when hedge requests come before events are loaded
        if not hasattr(app.state, 'btc_events') or not app.state.btc_events:
            logger.info("BTC events cache not populated, fetching now to ensure reliability")
            try:
                app.state.btc_events = await event_fetcher.get_top_4_btc_events()
                logger.info(f"Cache populated with {len(app.state.btc_events)} events")
            except Exception as e:
                logger.error(f"Failed to populate cache: {e}", exc_info=True)
                # Continue anyway - will try fallback matching
        
        # Parse event_id to extract event_ticker and optional choice info
        # Frontend sends base ticker like "KXBTCMAXY-25" for "how" events
        # OR full ticker like "KXBTCMAXY-25-DEC31-129999.99" if choice is specified
        parts = event_id.split('-')
        event_ticker_base = parts[0] if parts else event_id
        
        choice_ticker = None
        choice_threshold = None
        event_ticker_for_matching = event_id
        
        logger.debug("Parsed event_id", parts=parts, base=event_ticker_base)
        
        # Check if this is a full ticker with threshold price (last part is a number > 1000)
        # OR a base ticker for "how" events (like "KXBTCMAXY-25" where 25 is year, not threshold)
        if len(parts) >= 2:
            try:
                threshold_val = float(parts[-1])
                if threshold_val > 1000:  # Reasonable BTC price threshold (> $1000)
                    # This is a full ticker with price threshold
                    choice_threshold = threshold_val
                    choice_ticker = event_id
                    # Full ticker format - use as-is
                    event_ticker_for_matching = event_id
                    logger.info("Detected full ticker with threshold", event_id=event_id, threshold=threshold_val)
                elif event_ticker_base in ['KXBTCMAXY', 'KXBTCMINY'] and len(parts) == 2:
                    # Last part is a number but <= 1000, and it's a "how" event base ticker
                    # This means it's a year (like "25" for 2025), not a threshold
                    # Frontend sent base ticker like "KXBTCMAXY-25"
                    # Will match below after try/except
                    logger.info("Detected base ticker with year suffix", event_id=event_id, base=event_ticker_base)
            except ValueError:
                # Last part is not a number, could be a base ticker for "how" events
                pass
        
        # Handle base ticker matching for "how" events (both numeric year suffix and non-numeric)
        if event_ticker_base in ['KXBTCMAXY', 'KXBTCMINY'] and len(parts) == 2 and not choice_ticker:
            # Frontend sent base ticker like "KXBTCMAXY-25"
            # Find matching event from cached events and use first choice's threshold
            logger.info("Matching base ticker for 'how' event", event_id=event_id, base=event_ticker_base)
            
            # Cache should be populated above, but double-check
            if not app.state.btc_events:
                logger.warning("Cache still empty after population attempt, trying fresh fetch")
                try:
                    app.state.btc_events = await event_fetcher.get_top_4_btc_events()
                except Exception as e:
                    logger.error(f"Failed to fetch events: {e}", exc_info=True)
            
            # Try multiple matching strategies
            matched = False
            logger.debug(f"Searching {len(app.state.btc_events)} cached events for series_ticker={event_ticker_base}")
            
            for cached_event in app.state.btc_events:
                # Strategy 1: Match by series_ticker
                series_ticker = cached_event.get('series_ticker', '')
                if not series_ticker:
                    # Extract from ticker
                    ticker = cached_event.get('ticker', '') or cached_event.get('event_ticker', '')
                    if ticker:
                        series_ticker = ticker.split('-')[0] if '-' in ticker else ticker
                
                logger.debug("Checking cached event", series_ticker=series_ticker, base=event_ticker_base, 
                           has_choices=bool(cached_event.get('choices')))
                
                if series_ticker == event_ticker_base:
                    # Try to get threshold from choices array first (formatted events)
                    choices = cached_event.get('choices', [])
                    if choices and len(choices) > 0:
                        # Use first choice's threshold (top choice)
                        first_choice = choices[0]
                        choice_threshold = first_choice.get('price_threshold') or first_choice.get('threshold_price')
                        choice_ticker = first_choice.get('market_ticker') or first_choice.get('ticker')
                        event_ticker_for_matching = cached_event.get('event_ticker') or series_ticker
                        
                        # Validate threshold
                        if choice_threshold:
                            try:
                                choice_threshold = float(choice_threshold)
                                if choice_threshold > 1000:  # Valid BTC price
                                    logger.info("✅ Matched 'how' event from cache (formatted)", 
                                              series_ticker=series_ticker,
                                              choice_threshold=choice_threshold,
                                              choice_ticker=choice_ticker)
                                    matched = True
                                    break
                                else:
                                    logger.warning(f"Invalid threshold from choices: {choice_threshold}")
                            except (ValueError, TypeError):
                                logger.warning(f"Could not convert threshold to float: {choice_threshold}")
                        else:
                            logger.warning("No threshold found in first choice")
                    
                    # Fallback: Extract threshold directly from raw event's ticker
                    # Raw events don't have choices array, but ticker has threshold
                    if not matched:
                        ticker = cached_event.get('ticker', '') or cached_event.get('event_ticker', '')
                        if ticker:
                            ticker_parts = ticker.split('-')
                            # Ticker format: KXBTCMAXY-25-DEC31-129999.99
                            # Threshold is last part if it's a number > 1000
                            if len(ticker_parts) >= 4:
                                try:
                                    threshold_val = float(ticker_parts[-1])
                                    if threshold_val > 1000:  # Reasonable BTC price threshold
                                        choice_threshold = threshold_val
                                        choice_ticker = ticker
                                        event_ticker_for_matching = ticker
                                        logger.info("✅ Matched 'how' event from cache (raw event, extracted from ticker)", 
                                                  series_ticker=series_ticker,
                                                  choice_threshold=choice_threshold,
                                                  choice_ticker=choice_ticker)
                                        matched = True
                                        break
                                except (ValueError, IndexError) as e:
                                    logger.debug(f"Could not extract threshold from ticker: {ticker}, error: {e}")
                            
                            # Also try threshold_price field if available
                            if not matched and cached_event.get('threshold_price'):
                                try:
                                    threshold_val = float(cached_event.get('threshold_price'))
                                    if threshold_val > 1000:
                                        choice_threshold = threshold_val
                                        choice_ticker = ticker
                                        event_ticker_for_matching = ticker
                                        logger.info("✅ Matched 'how' event from cache (raw event, using threshold_price field)", 
                                                  series_ticker=series_ticker,
                                                  choice_threshold=choice_threshold,
                                                  choice_ticker=choice_ticker)
                                        matched = True
                                        break
                                except (ValueError, TypeError):
                                    logger.warning(f"Invalid threshold_price field: {cached_event.get('threshold_price')}")
            
            if not matched:
                logger.warning("Failed to match base ticker from cache, trying fresh fetch fallback", 
                             event_id=event_id, 
                             base=event_ticker_base, 
                             cached_count=len(app.state.btc_events))
                # Try fallback: fetch fresh events and update cache
                try:
                    fresh_events = await event_fetcher.get_top_4_btc_events()
                    # Update cache for future requests
                    app.state.btc_events = fresh_events
                    logger.info(f"Updated cache with {len(fresh_events)} fresh events")
                    
                    # Find first event with matching series_ticker
                    for event in fresh_events:
                        ticker = event.get('ticker', '') or event.get('event_ticker', '')
                        series_ticker = ticker.split('-')[0] if '-' in ticker else ''
                        
                        if series_ticker == event_ticker_base:
                            # Extract threshold from ticker
                            ticker_parts = ticker.split('-')
                            if len(ticker_parts) >= 4:
                                try:
                                    threshold_val = float(ticker_parts[-1])
                                    if threshold_val > 1000:  # Reasonable BTC price threshold
                                        choice_threshold = threshold_val
                                        choice_ticker = ticker
                                        event_ticker_for_matching = ticker
                                        logger.info("✅ Matched via fresh fetch fallback (from ticker)", 
                                                  series_ticker=event_ticker_base,
                                                  choice_threshold=choice_threshold,
                                                  choice_ticker=choice_ticker)
                                        matched = True
                                        break
                                except (ValueError, IndexError) as e:
                                    logger.debug(f"Could not extract threshold from ticker: {ticker}, error: {e}")
                            
                            # Also try threshold_price field if available
                            if not matched and event.get('threshold_price'):
                                try:
                                    threshold_val = float(event.get('threshold_price'))
                                    if threshold_val > 1000:
                                        choice_threshold = threshold_val
                                        choice_ticker = ticker
                                        event_ticker_for_matching = ticker
                                        logger.info("✅ Matched via fresh fetch fallback (using threshold_price)", 
                                                  series_ticker=event_ticker_base,
                                                  choice_threshold=choice_threshold,
                                                  choice_ticker=choice_ticker)
                                        matched = True
                                        break
                                except (ValueError, TypeError):
                                    logger.warning(f"Invalid threshold_price field: {event.get('threshold_price')}")
                except Exception as e:
                    logger.error(f"Error in fallback matching: {e}", exc_info=True)
            
            # Final validation: ensure we have a valid threshold
            if matched and choice_threshold:
                try:
                    choice_threshold = float(choice_threshold)
                    if choice_threshold <= 1000:
                        logger.warning(f"Threshold too low, likely invalid: {choice_threshold}")
                        matched = False
                        choice_threshold = None
                except (ValueError, TypeError):
                    logger.warning(f"Invalid threshold value: {choice_threshold}")
                    matched = False
                    choice_threshold = None
            
            if not matched:
                logger.error(f"❌ Failed to match '{event_ticker_base}' event after all attempts. "
                           f"Cache had {len(app.state.btc_events)} events. "
                           f"Available series: {[e.get('series_ticker', e.get('ticker', '').split('-')[0] if '-' in e.get('ticker', '') else '') for e in app.state.btc_events[:5]]}")
        
        # For simple events like KXBTC2025100, use the full ticker if it has multiple parts
        if event_ticker_base.startswith('KXBTC') and len(parts) >= 2 and not choice_ticker:
            event_ticker_for_matching = event_id
        
        logger.info("Creating hedge request", 
                   event_ticker=event_ticker_for_matching,
                   choice_ticker=choice_ticker,
                   choice_threshold=choice_threshold,
                   direction=direction)
        
        # Validate that we have required data for "how" events
        if event_ticker_base in ['KXBTCMAXY', 'KXBTCMINY'] and not choice_threshold:
            logger.warning(f"⚠️ No threshold found for '{event_ticker_base}' event. "
                         f"This may cause hedge quote to fail. "
                         f"Will attempt to extract from event during parsing.")
        
        # Create hedge request
        hedge_request = HedgeQuoteRequest(
            event_ticker=event_ticker_for_matching,  # Use full ticker for better matching
            direction=direction,
            stake_usd=Decimal(str(stake)),
            hedge_budget_usd=Decimal(str(stake * 0.2)),  # Default 20% of stake
            choice_ticker=choice_ticker if choice_ticker else None,
            choice_threshold=Decimal(str(choice_threshold)) if choice_threshold else None
        )
        
        # Call the main hedge quote endpoint logic
        hedge_response = await get_hedge_quote(hedge_request)
        
        logger.info("Hedge quote response", 
                   hedge_count=len(hedge_response.hedges),
                   status="available" if hedge_response.hedges else "unavailable")
        
        # Convert to frontend-expected format
        if not hedge_response.hedges or len(hedge_response.hedges) == 0:
            # Provide more specific rejection reasons
            rejection_reasons = {"no_options": ["No suitable hedge options found"]}
            
            # Add specific reason based on event type and direction
            # Note: hedge_request is not available here, need to extract from canonical_event
            # For now, use the event_ticker_for_matching to determine event type
            if 'MAXY' in event_ticker_for_matching and direction == 'no':
                # ABOVE event + NO
                rejection_reasons["strike_availability"] = [
                    f"No CALL strikes available above the threshold with sufficient liquidity. "
                    f"CALL strikes above the barrier are required to hedge a NO bet on 'above' events."
                ]
            elif 'MINY' in event_ticker_for_matching and direction == 'no':
                # BELOW event + NO
                rejection_reasons["strike_availability"] = [
                    f"No PUT strikes available at/below the threshold with valid prices. "
                    f"PUT strikes at or below the barrier are required to hedge a NO bet on 'below' events."
                ]
            
            return {
                "status": "hedge_unavailable",
                "candidates": [],
                "rejection_reasons": rejection_reasons
            }
        
        # Map hedges to candidates format
        candidates = []
        tier_names = ["Light protection", "Standard protection", "Max protection"]
        
        for idx, hedge in enumerate(hedge_response.hedges):
            # Extract strikes from legs
            strikes = [float(leg.strike) for leg in hedge.legs]
            
            candidates.append({
                "tier": tier_names[idx] if idx < len(tier_names) else hedge.label,
                "premium_usd": float(hedge.charged_premium_usd or hedge.premium_usd),  # Use charged premium
                "raw_premium_usd": float(hedge.raw_premium_usd or hedge.premium_usd),
                "charged_premium_usd": float(hedge.charged_premium_usd or hedge.premium_usd),
                "markup_usd": float(hedge.markup_usd or 0.0),
                "max_payout_usd": float(hedge.max_payout_usd),
                "description": hedge.description,
                "notional": float(hedge.legs[0].notional_btc) if hedge.legs else 0.0,
                "strikes": strikes,
                "venue": hedge.venue
            })
        
        return {
            "status": "available",
            "candidates": candidates,
            "rejection_reasons": {}
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get Kalshi hedge quote", error=str(e), exc_info=True)
        return {
            "status": "hedge_unavailable",
            "candidates": [],
            "rejection_reasons": {
                "error": [str(e)]
            }
        }


# Serve static frontend files AFTER all API routes are registered
# This allows the frontend to be served from the same domain as the API
import os
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Get frontend dist directory from environment or use default
frontend_root = os.getenv("KALSHI_DEMO_FRONTEND_ROOT", None)
logger.info(f"KALSHI_DEMO_FRONTEND_ROOT from env: {frontend_root}")

# Try multiple paths in order of preference
candidate_paths = []

if frontend_root:
    # First try: Use environment variable if set
    candidate_paths.append(Path(frontend_root))

# Second try: Absolute path (for Render)
candidate_paths.append(Path("/opt/render/project/src/kalshi_demo_v2/frontend/dist"))

# Third try: Relative to this file (api/main.py -> ../frontend/dist)
current_dir = Path(__file__).parent
candidate_paths.append(current_dir.parent / "frontend" / "dist")

# Fourth try: Relative to current working directory
candidate_paths.append(Path("frontend/dist").resolve())

# Fifth try: Relative to kalshi_demo_v2 directory from cwd
candidate_paths.append(Path("kalshi_demo_v2/frontend/dist").resolve())

frontend_path = None
for candidate in candidate_paths:
    resolved = candidate.resolve() if not candidate.is_absolute() else candidate
    logger.info(f"Trying frontend path: {resolved}, exists: {resolved.exists()}")
    if resolved.exists() and resolved.is_dir():
        frontend_path = resolved
        logger.info(f"✅ Found frontend at: {frontend_path}")
        break

if not frontend_path:
    # None of the paths worked
    frontend_path = Path("/opt/render/project/src/kalshi_demo_v2/frontend/dist")
    logger.warning(f"⚠️ Frontend not found in any candidate path, using default: {frontend_path}")

logger.info(f"Checking frontend at: {frontend_path}, exists: {frontend_path.exists()}, cwd: {os.getcwd()}")
logger.info(f"KALSHI_DEMO_FRONTEND_ROOT env var: {os.getenv('KALSHI_DEMO_FRONTEND_ROOT', 'NOT SET')}")

# List contents of potential frontend directories for debugging
if not frontend_path.exists():
    # Check if kalshi_demo_v2 directory exists
    base_dir = Path("/opt/render/project/src/kalshi_demo_v2")
    if base_dir.exists():
        logger.info(f"kalshi_demo_v2 base dir exists: {base_dir}")
        try:
            logger.info(f"kalshi_demo_v2 contents: {[str(p.name) for p in base_dir.iterdir()][:20]}")
        except Exception as e:
            logger.warning(f"Could not list kalshi_demo_v2 contents: {e}")
        
        frontend_dir = base_dir / "frontend"
        if frontend_dir.exists():
            logger.info(f"frontend dir exists: {frontend_dir}")
            try:
                logger.info(f"frontend dir contents: {[str(p.name) for p in frontend_dir.iterdir()][:20]}")
            except Exception as e:
                logger.warning(f"Could not list frontend contents: {e}")
            
            dist_dir = frontend_dir / "dist"
            logger.info(f"dist dir exists: {dist_dir.exists()}")
            if dist_dir.exists():
                try:
                    logger.info(f"dist dir contents: {[str(p.name) for p in dist_dir.iterdir()][:20]}")
                except Exception as e:
                    logger.warning(f"Could not list dist contents: {e}")
        else:
            logger.warning(f"frontend dir does not exist: {frontend_dir}")
    else:
        logger.warning(f"kalshi_demo_v2 base dir does not exist: {base_dir}")
        # Check project root
        project_root = Path("/opt/render/project/src")
        if project_root.exists():
            try:
                logger.info(f"Project root contents: {[str(p.name) for p in project_root.iterdir()][:20]}")
            except Exception as e:
                logger.warning(f"Could not list project root contents: {e}")

if frontend_path.exists() and frontend_path.is_dir():
    logger.info(f"Frontend found - setting up static file serving from {frontend_path}")
    
    # Serve static assets (JS, CSS, images, etc.)
    assets_dir = frontend_path / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")
        logger.info(f"Mounted assets directory: {assets_dir}")
    
    # CRITICAL: Define root route FIRST, before catch-all route
    # FastAPI matches routes in order, so specific routes must come before catch-all
    @app.get("/", include_in_schema=False)
    async def serve_frontend_root():
        """Serve frontend for root route."""
        index_path = frontend_path / "index.html"
        logger.info(f"🔵 Root route handler called - checking index.html at {index_path}, exists: {index_path.exists()}")
        if index_path.exists():
            logger.info(f"✅ Serving frontend index.html from {index_path}")
            try:
                response = FileResponse(
                    str(index_path),
                    media_type="text/html",
                    headers={"Cache-Control": "no-cache"}
                )
                logger.info(f"✅ FileResponse created successfully")
                return response
            except Exception as e:
                logger.error(f"❌ Error serving index.html: {e}", exc_info=True)
                return {"message": "Kalshi Demo V2 API", "version": "2.0.0", "frontend": "error", "error": str(e)}
        logger.warning(f"❌ Frontend index.html not found at {index_path}")
        # List what's actually in the dist folder
        try:
            dist_contents = list(frontend_path.iterdir())
            logger.warning(f"Dist folder contents: {[str(p.name) for p in dist_contents]}")
        except Exception as e:
            logger.warning(f"Could not list dist contents: {e}")
        return {"message": "Kalshi Demo V2 API", "version": "2.0.0", "frontend": "index_not_found", "frontend_path": str(frontend_path)}
    
    # Serve index.html for all other non-API routes (SPA routing)
    # This must be LAST to avoid catching API routes or root route
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """
        Serve frontend files. If path doesn't exist, serve index.html (for SPA routing).
        """
        # Don't serve root route - that's handled by serve_frontend_root() above
        if full_path == "" or full_path == "/":
            logger.warning("⚠️ Catch-all route intercepted root - this shouldn't happen!")
            index_file = frontend_path / "index.html"
            if index_file.exists():
                return FileResponse(str(index_file), media_type="text/html")
            raise HTTPException(status_code=404, detail="Root route should be handled by serve_frontend_root")
        
        # Don't serve API routes through this handler
        if full_path.startswith(("api/", "events", "hedge", "kalshi", "cache", "health")):
            raise HTTPException(status_code=404, detail="Not found")
        
        # Don't serve assets here - they're handled by the mount above
        if full_path.startswith("assets/"):
            raise HTTPException(status_code=404, detail="Asset not found")
        
        # Try to serve the requested file
        file_path = frontend_path / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        
        # For SPA routing, serve index.html for all other routes
        index_file = frontend_path / "index.html"
        if index_file.exists():
            return FileResponse(
                str(index_file),
                media_type="text/html",
                headers={"Cache-Control": "no-cache"}
            )
        
        raise HTTPException(status_code=404, detail="Frontend not found")
else:
    logger.warning(f"Frontend directory not found at {frontend_path} - static file serving disabled")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

