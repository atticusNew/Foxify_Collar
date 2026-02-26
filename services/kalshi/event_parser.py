"""
Event Parser - Parse Kalshi event to canonical format
Extracts event type, threshold, expiry from Kalshi event
"""
from decimal import Decimal
from typing import Dict, Optional
from datetime import date, datetime
from dataclasses import dataclass
import re

from utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class CanonicalEvent:
    """Canonical event structure."""
    event_type: str  # 'BELOW', 'ABOVE', 'HIT'
    threshold_price: Decimal  # K (barrier level)
    expiry_date: date  # T (settlement date)
    series_ticker: str  # e.g., "KXBTCMAXY"
    event_ticker: str  # Full event ticker
    title: str  # Event title
    market_id: Optional[str] = None


class EventParser:
    """
    Parse Kalshi event to canonical format.
    
    Handles:
    - BELOW: "Below $80k" events
    - ABOVE: "Above $130k" events
    - HIT: "Hit $150k" events (one-touch)
    """
    
    def parse(self, event: Dict) -> CanonicalEvent:
        """
        Parse Kalshi event to canonical format.
        
        Args:
            event: Kalshi event dictionary
            
        Returns:
            CanonicalEvent: Parsed event structure
        """
        title = event.get('title', '') or event.get('event_title', '')
        ticker = event.get('ticker', '') or event.get('event_ticker', '') or event.get('market_id', '')
        market_id = event.get('market_id', '')
        
        # Extract series ticker (first part before dash)
        series_ticker = ticker.split('-')[0] if '-' in ticker else ticker
        
        # Parse event type and threshold
        event_type, threshold_price = self._parse_event_type_and_threshold(title, ticker, series_ticker)
        
        # Parse expiry date
        expiry_date = self._parse_expiry_date(event)
        
        return CanonicalEvent(
            event_type=event_type,
            threshold_price=threshold_price,
            expiry_date=expiry_date,
            series_ticker=series_ticker,
            event_ticker=ticker,
            title=title,
            market_id=market_id
        )
    
    def _parse_event_type_and_threshold(
        self,
        title: str,
        ticker: str,
        series_ticker: str
    ) -> tuple[str, Decimal]:
        """
        Parse event type and threshold price.
        
        Returns:
            Tuple of (event_type, threshold_price)
        """
        title_lower = title.lower()
        
        # Check for "how high" events (KXBTCMAXY)
        if series_ticker == 'KXBTCMAXY' or 'how high' in title_lower:
            # Extract threshold from ticker or title
            # Ticker format: KXBTCMAXY-25-DEC31-130000
            threshold = self._extract_threshold_from_ticker(ticker, title)
            return ('ABOVE', threshold)
        
        # Check for "how low" events (KXBTCMINY)
        if series_ticker == 'KXBTCMINY' or 'how low' in title_lower:
            threshold = self._extract_threshold_from_ticker(ticker, title)
            return ('BELOW', threshold)
        
        # Check for "when will hit" events (KXBTCMAX150)
        if series_ticker == 'KXBTCMAX150' or ('when will' in title_lower and 'hit' in title_lower):
            # Extract target price (e.g., $150k)
            threshold = self._extract_price_from_title(title, default=Decimal('150000'))
            return ('HIT', threshold)
        
        # Check for "will BTC price" events (KXBTC2025100)
        if series_ticker.startswith('KXBTC') and 'above' in title_lower:
            threshold = self._extract_price_from_title(title, default=Decimal('100000'))
            return ('ABOVE', threshold)
        
        if series_ticker.startswith('KXBTC') and 'below' in title_lower:
            threshold = self._extract_price_from_title(title, default=Decimal('100000'))
            return ('BELOW', threshold)
        
        # Default: try to infer from title
        if 'above' in title_lower:
            threshold = self._extract_price_from_title(title, default=Decimal('100000'))
            return ('ABOVE', threshold)
        
        if 'below' in title_lower:
            threshold = self._extract_price_from_title(title, default=Decimal('100000'))
            return ('BELOW', threshold)
        
        if 'hit' in title_lower:
            threshold = self._extract_price_from_title(title, default=Decimal('150000'))
            return ('HIT', threshold)
        
        # Fallback: default to ABOVE with default threshold
        logger.warning(
            "Could not parse event type, defaulting to ABOVE",
            title=title,
            ticker=ticker
        )
        return ('ABOVE', Decimal('100000'))
    
    def _extract_threshold_from_ticker(self, ticker: str, title: str) -> Decimal:
        """Extract threshold price from ticker or title."""
        # Try to extract from ticker first (e.g., KXBTCMAXY-25-DEC31-130000)
        if '-' in ticker:
            parts = ticker.split('-')
            # Last part might be the threshold
            for part in reversed(parts):
                # Check if it's a number (price)
                try:
                    # Remove any non-numeric characters except decimal point
                    cleaned = re.sub(r'[^\d.]', '', part)
                    if cleaned:
                        price = Decimal(cleaned)
                        if price > 1000:  # Reasonable BTC price threshold
                            return price
                except (ValueError, TypeError):
                    continue
        
        # Fallback: extract from title
        return self._extract_price_from_title(title, default=Decimal('100000'))
    
    def _extract_price_from_title(self, title: str, default: Decimal = Decimal('100000')) -> Decimal:
        """Extract price from title (e.g., '$150k', '$100,000')."""
        # Look for price patterns: $150k, $100,000, $100k, etc.
        patterns = [
            r'\$(\d+)k',  # $150k
            r'\$(\d{1,3}(?:,\d{3})*(?:k)?)',  # $100,000 or $100k
            r'(\d+)k',  # 150k (without $)
        ]
        
        for pattern in patterns:
            match = re.search(pattern, title, re.IGNORECASE)
            if match:
                value_str = match.group(1).replace(',', '')
                try:
                    value = Decimal(value_str)
                    # If it's in thousands (k), multiply by 1000
                    if 'k' in match.group(0).lower():
                        value = value * 1000
                    if value > 1000:  # Reasonable BTC price
                        return value
                except (ValueError, TypeError):
                    continue
        
        return default
    
    def _parse_expiry_date(self, event: Dict) -> date:
        """Parse expiry date from event."""
        # Try multiple date fields
        expiry_str = (
            event.get('expected_expiration_time') or
            event.get('settlement_date') or
            event.get('expiry_date') or
            event.get('expiration_time')
        )
        
        if expiry_str:
            # Try ISO format first
            try:
                if isinstance(expiry_str, str):
                    # Handle ISO format with timezone
                    if 'T' in expiry_str:
                        dt = datetime.fromisoformat(expiry_str.replace('Z', '+00:00'))
                        return dt.date()
                    # Handle date-only format
                    return datetime.strptime(expiry_str, '%Y-%m-%d').date()
            except (ValueError, TypeError):
                pass
        
        # Try to extract from ticker (e.g., KXBTCMAXY-25-DEC31-130000)
        ticker = event.get('ticker', '') or event.get('event_ticker', '')
        if '-' in ticker:
            parts = ticker.split('-')
            # Look for date-like parts (DEC31, 2025-12-31, etc.)
            for part in parts:
                # Try DEC31 format
                if len(part) == 5 and part[:3].isalpha() and part[3:].isdigit():
                    try:
                        month_map = {
                            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4,
                            'MAY': 5, 'JUN': 6, 'JUL': 7, 'AUG': 8,
                            'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                        }
                        month_str = part[:3].upper()
                        day = int(part[3:])
                        if month_str in month_map:
                            # Assume current year or next year
                            year = datetime.now().year
                            if month_map[month_str] < datetime.now().month:
                                year += 1
                            return date(year, month_map[month_str], day)
                    except (ValueError, KeyError):
                        continue
        
        # Default: 1 year from now
        logger.warning(
            "Could not parse expiry date, defaulting to 1 year from now",
            event_ticker=ticker
        )
        from datetime import timedelta
        return date.today() + timedelta(days=365)

