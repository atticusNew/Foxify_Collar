"""
Strike Selector - Find strikes K₁, K₂ per specification
Follows specification exactly for all event types
"""
from decimal import Decimal
from typing import Optional, Tuple, List
from datetime import date

from services.option_chains.chain_service import OptionChain, OptionContract
from utils.logging import get_logger

logger = get_logger(__name__)


class StrikeSelector:
    """
    Find strikes K₁, K₂ per specification.
    
    Rules:
    - BELOW K + YES: First two call strikes ≥ K
    - BELOW K + NO: Two highest put strikes ≤ K
    - ABOVE K + YES: Two highest put strikes ≤ K
    - ABOVE K + NO: First two call strikes ≥ K
    - HIT K + YES: Two call strikes < K (just below)
    - HIT K + NO: First two call strikes ≥ K
    """
    
    def find_strikes(
        self,
        event_type: str,
        direction: str,
        barrier: Decimal,
        chains: List[OptionChain],
        expiry_date: date,
        try_alternatives: bool = False,
        alternative_offset: int = 0
    ) -> Optional[Tuple[Decimal, Decimal]]:
        """
        Find strikes K₁, K₂ per specification.
        
        Args:
            event_type: 'BELOW', 'ABOVE', or 'HIT'
            direction: 'yes' or 'no'
            barrier: K (barrier level)
            chains: List of option chains
            expiry_date: Target expiry date
            try_alternatives: If True, try alternative strikes (for fallback)
            alternative_offset: Offset for alternative strikes (0 = first attempt, 1 = next, etc.)
            
        Returns:
            Tuple of (K₁, K₂) or None if no valid strikes found
        """
        # Find chain with closest expiry
        chain = self._find_closest_expiry_chain(chains, expiry_date)
        if not chain:
            logger.warning("No chain found for expiry", expiry_date=expiry_date)
            return None
        
        # Get sorted strikes
        call_strikes = sorted(set(
            c.strike for c in chain.contracts
            if c.option_type == 'C' and c.bid > 0 and c.ask > 0
        ))
        put_strikes = sorted(set(
            c.strike for c in chain.contracts
            if c.option_type == 'P' and c.bid > 0 and c.ask > 0
        ))
        
        if not call_strikes and not put_strikes:
            logger.warning("No valid strikes found in chain")
            return None
        
        # Apply strike selection rules per specification
        if event_type == 'BELOW':
            if direction == 'yes':
                # BELOW K + YES: First two call strikes ≥ K
                return self._find_first_two_calls_above(barrier, call_strikes, alternative_offset)
            else:
                # BELOW K + NO: Two highest put strikes ≤ K
                return self._find_two_highest_puts_below(barrier, put_strikes, alternative_offset)
        
        elif event_type == 'ABOVE':
            if direction == 'yes':
                # ABOVE K + YES: Two highest put strikes ≤ K
                return self._find_two_highest_puts_below(barrier, put_strikes, alternative_offset)
            else:
                # ABOVE K + NO: First two call strikes ≥ K
                return self._find_first_two_calls_above(barrier, call_strikes, alternative_offset)
        
        elif event_type == 'HIT':
            if direction == 'yes':
                # HIT K + YES: Two call strikes < K (just below)
                return self._find_two_calls_below(barrier, call_strikes, alternative_offset)
            else:
                # HIT K + NO: First two call strikes ≥ K
                return self._find_first_two_calls_above(barrier, call_strikes, alternative_offset)
        
        else:
            logger.warning("Unknown event type", event_type=event_type)
            return None
    
    def _find_closest_expiry_chain(
        self,
        chains: List[OptionChain],
        target_expiry: date
    ) -> Optional[OptionChain]:
        """Find chain with expiry closest to target."""
        if not chains:
            return None
        
        # Find chain with exact expiry match first
        for chain in chains:
            if chain.expiry_date == target_expiry:
                return chain
        
        # If no exact match, find closest (±14 days)
        valid_chains = [
            chain for chain in chains
            if abs((chain.expiry_date - target_expiry).days) <= 14
        ]
        
        if not valid_chains:
            return None
        
        # Return closest expiry
        return min(
            valid_chains,
            key=lambda c: abs((c.expiry_date - target_expiry).days)
        )
    
    def _find_first_two_calls_above(
        self,
        barrier: Decimal,
        call_strikes: List[Decimal],
        offset: int = 0
    ) -> Optional[Tuple[Decimal, Decimal]]:
        """Find first two call strikes ≥ K, with optional offset for alternatives.
        
        Strategy:
        - offset=0: First two strikes (e.g., $130k, $135k) - narrow spread
        - offset=1: Skip one, take next two (e.g., $135k, $140k) - narrow spread
        - offset=2: First and third strike (e.g., $130k, $140k) - wider spread for better ratio
        - offset=3: Second and fourth strike (e.g., $135k, $145k) - wider spread
        """
        strikes_above = [s for s in call_strikes if s >= barrier]
        
        if len(strikes_above) < 2:
            logger.debug(
                "Not enough call strikes above barrier",
                barrier=barrier,
                strikes_above=strikes_above
            )
            return None
        
        # Strategy: Try wider spreads for better ratios
        if offset == 0:
            # First attempt: Adjacent strikes (narrow spread)
            return (strikes_above[0], strikes_above[1])
        elif offset == 1:
            # Second attempt: Next adjacent strikes
            if len(strikes_above) < 3:
                return None
            return (strikes_above[1], strikes_above[2])
        elif offset == 2:
            # Third attempt: Wider spread (skip one strike)
            if len(strikes_above) < 3:
                return None
            return (strikes_above[0], strikes_above[2])  # Wider spread
        elif offset == 3:
            # Fourth attempt: Even wider spread
            if len(strikes_above) < 4:
                return None
            return (strikes_above[0], strikes_above[3])  # Much wider spread
        elif offset == 4:
            # Fifth attempt: Very wide spread
            if len(strikes_above) < 5:
                return None
            return (strikes_above[0], strikes_above[4])  # Very wide spread
        elif offset == 5:
            # Sixth attempt: Extremely wide spread
            if len(strikes_above) < 6:
                return None
            return (strikes_above[0], strikes_above[5])  # Extremely wide spread
        elif offset == 6:
            # Seventh attempt: Maximum width spread
            if len(strikes_above) >= 7:
                return (strikes_above[0], strikes_above[6])  # Maximum width
            elif len(strikes_above) >= 2:
                # Use widest available
                return (strikes_above[0], strikes_above[-1])  # First to last
            return None
        elif offset == 7:
            # Eighth attempt: Use widest possible spread
            if len(strikes_above) >= 2:
                return (strikes_above[0], strikes_above[-1])  # First to last (widest)
            return None
        else:
            # Fallback: Try any available wider spread
            if len(strikes_above) >= offset + 2:
                return (strikes_above[offset], strikes_above[offset + 1])
            elif len(strikes_above) >= 2:
                # Use widest available
                return (strikes_above[0], strikes_above[-1])
            return None
    
    def _find_two_highest_puts_below(
        self,
        barrier: Decimal,
        put_strikes: List[Decimal],
        offset: int = 0
    ) -> Optional[Tuple[Decimal, Decimal]]:
        """Find two highest put strikes ≤ K, with optional offset for alternatives.
        
        Strategy:
        - offset=0: Two highest strikes (e.g., $100k, $95k) - narrow spread
        - offset=1: Next two highest (e.g., $95k, $90k) - narrow spread
        - offset=2: Highest and third highest (e.g., $100k, $90k) - wider spread
        - offset=3: Highest and fourth highest (e.g., $100k, $85k) - much wider spread
        """
        strikes_below = sorted([s for s in put_strikes if s <= barrier], reverse=True)
        
        if len(strikes_below) < 2:
            logger.debug(
                "Not enough put strikes below barrier",
                barrier=barrier,
                strikes_below=strikes_below
            )
            return None
        
        # Strategy: Try wider spreads for better ratios
        if offset == 0:
            # First attempt: Two highest (adjacent) - narrow spread
            return (strikes_below[1], strikes_below[0])  # K₁ < K₂
        elif offset == 1:
            # Second attempt: Next two highest
            if len(strikes_below) < 3:
                return None
            return (strikes_below[2], strikes_below[1])  # Narrow spread
        elif offset == 2:
            # Third attempt: Wider spread (skip one strike)
            if len(strikes_below) < 3:
                return None
            return (strikes_below[2], strikes_below[0])  # Wider spread: highest and third highest
        elif offset == 3:
            # Fourth attempt: Even wider spread
            if len(strikes_below) < 4:
                return None
            return (strikes_below[3], strikes_below[0])  # Much wider spread
        elif offset == 4:
            # Fifth attempt: Very wide spread
            if len(strikes_below) < 5:
                return None
            return (strikes_below[4], strikes_below[0])  # Very wide spread
        elif offset == 5:
            # Sixth attempt: Extremely wide spread
            if len(strikes_below) < 6:
                return None
            return (strikes_below[5], strikes_below[0])  # Extremely wide spread
        elif offset == 6:
            # Seventh attempt: Maximum width spread
            if len(strikes_below) >= 7:
                return (strikes_below[6], strikes_below[0])  # Maximum width
            elif len(strikes_below) >= 2:
                # Use widest available
                return (strikes_below[-1], strikes_below[0])  # Last to first (widest)
            return None
        elif offset == 7:
            # Eighth attempt: Use widest possible spread
            if len(strikes_below) >= 2:
                return (strikes_below[-1], strikes_below[0])  # Last to first (widest)
            return None
        else:
            # Fallback: Try any available wider spread
            if len(strikes_below) >= offset + 2:
                return (strikes_below[offset + 1], strikes_below[offset])
            elif len(strikes_below) >= 2:
                # Use widest available
                return (strikes_below[-1], strikes_below[0])
            return None
    
    def _find_two_calls_below(
        self,
        barrier: Decimal,
        call_strikes: List[Decimal],
        offset: int = 0
    ) -> Optional[Tuple[Decimal, Decimal]]:
        """Find two call strikes < K (just below), with optional offset for alternatives.
        
        Strategy: Similar to _find_first_two_calls_above but for strikes below barrier.
        """
        strikes_below = sorted([s for s in call_strikes if s < barrier], reverse=True)
        
        if len(strikes_below) < 2:
            logger.debug(
                "Not enough call strikes below barrier",
                barrier=barrier,
                strikes_below=strikes_below
            )
            return None
        
        # Strategy: Try wider spreads for better ratios
        if offset == 0:
            # First attempt: Two highest below barrier (adjacent) - narrow spread
            return (strikes_below[1], strikes_below[0])  # K₁ < K₂
        elif offset == 1:
            # Second attempt: Next two
            if len(strikes_below) < 3:
                return None
            return (strikes_below[2], strikes_below[1])
        elif offset == 2:
            # Third attempt: Wider spread
            if len(strikes_below) < 3:
                return None
            return (strikes_below[2], strikes_below[0])  # Wider spread
        elif offset == 3:
            # Fourth attempt: Even wider spread
            if len(strikes_below) < 4:
                return None
            return (strikes_below[3], strikes_below[0])  # Much wider spread
        elif offset == 4:
            # Fifth attempt: Very wide spread
            if len(strikes_below) < 5:
                return None
            return (strikes_below[4], strikes_below[0])  # Very wide spread
        elif offset == 5:
            # Sixth attempt: Extremely wide spread
            if len(strikes_below) < 6:
                return None
            return (strikes_below[5], strikes_below[0])  # Extremely wide spread
        elif offset == 6:
            # Seventh attempt: Maximum width spread
            if len(strikes_below) >= 7:
                return (strikes_below[6], strikes_below[0])  # Maximum width
            elif len(strikes_below) >= 2:
                # Use widest available
                return (strikes_below[-1], strikes_below[0])  # Last to first (widest)
            return None
        elif offset == 7:
            # Eighth attempt: Use widest possible spread
            if len(strikes_below) >= 2:
                return (strikes_below[-1], strikes_below[0])  # Last to first (widest)
            return None
        else:
            # Fallback
            if len(strikes_below) >= offset + 2:
                return (strikes_below[offset + 1], strikes_below[offset])
            elif len(strikes_below) >= 2:
                # Use widest available
                return (strikes_below[-1], strikes_below[0])
            return None

