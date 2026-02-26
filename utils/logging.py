"""
Production logging - Structured, time-synced, JSON format
"""
import structlog
import logging
from datetime import datetime
import sys
from typing import Optional


def setup_logging(
    log_level: str = "INFO",
    json_output: bool = True,
    include_traceback: bool = True
) -> structlog.BoundLogger:
    """
    Setup structured logging for production
    
    Args:
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        json_output: If True, output JSON format (production), else plain text (development)
        include_traceback: If True, include full tracebacks in errors
        
    Returns:
        structlog.BoundLogger: Configured logger instance
    """
    # Configure processors
    processors = [
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]
    
    # Add traceback processor if enabled
    if include_traceback:
        processors.append(structlog.processors.format_exc_info)
    
    processors.extend([
        structlog.processors.UnicodeDecoder(),
    ])
    
    # Choose output format
    if json_output:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.processors.KeyValueRenderer())
    
    # Configure structlog
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    
    # Set standard library logging level
    logging.basicConfig(
        format="%(message)s" if json_output else "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level.upper(), logging.INFO),
    )
    
    return structlog.get_logger()


# Global logger instance (will be initialized on first use)
_logger: Optional[structlog.BoundLogger] = None


def get_logger(name: Optional[str] = None) -> structlog.BoundLogger:
    """
    Get logger instance
    
    Args:
        name: Logger name (optional, defaults to module name)
        
    Returns:
        structlog.BoundLogger: Logger instance
    """
    global _logger
    
    if _logger is None:
        # Initialize with default settings
        _logger = setup_logging()
    
    if name:
        return _logger.bind(logger_name=name)
    
    return _logger


# Initialize default logger
logger = get_logger(__name__)



