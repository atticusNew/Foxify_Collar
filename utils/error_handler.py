"""
Production error handling - Comprehensive, structured error management
"""
from typing import Dict, Any, Optional
from decimal import Decimal
import traceback
from datetime import datetime
from utils.logging import get_logger

logger = get_logger(__name__)


class PlatformError(Exception):
    """Base platform error"""
    
    def __init__(
        self,
        message: str,
        error_code: str = None,
        details: Dict[str, Any] = None,
        status_code: int = 500
    ):
        self.message = message
        self.error_code = error_code or "PLATFORM_ERROR"
        self.details = details or {}
        self.status_code = status_code
        super().__init__(self.message)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert error to dictionary for API responses"""
        return {
            'error': self.error_code,
            'message': self.message,
            'details': self.details,
            'timestamp': datetime.utcnow().isoformat()
        }


class ExchangeConnectionError(PlatformError):
    """Exchange connection/API error"""
    
    def __init__(self, message: str, exchange: str = None, details: Dict = None):
        super().__init__(
            message=message,
            error_code="EXCHANGE_CONNECTION_ERROR",
            details=details or {},
            status_code=503
        )
        self.exchange = exchange


class ExchangeAPIError(PlatformError):
    """Exchange API error (rate limit, invalid request, etc.)"""
    
    def __init__(self, message: str, exchange: str = None, details: Dict = None):
        super().__init__(
            message=message,
            error_code="EXCHANGE_API_ERROR",
            details=details or {},
            status_code=429
        )
        self.exchange = exchange


class PricingError(PlatformError):
    """Pricing calculation error"""
    
    def __init__(self, message: str, details: Dict = None):
        super().__init__(
            message=message,
            error_code="PRICING_ERROR",
            details=details or {},
            status_code=500
        )


class HedgingError(PlatformError):
    """Hedging execution error"""
    
    def __init__(self, message: str, details: Dict = None):
        super().__init__(
            message=message,
            error_code="HEDGING_ERROR",
            details=details or {},
            status_code=500
        )


class InsufficientLiquidityError(PlatformError):
    """Insufficient liquidity for trade"""
    
    def __init__(self, message: str, required: Decimal = None, available: Decimal = None):
        details = {}
        if required is not None:
            details['required'] = str(required)
        if available is not None:
            details['available'] = str(available)
        
        super().__init__(
            message=message,
            error_code="INSUFFICIENT_LIQUIDITY",
            details=details,
            status_code=400
        )


class ConfigurationError(PlatformError):
    """Configuration error"""
    
    def __init__(self, message: str, config_key: str = None):
        details = {}
        if config_key:
            details['config_key'] = config_key
        
        super().__init__(
            message=message,
            error_code="CONFIGURATION_ERROR",
            details=details,
            status_code=500
        )


class ValidationError(PlatformError):
    """Input validation error"""
    
    def __init__(self, message: str, field: str = None, value: Any = None):
        details = {}
        if field:
            details['field'] = field
        if value is not None:
            details['value'] = str(value)
        
        super().__init__(
            message=message,
            error_code="VALIDATION_ERROR",
            details=details,
            status_code=400
        )


def handle_error(
    error: Exception,
    context: Dict[str, Any],
    error_code: str = None,
    log_error: bool = True
) -> Dict[str, Any]:
    """
    Handle and log errors with full context
    
    Args:
        error: Exception that occurred
        context: Additional context about where error occurred
        error_code: Custom error code (optional)
        log_error: Whether to log the error (default True)
        
    Returns:
        Dict: Error details dictionary
    """
    error_details = {
        'error_type': type(error).__name__,
        'error_message': str(error),
        'error_code': error_code or getattr(error, 'error_code', 'UNKNOWN_ERROR'),
        'context': context,
        'traceback': traceback.format_exc(),
        'timestamp': datetime.utcnow().isoformat()
    }
    
    # Add error-specific details if available
    if isinstance(error, PlatformError):
        error_details['platform_error_details'] = error.details
        error_details['status_code'] = error.status_code
    
    if log_error:
        logger.error(
            "Platform error occurred",
            **error_details
        )
    
    return error_details


def handle_exchange_error(
    error: Exception,
    exchange: str,
    operation: str,
    context: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Handle exchange-specific errors
    
    Args:
        error: Exception that occurred
        exchange: Exchange name
        operation: Operation that failed
        context: Additional context
        
    Returns:
        Dict: Error details
    """
    error_context = {
        'exchange': exchange,
        'operation': operation,
        **(context or {})
    }
    
    # Determine error code based on exception type
    if isinstance(error, ConnectionError) or "connection" in str(error).lower():
        error_code = "EXCHANGE_CONNECTION_ERROR"
    elif isinstance(error, TimeoutError) or "timeout" in str(error).lower():
        error_code = "EXCHANGE_TIMEOUT_ERROR"
    elif "rate limit" in str(error).lower() or "429" in str(error):
        error_code = "EXCHANGE_RATE_LIMIT_ERROR"
    else:
        error_code = "EXCHANGE_API_ERROR"
    
    return handle_error(error, error_context, error_code)



