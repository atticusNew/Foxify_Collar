"""
Performance profiling utilities for timing and optimization.
"""
import time
import functools
from contextlib import contextmanager
from typing import Dict, Optional
from utils.logging import get_logger

logger = get_logger(__name__)


class PerformanceProfiler:
    """Context manager for profiling code blocks."""
    
    def __init__(self, operation_name: str):
        self.operation_name = operation_name
        self.start_time: Optional[float] = None
        self.end_time: Optional[float] = None
        self.duration_ms: Optional[float] = None
    
    def __enter__(self):
        self.start_time = time.perf_counter()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.end_time = time.perf_counter()
        self.duration_ms = (self.end_time - self.start_time) * 1000
        logger.info(
            f"⏱️  {self.operation_name}",
            duration_ms=f"{self.duration_ms:.2f}ms"
        )
        return False
    
    def get_duration_ms(self) -> float:
        """Get duration in milliseconds."""
        if self.duration_ms is None:
            return (time.perf_counter() - self.start_time) * 1000 if self.start_time else 0.0
        return self.duration_ms


def timed_async(func):
    """Decorator to time async functions."""
    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        operation_name = f"{func.__module__}.{func.__name__}"
        with PerformanceProfiler(operation_name):
            return await func(*args, **kwargs)
    return wrapper


def timed_sync(func):
    """Decorator to time sync functions."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        operation_name = f"{func.__module__}.{func.__name__}"
        with PerformanceProfiler(operation_name):
            return func(*args, **kwargs)
    return wrapper


@contextmanager
def time_block(operation_name: str):
    """Context manager for timing a code block."""
    with PerformanceProfiler(operation_name) as profiler:
        yield profiler

