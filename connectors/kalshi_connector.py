"""
Kalshi Exchange Connector
Event trading platform connector
Uses RSA private key for JWT authentication
"""
import aiohttp
import time
import base64
from decimal import Decimal
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from utils.logging import get_logger
from utils.error_handler import ExchangeConnectionError, ExchangeAPIError, ValidationError
from utils.decimal_utils import DecimalMath as DM
from .base_connector import ExchangeConnector

logger = get_logger(__name__)


class KalshiConnector(ExchangeConnector):
    """
    Kalshi exchange connector for event markets.
    
    Uses RSA private key for JWT authentication.
    """
    
    def __init__(
        self,
        exchange_name: str,
        config: Dict[str, Any],
        credentials: Dict[str, str]
    ):
        """Initialize Kalshi connector."""
        super().__init__(exchange_name, config, credentials)
        self.base_url = config.get('base_url', 'https://api.elections.kalshi.com/trade-api/v2')
        # Get API key from kalshi.toml config
        from configs.loader import get_config_loader
        kalshi_config = get_config_loader().get_kalshi_config()
        self.api_key = kalshi_config.get('api', {}).get('api_key', '0642c333-3349-4423-be5e-2dfdc48baabe')
        self.session: Optional[aiohttp.ClientSession] = None
        self._private_key = None
        self._load_private_key()
    
    def _load_private_key(self):
        """Load RSA private key from credentials. Optional for read-only operations."""
        private_key_str = self.credentials.get('private_key')
        if not private_key_str:
            logger.warning("Kalshi private key not found - read-only mode (some endpoints may require authentication)")
            self._private_key = None
            return
        
        try:
            # Load PEM private key
            # The key should be in PKCS#1 or PKCS#8 format
            self._private_key = load_pem_private_key(
                private_key_str.encode('utf-8'),
                password=None
            )
            logger.info("Loaded Kalshi RSA private key")
        except ValueError as exc:
            # If standard loading fails, the key might be in wrong format
            logger.error("Failed to load Kalshi private key - invalid format", error=str(exc))
            logger.warning("Continuing without private key - read-only mode")
            self._private_key = None
        except Exception as exc:
            logger.error("Failed to load Kalshi private key", error=str(exc))
            logger.warning("Continuing without private key - read-only mode")
            self._private_key = None
    
    def _generate_signature(self, timestamp: str, method: str, path: str) -> str:
        """
        Generate RSA-PSS signature for Kalshi API.
        
        Per Kalshi documentation:
        - Message format: timestamp + method + path_without_query
        - Signature: RSA-PSS-SHA256(message)
        - Salt length: DIGEST_LENGTH (per official docs)
        """
        if not self._private_key:
            raise ExchangeConnectionError(
                "Kalshi private key required for authenticated requests. Set KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH environment variable.",
                exchange=self.exchange_name
            )
        
        # Strip query parameters from path before signing (per Kalshi docs)
        path_without_query = path.split('?')[0]
        
        # Build signature string: timestamp + method + path (no newlines, no body)
        signature_string = f"{timestamp}{method}{path_without_query}"
        
        # Sign with RSA-PSS (using DIGEST_LENGTH as per official docs)
        signature = self._private_key.sign(
            signature_string.encode('utf-8'),
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH  # Per official Kalshi documentation
            ),
            hashes.SHA256()
        )
        
        # Base64 encode signature
        return base64.b64encode(signature).decode('utf-8')
    
    async def connect(self) -> bool:
        """Establish connection to Kalshi."""
        import asyncio
        
        try:
            # Close existing session if it exists and is from a different loop
            if self.session and not self.session.closed:
                try:
                    await self.session.close()
                except Exception:
                    pass  # Ignore errors when closing old session
            
            # Create new session in current event loop
            self.session = aiohttp.ClientSession()
            
            # Test connection with authenticated endpoint
            # Kalshi may have a health/status endpoint
            # For now, just mark as connected
            self.connected = True
            self.last_heartbeat = datetime.now(timezone.utc)
            
            logger.info(
                "Connected to Kalshi",
                exchange=self.exchange_name
            )
            return True
            
        except Exception as exc:
            logger.error(
                "Failed to connect to Kalshi",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeConnectionError(
                f"Failed to connect to Kalshi: {exc}",
                exchange=self.exchange_name
            )
    
    async def disconnect(self) -> bool:
        """Disconnect from Kalshi."""
        if self.session:
            await self.session.close()
            self.session = None
        
        self.connected = False
        logger.info("Disconnected from Kalshi", exchange=self.exchange_name)
        return True
    
    async def health_check(self) -> Dict[str, Any]:
        """Check Kalshi connectivity."""
        if not self.session:
            return {
                'status': 'down',
                'latency_ms': None,
                'last_successful_call': None,
                'error_count': 1
            }
        
        try:
            start_time = datetime.now(timezone.utc)
            # Use a simple endpoint to test connectivity
            path = "/trade-api/v2/portfolio/balance"
            headers = self._get_auth_headers('GET', path)
            async with self.session.get(
                f"{self.base_url}/portfolio/balance",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                latency_ms = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000
                
                if response.status == 200:
                    self.last_heartbeat = datetime.now(timezone.utc)
                    return {
                        'status': 'healthy',
                        'latency_ms': latency_ms,
                        'last_successful_call': self.last_heartbeat.isoformat(),
                        'error_count': 0
                    }
                else:
                    return {
                        'status': 'degraded',
                        'latency_ms': latency_ms,
                        'last_successful_call': self.last_heartbeat.isoformat() if self.last_heartbeat else None,
                        'error_count': 1
                    }
        except Exception as exc:
            logger.debug("Kalshi health check failed", error=str(exc))
            return {
                'status': 'down',
                'latency_ms': None,
                'last_successful_call': self.last_heartbeat.isoformat() if self.last_heartbeat else None,
                'error_count': 1
            }
    
    def _get_auth_headers(self, method: str, path: str) -> Dict[str, str]:
        """
        Generate authentication headers for Kalshi API.
        
        Per Kalshi documentation:
        - KALSHI-ACCESS-KEY: API Key ID
        - KALSHI-ACCESS-TIMESTAMP: Current time in milliseconds
        - KALSHI-ACCESS-SIGNATURE: RSA-PSS signature
        
        Signature format: timestamp + method + path_without_query
        
        Returns empty headers if no private key is available (for public endpoints).
        """
        if not self._private_key:
            # Return minimal headers for public endpoints
            return {
                'Content-Type': 'application/json',
            }
        
        timestamp = str(int(time.time() * 1000))  # Milliseconds
        signature = self._generate_signature(timestamp, method, path)
        
        return {
            'KALSHI-ACCESS-KEY': self.api_key,
            'KALSHI-ACCESS-TIMESTAMP': timestamp,
            'KALSHI-ACCESS-SIGNATURE': signature,
            'Content-Type': 'application/json',
        }
    
    async def _raw_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict] = None,
        data: Optional[Dict] = None,
        max_retries: int = 3
    ) -> Dict[str, Any]:
        """Make raw HTTP request to Kalshi API with exponential backoff for rate limits."""
        import asyncio
        
        if not self.session:
            raise ExchangeConnectionError(
                "Not connected to Kalshi",
                exchange=self.exchange_name
            )
        
        url = f"{self.base_url}/{endpoint}"
        
        # Build path for signature (per Kalshi docs: strip query params before signing)
        # Format: /trade-api/v2/endpoint (full path without query params)
        # Extract path from base_url (e.g., /trade-api/v2) and append endpoint
        if '://' in self.base_url:
            url_parts = self.base_url.split('://', 1)[1].split('/', 1)
            if len(url_parts) > 1:
                base_path = url_parts[1]  # e.g., "trade-api/v2"
                path = f"/{base_path}/{endpoint}"
            else:
                path = f"/{endpoint}"
        else:
            path = f"/{endpoint}"
        if params:
            # Query params go in the request but NOT in the signature path
            from urllib.parse import urlencode
            query_string = urlencode(sorted(params.items()))
            # Note: path for signature doesn't include query params
            # Query params are added to the actual request URL below
        
        headers = self._get_auth_headers(method, path)
        
        # Retry logic with exponential backoff for rate limits
        for attempt in range(max_retries):
            try:
                # Ensure session is still valid
                if self.session.closed:
                    await self.connect()
                
                async with self.session.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=data,
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    if response.status == 429:
                        # Rate limited - exponential backoff
                        wait_time = min(2 ** attempt, 10)  # Max 10 seconds
                        if attempt < max_retries - 1:
                            logger.warning(
                                f"Rate limited (429), retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})",
                                exchange=self.exchange_name,
                                endpoint=endpoint
                            )
                            await asyncio.sleep(wait_time)
                            continue
                        else:
                            error_text = await response.text()
                            raise ExchangeAPIError(
                                f"Kalshi API rate limit exceeded after {max_retries} attempts. Please wait before retrying.",
                                exchange=self.exchange_name
                            )
                    
                    if response.status not in [200, 201]:
                        error_text = await response.text()
                        # Provide helpful error message for authentication errors
                        if response.status == 401:
                            if not self._private_key:
                                raise ExchangeAPIError(
                                    f"Kalshi API authentication required. Set KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH environment variable. Error: HTTP {response.status} - {error_text}",
                                    exchange=self.exchange_name
                                )
                            else:
                                raise ExchangeAPIError(
                                    f"Kalshi API authentication failed. Check your API key and private key. Error: HTTP {response.status} - {error_text}",
                                    exchange=self.exchange_name
                                )
                        raise ExchangeAPIError(
                            f"Kalshi API error: HTTP {response.status} - {error_text}",
                            exchange=self.exchange_name
                        )
                    
                    return await response.json()
                        
            except aiohttp.ClientError as exc:
                if attempt < max_retries - 1:
                    wait_time = min(2 ** attempt, 5)
                    logger.warning(
                        f"Connection error, retrying in {wait_time}s",
                        exchange=self.exchange_name,
                        error=str(exc)
                    )
                    await asyncio.sleep(wait_time)
                    continue
                raise ExchangeConnectionError(
                    f"Kalshi connection error: {exc}",
                    exchange=self.exchange_name
                )
        
        # Should not reach here, but just in case
        raise ExchangeAPIError(
            f"Failed to complete request after {max_retries} attempts",
            exchange=self.exchange_name
        )
    
    async def fetch_balances(self) -> Dict[str, Decimal]:
        """Fetch account balances."""
        try:
            data = await self._raw_request('GET', 'portfolio/balance')
            
            balances = {}
            if 'balance' in data:
                balances['USD'] = DM.to_decimal(str(data['balance']))
            
            logger.info(
                "Fetched Kalshi balances",
                exchange=self.exchange_name,
                balances=balances
            )
            
            return balances
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi balances",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch balances: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_markets(
        self,
        category: Optional[str] = None,
        ticker_prefix: Optional[str] = None,
        limit: int = 100,
        max_pages: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch available markets/events with cursor-based pagination.
        
        NOTE: The Kalshi demo API ignores the category filter parameter.
        We fetch all events and filter client-side.
        
        Args:
            category: Filter by category (e.g., 'crypto') - applied client-side
            ticker_prefix: Filter by ticker prefix (e.g., 'BTC') - may be ignored by API
            limit: Number of items per page (default: 100, max: 100)
            max_pages: Maximum number of pages to fetch (None = all pages, but limited for performance)
        """
        try:
            all_events = []
            cursor = None
            page_count = 0
            
            # If max_pages is None, use a reasonable default (100 pages = 10,000 events)
            # This should be enough to get all crypto events without being too slow
            # Set max_pages explicitly if you need more or fewer pages
            if max_pages is None:
                max_pages = 100  # Default: 100 pages (10,000 events) for performance
            
            import asyncio
            while True:
                # Add delay between pages to avoid rate limiting (except for first page)
                if page_count > 0:
                    await asyncio.sleep(0.3)  # 300ms delay between pages
                
                params = {'limit': min(limit, 100)}  # API max is 100
                # Per Kalshi docs: filter for open markets
                params['status'] = 'open'
                # Per Kalshi docs: can filter by series_ticker (not category - category param doesn't exist)
                if ticker_prefix:
                    params['series_ticker'] = ticker_prefix
                # Note: category filter doesn't exist in /markets endpoint - filter client-side instead
                if cursor:
                    params['cursor'] = cursor
                
                # Use 'markets' endpoint (per Kalshi docs)
                data = await self._raw_request('GET', 'markets', params=params)
                
                # Parse response - look for 'events' key
                page_events = []
                if isinstance(data, list):
                    page_events = data
                elif isinstance(data, dict) and 'events' in data:
                    page_events = data['events']
                elif isinstance(data, dict) and 'markets' in data:
                    # Fallback for backward compatibility
                    page_events = data['markets']
                
                all_events.extend(page_events)
                page_count += 1
                
                # Check for next page cursor
                if isinstance(data, dict):
                    cursor = data.get('cursor')
                else:
                    cursor = None
                
                # Stop if no more pages, max_pages reached, or no events returned
                if not cursor or (max_pages and page_count >= max_pages) or len(page_events) == 0:
                    break
                
                # Safety check: if we got fewer events than requested, we're likely at the end
                if len(page_events) < limit:
                    break
                
                logger.debug(
                    "Fetched page of Kalshi events",
                    exchange=self.exchange_name,
                    page=page_count,
                    events_on_page=len(page_events),
                    total_events=len(all_events)
                )
            
            # Filter by category client-side (API ignores category parameter)
            if category:
                category_lower = category.lower().strip()
                filtered_events = [
                    e for e in all_events
                    if str(e.get('category', '')).lower().strip() == category_lower
                ]
                logger.info(
                    "Fetched Kalshi events",
                    exchange=self.exchange_name,
                    filtered_event_count=len(filtered_events),
                    total_fetched=len(all_events),
                    pages_fetched=page_count,
                    category=category,
                    sample_titles=[e.get('title', 'N/A')[:40] for e in filtered_events[:3]] if filtered_events else []
                )
                return filtered_events
            else:
                logger.info(
                    "Fetched Kalshi events",
                    exchange=self.exchange_name,
                    event_count=len(all_events),
                    pages_fetched=page_count,
                    category="all"
                )
                return all_events
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi events",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch events: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_events_endpoint(
        self,
        category: Optional[str] = None,
        limit: int = 100,
        max_pages: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch events from /events endpoint (alternative to /markets).
        
        This endpoint might return events in a different format or include
        events not available in /markets endpoint.
        """
        try:
            all_events = []
            cursor = None
            page_count = 0
            
            if max_pages is None:
                max_pages = 50
            
            while True:
                params = {'limit': min(limit, 100)}
                params['status'] = 'open'
                if category:
                    params['category'] = category
                if cursor:
                    params['cursor'] = cursor
                
                # Try /events endpoint
                try:
                    data = await self._raw_request('GET', 'events', params=params)
                except ExchangeAPIError as e:
                    # If /events endpoint doesn't exist, return empty list
                    logger.warning("Events endpoint not available", error=str(e))
                    break
                
                # Parse response
                page_events = []
                if isinstance(data, list):
                    page_events = data
                elif isinstance(data, dict) and 'events' in data:
                    page_events = data['events']
                elif isinstance(data, dict) and 'markets' in data:
                    page_events = data['markets']
                
                all_events.extend(page_events)
                page_count += 1
                
                # Check for next page cursor
                if isinstance(data, dict):
                    cursor = data.get('cursor')
                else:
                    cursor = None
                
                # Stop if no more pages, max_pages reached, or no events returned
                if not cursor or (max_pages and page_count >= max_pages) or len(page_events) == 0:
                    break
                
                if len(page_events) < limit:
                    break
                
                logger.debug(
                    "Fetched page of Kalshi events from /events endpoint",
                    exchange=self.exchange_name,
                    page=page_count,
                    events_on_page=len(page_events),
                    total_events=len(all_events)
                )
            
            logger.info(
                "Fetched Kalshi events from /events endpoint",
                exchange=self.exchange_name,
                total_events=len(all_events),
                pages_fetched=page_count
            )
            
            return all_events
            
        except Exception as exc:
            logger.error(
                "Failed to fetch events from /events endpoint",
                exchange=self.exchange_name,
                error=str(exc)
            )
            return []  # Return empty list instead of raising error
    
    async def fetch_api_keys(self) -> List[Dict[str, Any]]:
        """
        Fetch all API keys associated with the authenticated user.
        
        Returns:
            List of API keys with their details
        """
        try:
            # Try both possible endpoint paths
            try:
                data = await self._raw_request('GET', 'api_keys')
            except ExchangeAPIError as e:
                # If that fails, try with leading slash
                if '404' in str(e) or 'NOT_FOUND' in str(e):
                    data = await self._raw_request('GET', '/api_keys')
                else:
                    raise
            
            api_keys = []
            if isinstance(data, list):
                api_keys = data
            elif isinstance(data, dict) and 'api_keys' in data:
                api_keys = data['api_keys']
            
            logger.info(
                "Fetched Kalshi API keys",
                exchange=self.exchange_name,
                key_count=len(api_keys)
            )
            
            return api_keys
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi API keys",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch API keys: {exc}",
                exchange=self.exchange_name
            )
    
    async def generate_api_key(self, name: str) -> Dict[str, str]:
        """
        Generate a new API key with automatically created key pair.
        
        Args:
            name: Name for the API key (helps identify its purpose)
            
        Returns:
            Dict with 'api_key_id' and 'private_key' (PEM format)
            
        Note:
            The private key is only returned once and cannot be retrieved again.
            Store it securely!
        """
        try:
            data = await self._raw_request(
                'POST',
                'api_keys/generate',
                data={'name': name}
            )
            
            api_key_id = data.get('api_key_id', '')
            private_key = data.get('private_key', '')
            
            if not api_key_id or not private_key:
                raise ExchangeAPIError(
                    "Invalid response from API key generation",
                    exchange=self.exchange_name
                )
            
            logger.info(
                "Generated new Kalshi API key",
                exchange=self.exchange_name,
                key_id=api_key_id,
                name=name
            )
            
            return {
                'api_key_id': api_key_id,
                'private_key': private_key,
                'name': name
            }
            
        except Exception as exc:
            logger.error(
                "Failed to generate Kalshi API key",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to generate API key: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_products(self) -> List[Dict[str, Any]]:
        """
        Fetch available trading products (events).
        
        Returns events as products for compatibility with base connector.
        """
        try:
            markets = await self.fetch_markets(category='crypto', ticker_prefix='BTC')
            
            products = []
            for market in markets:
                products.append({
                    'product_id': market.get('ticker', ''),
                    'base_currency': 'BTC',
                    'quote_currency': 'USD',
                    'min_order_size': DM.to_decimal('1'),  # Kalshi uses contracts
                    'max_order_size': DM.to_decimal('10000'),
                    'price_increment': DM.to_decimal('0.01'),
                    'size_increment': DM.to_decimal('1'),
                    'kind': 'event',
                    'market_id': market.get('market_id'),
                    'title': market.get('title'),
                    'settlement_date': market.get('expected_expiration_time'),
                })
            
            return products
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi products",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch products: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_ticker(self, product_id: str) -> Dict[str, Decimal]:
        """
        Fetch current ticker/price data for event market.
        
        Note: Kalshi events have yes/no prices, not traditional ticker.
        Checks multiple fields with fallback logic.
        """
        try:
            # Get market data
            data = await self._raw_request('GET', f'markets/{product_id}')
            
            # Extract YES price with fallback logic
            yes_price = None
            no_price = None
            
            # Try direct price fields first (most common)
            yes_price_raw = data.get('yes_price') or data.get('yes_ask') or data.get('probability')
            no_price_raw = data.get('no_price') or data.get('no_ask')
            
            if yes_price_raw is not None:
                try:
                    yes_price_val = float(yes_price_raw)
                    # Handle different formats: 0-1 vs 0-100
                    yes_price = DM.to_decimal(str(yes_price_val / 100.0 if yes_price_val > 1 else yes_price_val))
                except (ValueError, TypeError):
                    pass
            
            if no_price_raw is not None:
                try:
                    no_price_val = float(no_price_raw)
                    # Handle different formats: 0-1 vs 0-100
                    no_price = DM.to_decimal(str(no_price_val / 100.0 if no_price_val > 1 else no_price_val))
                except (ValueError, TypeError):
                    pass
            
            # Try bid/ask fields as fallback
            if yes_price is None:
                yes_bid = data.get('yes_bid')
                yes_ask = data.get('yes_ask')
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
                            yes_price = DM.to_decimal(str(yes_price_raw / 100.0 if yes_price_raw > 1 else yes_price_raw))
                    except (ValueError, TypeError):
                        pass
            
            if no_price is None:
                no_bid = data.get('no_bid')
                no_ask = data.get('no_ask')
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
                            no_price = DM.to_decimal(str(no_price_raw / 100.0 if no_price_raw > 1 else no_price_raw))
                    except (ValueError, TypeError):
                        pass
            
            # Final fallback - default to 50/50 if nothing found
            if yes_price is None:
                yes_price = DM.to_decimal('0.5')
            if no_price is None:
                no_price = DM.to_decimal('0.5')
            
            # Normalize probabilities (ensure 0-1 range and sum to 1.0)
            yes_price_val = float(yes_price)
            no_price_val = float(no_price)
            
            yes_price_val = max(0.0, min(1.0, yes_price_val))
            no_price_val = max(0.0, min(1.0, no_price_val))
            
            # Normalize if they don't sum to 1.0
            total = yes_price_val + no_price_val
            if total > 0:
                yes_price_val = yes_price_val / total
                no_price_val = no_price_val / total
            else:
                yes_price_val = 0.5
                no_price_val = 0.5
            
            yes_price = DM.to_decimal(str(yes_price_val))
            no_price = DM.to_decimal(str(no_price_val))
            
            # Convert to standard ticker format
            ticker = {
                'bid': yes_price,  # Yes bid
                'ask': DM.to_decimal(str(data.get('yes_ask', '0'))),  # Yes ask
                'last': yes_price,
                'volume_24h': DM.to_decimal(str(data.get('volume', '0'))),
                'timestamp': datetime.now(timezone.utc),
                'yes_price': yes_price,
                'no_price': no_price,
            }
            
            logger.debug(
                "Fetched Kalshi ticker",
                exchange=self.exchange_name,
                product_id=product_id,
                yes_price=str(yes_price),
                no_price=str(no_price),
                fields_found={
                    'yes_price': 'yes_price' in data or 'yes_ask' in data or 'yes_bid' in data,
                    'no_price': 'no_price' in data or 'no_ask' in data or 'no_bid' in data
                }
            )
            
            return ticker
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi ticker",
                exchange=self.exchange_name,
                product_id=product_id,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch ticker: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_orderbook(
        self,
        product_id: str,
        depth: int = 50
    ) -> Dict[str, Any]:
        """
        Fetch order book for event market.
        
        Note: Kalshi events have yes/no orderbooks.
        """
        try:
            data = await self._raw_request('GET', f'markets/{product_id}/orderbook')
            
            # Parse yes/no orderbooks
            yes_bids = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in data.get('yes', {}).get('bids', [])
            ]
            yes_asks = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in data.get('yes', {}).get('asks', [])
            ]
            
            # Return yes orderbook (standard format)
            orderbook = {
                'bids': yes_bids,
                'asks': yes_asks,
                'timestamp': datetime.now(timezone.utc),
                'yes_bids': yes_bids,
                'yes_asks': yes_asks,
                'no_bids': [
                    [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                    for level in data.get('no', {}).get('bids', [])
                ],
                'no_asks': [
                    [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                    for level in data.get('no', {}).get('asks', [])
                ],
            }
            
            return orderbook
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi orderbook",
                exchange=self.exchange_name,
                product_id=product_id,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch orderbook: {exc}",
                exchange=self.exchange_name
            )
    
    async def place_order(
        self,
        product_id: str,
        side: str,
        order_type: str,
        size: Decimal,
        price: Optional[Decimal] = None,
        time_in_force: str = 'GTC',
        client_order_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Simulate order placement for Kalshi event.
        
        Note: Kalshi uses 'yes'/'no' sides, not 'buy'/'sell'.
        """
        import uuid
        
        # Get real current price
        ticker = await self.fetch_ticker(product_id)
        current_price = ticker['yes_price'] if side == 'buy' else ticker['no_price']
        
        fill_price = current_price if order_type == 'market' else (price or current_price)
        notional = size * fill_price
        
        order_id = f"sim_kalshi_{uuid.uuid4().hex[:16]}"
        
        simulated_order = {
            'order_id': order_id,
            'client_order_id': client_order_id,
            'status': 'filled',
            'filled_size': str(size),
            'average_price': str(fill_price),
            'price': str(fill_price),
            'size': str(size),
            'side': side,
            'order_type': order_type,
            'product_id': product_id,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'execution_mode': 'simulated',
            'note': 'Order calculated using real market prices. Execution simulated due to NYC restrictions.'
        }
        
        logger.info(
            "Simulated order placement",
            exchange=self.exchange_name,
            product_id=product_id,
            side=side,
            size=str(size),
            price=str(fill_price),
            order_id=order_id
        )
        
        return simulated_order
    
    async def cancel_order(
        self,
        order_id: str,
        product_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Simulate order cancellation."""
        return {
            'order_id': order_id,
            'status': 'cancelled',
            'cancelled_at': datetime.now(timezone.utc).isoformat(),
            'execution_mode': 'simulated',
            'note': 'Order cancellation simulated'
        }
    
    async def fetch_order(
        self,
        order_id: str,
        product_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Fetch order status (simulated orders only)."""
        raise ExchangeAPIError(
            f"Order {order_id} not found (simulated orders not tracked)",
            exchange=self.exchange_name
        )
    
    async def fetch_open_orders(
        self,
        product_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Fetch open orders."""
        try:
            params = {}
            if product_id:
                params['market'] = product_id
            
            data = await self._raw_request('GET', 'portfolio/orders', params=params)
            
            orders = []
            if isinstance(data, list):
                orders = data
            elif isinstance(data, dict) and 'orders' in data:
                orders = data['orders']
            
            return orders
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi orders",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch orders: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_fills(
        self,
        product_id: Optional[str] = None,
        order_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Fetch order fills/trades."""
        try:
            params = {'limit': limit}
            if product_id:
                params['market'] = product_id
            if order_id:
                params['order_id'] = order_id
            
            data = await self._raw_request('GET', 'portfolio/fills', params=params)
            
            fills = []
            if isinstance(data, list):
                fills = data
            elif isinstance(data, dict) and 'fills' in data:
                fills = data['fills']
            
            return fills
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kalshi fills",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch fills: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_perpetual_positions(self) -> List[Dict[str, Any]]:
        """Kalshi doesn't support perpetuals."""
        return []

