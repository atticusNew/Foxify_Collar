"""
OKX Exchange Connector
Public feeds only - no authentication needed
Supports: Spot, Options, Perpetual Futures
"""
import aiohttp
from decimal import Decimal
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone

from utils.logging import get_logger
from utils.error_handler import ExchangeConnectionError, ExchangeAPIError
from utils.decimal_utils import DecimalMath as DM
from .base_connector import ExchangeConnector

logger = get_logger(__name__)


class OKXConnector(ExchangeConnector):
    """
    OKX exchange connector for public feeds.
    
    No authentication needed - uses public endpoints only.
    """
    
    def __init__(
        self,
        exchange_name: str,
        config: Dict[str, Any],
        credentials: Dict[str, str]
    ):
        """Initialize OKX connector."""
        super().__init__(exchange_name, config, credentials)
        self.base_url = config.get('base_url', 'https://www.okx.com/api/v5')
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def connect(self) -> bool:
        """Establish connection to OKX (public feeds - no auth needed)."""
        try:
            self.session = aiohttp.ClientSession()
            
            # Test connection with public endpoint
            async with self.session.get(f"{self.base_url}/public/time") as response:
                if response.status == 200:
                    self.connected = True
                    self.last_heartbeat = datetime.now(timezone.utc)
                    logger.info(
                        "Connected to OKX (public feeds)",
                        exchange=self.exchange_name
                    )
                    return True
                else:
                    raise ExchangeConnectionError(
                        f"OKX connection test failed: HTTP {response.status}",
                        exchange=self.exchange_name
                    )
        except Exception as exc:
            logger.error(
                "Failed to connect to OKX",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeConnectionError(
                f"Failed to connect to OKX: {exc}",
                exchange=self.exchange_name
            )
    
    async def disconnect(self) -> bool:
        """Disconnect from OKX."""
        if self.session:
            await self.session.close()
            self.session = None
        
        self.connected = False
        logger.info("Disconnected from OKX", exchange=self.exchange_name)
        return True
    
    async def health_check(self) -> Dict[str, Any]:
        """Check OKX connectivity."""
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
                f"{self.base_url}/public/time",
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
            logger.debug("OKX health check failed", error=str(exc))
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
        """Make raw HTTP request to OKX API."""
        if not self.session:
            raise ExchangeConnectionError(
                "Not connected to OKX",
                exchange=self.exchange_name
            )
        
        url = f"{self.base_url}/{endpoint}"
        
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
                        f"OKX API error: HTTP {response.status} - {error_text}",
                        exchange=self.exchange_name
                    )
                
                data = await response.json()
                
                # OKX returns {code: "0", msg: "", data: [...]}
                if data.get('code') == '0':
                    return data.get('data', [])
                else:
                    raise ExchangeAPIError(
                        f"OKX API error: {data.get('msg', 'Unknown error')}",
                        exchange=self.exchange_name
                    )
                    
        except aiohttp.ClientError as exc:
            raise ExchangeConnectionError(
                f"OKX connection error: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_balances(self) -> Dict[str, Decimal]:
        """Fetch account balances (returns empty for public feeds)."""
        logger.debug("OKX public feeds - returning empty balances")
        return {}
    
    async def fetch_products(self) -> List[Dict[str, Any]]:
        """Fetch available trading products."""
        try:
            # Get instruments for BTC
            data = await self._raw_request('GET', 'public/instruments', {'instType': 'SPOT'})
            spot_products = data if isinstance(data, list) else []
            
            # Get options
            options_data = await self._raw_request('GET', 'public/instruments', {'instType': 'OPTION', 'uly': 'BTC-USD'})
            option_products = options_data if isinstance(options_data, list) else []
            
            # Get perpetuals
            perp_data = await self._raw_request('GET', 'public/instruments', {'instType': 'SWAP', 'uly': 'BTC-USD'})
            perp_products = perp_data if isinstance(perp_data, list) else []
            
            products = []
            
            # Process spot products
            for inst in spot_products:
                min_sz = inst.get('minSz') or '0.001'
                max_sz = inst.get('maxSz') or '1000000'
                tick_sz = inst.get('tickSz') or '0.01'
                lot_sz = inst.get('lotSz') or '0.001'
                
                products.append({
                    'product_id': inst.get('instId', ''),
                    'base_currency': inst.get('baseCcy', 'BTC'),
                    'quote_currency': inst.get('quoteCcy', 'USD'),
                    'min_order_size': DM.to_decimal(str(min_sz)),
                    'max_order_size': DM.to_decimal(str(max_sz)),
                    'price_increment': DM.to_decimal(str(tick_sz)),
                    'size_increment': DM.to_decimal(str(lot_sz)),
                    'kind': 'spot',
                })
            
            # Process option products
            for inst in option_products:
                min_sz = inst.get('minSz') or '0.01'
                max_sz = inst.get('maxSz') or '1000000'
                tick_sz = inst.get('tickSz') or '0.01'
                lot_sz = inst.get('lotSz') or '0.01'
                stk = inst.get('stk')
                
                products.append({
                    'product_id': inst.get('instId', ''),
                    'base_currency': 'BTC',
                    'quote_currency': 'USD',
                    'min_order_size': DM.to_decimal(str(min_sz)),
                    'max_order_size': DM.to_decimal(str(max_sz)),
                    'price_increment': DM.to_decimal(str(tick_sz)),
                    'size_increment': DM.to_decimal(str(lot_sz)),
                    'kind': 'option',
                    'expiry': inst.get('expTime'),
                    'strike': DM.to_decimal(str(stk)) if stk else None,
                    'option_type': 'C' if inst.get('optType') == 'C' else 'P',
                })
            
            # Process perpetual products
            for inst in perp_products:
                min_sz = inst.get('minSz') or '0.001'
                max_sz = inst.get('maxSz') or '1000000'
                tick_sz = inst.get('tickSz') or '0.01'
                lot_sz = inst.get('lotSz') or '0.001'
                
                products.append({
                    'product_id': inst.get('instId', '').replace('-SWAP', '-PERP'),
                    'base_currency': 'BTC',
                    'quote_currency': 'USD',
                    'min_order_size': DM.to_decimal(str(min_sz)),
                    'max_order_size': DM.to_decimal(str(max_sz)),
                    'price_increment': DM.to_decimal(str(tick_sz)),
                    'size_increment': DM.to_decimal(str(lot_sz)),
                    'kind': 'future',
                })
            
            logger.info(
                "Fetched OKX products",
                exchange=self.exchange_name,
                product_count=len(products)
            )
            
            return products
            
        except Exception as exc:
            logger.error(
                "Failed to fetch OKX products",
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
            # OKX uses instId format
            inst_id = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'public/ticker', {'instId': inst_id})
            
            if not data or len(data) == 0:
                raise ExchangeAPIError(
                    f"No ticker data for {product_id}",
                    exchange=self.exchange_name
                )
            
            ticker_data = data[0]
            
            # Handle None values and empty strings
            bid_px = ticker_data.get('bidPx')
            ask_px = ticker_data.get('askPx')
            last_px = ticker_data.get('last')
            vol_24h = ticker_data.get('vol24h')
            
            ticker = {
                'bid': DM.to_decimal(str(bid_px)) if bid_px and str(bid_px).strip() else Decimal('0'),
                'ask': DM.to_decimal(str(ask_px)) if ask_px and str(ask_px).strip() else Decimal('0'),
                'last': DM.to_decimal(str(last_px)) if last_px and str(last_px).strip() else Decimal('0'),
                'volume_24h': DM.to_decimal(str(vol_24h)) if vol_24h and str(vol_24h).strip() else Decimal('0'),
                'timestamp': datetime.now(timezone.utc)
            }
            
            logger.debug(
                "Fetched OKX ticker",
                exchange=self.exchange_name,
                product_id=product_id,
                inst_id=inst_id,
                bid=str(ticker['bid']),
                ask=str(ticker['ask']),
                last=str(ticker['last'])
            )
            
            return ticker
            
        except Exception as exc:
            logger.error(
                "Failed to fetch OKX ticker",
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
            inst_id = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'public/books', {
                'instId': inst_id,
                'sz': str(depth)
            })
            
            if not data or len(data) == 0:
                raise ExchangeAPIError(
                    f"No orderbook data for {product_id}",
                    exchange=self.exchange_name
                )
            
            book_data = data[0]
            
            # Parse bids and asks
            bids = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in book_data.get('bids', [])
            ]
            asks = [
                [DM.to_decimal(level[0]), DM.to_decimal(level[1])]
                for level in book_data.get('asks', [])
            ]
            
            orderbook = {
                'bids': bids,
                'asks': asks,
                'timestamp': datetime.now(timezone.utc)
            }
            
            logger.debug(
                "Fetched OKX orderbook",
                exchange=self.exchange_name,
                product_id=product_id,
                bids=len(bids),
                asks=len(asks)
            )
            
            return orderbook
            
        except Exception as exc:
            logger.error(
                "Failed to fetch OKX orderbook",
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
        """Simulate order placement using real market prices."""
        import uuid
        
        # Get real current price
        ticker = await self.fetch_ticker(product_id)
        current_price = ticker['last']
        
        fill_price = current_price if order_type == 'market' else (price or current_price)
        notional = size * fill_price
        
        order_id = f"sim_okx_{uuid.uuid4().hex[:16]}"
        
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
        Normalize product ID to OKX instId format.
        
        OKX formats:
        - Spot: BTC-USDT
        - Perpetuals: BTC-USDT-SWAP
        - Options: BTC-USD-YYMMDD-STRIKE-TYPE (e.g., BTC-USD-251206-76000-C)
        
        Examples:
        - BTC-USD -> BTC-USDT (OKX uses USDT for spot)
        - BTC-USD-PERP -> BTC-USDT-SWAP
        - BTC-USD-251206-76000-C -> BTC-USD-251206-76000-C (already correct)
        """
        # Handle perpetuals
        if product_id.endswith('-PERP'):
            return product_id.replace('-PERP', '-USDT-SWAP')
        
        # Handle spot (OKX uses USDT, not USD)
        if product_id == 'BTC-USD':
            return 'BTC-USDT'
        
        # Options format: BTC-USD-YYMMDD-STRIKE-TYPE (already correct OKX format)
        # Check if it's an option by looking for date pattern (6 digits after BTC-USD-)
        parts = product_id.split('-')
        if len(parts) >= 4 and parts[0] == 'BTC' and parts[1] == 'USD':
            # Check if third part looks like a date (YYMMDD format - 6 digits)
            if len(parts[2]) == 6 and parts[2].isdigit():
                # This is an option - return as-is (already in OKX format)
                return product_id
        
        # Return as-is for other formats (might already be OKX format)
        return product_id

