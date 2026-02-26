"""
Option Chain Cache - Simple cache with TTL
Thread-safe caching for option chains
"""
from datetime import datetime, timedelta
from typing import Dict, Optional, List
from dataclasses import dataclass
import asyncio

from typing import TYPE_CHECKING, List
if TYPE_CHECKING:
    from services.option_chains.chain_service import OptionChain
from utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class CacheEntry:
    """Cache entry with TTL."""
    data: List['OptionChain']
    timestamp: datetime
    ttl_seconds: int = 30  # 30 second TTL


class OptionChainCache:
    """
    Simple cache for option chains with TTL.
    Thread-safe using asyncio locks.
    """
    
    def __init__(self):
        """Initialize cache."""
        self._cache: Dict[str, CacheEntry] = {}
        self._lock = asyncio.Lock()
    
    async def get(
        self,
        cache_key: str,
        fetcher: callable,
        ttl_seconds: int = 30
    ) -> List['OptionChain']:
        """
        Get cached chains or fetch if expired/missing.
        
        Args:
            cache_key: Cache key (e.g., "expiry-2025-12-31-deribit")
            fetcher: Async function to fetch chains if cache miss
            ttl_seconds: TTL in seconds (default 30)
            
        Returns:
            List of option chains
        """
        async with self._lock:
            entry = self._cache.get(cache_key)
            
            # Check if entry exists and is valid
            if entry:
                age = (datetime.now() - entry.timestamp).total_seconds()
                if age < entry.ttl_seconds:
                    logger.debug(
                        "Cache hit",
                        cache_key=cache_key,
                        age_seconds=age
                    )
                    return entry.data
                else:
                    logger.debug(
                        "Cache expired",
                        cache_key=cache_key,
                        age_seconds=age
                    )
            
            # Cache miss or expired - fetch
            logger.debug("Cache miss, fetching", cache_key=cache_key)
            chains = await fetcher()
            
            # Store in cache
            self._cache[cache_key] = CacheEntry(
                data=chains,
                timestamp=datetime.now(),
                ttl_seconds=ttl_seconds
            )
            
            return chains
    
    async def clear(self):
        """Clear all cache entries."""
        async with self._lock:
            self._cache.clear()
            logger.info("Cleared option chain cache")
    
    async def get_stats(self) -> Dict:
        """Get cache statistics."""
        async with self._lock:
            return {
                'entries': len(self._cache),
                'keys': list(self._cache.keys())
            }


# Singleton instance
_cache_instance: Optional[OptionChainCache] = None


def get_chain_cache() -> OptionChainCache:
    """Get singleton cache instance."""
    global _cache_instance
    
    if _cache_instance is None:
        _cache_instance = OptionChainCache()
    
    return _cache_instance

