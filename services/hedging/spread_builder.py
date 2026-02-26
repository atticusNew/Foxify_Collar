"""
Spread Builder - Build 2-leg spread structure
Always builds 2-leg spreads (no single-leg)
"""
from decimal import Decimal
from typing import Dict, Optional, List
from datetime import date

from services.option_chains.chain_service import OptionChain, OptionContract
from utils.logging import get_logger

logger = get_logger(__name__)


class SpreadBuilder:
    """
    Build 2-leg spread structure.
    
    Always builds 2 legs:
    - Long leg: K₁ (buy at ask)
    - Short leg: K₂ (sell at bid)
    """
    
    def build_spread(
        self,
        K1: Decimal,
        K2: Decimal,
        option_type: str,  # 'call' or 'put'
        chains: List[OptionChain],
        expiry_date: date
    ) -> Optional[Dict]:
        """
        Build 2-leg spread.
        
        Args:
            K1: Lower strike (long leg)
            K2: Higher strike (short leg)
            option_type: 'call' or 'put'
            chains: List of option chains
            expiry_date: Target expiry date
            
        Returns:
            Dict with spread structure or None if invalid
        """
        # Find chain with closest expiry
        chain = self._find_closest_expiry_chain(chains, expiry_date)
        if not chain:
            return None
        
        # Find contracts for K1 and K2
        K1_contract = self._find_contract(chain, K1, option_type)
        K2_contract = self._find_contract(chain, K2, option_type)
        
        if not K1_contract or not K2_contract:
            logger.debug(
                "Could not find contracts for strikes",
                K1=K1,
                K2=K2,
                option_type=option_type
            )
            return None
        
        # For PUT spreads below barrier, we need to swap legs
        # PUT at higher strike (closer to barrier) costs MORE than PUT at lower strike
        # So long leg should be PUT at higher strike (K2), short leg at lower strike (K1)
        # For CALL spreads, standard order is correct (long at lower strike, short at higher strike)
        
        if option_type.lower() == 'put':
            # PUT spread: Long at higher strike (K2), Short at lower strike (K1)
            long_contract = K2_contract
            short_contract = K1_contract
            long_strike = K2
            short_strike = K1
        else:
            # CALL spread: Long at lower strike (K1), Short at higher strike (K2)
            long_contract = K1_contract
            short_contract = K2_contract
            long_strike = K1
            short_strike = K2
        
        # Validate prices
        # Long leg needs ask > 0
        # Short leg needs bid > 0
        if long_contract.ask <= 0:
            logger.debug("Long leg contract has no valid ask price", symbol=long_contract.symbol, strike=long_strike)
            return None
        
        if short_contract.bid <= 0:
            logger.debug("Short leg contract has no valid bid price", symbol=short_contract.symbol, strike=short_strike)
            return None
        
        return {
            'legs': [
                {
                    'type': option_type,
                    'strike': long_strike,
                    'side': 'long',
                    'contract': long_contract
                },
                {
                    'type': option_type,
                    'strike': short_strike,
                    'side': 'short',
                    'contract': short_contract
                }
            ],
            'spread_width': abs(K2 - K1),  # Always positive width
            'expiry_date': expiry_date
        }
    
    def _find_closest_expiry_chain(
        self,
        chains: List[OptionChain],
        target_expiry: date
    ) -> Optional[OptionChain]:
        """Find chain with expiry closest to target."""
        if not chains:
            return None
        
        # Find exact match first
        for chain in chains:
            if chain.expiry_date == target_expiry:
                return chain
        
        # Find closest (±14 days)
        valid_chains = [
            chain for chain in chains
            if abs((chain.expiry_date - target_expiry).days) <= 14
        ]
        
        if not valid_chains:
            return None
        
        return min(
            valid_chains,
            key=lambda c: abs((c.expiry_date - target_expiry).days)
        )
    
    def _find_contract(
        self,
        chain: OptionChain,
        strike: Decimal,
        option_type: str
    ) -> Optional[OptionContract]:
        """Find contract for strike and option type."""
        option_code = 'C' if option_type.lower() == 'call' else 'P'
        
        for contract in chain.contracts:
            if contract.strike == strike and contract.option_type == option_code:
                return contract
        
        return None

