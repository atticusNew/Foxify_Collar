"""
Venue Optimizer - Select best 1-3 hedges across venues
Scores candidates by cost-per-max-payoff
"""
from decimal import Decimal
from typing import List, Dict, Optional, Tuple

from utils.logging import get_logger

logger = get_logger(__name__)


class VenueOptimizer:
    """
    Select best 1-3 hedges across venues.
    
    Scoring: score = premium / max_payout (lower is better)
    Returns best 1-3 candidates.
    """
    
    MIN_CHARGED_PREMIUM_USD = Decimal('5')  # Minimum charge to user (after markup)
    MIN_VALUE_RATIO = Decimal('1.1')  # Max payout must be at least 10% more than charged premium
    
    def optimize(
        self,
        candidates_by_venue: Dict[str, Dict]
    ) -> List[Dict]:
        """
        Score candidates and select best 1-3.
        
        Args:
            candidates_by_venue: Dict mapping venue name to candidate dict
            
        Returns:
            List of 1-3 best candidates
        """
        if not candidates_by_venue:
            return []
        
        # Score all candidates
        scored_candidates = []
        for venue, candidate in candidates_by_venue.items():
            premium = candidate.get('premium_usd', Decimal('0'))
            max_payout = candidate.get('max_payout_usd', Decimal('0'))
            
            if max_payout <= 0:
                logger.debug("Skipping candidate with zero max payout", venue=venue)
                continue
            
            # Score: premium / max_payout (lower is better)
            score = premium / max_payout
            
            scored_candidates.append({
                'venue': venue,
                'candidate': candidate,
                'score': score
            })
        
        if not scored_candidates:
            return []
        
        # Sort by score (ascending - lower is better)
        scored_candidates.sort(key=lambda x: x['score'])
        
        # Select best candidate (single best venue)
        if not scored_candidates:
            return []
        
        best_candidate = scored_candidates[0]
        base_candidate = best_candidate['candidate']
        venue = best_candidate['venue']
        
        # Apply markup and check validity for base candidate
        base_raw_premium = base_candidate['premium_usd']
        base_max_payout = base_candidate['max_payout_usd']
        base_charged_premium, base_markup = self._apply_markup(base_raw_premium)
        
        # Check if base candidate is valid after markup
        if not self._check_economic_validity(base_charged_premium, base_max_payout):
            ratio = float(base_max_payout / base_charged_premium) if base_charged_premium > 0 else 0
            logger.warning(
                "Base candidate fails economic validity after markup",
                venue=venue,
                raw_premium=float(base_raw_premium),
                charged_premium=float(base_charged_premium),
                max_payout=float(base_max_payout),
                ratio=ratio,
                min_ratio=float(self.MIN_VALUE_RATIO),
                premium_exceeds_payout=base_charged_premium > base_max_payout
            )
            # Try next candidate if available
            if len(scored_candidates) > 1:
                best_candidate = scored_candidates[1]
                base_candidate = best_candidate['candidate']
                venue = best_candidate['venue']
                base_raw_premium = base_candidate['premium_usd']
                base_max_payout = base_candidate['max_payout_usd']
                base_charged_premium, base_markup = self._apply_markup(base_raw_premium)
                if not self._check_economic_validity(base_charged_premium, base_max_payout):
                    logger.warning("No valid candidates found after markup and validity checks")
                    return []
            else:
                logger.warning("No valid candidates found after markup and validity checks")
                return []
        
        # Create 3 protection tiers from single best candidate
        # Scale notional to create Light/Standard/Max tiers
        tier_multipliers = [
            ('Light protection', Decimal('0.5')),   # 50% of budget
            ('Standard protection', Decimal('1.0')), # 100% of budget
            ('Max protection', Decimal('1.5'))      # 150% of budget (capped at max_payout)
        ]
        
        results = []
        base_notional = base_candidate['notional_btc']
        spread_width = base_candidate.get('spread_width', base_max_payout / base_notional if base_notional > 0 else Decimal('0'))
        spot_price = base_candidate.get('spot_price', Decimal('100000'))
        spread = base_candidate['spread']
        
        # Get option prices from spread
        long_leg = spread['legs'][0]
        short_leg = spread['legs'][1]
        long_ask = long_leg['contract'].ask
        short_bid = short_leg['contract'].bid
        
        # Calculate premium per BTC notional
        premium_per_btc = spot_price * (long_ask - short_bid)
        
        for label, multiplier in tier_multipliers:
            # Scale notional
            tier_notional = base_notional * multiplier
            
            # Calculate raw premium and max_payout for this tier
            tier_raw_premium = tier_notional * premium_per_btc
            tier_max_payout = tier_notional * spread_width
            
            # Cap raw premium at max_payout (enforce guarantee)
            if tier_raw_premium > tier_max_payout:
                # Scale down to ensure raw premium ≤ max_payout
                scale_factor = tier_max_payout / tier_raw_premium
                tier_notional = tier_notional * scale_factor
                tier_raw_premium = tier_notional * premium_per_btc
                tier_max_payout = tier_notional * spread_width
            
            # Apply markup
            tier_charged_premium, tier_markup = self._apply_markup(tier_raw_premium)
            
            # Check economic validity (charged_premium <= max_payout AND ratio >= 1.1)
            if not self._check_economic_validity(tier_charged_premium, tier_max_payout):
                logger.debug(
                    "Skipping tier: fails economic validity after markup",
                    label=label,
                    raw_premium=tier_raw_premium,
                    charged_premium=tier_charged_premium,
                    max_payout=tier_max_payout
                )
                continue
            
            results.append({
                'label': label,
                'venue': venue,
                'raw_premium_usd': tier_raw_premium,
                'charged_premium_usd': tier_charged_premium,
                'markup_usd': tier_markup,
                'premium_usd': tier_charged_premium,  # Keep for backward compatibility
                'max_payout_usd': tier_max_payout,
                'notional_btc': tier_notional,
                'spread': spread,
                'score': tier_charged_premium / tier_max_payout if tier_max_payout > 0 else Decimal('0')
            })
        
        # If no tiers created, return single best candidate with markup applied
        if not results:
            results.append({
                'label': 'Standard protection',
                'venue': venue,
                'raw_premium_usd': base_raw_premium,
                'charged_premium_usd': base_charged_premium,
                'markup_usd': base_markup,
                'premium_usd': base_charged_premium,  # Keep for backward compatibility
                'max_payout_usd': base_max_payout,
                'notional_btc': base_candidate['notional_btc'],
                'spread': spread,
                'score': base_charged_premium / base_max_payout if base_max_payout > 0 else Decimal('0')
            })
        
        logger.info(
            "Optimized candidates",
            total_candidates=len(scored_candidates),
            selected_count=len(results),
            venues=[r['venue'] for r in results]
        )
        
        return results
    
    def _apply_markup(self, raw_premium: Decimal) -> Tuple[Decimal, Decimal]:
        """
        Apply markup to ensure minimum charge.
        
        Args:
            raw_premium: Raw option premium (before markup)
            
        Returns:
            Tuple of (charged_premium, markup_amount)
        """
        if raw_premium < self.MIN_CHARGED_PREMIUM_USD:
            markup = self.MIN_CHARGED_PREMIUM_USD - raw_premium
            charged_premium = self.MIN_CHARGED_PREMIUM_USD
        else:
            markup = Decimal('0')
            charged_premium = raw_premium
        
        return charged_premium, markup
    
    def _check_economic_validity(
        self,
        charged_premium: Decimal,
        max_payout: Decimal
    ) -> bool:
        """
        Check if hedge is economically valid.
        
        Requirements:
        1. charged_premium <= max_payout (can't charge more than payout)
        2. max_payout / charged_premium >= 1.1 (minimum value ratio)
        
        Args:
            charged_premium: Premium charged to user (after markup)
            max_payout: Maximum payout from hedge
            
        Returns:
            True if valid, False otherwise
        """
        # Check 1: Can't charge more than payout
        if charged_premium > max_payout:
            logger.debug(
                "Rejecting: charged premium exceeds max payout",
                charged_premium=charged_premium,
                max_payout=max_payout
            )
            return False
        
        # Check 2: Minimum value ratio
        if max_payout <= 0 or charged_premium <= 0:
            logger.debug(
                "Rejecting: invalid premium or max_payout",
                charged_premium=charged_premium,
                max_payout=max_payout
            )
            return False
        
        ratio = max_payout / charged_premium
        if ratio < self.MIN_VALUE_RATIO:
            logger.debug(
                "Rejecting: ratio too low",
                charged_premium=charged_premium,
                max_payout=max_payout,
                ratio=float(ratio),
                min_ratio=float(self.MIN_VALUE_RATIO)
            )
            return False
        
        return True

