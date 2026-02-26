"""
Base Exchange Connector Interface
All exchange connectors must implement this interface
Production-ready: Async, Decimal-based, comprehensive error handling
"""
from abc import ABC, abstractmethod
from decimal import Decimal
from typing import Dict, List, Optional, Any
from datetime import datetime
from utils.logging import get_logger
from utils.error_handler import ExchangeConnectionError, ExchangeAPIError

logger = get_logger(__name__)


class ExchangeConnector(ABC):
    """
    Base interface for all exchange connectors
    
    All financial values MUST be Decimal type
    All methods MUST be async
    All errors MUST be properly handled and logged
    """
    
    def __init__(
        self,
        exchange_name: str,
        config: Dict[str, Any],
        credentials: Dict[str, str]
    ):
        """
        Initialize exchange connector
        
        Args:
            exchange_name: Name of the exchange (e.g., 'deribit')
            config: Exchange configuration from exchanges.toml
            credentials: API credentials (loaded from environment)
        """
        self.exchange_name = exchange_name
        self.config = config
        self.credentials = credentials
        self.connected = False
        self.last_heartbeat = None
        
        logger.info(
            f"Initializing {exchange_name} connector",
            exchange=exchange_name,
            config_keys=list(config.keys())
        )
    
    @abstractmethod
    async def connect(self) -> bool:
        """
        Establish connection to exchange
        
        Returns:
            bool: True if connection successful
            
        Raises:
            ExchangeConnectionError: If connection fails
        """
        pass
    
    @abstractmethod
    async def disconnect(self) -> bool:
        """
        Gracefully disconnect from exchange
        
        Returns:
            bool: True if disconnection successful
        """
        pass
    
    @abstractmethod
    async def health_check(self) -> Dict[str, Any]:
        """
        Check exchange connectivity and health
        
        Returns:
            Dict: Health status with keys:
                - status: 'healthy' | 'degraded' | 'down'
                - latency_ms: Response time in milliseconds
                - last_successful_call: Timestamp of last successful API call
                - error_count: Number of consecutive errors
        """
        pass
    
    @abstractmethod
    async def fetch_balances(self) -> Dict[str, Decimal]:
        """
        Fetch account balances
        
        Returns:
            Dict: Currency symbol -> available balance (Decimal)
            Example: {'BTC': Decimal('1.5'), 'USD': Decimal('50000.00')}
            
        Raises:
            ExchangeAPIError: If API call fails
        """
        pass
    
    @abstractmethod
    async def fetch_products(self) -> List[Dict[str, Any]]:
        """
        Fetch available trading products/pairs
        
        Returns:
            List[Dict]: List of products with keys:
                - product_id: Product identifier (e.g., 'BTC-USD')
                - base_currency: Base currency (e.g., 'BTC')
                - quote_currency: Quote currency (e.g., 'USD')
                - min_order_size: Minimum order size (Decimal)
                - max_order_size: Maximum order size (Decimal)
                - price_increment: Price increment (Decimal)
                - size_increment: Size increment (Decimal)
                
        Raises:
            ExchangeAPIError: If API call fails
        """
        pass
    
    @abstractmethod
    async def fetch_ticker(self, product_id: str) -> Dict[str, Decimal]:
        """
        Fetch current ticker/price data
        
        Args:
            product_id: Product identifier (e.g., 'BTC-USD')
            
        Returns:
            Dict: Ticker data with keys:
                - bid: Best bid price (Decimal)
                - ask: Best ask price (Decimal)
                - last: Last trade price (Decimal)
                - volume_24h: 24h volume (Decimal)
                - timestamp: Timestamp of ticker data
                
        Raises:
            ExchangeAPIError: If API call fails
        """
        pass
    
    @abstractmethod
    async def fetch_orderbook(
        self,
        product_id: str,
        depth: int = 50
    ) -> Dict[str, Any]:
        """
        Fetch order book
        
        Args:
            product_id: Product identifier (e.g., 'BTC-USD')
            depth: Number of levels to fetch
            
        Returns:
            Dict: Order book with keys:
                - bids: List of [price (Decimal), size (Decimal)]
                - asks: List of [price (Decimal), size (Decimal)]
                - timestamp: Timestamp of order book snapshot
                
        Raises:
            ExchangeAPIError: If API call fails
        """
        pass
    
    @abstractmethod
    async def place_order(
        self,
        product_id: str,
        side: str,  # 'buy' or 'sell'
        order_type: str,  # 'market', 'limit'
        size: Decimal,
        price: Optional[Decimal] = None,
        time_in_force: str = 'GTC',  # 'GTC', 'IOC', 'FOK'
        client_order_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Place an order (SIMULATED for demo - uses real prices but doesn't execute)
        
        Args:
            product_id: Product identifier (e.g., 'BTC-USD')
            side: Order side ('buy' or 'sell')
            order_type: Order type ('market' or 'limit')
            size: Order size (Decimal)
            price: Limit price (Decimal, required for limit orders)
            time_in_force: Time in force ('GTC', 'IOC', 'FOK')
            client_order_id: Client-provided order ID (optional)
            
        Returns:
            Dict: Simulated order details with keys:
                - order_id: Simulated order ID (prefixed with 'sim_')
                - client_order_id: Client order ID (if provided)
                - status: Order status ('filled' for simulated)
                - filled_size: Filled size (Decimal)
                - average_price: Average fill price (Decimal, real market price)
                - timestamp: Order timestamp
                - execution_mode: 'simulated'
                - note: Explanation that order was simulated
                
        Raises:
            ExchangeAPIError: If order placement fails
            ValidationError: If order parameters are invalid
        """
        pass
    
    @abstractmethod
    async def cancel_order(
        self,
        order_id: str,
        product_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Cancel an order (SIMULATED for demo)
        
        Args:
            order_id: Exchange order ID
            product_id: Product identifier (optional, some exchanges require)
            
        Returns:
            Dict: Cancellation result with keys:
                - order_id: Exchange order ID
                - status: Order status after cancellation
                - cancelled_at: Cancellation timestamp
                
        Raises:
            ExchangeAPIError: If cancellation fails
        """
        pass
    
    @abstractmethod
    async def fetch_order(
        self,
        order_id: str,
        product_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Fetch order status
        
        Args:
            order_id: Exchange order ID
            product_id: Product identifier (optional)
            
        Returns:
            Dict: Order details (same format as place_order)
                
        Raises:
            ExchangeAPIError: If fetch fails
        """
        pass
    
    @abstractmethod
    async def fetch_open_orders(
        self,
        product_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch all open orders
        
        Args:
            product_id: Product identifier (optional, filter by product)
            
        Returns:
            List[Dict]: List of open orders (same format as place_order)
                
        Raises:
            ExchangeAPIError: If fetch fails
        """
        pass
    
    @abstractmethod
    async def fetch_fills(
        self,
        product_id: Optional[str] = None,
        order_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Fetch order fills/trades
        
        Args:
            product_id: Product identifier (optional filter)
            order_id: Order ID (optional filter)
            limit: Maximum number of fills to return
            
        Returns:
            List[Dict]: List of fills with keys:
                - fill_id: Fill identifier
                - order_id: Order ID
                - product_id: Product identifier
                - side: Order side ('buy' or 'sell')
                - size: Fill size (Decimal)
                - price: Fill price (Decimal)
                - fee: Fee amount (Decimal)
                - fee_currency: Fee currency
                - timestamp: Fill timestamp
                
        Raises:
            ExchangeAPIError: If fetch fails
        """
        pass
    
    # WebSocket methods (optional but recommended for real-time data)
    
    async def subscribe_ticker(
        self,
        product_id: str,
        callback: callable
    ) -> bool:
        """
        Subscribe to real-time ticker updates (optional)
        
        Args:
            product_id: Product identifier
            callback: Async function to call with ticker updates
            
        Returns:
            bool: True if subscription successful
        """
        logger.warning(
            f"WebSocket ticker subscription not implemented for {self.exchange_name}",
            exchange=self.exchange_name
        )
        return False
    
    async def subscribe_orderbook(
        self,
        product_id: str,
        callback: callable
    ) -> bool:
        """
        Subscribe to real-time order book updates (optional)
        
        Args:
            product_id: Product identifier
            callback: Async function to call with order book updates
            
        Returns:
            bool: True if subscription successful
        """
        logger.warning(
            f"WebSocket orderbook subscription not implemented for {self.exchange_name}",
            exchange=self.exchange_name
        )
        return False
    
    def is_connected(self) -> bool:
        """Check if connector is connected"""
        return self.connected
    
    def get_rate_limit(self) -> int:
        """Get rate limit per second from config"""
        return self.config.get('rate_limit_per_second', 10)
    
    def get_priority(self) -> int:
        """Get exchange priority from config"""
        return self.config.get('priority', 999)
    
    def is_enabled(self) -> bool:
        """Check if exchange is enabled in config"""
        return self.config.get('enabled', True)
    
    @abstractmethod
    async def fetch_perpetual_positions(self) -> List[Dict[str, Any]]:
        """
        Fetch perpetual futures positions from exchange.
        
        Returns:
            List[Dict]: List of positions with standardized format:
                - symbol: str (e.g., "BTC-PERP")
                - quantity: Decimal (positive = long, negative = short)
                - entry_price: Decimal
                - leverage: Decimal
                - margin_used: Decimal
                - liquidation_price: Optional[Decimal]
                - position_id: Optional[str] (exchange-specific ID)
                - exchange: str (exchange name, will be set by adapter)
            
        Raises:
            ExchangeAPIError: If API call fails
            NotImplementedError: If exchange doesn't support perpetuals
        """
        raise NotImplementedError(
            f"{self.exchange_name} does not support perpetual positions"
        )



