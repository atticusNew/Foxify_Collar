"""
Kraken Exchange Connector
Public feeds only - no authentication needed
Supports: Spot (options support to be verified)
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


class KrakenConnector(ExchangeConnector):
    """
    Kraken exchange connector for public feeds.
    
    No authentication needed - uses public endpoints only.
    """
    
    def __init__(
        self,
        exchange_name: str,
        config: Dict[str, Any],
        credentials: Dict[str, str]
    ):
        """Initialize Kraken connector."""
        super().__init__(exchange_name, config, credentials)
        self.base_url = config.get('base_url', 'https://api.kraken.com/0/public')
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def connect(self) -> bool:
        """Establish connection to Kraken (public feeds - no auth needed)."""
        try:
            self.session = aiohttp.ClientSession()
            
            # Test connection with public endpoint
            async with self.session.get(f"{self.base_url}/Time") as response:
                if response.status == 200:
                    self.connected = True
                    self.last_heartbeat = datetime.now(timezone.utc)
                    logger.info(
                        "Connected to Kraken (public feeds)",
                        exchange=self.exchange_name
                    )
                    return True
                else:
                    raise ExchangeConnectionError(
                        f"Kraken connection test failed: HTTP {response.status}",
                        exchange=self.exchange_name
                    )
        except Exception as exc:
            logger.error(
                "Failed to connect to Kraken",
                exchange=self.exchange_name,
                error=str(exc)
            )
            raise ExchangeConnectionError(
                f"Failed to connect to Kraken: {exc}",
                exchange=self.exchange_name
            )
    
    async def disconnect(self) -> bool:
        """Disconnect from Kraken."""
        if self.session:
            await self.session.close()
            self.session = None
        
        self.connected = False
        logger.info("Disconnected from Kraken", exchange=self.exchange_name)
        return True
    
    async def health_check(self) -> Dict[str, Any]:
        """Check Kraken connectivity."""
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
                f"{self.base_url}/Time",
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
            logger.debug("Kraken health check failed", error=str(exc))
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
        """Make raw HTTP request to Kraken API."""
        if not self.session:
            raise ExchangeConnectionError(
                "Not connected to Kraken",
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
                        f"Kraken API error: HTTP {response.status} - {error_text}",
                        exchange=self.exchange_name
                    )
                
                data = await response.json()
                
                # Kraken returns {error: [], result: {...}}
                if data.get('error') and len(data['error']) > 0:
                    raise ExchangeAPIError(
                        f"Kraken API error: {data['error']}",
                        exchange=self.exchange_name
                    )
                
                return data.get('result', {})
                    
        except aiohttp.ClientError as exc:
            raise ExchangeConnectionError(
                f"Kraken connection error: {exc}",
                exchange=self.exchange_name
            )
    
    async def fetch_balances(self) -> Dict[str, Decimal]:
        """Fetch account balances (returns empty for public feeds)."""
        logger.debug("Kraken public feeds - returning empty balances")
        return {}
    
    async def fetch_products(self) -> List[Dict[str, Any]]:
        """Fetch available trading products."""
        try:
            # Get asset pairs
            data = await self._raw_request('GET', 'AssetPairs')
            
            products = []
            for pair_name, pair_info in data.items():
                # Filter for BTC pairs
                if 'BTC' in pair_name and 'USD' in pair_name:
                    base = pair_info.get('base', 'BTC')
                    quote = pair_info.get('quote', 'USD')
                    
                    products.append({
                        'product_id': f"{base}-{quote}",
                        'base_currency': base,
                        'quote_currency': quote,
                        'min_order_size': DM.to_decimal(pair_info.get('ordermin', '0.001')),
                        'max_order_size': DM.to_decimal('1000000'),  # Not provided by Kraken
                        'price_increment': DM.to_decimal(pair_info.get('tick_size', '0.01')),
                        'size_increment': DM.to_decimal(pair_info.get('lot_decimals', '8')),
                        'kind': 'spot',
                    })
            
            logger.info(
                "Fetched Kraken products",
                exchange=self.exchange_name,
                product_count=len(products)
            )
            
            return products
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kraken products",
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
            # Kraken uses XBTUSD format for BTC-USD
            pair_name = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'Ticker', {'pair': pair_name})
            
            # Kraken returns data keyed by pair name
            ticker_data = list(data.values())[0] if data else {}
            
            ticker = {
                'bid': DM.to_decimal(ticker_data.get('b', ['0'])[0]),
                'ask': DM.to_decimal(ticker_data.get('a', ['0'])[0]),
                'last': DM.to_decimal(ticker_data.get('c', ['0'])[0]),
                'volume_24h': DM.to_decimal(ticker_data.get('v', ['0'])[1] if len(ticker_data.get('v', [])) > 1 else '0'),
                'timestamp': datetime.now(timezone.utc)
            }
            
            logger.debug(
                "Fetched Kraken ticker",
                exchange=self.exchange_name,
                product_id=product_id,
                price=str(ticker['last'])
            )
            
            return ticker
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kraken ticker",
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
            pair_name = self._normalize_product_id(product_id)
            
            data = await self._raw_request('GET', 'Depth', {
                'pair': pair_name,
                'count': depth
            })
            
            # Kraken returns data keyed by pair name
            book_data = list(data.values())[0] if data else {}
            
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
                "Fetched Kraken orderbook",
                exchange=self.exchange_name,
                product_id=product_id,
                bids=len(bids),
                asks=len(asks)
            )
            
            return orderbook
            
        except Exception as exc:
            logger.error(
                "Failed to fetch Kraken orderbook",
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
        
        order_id = f"sim_kraken_{uuid.uuid4().hex[:16]}"
        
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
        Normalize product ID to Kraken pair format.
        
        Examples:
        - BTC-USD -> XBTUSD
        """
        if product_id == 'BTC-USD':
            return 'XBTUSD'
        
        return product_id



