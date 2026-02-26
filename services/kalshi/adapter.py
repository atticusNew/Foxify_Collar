"""
Adapter - Map event + direction → hedge request
Follows specification exactly for insurance type mapping
"""
from decimal import Decimal
from typing import Dict, Optional

from .event_parser import CanonicalEvent
from utils.logging import get_logger

logger = get_logger(__name__)


class KalshiAdapter:
    """
    Map Kalshi event + direction → hedge request.
    
    Follows specification exactly:
    - BELOW K + YES → call
    - BELOW K + NO → put
    - ABOVE K + YES → put
    - ABOVE K + NO → call
    - HIT K + YES → call
    - HIT K + NO → call
    """
    
    DEFAULT_HEDGE_BUDGET_FRACTION = Decimal('0.2')  # 20% of stake
    
    def create_hedge_request(
        self,
        event: CanonicalEvent,
        direction: str,  # 'yes' or 'no'
        stake_usd: Decimal,
        hedge_budget_usd: Optional[Decimal] = None
    ) -> Dict:
        """
        Create hedge request per specification.
        
        Args:
            event: Canonical event structure
            direction: 'yes' or 'no'
            stake_usd: User stake amount
            hedge_budget_usd: Optional hedge budget (defaults to fraction of stake)
            
        Returns:
            Dict with hedge request parameters
        """
        # Determine insurance type per specification
        insurance_type = self._determine_insurance_type(event.event_type, direction)
        
        # Calculate hedge budget
        if hedge_budget_usd is None:
            hedge_budget_usd = stake_usd * self.DEFAULT_HEDGE_BUDGET_FRACTION
        
        return {
            "event_type": event.event_type,
            "direction": direction,
            "barrier": event.threshold_price,
            "expiry": event.expiry_date,
            "user_stake_usd": stake_usd,
            "user_hedge_budget_usd": hedge_budget_usd,
            "insurance_type": insurance_type,
            "series_ticker": event.series_ticker,
            "event_ticker": event.event_ticker
        }
    
    def _determine_insurance_type(self, event_type: str, direction: str) -> str:
        """
        Determine insurance type per specification.
        
        Specification:
        - BELOW K + YES → call (loss region S_T > K)
        - BELOW K + NO → put (loss region S_T ≤ K)
        - ABOVE K + YES → put (loss region S_T < K)
        - ABOVE K + NO → call (loss region S_T ≥ K)
        - HIT K + YES → call (both YES and NO)
        - HIT K + NO → call (both YES and NO)
        """
        if event_type == 'BELOW':
            return 'call' if direction == 'yes' else 'put'
        elif event_type == 'ABOVE':
            return 'put' if direction == 'yes' else 'call'
        elif event_type == 'HIT':
            return 'call'  # Both YES and NO use call
        else:
            # Safe default
            logger.warning(
                "Unknown event type, defaulting to call",
                event_type=event_type,
                direction=direction
            )
            return 'call'

