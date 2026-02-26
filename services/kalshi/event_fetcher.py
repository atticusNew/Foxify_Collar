"""
Event Fetcher - Fetch top 4 BTC events by volume
Simple, direct fetching focused on top volume events
"""
from decimal import Decimal
from typing import List, Dict, Optional, Any
from datetime import datetime

from connectors import get_exchange_registry
from connectors.kalshi_connector import KalshiConnector
from utils.logging import get_logger

logger = get_logger(__name__)


class EventFetcher:
    """
    Fetch top 4 BTC events by volume:
    1. How high (KXBTCMAXY)
    2. How low (KXBTCMINY)
    3. When will hit $150k (KXBTCMAX150)
    4. Will BTC price above $100k (KXBTC2025100)
    """
    
    # Target series tickers for top 4 events
    TARGET_SERIES = [
        'KXBTCMAXY',   # How high will Bitcoin get this year?
        'KXBTCMINY',   # How low will Bitcoin get this year?
        'KXBTCMAX150', # When will Bitcoin hit $150k?
        'KXBTC2025100' # Will Bitcoin be above $100k by Dec 31, 2025?
    ]
    
    def __init__(self, registry=None):
        """Initialize event fetcher."""
        self.registry = registry or get_exchange_registry()
        self._kalshi_connector: Optional[KalshiConnector] = None
    
    async def _ensure_kalshi_connector(self) -> KalshiConnector:
        """Ensure Kalshi connector is initialized and connected."""
        connector = self.registry.connectors.get('kalshi')
        
        if not connector:
            connector = await self.registry.initialize_exchange('kalshi')
        
        if not connector.is_connected():
            await connector.connect()
        elif connector.session and connector.session.closed:
            await connector.disconnect()
            await connector.connect()
        
        return connector
    
    async def get_top_4_btc_events(self) -> List[Dict[str, Any]]:
        """
        Fetch top 4 BTC events by volume.
        
        Returns:
            List of 4 events (one per series) with highest volume
        """
        connector = await self._ensure_kalshi_connector()
        
        all_events = []
        
        # Fetch markets for each target series
        import asyncio
        for idx, series_ticker in enumerate(self.TARGET_SERIES):
            # Add delay between requests to avoid rate limiting
            if idx > 0:
                await asyncio.sleep(0.5)  # 500ms delay
            
            try:
                # Fetch markets for this series
                series_markets = await connector.fetch_markets(
                    category=None,
                    ticker_prefix=series_ticker,
                    max_pages=10  # Limit pages for performance
                )
                
                if series_markets:
                    logger.info(
                        f"Fetched markets for {series_ticker}",
                        count=len(series_markets),
                        sample_titles=[m.get('title', 'N/A')[:50] for m in series_markets[:3]]
                    )
                    all_events.extend(series_markets)
            except Exception as e:
                logger.warning(
                    f"Error fetching markets for {series_ticker}",
                    error=str(e)
                )
        
        # Extract YES/NO prices from market data or fetch ticker
        async def fetch_prices_for_event(event):
            """
            Extract YES/NO prices from event data.
            First checks market data fields, then fetches ticker if needed.
            """
            # Step 1: Check if market data already has prices
            yes_price = None
            no_price = None
            
            # Try direct price fields first (most common)
            yes_price_raw = event.get('yes_price') or event.get('yes_ask') or event.get('probability')
            no_price_raw = event.get('no_price') or event.get('no_ask')
            
            if yes_price_raw is not None:
                try:
                    yes_price_raw = float(yes_price_raw)
                    # Handle different formats: 0-1 vs 0-100
                    yes_price = yes_price_raw / 100.0 if yes_price_raw > 1 else yes_price_raw
                except (ValueError, TypeError):
                    pass
            
            if no_price_raw is not None:
                try:
                    no_price_raw = float(no_price_raw)
                    # Handle different formats: 0-1 vs 0-100
                    no_price = no_price_raw / 100.0 if no_price_raw > 1 else no_price_raw
                except (ValueError, TypeError):
                    pass
            
            # Step 2: Try bid/ask fields
            if yes_price is None:
                yes_bid = event.get('yes_bid')
                yes_ask = event.get('yes_ask')
                if yes_bid is not None or yes_ask is not None:
                    try:
                        bid_val = float(yes_bid) if yes_bid else 0
                        ask_val = float(yes_ask) if yes_ask else 0
                        # Use mid-price if both available, otherwise use available one
                        if bid_val > 0 and ask_val > 0:
                            yes_price_raw = (bid_val + ask_val) / 2.0
                        elif ask_val > 0:
                            yes_price_raw = ask_val
                        elif bid_val > 0:
                            yes_price_raw = bid_val
                        else:
                            yes_price_raw = None
                        
                        if yes_price_raw is not None:
                            yes_price = yes_price_raw / 100.0 if yes_price_raw > 1 else yes_price_raw
                    except (ValueError, TypeError):
                        pass
            
            if no_price is None:
                no_bid = event.get('no_bid')
                no_ask = event.get('no_ask')
                if no_bid is not None or no_ask is not None:
                    try:
                        bid_val = float(no_bid) if no_bid else 0
                        ask_val = float(no_ask) if no_ask else 0
                        # Use mid-price if both available, otherwise use available one
                        if bid_val > 0 and ask_val > 0:
                            no_price_raw = (bid_val + ask_val) / 2.0
                        elif ask_val > 0:
                            no_price_raw = ask_val
                        elif bid_val > 0:
                            no_price_raw = bid_val
                        else:
                            no_price_raw = None
                        
                        if no_price_raw is not None:
                            no_price = no_price_raw / 100.0 if no_price_raw > 1 else no_price_raw
                    except (ValueError, TypeError):
                        pass
            
            # Step 3: If still no prices, fetch ticker
            if yes_price is None or no_price is None:
                try:
                    market_id = event.get('market_id') or event.get('ticker') or event.get('event_ticker')
                    if market_id:
                        ticker_data = await connector.fetch_ticker(market_id)
                        ticker_yes = ticker_data.get('yes_price')
                        ticker_no = ticker_data.get('no_price')
                        
                        if ticker_yes is not None and yes_price is None:
                            yes_price = float(ticker_yes)
                        if ticker_no is not None and no_price is None:
                            no_price = float(ticker_no)
                except Exception as e:
                    logger.debug(
                        "Failed to fetch ticker for event",
                        market_id=market_id,
                        error=str(e)
                    )
            
            # Step 4: Final fallback - calculate from yes_price or default to 50/50
            if yes_price is None:
                yes_price = 0.5
            if no_price is None:
                no_price = 1.0 - yes_price if yes_price else 0.5
            
            # Step 5: Normalize probabilities (ensure 0-1 range and sum to 1.0)
            yes_price = max(0.0, min(1.0, float(yes_price)))
            no_price = max(0.0, min(1.0, float(no_price)))
            
            # Normalize if they don't sum to 1.0
            total = yes_price + no_price
            if total > 0:
                yes_price = yes_price / total
                no_price = no_price / total
            else:
                # Fallback if both are 0
                yes_price = 0.5
                no_price = 0.5
            
            event['yes_price'] = yes_price
            event['no_price'] = no_price
            
            logger.debug(
                "Extracted prices for event",
                market_id=event.get('market_id', 'N/A'),
                yes_price=yes_price,
                no_price=no_price,
                source="market_data" if (yes_price_raw or no_price_raw) else "ticker"
            )
            
            return event
        
        # Extract prices from market data or fetch tickers in parallel
        events_with_prices = []
        batch_size = 10
        for i in range(0, len(all_events), batch_size):
            batch = all_events[i:i + batch_size]
            batch_results = await asyncio.gather(*[fetch_prices_for_event(e) for e in batch])
            events_with_prices.extend(batch_results)
            # Small delay between batches (only if we need to fetch tickers)
            if i + batch_size < len(all_events):
                await asyncio.sleep(0.2)
        
        all_events = events_with_prices
        
        # Sort by volume (descending) and select top 1 per series
        # Group by series ticker
        events_by_series: Dict[str, List[Dict]] = {}
        
        for event in all_events:
            # Extract series ticker from event ticker or market_id
            ticker = event.get('ticker', '') or event.get('event_ticker', '') or event.get('market_id', '')
            
            # Find matching series
            for series in self.TARGET_SERIES:
                if ticker.startswith(series):
                    if series not in events_by_series:
                        events_by_series[series] = []
                    events_by_series[series].append(event)
                    break
        
        # For "how" events (KXBTCMAXY, KXBTCMINY), return all choices
        # For other events, return top event per series
        result_events = []
        
        for series in self.TARGET_SERIES:
            if series not in events_by_series:
                continue
                
            series_events = events_by_series[series]
            # Sort by volume (descending)
            series_events.sort(
                key=lambda e: float(e.get('volume', 0) or 0),
                reverse=True
            )
            
            # For "how" events, return top 2 choices by volume
            if series in ['KXBTCMAXY', 'KXBTCMINY']:
                # Return top 2 choices for "how" events
                top_choices = series_events[:2]
                result_events.extend(top_choices)
                logger.info(
                    f"Selected top {len(top_choices)} choices for {series}",
                    count=len(top_choices),
                    sample_tickers=[e.get('ticker', 'N/A')[:30] for e in top_choices[:2]]
                )
            elif series == 'KXBTCMAX150':
                # For "when will" events, return top 2 date variants by volume
                top_dates = series_events[:2]  # Top 2 date choices
                result_events.extend(top_dates)
                logger.info(
                    f"Selected top {len(top_dates)} date choices for {series}",
                    count=len(top_dates),
                    sample_tickers=[e.get('ticker', 'N/A')[:30] for e in top_dates[:2]]
                )
            else:
                # For other events, return top event only
                top_event = series_events[0]
                result_events.append(top_event)
                logger.info(
                    f"Selected top event for {series}",
                    ticker=top_event.get('ticker', 'N/A'),
                    volume=top_event.get('volume', 0),
                    title=top_event.get('title', 'N/A')[:50]
                )
        
        logger.info(
            "Fetched BTC events",
            total_events=len(result_events),
            series_found=[e.get('ticker', 'N/A').split('-')[0] if '-' in e.get('ticker', '') else 'N/A' for e in result_events]
        )
        
        return result_events

