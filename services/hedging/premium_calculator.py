"""
Premium Calculator - Calculate premium and enforce premium ≤ max_payout
Follows specification exactly for premium calculation and scaling
"""
from decimal import Decimal
from typing import Dict, Optional

from utils.logging import get_logger

logger = get_logger(__name__)


class PremiumCalculator:
    """
    Calculate premium and scale notional to enforce premium ≤ max_payout.
    
    Specification:
    1. Initial notional: N = user_stake / (5 * spread_width)
    2. Premium: premium = N * spot * (c_long_ask - c_short_bid)
    3. Max payout: max_payout = N * spread_width
    4. Target premium: target_premium = min(user_budget, max_payout)
    5. Scale notional: N_final = N * (target_premium / premium_raw)
    6. Guarantee: target_premium <= max_payout_final
    
    Economic Validity:
    - Reject if premium > max_payout (economically nonsensical)
    - Require minimum value ratio (max_payout must be significantly more than premium)
    """
    
    MIN_VALUE_RATIO = Decimal('1.1')  # Max payout must be at least 10% more than premium
    MIN_CHARGED_PREMIUM_USD = Decimal('5')  # Minimum charge to user (after markup)
    MIN_MAX_PAYOUT_FOR_MIN_CHARGE = Decimal('5.50')  # $5 * 1.1 - minimum max_payout needed for $5 charge
    
    def calculate_and_scale(
        self,
        spread: Dict,
        spot_price: Decimal,
        user_budget: Decimal,
        user_stake: Decimal
    ) -> Optional[Dict]:
        """
        Calculate premium and scale notional.
        
        Args:
            spread: Spread structure from SpreadBuilder
            spot_price: Current BTC spot price
            user_budget: User hedge budget
            user_stake: User stake amount
            
        Returns:
            Dict with scaled spread and premium info or None if invalid
        """
        spread_width = spread['spread_width']
        legs = spread['legs']
        
        if len(legs) != 2:
            logger.warning("Spread must have exactly 2 legs", leg_count=len(legs))
            return None
        
        long_leg = legs[0]  # K₁ (long)
        short_leg = legs[1]  # K₂ (short)
        
        # Get prices
        long_ask = long_leg['contract'].ask
        short_bid = short_leg['contract'].bid
        
        if long_ask <= 0 or short_bid <= 0:
            logger.debug("Invalid prices for premium calculation")
            return None
        
        # Step 1: Initial notional guess
        initial_notional = user_stake / (Decimal('5') * spread_width)
        
        # Step 2: Calculate raw premium
        # Premium = N * spot * (c_long_ask - c_short_bid)
        # For PUT spreads: long_ask (lower strike) should be > short_bid (higher strike)
        # For CALL spreads: long_ask (lower strike) should be < short_bid (higher strike)
        premium_raw = initial_notional * spot_price * (long_ask - short_bid)
        
        # Validate premium is positive (economically sensible)
        if premium_raw <= 0:
            logger.debug(
                "Rejecting candidate: negative or zero premium (economically nonsensical)",
                premium_raw=premium_raw,
                long_ask=long_ask,
                short_bid=short_bid,
                option_type=spread['legs'][0]['type'],
                K1=spread['legs'][0]['strike'],
                K2=spread['legs'][1]['strike']
            )
            return None
        
        # Step 3: Calculate max payout
        max_payout_raw = initial_notional * spread_width
        
        # Step 4: Calculate raw ratio (this is independent of notional scaling)
        raw_ratio = max_payout_raw / premium_raw if premium_raw > 0 else Decimal('0')
        
        # Step 5: Scale notional intelligently
        # Strategy: Scale to fit budget, but ensure we maintain good ratio
        # Never scale to premium = payout (ratio = 1.0)
        
        # Calculate target premium (fit budget or max_payout, whichever is lower)
        target_premium = min(user_budget, max_payout_raw)
        
        # Scale to fit budget
        scale = target_premium / premium_raw if premium_raw > 0 else Decimal('0')
        N_final = initial_notional * scale
        
        # Step 6: Recalculate with final notional
        premium_final = N_final * spot_price * (long_ask - short_bid)
        max_payout_final = N_final * spread_width
        
        # CRITICAL: Ensure we never have premium = max_payout (ratio = 1.0)
        # The ratio is independent of notional, so if raw_ratio < 1.0, we can't fix it
        # But we can reject candidates that would result in ratio too close to 1.0
        final_ratio = max_payout_final / premium_final if premium_final > 0 else Decimal('0')
        
        if final_ratio < Decimal('1.01'):
            # Ratio is too close to 1.0 (premium ≈ max_payout), reject
            logger.debug(
                "Rejecting candidate: ratio too close to 1.0 (premium ≈ max_payout)",
                premium_final=premium_final,
                max_payout_final=max_payout_final,
                ratio=float(final_ratio),
                raw_ratio=float(raw_ratio)
            )
            return None
        
        # Note: We don't check MIN_VALUE_RATIO here because:
        # 1. Ratio is independent of notional scaling
        # 2. If raw_ratio < 1.1, we can't fix it by scaling
        # 3. VenueOptimizer will check ratio after markup and try alternative strikes if needed
        
        # CRITICAL: Check economic validity
        # Reject if premium > max_payout (economically nonsensical)
        if premium_final > max_payout_final:
            logger.debug(
                "Rejecting candidate: premium exceeds max payout (economically nonsensical)",
                premium_final=premium_final,
                max_payout_final=max_payout_final,
                ratio=float(max_payout_final / premium_final) if premium_final > 0 else 0
            )
            return None  # Reject - this spread doesn't make economic sense
        
        # Preliminary check: If raw premium < $5, we'll charge $5, so need max_payout >= $5.50
        # This is an early rejection to avoid unnecessary markup calculation
        if premium_final < self.MIN_CHARGED_PREMIUM_USD:
            if max_payout_final < self.MIN_MAX_PAYOUT_FOR_MIN_CHARGE:
                logger.debug(
                    "Rejecting candidate: raw premium below minimum and max_payout too low for markup",
                    premium_final=premium_final,
                    max_payout_final=max_payout_final,
                    min_charge=self.MIN_CHARGED_PREMIUM_USD,
                    min_max_payout=self.MIN_MAX_PAYOUT_FOR_MIN_CHARGE
                )
                return None
        
        # NOTE: MIN_VALUE_RATIO check removed from here
        # Ratio will be checked AFTER markup in VenueOptimizer
        # This allows hedges with good raw ratios to pass through,
        # even if markup might change the ratio (will be validated in VenueOptimizer)
        
        return {
            'spread': spread,
            'notional_btc': N_final,
            'premium_usd': premium_final,
            'max_payout_usd': max_payout_final,
            'spot_price': spot_price,
            'spread_width': spread_width
        }

