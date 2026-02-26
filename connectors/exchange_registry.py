"""
Exchange Registry for Kalshi Demo
Manages Deribit, OKX, Kraken, and Kalshi connectors
"""
import os
from typing import Dict, Optional, Type, List

from configs.loader import get_config_loader
from utils.logging import get_logger
from utils.error_handler import ConfigurationError, ValidationError

from .base_connector import ExchangeConnector

logger = get_logger(__name__)


class ExchangeRegistry:
    """
    Registry for exchange connectors
    Manages initialization, configuration, and access to exchange connectors
    """
    
    # Mapping of exchange names to connector classes
    CONNECTOR_CLASSES: Dict[str, Type[ExchangeConnector]] = {
        'deribit': None,  # Will be imported when implemented
        'okx': None,  # Will be imported when implemented
        'kraken': None,  # Will be imported when implemented
        'kalshi': None,  # Will be imported when implemented
    }
    
    def __init__(self):
        """Initialize exchange registry"""
        self.config_loader = get_config_loader()
        self.connectors: Dict[str, ExchangeConnector] = {}
        self._initialized = False
        
        # Lazy import connectors to avoid circular dependencies
        self._load_connector_classes()
        
        logger.info(
            "Exchange registry initialized",
            available_connectors=[k for k, v in self.CONNECTOR_CLASSES.items() if v is not None]
        )
    
    def _load_connector_classes(self):
        """Lazy load connector classes to avoid circular imports."""
        try:
            from .deribit_connector import DeribitConnector
            self.CONNECTOR_CLASSES['deribit'] = DeribitConnector
            logger.debug("DeribitConnector loaded")
        except ImportError as e:
            logger.warning("DeribitConnector not available", error=str(e))
        
        try:
            from .okx_connector import OKXConnector
            self.CONNECTOR_CLASSES['okx'] = OKXConnector
            logger.debug("OKXConnector loaded")
        except ImportError as e:
            logger.warning("OKXConnector not available", error=str(e))
        
        try:
            from .kraken_connector import KrakenConnector
            self.CONNECTOR_CLASSES['kraken'] = KrakenConnector
            logger.debug("KrakenConnector loaded")
        except ImportError as e:
            logger.warning("KrakenConnector not available", error=str(e))
        
        try:
            from .kalshi_connector import KalshiConnector
            self.CONNECTOR_CLASSES['kalshi'] = KalshiConnector
            logger.debug("KalshiConnector loaded")
        except ImportError as e:
            logger.warning("KalshiConnector not available", error=str(e))
    
    def _load_credentials(self, exchange_name: str, config: Dict) -> Dict[str, str]:
        """
        Load credentials from environment variables
        
        For public feeds (Deribit, OKX, Kraken), no credentials needed.
        For Kalshi, loads RSA private key.
        
        Args:
            exchange_name: Name of exchange
            config: Exchange configuration from exchanges.toml
            
        Returns:
            Dict: Credentials dictionary (empty for public feeds)
        """
        credentials = {}
        
        # Public feeds don't need credentials
        if exchange_name in ['deribit', 'okx', 'kraken']:
            logger.debug(
                f"Public feed exchange '{exchange_name}' - no credentials needed",
                exchange=exchange_name
            )
            return credentials
        
        # Kalshi uses RSA private key
        if exchange_name == 'kalshi':
            # First try environment variable for path
            private_key_path_env = config.get('private_key_path_env', 'KALSHI_PRIVATE_KEY_PATH')
            private_key_path = os.getenv(private_key_path_env)
            
            # If not in env, try config file path (relative to project root)
            if not private_key_path:
                private_key_path = config.get('private_key_path', '')
                if private_key_path:
                    # Resolve relative to project root (kalshi_demo/)
                    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                    private_key_path = os.path.join(project_root, private_key_path)
            
            if private_key_path and os.path.exists(private_key_path):
                # Read private key from file
                try:
                    with open(private_key_path, 'r') as f:
                        private_key = f.read()
                    credentials['private_key'] = private_key
                    logger.debug(f"Loaded Kalshi private key from file: {private_key_path}")
                except Exception as exc:
                    raise ValidationError(
                        f"Failed to read Kalshi private key: {exc}",
                        field="credentials.private_key_path",
                        value=private_key_path
                    )
            else:
                # Try direct env var
                private_key_env = config.get('private_key_env', 'KALSHI_PRIVATE_KEY')
                private_key = os.getenv(private_key_env)
                if private_key:
                    credentials['private_key'] = private_key
                    logger.debug("Loaded Kalshi private key from environment variable")
                else:
                    raise ValidationError(
                        f"Missing Kalshi credentials: private_key_path or private_key. "
                        f"Checked: env={private_key_path_env}, config={config.get('private_key_path', 'N/A')}, "
                        f"direct_env={private_key_env}",
                        field="credentials",
                        value="missing"
                    )
        
        logger.debug(
            f"Loaded credentials for {exchange_name}",
            exchange=exchange_name,
            credential_keys=list(credentials.keys())
        )
        
        return credentials
    
    async def initialize_exchange(self, exchange_name: str) -> ExchangeConnector:
        """
        Initialize a single exchange connector
        
        Args:
            exchange_name: Name of exchange (e.g., 'deribit')
            
        Returns:
            ExchangeConnector: Initialized connector
            
        Raises:
            ConfigurationError: If exchange configuration invalid
            ValidationError: If credentials missing (for Kalshi)
        """
        # For Kalshi, don't cache connectors to avoid event loop issues
        # Always create fresh connector to ensure it's in the current event loop
        if exchange_name == 'kalshi':
            # Don't use cached connector - create fresh one
            pass
        elif exchange_name in self.connectors:
            # For other exchanges, check if cached connector is still connected
            cached_connector = self.connectors[exchange_name]
            if cached_connector.is_connected():
                logger.debug(f"Reusing cached connection for {exchange_name}")
                return cached_connector
            else:
                # Connection lost, remove from cache and reconnect below
                logger.info(f"Cached connector for {exchange_name} is disconnected, reconnecting...")
                del self.connectors[exchange_name]
        
        # Get exchange configuration
        try:
            config = self.config_loader.get_exchange_config(exchange_name)
        except ConfigurationError as e:
            logger.error(
                f"Exchange '{exchange_name}' not found in configuration",
                exchange=exchange_name
            )
            raise
        
        # Check if exchange is enabled
        if not config.get('enabled', True):
            logger.warning(
                f"Exchange '{exchange_name}' is disabled in configuration",
                exchange=exchange_name
            )
            raise ConfigurationError(
                f"Exchange '{exchange_name}' is disabled",
                config_key=f"exchanges.{exchange_name}.enabled"
            )
        
        # Check if connector class exists
        connector_class = self.CONNECTOR_CLASSES.get(exchange_name)
        if not connector_class or connector_class is None:
            raise ConfigurationError(
                f"No connector implementation for '{exchange_name}'. Available: {[k for k, v in self.CONNECTOR_CLASSES.items() if v is not None]}",
                config_key=f"exchanges.{exchange_name}"
            )
        
        # Load credentials (empty for public feeds)
        try:
            credentials = self._load_credentials(exchange_name, config)
        except ValidationError as e:
            logger.error(
                f"Failed to load credentials for '{exchange_name}'",
                exchange=exchange_name,
                error=str(e)
            )
            raise
        
        # Initialize connector
        try:
            connector = connector_class(
                exchange_name=exchange_name,
                config=config,
                credentials=credentials
            )
            
            # Only connect if not already connected (for cached connectors that were reinitialized)
            if not connector.is_connected():
                await connector.connect()
            else:
                logger.debug(f"Connector for {exchange_name} already connected, skipping connection")
            
            # Cache connector (except for Kalshi to avoid event loop issues)
            if exchange_name != 'kalshi':
                self.connectors[exchange_name] = connector
            
            logger.info(
                f"Initialized exchange connector '{exchange_name}'",
                exchange=exchange_name
            )
            
            return connector
            
        except Exception as exc:
            logger.error(
                f"Failed to initialize exchange '{exchange_name}'",
                exchange=exchange_name,
                error=str(exc)
            )
            raise ConfigurationError(
                f"Failed to initialize exchange '{exchange_name}': {exc}",
                config_key=f"exchanges.{exchange_name}"
            )
    
    def get_enabled_connectors(self) -> List[ExchangeConnector]:
        """
        Get all enabled and initialized connectors
        
        Returns:
            List[ExchangeConnector]: List of enabled connectors
        """
        return list(self.connectors.values())
    
    def get_primary_connector(self) -> Optional[ExchangeConnector]:
        """
        Get primary connector (highest priority)
        
        Returns:
            ExchangeConnector: Primary connector or None
        """
        enabled = self.get_enabled_connectors()
        if not enabled:
            return None
        
        # Return connector with highest priority (lowest priority number)
        return min(enabled, key=lambda c: c.get_priority())


# Singleton instance
_registry_instance: Optional[ExchangeRegistry] = None


def get_exchange_registry() -> ExchangeRegistry:
    """Get singleton exchange registry instance."""
    global _registry_instance
    
    if _registry_instance is None:
        _registry_instance = ExchangeRegistry()
    
    return _registry_instance

