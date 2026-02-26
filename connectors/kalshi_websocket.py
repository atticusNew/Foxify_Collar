"""
Kalshi WebSocket Connector
Real-time market data via WebSocket
"""
import asyncio
import json
import time
from typing import Dict, List, Optional, Any, Callable
from datetime import datetime, timezone
from decimal import Decimal

import websockets
from websockets.client import WebSocketClientProtocol
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from utils.logging import get_logger
from utils.error_handler import ExchangeConnectionError, ExchangeAPIError
from utils.decimal_utils import DecimalMath as DM

logger = get_logger(__name__)


class KalshiWebSocketConnector:
    """
    WebSocket connector for Kalshi real-time market data.
    
    Supports:
    - Market data subscriptions
    - Real-time price updates
    - Market listings
    """
    
    def __init__(
        self,
        base_url: str,
        api_key: str,
        private_key: Any = None,
        on_market_update: Optional[Callable] = None
    ):
        """
        Initialize WebSocket connector.
        
        Args:
            base_url: REST API base URL (will convert to WebSocket URL)
            api_key: API key for authentication
            private_key: RSA private key for signature generation
            on_market_update: Callback for market updates
        """
        # Convert HTTP URL to WebSocket URL
        # Kalshi WebSocket is at /trade-api/ws/v2
        if base_url.startswith('https://'):
            ws_url = base_url.replace('https://', 'wss://').replace('/trade-api/v2', '/trade-api/ws/v2')
        elif base_url.startswith('http://'):
            ws_url = base_url.replace('http://', 'ws://').replace('/trade-api/v2', '/trade-api/ws/v2')
        else:
            ws_url = base_url
        
        # Ensure it's a WebSocket URL
        if not ws_url.startswith('ws'):
            ws_url = f"wss://{ws_url}/trade-api/ws/v2"
        
        self.ws_url = ws_url
        self.private_key = private_key
        self.api_key = api_key
        self.on_market_update = on_market_update
        self.ws: Optional[WebSocketClientProtocol] = None
        self.connected = False
        self.subscriptions: Dict[str, List[str]] = {}  # channel -> [market_ids]
        self._receive_task: Optional[asyncio.Task] = None
        
    async def connect(self) -> bool:
        """Connect to WebSocket."""
        try:
            import base64
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import padding
            
            # Generate signature for WebSocket connection
            # Kalshi uses RSA-PSS signature similar to REST API
            timestamp = str(int(time.time() * 1000))  # Milliseconds
            
            if self.private_key:
                # Sign timestamp + method + path
                message = f"{timestamp}GET/trade-api/ws/v2".encode('utf-8')
                signature = self.private_key.sign(
                    message,
                    padding.PSS(
                        mgf=padding.MGF1(hashes.SHA256()),
                        salt_length=padding.PSS.DIGEST_LENGTH
                    ),
                    hashes.SHA256()
                )
                signature_b64 = base64.b64encode(signature).decode('utf-8')
            else:
                signature_b64 = ''
            
            # Kalshi WebSocket authentication headers
            headers = {
                'KALSHI-ACCESS-KEY': self.api_key,
                'KALSHI-ACCESS-TIMESTAMP': timestamp,
                'KALSHI-ACCESS-SIGNATURE': signature_b64,
            }
            
            self.ws = await websockets.connect(
                self.ws_url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=10
            )
            
            self.connected = True
            
            # Start receiving messages
            self._receive_task = asyncio.create_task(self._receive_loop())
            
            logger.info(
                "Connected to Kalshi WebSocket",
                url=self.ws_url
            )
            
            return True
            
        except Exception as exc:
            logger.error(
                "Failed to connect to Kalshi WebSocket",
                error=str(exc),
                url=self.ws_url
            )
            raise ExchangeConnectionError(
                f"Failed to connect to Kalshi WebSocket: {exc}",
                exchange="kalshi"
            )
    
    async def disconnect(self):
        """Disconnect from WebSocket."""
        self.connected = False
        
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
        
        if self.ws:
            await self.ws.close()
            self.ws = None
        
        logger.info("Disconnected from Kalshi WebSocket")
    
    async def subscribe_markets(
        self,
        market_ids: Optional[List[str]] = None,
        category: Optional[str] = None,
        ticker_prefix: Optional[str] = None
    ) -> bool:
        """
        Subscribe to market updates.
        
        Args:
            market_ids: Specific market IDs to subscribe to (None = all)
            category: Filter by category (e.g., 'crypto')
            ticker_prefix: Filter by ticker prefix (e.g., 'BTC')
        """
        if not self.connected or not self.ws:
            raise ExchangeConnectionError(
                "Not connected to WebSocket",
                exchange="kalshi"
            )
        
        try:
            # Build subscribe command based on Kalshi WebSocket API
            # Format: {"action": "subscribe", "channels": ["markets"]}
            subscribe_cmd = {
                "action": "subscribe",
                "channels": ["markets"]
            }
            
            # Add filters if provided
            if market_ids:
                subscribe_cmd["markets"] = market_ids
            if category:
                subscribe_cmd["category"] = category
            if ticker_prefix:
                subscribe_cmd["ticker_prefix"] = ticker_prefix
            
            await self.ws.send(json.dumps(subscribe_cmd))
            
            logger.info(
                "Subscribed to Kalshi markets",
                market_count=len(market_ids) if market_ids else 0,
                category=category,
                ticker_prefix=ticker_prefix
            )
            
            return True
            
        except Exception as exc:
            logger.error(
                "Failed to subscribe to markets",
                error=str(exc)
            )
            raise ExchangeAPIError(
                f"Failed to subscribe: {exc}",
                exchange="kalshi"
            )
    
    async def unsubscribe_markets(self, market_ids: Optional[List[str]] = None):
        """Unsubscribe from market updates."""
        if not self.connected or not self.ws:
            return
        
        try:
            unsubscribe_cmd = {
                "action": "unsubscribe",
                "channel": "markets"
            }
            
            if market_ids:
                unsubscribe_cmd["markets"] = market_ids
            
            await self.ws.send(json.dumps(unsubscribe_cmd))
            
            logger.info("Unsubscribed from Kalshi markets")
            
        except Exception as exc:
            logger.error(
                "Failed to unsubscribe from markets",
                error=str(exc)
            )
    
    async def _receive_loop(self):
        """Receive and process WebSocket messages."""
        try:
            async for message in self.ws:
                if not self.connected:
                    break
                
                try:
                    data = json.loads(message)
                    await self._handle_message(data)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON received from WebSocket")
                except Exception as exc:
                    logger.error(
                        "Error handling WebSocket message",
                        error=str(exc)
                    )
                    
        except websockets.exceptions.ConnectionClosed:
            logger.info("WebSocket connection closed")
            self.connected = False
        except asyncio.CancelledError:
            logger.info("WebSocket receive loop cancelled")
        except Exception as exc:
            logger.error(
                "WebSocket receive loop error",
                error=str(exc)
            )
            self.connected = False
    
    async def _handle_message(self, data: Dict[str, Any]):
        """Handle incoming WebSocket message."""
        msg_type = data.get('type') or data.get('action')
        
        if msg_type == 'subscribed':
            logger.info("Subscription confirmed", channel=data.get('channel'))
        elif msg_type == 'market_update' or 'market' in msg_type.lower():
            # Market data update
            if self.on_market_update:
                await self.on_market_update(data)
        elif msg_type == 'error':
            logger.error("WebSocket error", error=data.get('message'))
        elif msg_type == 'ping':
            # Respond to ping
            await self.ws.send(json.dumps({'type': 'pong'}))
        else:
            logger.debug("Unhandled WebSocket message", type=msg_type)
    
    async def list_subscriptions(self) -> List[Dict[str, Any]]:
        """List active subscriptions."""
        if not self.connected or not self.ws:
            return []
        
        try:
            list_cmd = {
                "action": "list_subscriptions"
            }
            
            await self.ws.send(json.dumps(list_cmd))
            
            # Wait for response (simplified - would need proper response handling)
            await asyncio.sleep(0.1)
            
            return []
            
        except Exception as exc:
            logger.error(
                "Failed to list subscriptions",
                error=str(exc)
            )
            return []

