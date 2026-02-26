"""
Configuration loader for Kalshi demo
Simplified version for demo exchanges
"""
import tomllib
from pathlib import Path
from typing import Dict, Any, Optional

from utils.logging import get_logger
from utils.error_handler import ConfigurationError

logger = get_logger(__name__)

_config_loader_instance: Optional['ConfigLoader'] = None


class ConfigLoader:
    """Load configuration from TOML files."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        """
        Initialize config loader.
        
        Args:
            config_dir: Directory containing config files (defaults to configs/)
        """
        if config_dir is None:
            config_dir = Path(__file__).parent
        
        self.config_dir = Path(config_dir)
        self._exchanges_config: Optional[Dict[str, Any]] = None
        self._kalshi_config: Optional[Dict[str, Any]] = None
    
    def get_exchange_config(self, exchange_name: str) -> Dict[str, Any]:
        """
        Get configuration for a specific exchange.
        
        Args:
            exchange_name: Name of exchange
            
        Returns:
            Dict: Exchange configuration
            
        Raises:
            ConfigurationError: If exchange not found
        """
        if self._exchanges_config is None:
            self._load_exchanges_config()
        
        if exchange_name not in self._exchanges_config:
            raise ConfigurationError(
                f"Exchange '{exchange_name}' not found in configuration",
                config_key=f"exchanges.{exchange_name}"
            )
        
        return self._exchanges_config[exchange_name]
    
    def get_kalshi_config(self) -> Dict[str, Any]:
        """Get Kalshi configuration."""
        if self._kalshi_config is None:
            self._load_kalshi_config()
        
        return self._kalshi_config
    
    def _load_exchanges_config(self):
        """Load exchanges.toml configuration."""
        config_path = self.config_dir / "exchanges.toml"
        
        if not config_path.exists():
            logger.warning(
                "exchanges.toml not found, using empty config",
                config_path=str(config_path)
            )
            self._exchanges_config = {}
            return
        
        try:
            with open(config_path, 'rb') as f:
                config_data = tomllib.load(f)
            
            self._exchanges_config = config_data
            logger.info(
                "Loaded exchanges configuration",
                exchanges=list(config_data.keys())
            )
        except Exception as exc:
            logger.error(
                "Failed to load exchanges configuration",
                error=str(exc),
                config_path=str(config_path)
            )
            raise ConfigurationError(
                f"Failed to load exchanges config: {exc}",
                config_key="exchanges.toml"
            )
    
    def _load_kalshi_config(self):
        """Load kalshi.toml configuration."""
        config_path = self.config_dir / "kalshi.toml"
        
        if not config_path.exists():
            logger.warning(
                "kalshi.toml not found, using empty config",
                config_path=str(config_path)
            )
            self._kalshi_config = {}
            return
        
        try:
            with open(config_path, 'rb') as f:
                config_data = tomllib.load(f)
            
            self._kalshi_config = config_data
            logger.info("Loaded Kalshi configuration")
        except Exception as exc:
            logger.error(
                "Failed to load Kalshi configuration",
                error=str(exc),
                config_path=str(config_path)
            )
            raise ConfigurationError(
                f"Failed to load Kalshi config: {exc}",
                config_key="kalshi.toml"
            )


def get_config_loader() -> ConfigLoader:
    """Get singleton config loader instance."""
    global _config_loader_instance
    
    if _config_loader_instance is None:
        _config_loader_instance = ConfigLoader()
    
    return _config_loader_instance



