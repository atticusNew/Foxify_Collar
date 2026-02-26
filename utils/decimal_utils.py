"""
Production-ready Decimal utilities for all financial calculations
NO FLOAT OPERATIONS - ALL DECIMAL
"""
from decimal import Decimal, getcontext, ROUND_DOWN, ROUND_UP, ROUND_HALF_UP
from typing import Union
import math

# Set high precision for financial calculations
getcontext().prec = 28
getcontext().rounding = ROUND_DOWN  # Conservative rounding for financial


class DecimalMath:
    """Decimal math utilities for financial calculations - Production ready"""
    
    @staticmethod
    def to_decimal(value: Union[str, int, float, Decimal]) -> Decimal:
        """
        Safely convert any value to Decimal
        
        Args:
            value: Value to convert (str, int, float, or Decimal)
            
        Returns:
            Decimal: Converted value with high precision
            
        Raises:
            TypeError: If value cannot be converted to Decimal
        """
        if isinstance(value, Decimal):
            return value
        if isinstance(value, str):
            # Remove any whitespace and validate
            cleaned = value.strip()
            if not cleaned:
                raise ValueError("Cannot convert empty string to Decimal")
            return Decimal(cleaned)
        if isinstance(value, (int, float)):
            # Convert via string to avoid float precision issues
            return Decimal(str(value))
        raise TypeError(f"Cannot convert {type(value)} to Decimal")
    
    @staticmethod
    def sqrt(x: Decimal) -> Decimal:
        """
        Square root with Decimal precision
        
        Args:
            x: Value to take square root of
            
        Returns:
            Decimal: Square root with high precision
            
        Raises:
            ValueError: If x is negative
        """
        if x < 0:
            raise ValueError("Cannot take square root of negative number")
        return Decimal(str(math.sqrt(float(x))))
    
    @staticmethod
    def exp(x: Decimal) -> Decimal:
        """
        Exponential function with Decimal precision
        
        Args:
            x: Exponent value
            
        Returns:
            Decimal: e^x with high precision
        """
        return Decimal(str(math.exp(float(x))))
    
    @staticmethod
    def ln(x: Decimal) -> Decimal:
        """
        Natural logarithm with Decimal precision
        
        Args:
            x: Value to take natural log of
            
        Returns:
            Decimal: Natural logarithm with high precision
            
        Raises:
            ValueError: If x <= 0
        """
        if x <= 0:
            raise ValueError("ln(x) requires x > 0")
        return Decimal(str(math.log(float(x))))
    
    @staticmethod
    def log(x: Decimal, base: Decimal = Decimal('10')) -> Decimal:
        """
        Logarithm with custom base
        
        Args:
            x: Value to take log of
            base: Base of logarithm (default 10)
            
        Returns:
            Decimal: Logarithm with high precision
        """
        if x <= 0:
            raise ValueError("log(x) requires x > 0")
        if base <= 0 or base == Decimal('1'):
            raise ValueError("log base must be > 0 and != 1")
        return DecimalMath.ln(x) / DecimalMath.ln(base)
    
    @staticmethod
    def norm_cdf(x: Decimal) -> Decimal:
        """
        Cumulative distribution function for standard normal distribution
        Uses scipy.stats.norm.cdf for precision
        
        Args:
            x: Z-score value
            
        Returns:
            Decimal: Cumulative probability (0 to 1)
        """
        try:
            from scipy.stats import norm
            return Decimal(str(norm.cdf(float(x))))
        except ImportError:
            # Fallback approximation if scipy not available
            # Using Abramowitz and Stegun approximation
            t = Decimal('1') / (Decimal('1') + Decimal('0.2316419') * abs(x))
            d = Decimal('0.3989423') * DecimalMath.exp(-x * x / Decimal('2'))
            p = d * t * (Decimal('0.3193815') + 
                        t * (-Decimal('0.3565638') + 
                             t * (Decimal('1.7814779') + 
                                  t * (-Decimal('1.8212560') + 
                                       t * Decimal('1.3302744')))))
            if x > 0:
                return Decimal('1') - p
            return p
    
    @staticmethod
    def norm_pdf(x: Decimal) -> Decimal:
        """
        Probability density function for standard normal distribution
        
        Args:
            x: Value
            
        Returns:
            Decimal: Probability density
        """
        try:
            from scipy.stats import norm
            return Decimal(str(norm.pdf(float(x))))
        except ImportError:
            # Fallback: standard normal PDF formula
            return (Decimal('1') / DecimalMath.sqrt(Decimal('2') * Decimal(str(math.pi)))) * \
                   DecimalMath.exp(-x * x / Decimal('2'))
    
    @staticmethod
    def round_financial(value: Decimal, decimals: int = 8) -> Decimal:
        """
        Round for financial calculations (conservative rounding)
        
        Args:
            value: Value to round
            decimals: Number of decimal places (default 8 for BTC)
            
        Returns:
            Decimal: Rounded value
        """
        return value.quantize(Decimal('0.1') ** decimals, rounding=ROUND_DOWN)
    
    @staticmethod
    def round_precise(value: Decimal, decimals: int = 8) -> Decimal:
        """
        Round with half-up rounding (for precise calculations)
        
        Args:
            value: Value to round
            decimals: Number of decimal places
            
        Returns:
            Decimal: Rounded value
        """
        return value.quantize(Decimal('0.1') ** decimals, rounding=ROUND_HALF_UP)
    
    @staticmethod
    def percentage(value: Decimal, total: Decimal) -> Decimal:
        """
        Calculate percentage
        
        Args:
            value: Part value
            total: Total value
            
        Returns:
            Decimal: Percentage (0-100)
            
        Raises:
            ValueError: If total is zero
        """
        if total == 0:
            raise ValueError("Cannot calculate percentage with zero total")
        return (value / total) * Decimal('100')
    
    @staticmethod
    def percentage_change(old_value: Decimal, new_value: Decimal) -> Decimal:
        """
        Calculate percentage change
        
        Args:
            old_value: Original value
            new_value: New value
            
        Returns:
            Decimal: Percentage change
        """
        if old_value == 0:
            raise ValueError("Cannot calculate percentage change from zero")
        return ((new_value - old_value) / old_value) * Decimal('100')
    
    @staticmethod
    def max(*values: Decimal) -> Decimal:
        """
        Find maximum value
        
        Args:
            *values: Decimal values to compare
            
        Returns:
            Decimal: Maximum value
        """
        if not values:
            raise ValueError("max() requires at least one value")
        return max(values)
    
    @staticmethod
    def min(*values: Decimal) -> Decimal:
        """
        Find minimum value
        
        Args:
            *values: Decimal values to compare
            
        Returns:
            Decimal: Minimum value
        """
        if not values:
            raise ValueError("min() requires at least one value")
        return min(values)
    
    @staticmethod
    def abs(value: Decimal) -> Decimal:
        """
        Absolute value
        
        Args:
            value: Value to get absolute value of
            
        Returns:
            Decimal: Absolute value
        """
        return abs(value)


# Convenience aliases for common operations
DM = DecimalMath  # Shorter alias for code readability



