"""
Deribit Exchange Connector
Public feeds only - no authentication needed
Supports: Spot, Options, Perpetual Futures
"""
import aiohttp
from decimal import Decimal
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone

from utils.logging import get_logger
from utils.error_handler import ExchangeConnectionError, ExchangeAPIError, ValidationError
from utils.decimal_utils import DecimalMath as DM
from .base_connector import ExchangeConnector

logger = get_logger(__name__)


class DeribitConnector(ExchangeConnector):
    """
    Deribit exchange connector for public feeds.
    
    No authentication needed - uses public endpoints only.
    """
    
    def __init__(
        self,
        exchange_name: str,
        config: Dict[str, Any],
        credentials: Dict[str, str]
    ):
        """Initialize Deribit connector."""
        super().__init__(exchange_name, config, credentials)
        self.base_url = config.get('base_url', 'https://www.deribit.com/api/v2')
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def connect(self) -> bool:
        """Establish connection to Deribit (public feeds - no auth needed)."""
        try:
            self.session = aiohttp.ClientSession()
            
            # Test connection with public endpoint
            async with self.session.get(f"{self.base_url}/public/get_time") as response:
                if response.status == 200:
                    self.connected = True
                    self.last_heartbeat = datetime.now(timezone.utc)
                    logger.info(
                        "Connected to Deribit (public feeds)",
                        exchange=self.exchange_name
                    )
                    return True
                else:
                    raise ExchangeConnectionError(
                        f"Deribit connection test failed: HTTP {response.status}",
                        exchange=self.exchange_name
                    )
        except Exception as exc:
            logger.error(
                "Failed to connect to Deribit",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeConnectionError(
                f"Failed to connect to Deribit: {exc}",
                exchange=self.exchange_name
            )
    
    async def disconnect(self) -> bool:
        """Disconnect from Deribit."""
        if self.session:
            await self.session.close()
            self.session = None
        
        self.connected = False
        logger.info("Disconnected from Deribit", exchange=self.exchange_name)
        return True
    
    async def health_check(self) -> Dict[str, Any]:
        """Check Deribit connectivity."""
        if not self.session:
            return {
                'status': 'down',
                'latency_ms': None,
                'last_successful_call': None,
                'error_count': 1
            }
        
        try:
            start_time = datetime.now(timezone.utc)
            async with self.session.get(
                f"{self.base_url}/public/get_time",
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
            logger.debug("Deribit health check failed", error=str(exc))
            return {
                'status': 'down',
                'latency_ms': None,
                'last_successful_call': self.last_heartbeat.isoformat() if self.last_heartbeat else None,
                'error_count': 1
            }
    
    async def _raw_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Make raw HTTP request to Deribit API."""
        if not self.session:
            raise ExchangeConnectionError(
                "Not connected to Deribit",
                exchange=self.exchange_name
            )
        
        url = f"{self.base_url}/public/{endpoint}"
        
        try:
            async with self.session.request(
                method=method,
                url=url,
                params=params,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    raise ExchangeAPIError(
                        f"Deribit API error: HTTP {response.status} - {error_text}",
                        exchange=self.exchange_name
                    )
                
                data = await response.json()
                
                # Deribit returns {result: {...}, jsonrpc: "2.0", id: ...}
                if 'result' in data:
                    return data['result']
                elif 'error' in data:
                    raise ExchangeAPIError(
                        f"Deribit API error: {data['error']}",
                        exchange=self.exchange_name
                    )
                else:
                    return data
                    
        except aiohttp.ClientError as exc:
            raise ExchangeConnectionError(
                f"Deribit connection error: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_balances(self) -> Dict[str, Decimal]:
        """
        Fetch account balances.
        
        Note: Public feeds only - returns empty balances.
        """
        logger.debug("Deribit public feeds - returning empty balances")
        return {}
    
    async def fetch_products(self) -> List[Dict[str, Any]]:
        """Fetch available trading products."""
        try:
            # Get all instruments
            data = await self._raw_request('GET', 'get_instruments', {'currency': 'BTC'})
            
            products = []
            for instrument in data:
                if instrument.get('kind') in ['spot', 'option', 'future']:
                    # Normalize product ID
                    product_id = instrument.get('instrument_name', '')
                    
                    # Convert Deribit format to standard format
                    # BTC-PERPETUAL -> BTC-USD-PERP
                    # BTC-USD -> BTC-USD
                    # BTC-31DEC25-50000-P -> BTC-USD-50000-P-2025-12-31
                    
                    base_currency = 'BTC'
                    quote_currency = 'USD'
                    
                    # Parse instrument name
                    if instrument.get('kind') == 'spot':
                        # BTC-USD
                        parts = product_id.split('-')
                        if len(parts) >= 2:
                            base_currency = parts[0]
                            quote_currency = parts[1]
                    elif instrument.get('kind') == 'option':
                        # BTC-31DEC25-50000-P
                        # Extract strike and expiry
                        pass  # Will parse in option-specific logic
                    elif instrument.get('kind') == 'future':
                        # BTC-PERPETUAL or BTC-31DEC25
                        if 'PERPETUAL' in product_id:
                            product_id = 'BTC-USD-PERP'
                    
                    products.append({
                        'product_id': product_id,
                        'base_currency': base_currency,
                        'quote_currency': quote_currency,
                        'min_order_size': DM.to_decimal(instrument.get('min_trade_amount', '0.001')),
                        'max_order_size': DM.to_decimal(instrument.get('max_trade_amount', '1000000')),
                        'price_increment': DM.to_decimal(instrument.get('tick_size', '0.01')),
                        'size_increment': DM.to_decimal(instrument.get('min_trade_amount', '0.001')),
                        'kind': instrument.get('kind'),
                        'expiry': instrument.get('expiration_timestamp'),
                        'strike': instrument.get('strike') if instrument.get('kind') == 'option' else None,
                        'option_type': instrument.get('option_type') if instrument.get('kind') == 'option' else None,
                    })
            
            logger.info(
                "Fetched Deribit products",
                exchange=self.exchange_name,
                product_count=len(products)
            )
            
            return products
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Deribit products",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to fetch products: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_ticker(self, product_id: str) -> Dict[str, Decimal]:
        """Fetch current ticker/price data."""
        try:
            # Deribit uses instrument_name format
            # Convert BTC-USD to BTC-USD or BTC-USD-PERP to BTC-PERPETUAL
            instrument_name = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'ticker', {'instrument_name': instrument_name})
            
            # Handle None values - Deribit may return None for some fields
            best_bid = data.get('best_bid_price')
            best_ask = data.get('best_ask_price')
            last_price = data.get('last_price')
            volume = data.get('stats', {}).get('volume') if data.get('stats') else None
            
            ticker = {
                'bid': DM.to_decimal(str(best_bid)) if best_bid is not None else Decimal('0'),
                'ask': DM.to_decimal(str(best_ask)) if best_ask is not None else Decimal('0'),
                'last': DM.to_decimal(str(last_price)) if last_price is not None else Decimal('0'),
                'volume_24h': DM.to_decimal(str(volume)) if volume is not None else Decimal('0'),
                'timestamp': datetime.now(timezone.utc)
            }
            
            logger.debug(
                "Fetched Deribit ticker",
                exchange=self.exchange_name,
                product_id=product_id,
                price=str(ticker['last'])
            )
            
            return ticker
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Deribit ticker",
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
        """Fetch order book."""
        try:
            instrument_name = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'get_order_book', {
                'instrument_name': instrument_name,
                'depth': depth
            })
            
            # Parse bids and asks
            bids = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in data.get('bids', [])
            ]
            asks = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in data.get('asks', [])
            ]
            
            orderbook = {
                'bids': bids,
                'asks': asks,
                'timestamp': datetime.now(timezone.utc)
            }
            
            logger.debug(
                "Fetched Deribit orderbook",
                exchange=self.exchange_name,
                product_id=product_id,
                bids=len(bids),
                asks=len(asks)
            )
            
            return orderbook
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Deribit orderbook",
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
        Simulate order placement (public feeds - no actual execution).
        
        Returns simulated order using real market prices.
        """
        import uuid
        from datetime import datetime, timezone
        
        # Get real current price
        ticker = await self.fetch_ticker(product_id)
        current_price = ticker['last']
        
        # For market orders, use current price
        # For limit orders, use provided price
        fill_price = current_price if order_type == 'market' else price
        
        if fill_price is None:
            fill_price = current_price
        
        # Calculate notional
        notional = size * fill_price
        
        # Generate simulated order ID
        order_id = f"sim_deribit_{uuid.uuid4().hex[:16]}"
        
        simulated_order = {
            'order_id': order_id,
            'client_order_id': client_order_id,
            'status': 'filled',  # Market orders typically fill immediately
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
        # For simulated orders, we'd need to track them
        # For now, return not found
        raise ExchangeAPIError(
            f"Order {order_id} not found (simulated orders not tracked)",
            exchange=self.exchange_name
        )
    
    async def fetch_open_orders(
        self,
        product_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Fetch open orders (returns empty for public feeds)."""
        return []
    
    async def fetch_fills(
        self,
        product_id: Optional[str] = None,
        order_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Fetch order fills (returns empty for public feeds)."""
        return []
    
    async def fetch_perpetual_positions(self) -> List[Dict[str, Any]]:
        """Fetch perpetual positions (returns empty for public feeds)."""
        return []
    
    def _normalize_product_id(self, product_id: str) -> str:
        """
        Normalize product ID to Deribit instrument name format.
        
        Deribit uses:
        - BTC-PERPETUAL for perpetual futures (closest to spot)
        - BTC-31DEC25-50000-P for options (format: BTC-DDMMMYY-STRIKE-TYPE)
        - BTC-USD doesn't exist - use BTC-PERPETUAL instead
        
        Examples:
        - BTC-USD -> BTC-PERPETUAL (Deribit doesn't have spot, use perpetual)
        - BTC-USD-PERP -> BTC-PERPETUAL
        - BTC-USD-50000-P-2025-12-31 -> BTC-31DEC25-50000-P
        """
        # Handle perpetuals
        if product_id.endswith('-PERP'):
            return 'BTC-PERPETUAL'
        
        # Handle options format: BTC-USD-STRIKE-TYPE-YYYY-MM-DD
        # Convert to Deribit format: BTC-DDMMMYY-STRIKE-TYPE
        parts = product_id.split('-')
        if len(parts) >= 5 and parts[0] == 'BTC' and parts[1] == 'USD':
            try:
                strike = parts[2]
                option_type = parts[3]  # 'P' or 'C'
                expiry_str = parts[4]  # YYYYMMDD format
                
                # Parse expiry date
                from datetime import datetime
                expiry_date = datetime.strptime(expiry_str, '%Y%m%d')
                
                # Format: DDMMMYY (e.g., 31DEC25)
                day = expiry_date.strftime('%d')
                month = expiry_date.strftime('%b').upper()
                year = expiry_date.strftime('%y')
                
                # Deribit format: BTC-31DEC25-50000-P
                return f"BTC-{day}{month}{year}-{strike}-{option_type}"
            except (ValueError, IndexError):
                # If parsing fails, return as-is
                pass
        
        # For spot BTC-USD, Deribit doesn't have spot - use perpetual instead
        if product_id == 'BTC-USD':
            return 'BTC-PERPETUAL'
        
        # Return as-is for other formats (might be already in Deribit format)
        return product_id

