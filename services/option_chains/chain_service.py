"""
Option Chain Service - Institutional-Grade Option Discovery
Queries actual option chains from exchanges with proper symbol handling.
"""
from decimal import Decimal
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import asyncio

from connectors.base_connector import ExchangeConnector
from utils.logging import get_logger
from utils.error_handler import ExchangeAPIError
from utils.decimal_utils import DecimalMath as DM

logger = get_logger(__name__)


@dataclass(frozen=True)
class OptionContract:
    """Option contract with full details."""
    symbol: str
    exchange: str
    strike: Decimal
    expiry_date: date
    option_type: str  # 'C' or 'P'
    bid: Decimal
    ask: Decimal
    last: Decimal
    volume_24h: Decimal
    open_interest: Decimal
    bid_size: Decimal
    ask_size: Decimal
    mid_price: Decimal
    spread: Decimal
    liquidity_score: Decimal  # Combined liquidity metric


@dataclass(frozen=True)
class OptionChain:
    """Option chain for a specific expiry."""
    expiry_date: date
    contracts: List[OptionContract]
    underlying_price: Decimal
    exchange: str


class OptionChainService:
    """
    Institutional-grade option chain service.
    
    Queries actual option chains from exchanges, not constructed symbols.
    Handles exchange-specific formats and provides liquidity analysis.
    """
    
    def __init__(self, registry=None):
        """Initialize option chain service."""
        from connectors import get_exchange_registry
        self.registry = registry or get_exchange_registry()
    
    async def get_option_chains(
        self,
        underlying: str = 'BTC',
        expiry_date: Optional[date] = None,
        min_days_to_expiry: Optional[int] = None,
        max_days_to_expiry: Optional[int] = None,
    ) -> List[OptionChain]:
        """
        Get option chains from all available option exchanges.
        
        Args:
            underlying: Underlying asset (e.g., 'BTC')
            expiry_date: Specific expiry date (optional)
            min_days_to_expiry: Minimum days until expiry
            max_days_to_expiry: Maximum days until expiry
            
        Returns:
            List of option chains (one per exchange per expiry)
        """
        # Get all option exchanges and ensure they're connected
        # DEMO OPTIMIZATION: Use Deribit only for faster performance
        # Deribit has good liquidity and strike coverage for BTC options
        enabled = self.registry.get_enabled_connectors()
        option_exchanges = []
        
        for connector in enabled:
            # Only use Deribit for demo (faster, still institutional-grade)
            if connector.exchange_name.lower() != 'deribit':
                continue
                
            if self._supports_options(connector):
                # Ensure connector is connected
                if not connector.is_connected():
                    try:
                        logger.info(f"Connecting to {connector.exchange_name} for option chain query...")
                        await connector.connect()
                    except Exception as e:
                        logger.warning(f"Failed to connect to {connector.exchange_name}: {e}")
                        continue
                
                if connector.is_connected():
                    option_exchanges.append(connector)
        
        if not option_exchanges:
            logger.warning(
                "No option exchanges available or connected",
                enabled_exchanges=[c.exchange_name for c in enabled],
                option_supporting=[c.exchange_name for c in enabled if self._supports_options(c)]
            )
            return []
        
        # Query chains from all exchanges in parallel
        chain_tasks = []
        for connector in option_exchanges:
            chain_tasks.append(
                self._get_chain_from_exchange(
                    connector=connector,
                    underlying=underlying,
                    expiry_date=expiry_date,
                    min_days=min_days_to_expiry,
                    max_days=max_days_to_expiry,
                )
            )
        
        results = await asyncio.gather(*chain_tasks, return_exceptions=True)
        
        chains = []
        for result in results:
            if isinstance(result, Exception):
                logger.debug("Failed to get option chain", error=str(result))
                continue
            if result:
                chains.extend(result)
        
        logger.info(
            "Retrieved option chains",
            exchange_count=len(option_exchanges),
            chain_count=len(chains),
            total_contracts=sum(len(c.contracts) for c in chains)
        )
        
        return chains
    
    async def _get_chain_from_exchange(
        self,
        connector: ExchangeConnector,
        underlying: str,
        expiry_date: Optional[date],
        min_days: Optional[int],
        max_days: Optional[int],
    ) -> List[OptionChain]:
        """Get option chain from a specific exchange."""
        exchange_name = connector.exchange_name
        
        try:
            if exchange_name == 'deribit':
                return await self._get_deribit_chain(
                    connector, underlying, expiry_date, min_days, max_days
                )
            elif exchange_name == 'okx':
                return await self._get_okx_chain(
                    connector, underlying, expiry_date, min_days, max_days
                )
            else:
                logger.warning(f"Option chain query not implemented for {exchange_name}")
                return []
        except Exception as e:
            logger.error(
                f"Failed to get option chain from {exchange_name}",
                error=str(e)
            )
            return []
    
    async def _get_deribit_chain(
        self,
        connector: ExchangeConnector,
        underlying: str,
        expiry_date: Optional[date],
        min_days: Optional[int],
        max_days: Optional[int],
    ) -> List[OptionChain]:
        """Get option chain from Deribit."""
        try:
            # Deribit uses currency 'BTC' for Bitcoin options
            currency = 'BTC'
            
            # Get all instruments using connector's _raw_request
            # Deribit API: get_instruments with currency='BTC' and kind='option'
            try:
                if hasattr(connector, '_raw_request'):
                    # Deribit API v2: get_instruments endpoint
                    instruments = await connector._raw_request('GET', 'get_instruments', {
                        'currency': currency,
                        'kind': 'option'
                    })
                else:
                    # Fallback: use fetch_products and filter
                    products = await connector.fetch_products()
                    instruments = [
                        p for p in products
                        if p.get('kind') == 'option'
                    ]
            except Exception as e:
                logger.error("Failed to fetch Deribit instruments", error=str(e))
                return []
            
            if not instruments:
                logger.warning("Deribit returned no instruments", currency=currency)
                return []
            
            logger.info(f"Deribit returned {len(instruments)} option instruments")
            
            # Group by expiry
            chains_by_expiry: Dict[date, List[Dict]] = {}
            today = date.today()
            valid_count = 0
            filtered_count = 0
            
            for inst in instruments:
                # Parse expiry - Deribit uses 'expiry' field (timestamp in milliseconds)
                expiry_timestamp = inst.get('expiration_timestamp') or inst.get('expiry')
                if not expiry_timestamp:
                    filtered_count += 1
                    continue
                
                # Handle both millisecond and second timestamps
                if expiry_timestamp > 1e10:  # Milliseconds
                    expiry_date_obj = datetime.fromtimestamp(expiry_timestamp / 1000).date()
                else:  # Seconds
                    expiry_date_obj = datetime.fromtimestamp(expiry_timestamp).date()
                days_to_expiry = (expiry_date_obj - today).days
                
                # If we have a days range (min_days/max_days), use that instead of exact expiry filter
                # The days range is more flexible and allows finding options within a broader window
                if min_days is not None or max_days is not None:
                    # Use days range filter (more flexible)
                    if min_days and days_to_expiry < min_days:
                        filtered_count += 1
                        continue
                    if max_days and days_to_expiry > max_days:
                        filtered_count += 1
                        continue
                elif expiry_date:
                    # For "when will" events or very short-term events, allow more flexibility
                    days_to_target = (expiry_date - today).days
                    if days_to_target <= 30:
                        # Very short-term events: allow up to 30 days flexibility
                        max_flexibility = 30
                    elif days_to_target <= 90:
                        # Short-term events: allow up to 14 days flexibility
                        max_flexibility = 14
                    else:
                        # Standard: allow 3 days flexibility
                        max_flexibility = 3
                    
                    days_diff = abs((expiry_date_obj - expiry_date).days)
                    if days_diff > max_flexibility:
                        filtered_count += 1
                        continue
                
                valid_count += 1
                if expiry_date_obj not in chains_by_expiry:
                    chains_by_expiry[expiry_date_obj] = []
                
                chains_by_expiry[expiry_date_obj].append(inst)
            
            logger.info(
                "Deribit option filtering",
                total_instruments=len(instruments),
                valid_after_filtering=valid_count,
                filtered_out=filtered_count,
                unique_expiries=len(chains_by_expiry),
                expiry_dates=[str(d) for d in sorted(chains_by_expiry.keys())[:5]]
            )
            
            # Build option chains
            chains = []
            for expiry_date_obj, insts in chains_by_expiry.items():
                contracts = []
                
                # Get underlying price
                try:
                    ticker = await connector.fetch_ticker('BTC-USD')
                    underlying_price = ticker['last']
                except:
                    underlying_price = Decimal('0')
                
                # Prepare contract data for parallel fetching
                contract_data = []
                for inst in insts:
                    # Deribit uses product_id format: BTC-31DEC25-50000-P
                    # Fallback to instrument_name if product_id not available
                    symbol = inst.get('product_id') or inst.get('instrument_name', '')
                    if not symbol:
                        # Try to construct from parts if available
                        base = inst.get('base_currency', 'BTC')
                        strike = inst.get('strike')
                        opt_type = inst.get('option_type', 'P')
                        if opt_type:
                            opt_type = opt_type.upper()[0] if opt_type.lower().startswith('c') else 'P'
                        if strike:
                            # Format: BTC-DDMMMYY-STRIKE-TYPE
                            expiry_str = expiry_date_obj.strftime('%d%b%y').upper()
                            symbol = f"{base}-{expiry_str}-{int(strike)}-{opt_type}"
                        else:
                            continue
                    
                    # Extract strike and option type from Deribit format
                    # Format: BTC-DDMMMYY-STRIKE-TYPE
                    parts = symbol.split('-')
                    if len(parts) >= 4:
                        strike_str = parts[2]
                        option_type = parts[3].upper()  # 'P' or 'C'
                    else:
                        # Fallback to direct fields
                        strike_str = str(inst.get('strike', '0'))
                        option_type = inst.get('option_type', 'P').upper()
                    
                    strike = DM.to_decimal(strike_str)
                    
                    # Store contract metadata for parallel fetching
                    contract_data.append({
                        'symbol': symbol,
                        'strike': strike,
                        'option_type': option_type,
                        'inst': inst,
                        'expiry_date_obj': expiry_date_obj
                    })
                
                # Fetch all tickers and orderbooks in parallel with concurrency control
                # Use semaphore to limit concurrent requests (respect rate limits)
                # Deribit rate limit: ~20 req/s, but we're hitting limits
                # Reduce to 5 concurrent requests and add delay between batches
                semaphore = asyncio.Semaphore(10)  # Increased from 5 to 10 for faster parallel fetching
                
                async def fetch_contract_data(data):
                    """Fetch ticker and orderbook for a single contract."""
                    async with semaphore:
                        # Rate limiting: Small delay per contract to avoid hitting Deribit limits
                        await asyncio.sleep(0.05)  # 50ms delay per request
                        
                        symbol = data['symbol']
                        strike = data['strike']
                        option_type = data['option_type']
                        inst = data['inst']
                        expiry_date_obj = data['expiry_date_obj']
                        
                        try:
                            # Fetch ticker and orderbook in parallel for this contract
                            ticker_task = connector.fetch_ticker(symbol)
                            orderbook_task = connector.fetch_orderbook(symbol, depth=5)
                            
                            ticker, orderbook = await asyncio.gather(
                                ticker_task,
                                orderbook_task,
                                return_exceptions=True
                            )
                            
                            # Handle ticker result
                            if isinstance(ticker, Exception):
                                logger.debug(f"Failed to fetch ticker for {symbol}: {ticker}")
                                return None
                            
                            if not ticker:
                                logger.warning(f"No ticker data returned for {symbol}")
                                return None
                            
                            bid = ticker.get('bid', Decimal('0'))
                            ask = ticker.get('ask', Decimal('0'))
                            last = ticker.get('last', Decimal('0'))
                            
                            # CRITICAL: Require valid ask price (what we pay to buy) - NO FALLBACK to mid/bid/last
                            # If ask = 0, contract is not executable, skip it
                            if ask <= 0:
                                logger.debug(f"Skipping contract {symbol} - no valid ask price (ask={ask})")
                                return None  # Skip if no ask price - NO FALLBACK
                            
                            # Calculate mid price for display/analysis (but we use ask for cost calculation)
                            if bid > 0 and ask > 0:
                                mid_price = (bid + ask) / Decimal('2')
                            elif ask > 0:
                                mid_price = ask  # Use ask if bid unavailable
                            else:
                                # This should not happen due to check above, but handle gracefully
                                logger.warning(f"No valid ask price for {symbol} (ask={ask})")
                                return None
                            
                            # Handle orderbook result
                            if isinstance(orderbook, Exception):
                                logger.debug(f"Could not fetch orderbook for {symbol}: {orderbook}")
                                bid_size = Decimal('0')
                                ask_size = Decimal('0')
                            else:
                                bid_size = sum(level[1] for level in orderbook.get('bids', [])[:5])
                                ask_size = sum(level[1] for level in orderbook.get('asks', [])[:5])
                            
                            spread = ask - bid if bid > 0 and ask > 0 else Decimal('0')
                            
                            # Extract volume and open interest from instrument data
                            volume_24h_value = DM.to_decimal(str(inst.get('volume_24h', '0')))
                            open_interest_value = DM.to_decimal(str(inst.get('open_interest', '0')))
                            
                            # Calculate liquidity score (higher is better)
                            # Combines volume, open interest, and orderbook depth
                            liquidity_score = (
                                open_interest_value * Decimal('0.4') +
                                (bid_size + ask_size) * Decimal('0.4') +
                                (Decimal('1') / (spread / mid_price + Decimal('0.001'))) * Decimal('0.2')
                                if mid_price > 0 else Decimal('0')
                            )
                            
                            contract = OptionContract(
                                symbol=symbol,
                                exchange='deribit',
                                strike=strike,
                                expiry_date=expiry_date_obj,
                                option_type=option_type,
                                bid=bid,
                                ask=ask,
                                last=last,
                                volume_24h=volume_24h_value,
                                open_interest=open_interest_value,
                                bid_size=bid_size,
                                ask_size=ask_size,
                                mid_price=mid_price,
                                spread=spread,
                                liquidity_score=liquidity_score
                            )
                            
                            logger.debug(f"Added real option contract: {symbol}, strike={strike}, price={mid_price}, exchange=deribit")
                            return contract
                            
                        except Exception as e:
                            logger.warning(f"Failed to fetch real price for {symbol}: {e}")
                            return None  # Skip on error - NO FALLBACK TO ESTIMATES
                
                # Fetch contracts in smaller batches to avoid rate limits
                if contract_data:
                    # DEMO OPTIMIZATION: Increased batch size and reduced delays for faster performance
                    batch_size = 20  # Process 20 contracts at a time (increased from 10)
                    logger.info(f"Fetching {len(contract_data)} Deribit option contracts in batches of {batch_size}...")
                    contract_results = []
                    
                    for i in range(0, len(contract_data), batch_size):
                        batch = contract_data[i:i + batch_size]
                        batch_results = await asyncio.gather(
                            *[fetch_contract_data(data) for data in batch],
                            return_exceptions=True
                        )
                        contract_results.extend(batch_results)
                        
                        # Add delay between batches to avoid rate limits
                        if i + batch_size < len(contract_data):
                            await asyncio.sleep(0.2)  # 200ms delay between batches
                    
                    # Filter out None results and exceptions
                    for result in contract_results:
                        if isinstance(result, Exception):
                            logger.debug(f"Contract fetch exception: {result}")
                            continue
                        if result is not None:
                            contracts.append(result)
                
                if contracts:
                    chain = OptionChain(
                        expiry_date=expiry_date_obj,
                        contracts=contracts,
                        underlying_price=underlying_price,
                        exchange='deribit'
                    )
                    chains.append(chain)
            
            return chains
            
        except Exception as e:
            logger.error("Failed to get Deribit option chain", error=str(e))
            return []
    
    async def _get_okx_chain(
        self,
        connector: ExchangeConnector,
        underlying: str,
        expiry_date: Optional[date],
        min_days: Optional[int],
        max_days: Optional[int],
    ) -> List[OptionChain]:
        """Get option chain from OKX."""
        try:
            # OKX uses instType='OPTION' and uly='BTC-USD'
            try:
                # Try to use _raw_request if available
                if hasattr(connector, '_raw_request'):
                    instruments = await connector._raw_request('GET', 'public/instruments', {
                        'instType': 'OPTION',
                        'uly': 'BTC-USD'
                    })
                else:
                    # Fallback: use fetch_products and filter
                    products = await connector.fetch_products()
                    instruments = [
                        p for p in products
                        if p.get('kind') == 'option'
                    ]
            except Exception as e:
                logger.error("Failed to fetch OKX instruments", error=str(e))
                return []
            
            if not instruments or not isinstance(instruments, list):
                return []
            
            # Group by expiry
            chains_by_expiry: Dict[date, List[Dict]] = {}
            today = date.today()
            
            for inst in instruments:
                # Parse expiry
                exp_time = inst.get('expTime')
                if not exp_time:
                    continue
                
                expiry_date_obj = datetime.fromtimestamp(int(exp_time) / 1000).date()
                
                # Filter by days to expiry (more flexible than exact date match)
                days_to_expiry = (expiry_date_obj - today).days
                
                # If we have a days range (min_days/max_days), use that instead of exact expiry filter
                # The days range is more flexible and allows finding options within a broader window
                if min_days is not None or max_days is not None:
                    # Use days range filter (more flexible)
                    if min_days and days_to_expiry < min_days:
                        continue
                    if max_days and days_to_expiry > max_days:
                        continue
                elif expiry_date:
                    # Only apply exact expiry ±3 day filter if NO days range is provided
                    days_diff = abs((expiry_date_obj - expiry_date).days)
                    if days_diff > 3:  # Allow 3 days flexibility
                        continue
                
                if expiry_date_obj not in chains_by_expiry:
                    chains_by_expiry[expiry_date_obj] = []
                
                chains_by_expiry[expiry_date_obj].append(inst)
            
            # Build option chains
            chains = []
            for expiry_date_obj, insts in chains_by_expiry.items():
                contracts = []
                
                # Get underlying price (OKX uses BTC-USDT for spot)
                try:
                    ticker = await connector.fetch_ticker('BTC-USDT')
                    underlying_price = ticker['last']
                except:
                    try:
                        # Fallback to BTC-USD
                        ticker = await connector.fetch_ticker('BTC-USD')
                        underlying_price = ticker['last']
                    except:
                        underlying_price = Decimal('0')
                
                # Prepare contract data for parallel fetching
                contract_data = []
                for inst in insts:
                    symbol = inst.get('instId', '')  # OKX format: BTC-USD-YYMMDD-STRIKE-TYPE
                    if not symbol:
                        continue
                    
                    strike = DM.to_decimal(str(inst.get('stk', '0')))
                    option_type = inst.get('optType', 'P')  # 'C' or 'P'
                    
                    contract_data.append({
                        'symbol': symbol,
                        'strike': strike,
                        'option_type': option_type,
                        'inst': inst,
                        'expiry_date_obj': expiry_date_obj
                    })
                
                # Fetch all tickers and orderbooks in parallel with concurrency control
                # OKX rate limit: ~10 req/s, so use 8 concurrent to be safe
                semaphore = asyncio.Semaphore(8)
                
                async def fetch_contract_data(data):
                    """Fetch ticker and orderbook for a single contract."""
                    async with semaphore:
                        symbol = data['symbol']
                        strike = data['strike']
                        option_type = data['option_type']
                        inst = data['inst']
                        expiry_date_obj = data['expiry_date_obj']
                        
                        try:
                            # Fetch ticker and orderbook in parallel for this contract
                            ticker_task = connector.fetch_ticker(symbol)
                            orderbook_task = connector.fetch_orderbook(symbol, depth=5)
                            
                            ticker, orderbook = await asyncio.gather(
                                ticker_task,
                                orderbook_task,
                                return_exceptions=True
                            )
                            
                            # Handle ticker result
                            if isinstance(ticker, Exception):
                                logger.debug(f"Failed to fetch ticker for {symbol}: {ticker}")
                                return None
                            
                            bid = ticker.get('bid', Decimal('0'))
                            ask = ticker.get('ask', Decimal('0'))
                            last = ticker.get('last', Decimal('0'))
                            
                            # CRITICAL: Require valid ask price (what we pay to buy) - NO FALLBACK to mid/bid/last
                            # If ask = 0, contract is not executable, skip it
                            if ask <= 0:
                                logger.debug(f"Skipping OKX contract {symbol} - no valid ask price (ask={ask})")
                                return None  # Skip if no ask price - NO FALLBACK
                            
                            # Handle orderbook result
                            if isinstance(orderbook, Exception):
                                bid_size = Decimal('0')
                                ask_size = Decimal('0')
                            else:
                                bid_size = sum(level[1] for level in orderbook.get('bids', [])[:5])
                                ask_size = sum(level[1] for level in orderbook.get('asks', [])[:5])
                            
                            # Calculate mid price for display/analysis (but we use ask for cost calculation)
                            mid_price = (bid + ask) / Decimal('2') if bid > 0 and ask > 0 else ask
                            spread = ask - bid if bid > 0 and ask > 0 else Decimal('0')
                            
                            # Calculate liquidity score
                            volume = DM.to_decimal(str(ticker.get('vol24h', '0')))
                            liquidity_score = (
                                volume * Decimal('0.4') +
                                (bid_size + ask_size) * Decimal('0.4') +
                                (Decimal('1') / (spread / mid_price + Decimal('0.001'))) * Decimal('0.2')
                                if mid_price > 0 else Decimal('0')
                            )
                            
                            contract = OptionContract(
                                symbol=symbol,
                                exchange='okx',
                                strike=strike,
                                expiry_date=expiry_date_obj,
                                option_type=option_type,
                                bid=bid,
                                ask=ask,
                                last=last,
                                volume_24h=volume,
                                open_interest=DM.to_decimal('0'),  # OKX may not provide this
                                bid_size=bid_size,
                                ask_size=ask_size,
                                mid_price=mid_price,
                                spread=spread,
                                liquidity_score=liquidity_score
                            )
                            
                            return contract
                            
                        except Exception as e:
                            logger.debug(f"Failed to fetch price for {symbol}", error=str(e))
                            return None
                
                # Fetch all contracts in parallel
                if contract_data:
                    logger.info(f"Fetching {len(contract_data)} OKX option contracts in parallel...")
                    contract_results = await asyncio.gather(
                        *[fetch_contract_data(data) for data in contract_data],
                        return_exceptions=True
                    )
                    
                    # Filter out None results and exceptions
                    for result in contract_results:
                        if isinstance(result, Exception):
                            logger.debug(f"Contract fetch exception: {result}")
                            continue
                        if result is not None:
                            contracts.append(result)
                
                if contracts:
                    chain = OptionChain(
                        expiry_date=expiry_date_obj,
                        contracts=contracts,
                        underlying_price=underlying_price,
                        exchange='okx'
                    )
                    chains.append(chain)
            
            return chains
            
        except Exception as e:
            logger.error("Failed to get OKX option chain", error=str(e))
            return []
    
    def _supports_options(self, connector: ExchangeConnector) -> bool:
        """Check if connector supports options."""
        config = getattr(connector, 'config', {})
        return config.get('options_trading', False)
    
    def find_best_option(
        self,
        chains: List[OptionChain],
        strike_target: Decimal,
        option_type: str,
        expiry_date: Optional[date] = None,  # Target expiry date
        min_liquidity_score: Optional[Decimal] = None,
    ) -> Optional[OptionContract]:
        """
        Find best option contract across all chains.
        
        OPTIMIZED: Short-circuits early when optimal contract found.
        
        Considers:
        - Expiry date proximity to target (closer is better)
        - Strike distance from target
        - Liquidity score
        - Must be in the future (expiry >= today)
        """
        from datetime import date as date_class
        from decimal import Decimal
        today = date_class.today()
        candidates = []
        
        # Pre-compute constants
        best_strike_distance = None
        best_expiry_distance = None
        best_liquidity = None
        
        for chain in chains:
            # CRITICAL: Filter out expired options
            if chain.expiry_date < today:
                logger.debug(f"Skipping expired chain: {chain.expiry_date}")
                continue
            
            # Calculate expiry distance from target (if target provided)
            expiry_distance = None
            if expiry_date:
                expiry_distance = abs((chain.expiry_date - expiry_date).days)
                # For far-out events (>365 days), allow more flexibility
                max_flexibility = 14 if (expiry_date - today).days <= 365 else 90
                if expiry_distance > max_flexibility:
                    logger.debug(
                        f"Skipping chain with expiry too far from target: {chain.expiry_date} "
                        f"(target: {expiry_date}, distance: {expiry_distance} days)"
                    )
                    continue
            
            for contract in chain.contracts:
                if contract.option_type != option_type:
                    continue
                
                # Filter by liquidity if specified
                if min_liquidity_score and contract.liquidity_score < min_liquidity_score:
                    continue
                
                # Calculate strike distance
                strike_distance = abs(contract.strike - strike_target)
                
                # OPTIMIZATION: Short-circuit if we find a perfect match (strike = target, expiry = target, good liquidity)
                if expiry_distance == 0 and strike_distance == 0 and contract.liquidity_score > Decimal('0.5'):
                    logger.info(
                        "Found perfect match - short-circuiting",
                        contract=contract.symbol,
                        strike=contract.strike,
                        expiry=chain.expiry_date
                    )
                    return contract
                
                # Store expiry distance for sorting
                candidates.append((
                    contract, 
                    expiry_distance if expiry_distance is not None else 999999,  # Prefer options with target expiry
                    strike_distance
                ))
        
        if not candidates:
            logger.warning(
                "No valid option candidates found",
                target_expiry=expiry_date.isoformat() if expiry_date else None,
                option_type=option_type,
                strike_target=str(strike_target)
            )
            return None
        
        # Sort by: 
        # 1) Expiry distance from target (closer is better, but prefer future dates)
        # 2) Strike distance (closer is better)
        # 3) Liquidity score (higher is better)
        # Note: For expiry_distance, we want to minimize it, but also prefer options >= target date
        def sort_key(x):
            contract, expiry_dist, strike_dist = x
            # Prefer options that are >= target date (if target provided)
            expiry_penalty = 0
            if expiry_date and contract.expiry_date < expiry_date:
                # Penalize options that expire before target (but still allow them if no better options)
                expiry_penalty = 10000
            
            return (
                expiry_penalty + expiry_dist,  # Expiry proximity (with penalty for early expiry)
                strike_dist,  # Strike distance
                -contract.liquidity_score  # Liquidity (negative because higher is better)
            )
        
        candidates.sort(key=sort_key)
        best_contract = candidates[0][0]
        
        logger.info(
            "Selected best option",
            symbol=best_contract.symbol,
            expiry=best_contract.expiry_date.isoformat(),
            strike=str(best_contract.strike),
            target_expiry=expiry_date.isoformat() if expiry_date else None,
            expiry_distance=candidates[0][1] if expiry_date else None,
            strike_distance=candidates[0][2],
            exchange=best_contract.exchange
        )
        
        return best_contract

