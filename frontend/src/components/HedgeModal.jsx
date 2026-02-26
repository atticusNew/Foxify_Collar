import React, { useState, useEffect, useRef } from 'react'
import { getCachedOptions, setCachedOptions } from '../utils/hedgeOptionsCache'

// Use relative path in production (same domain), absolute in development
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:8000')
const MIN_PREMIUM_USD = 0  // No minimum premium requirement

export default function HedgeModal({ event, choice, onClose, onHedgeComplete, preSelectedPosition = null }) {
  const [selectedPosition, setSelectedPosition] = useState(preSelectedPosition) // 'yes' or 'no' - pre-selected if provided
  const [loading, setLoading] = useState(false)
  const [strategy, setStrategy] = useState(null)
  const [error, setError] = useState(null)
  const [executing, setExecuting] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  // State for preset hedge options
  const [hedgeOptions, setHedgeOptions] = useState(null)
  const [selectedOption, setSelectedOption] = useState(null)
  const [loadingOptions, setLoadingOptions] = useState(false)
  // Trade execution state
  const [executingTrade, setExecutingTrade] = useState(false)
  const [tradeDetails, setTradeDetails] = useState(null)
  // State for preview counts (tier availability per position)
  const [previewCounts, setPreviewCounts] = useState({ yes: null, no: null })
  const [loadingPreview, setLoadingPreview] = useState(false)
  // Phase 2: Cache options by position for instant display
  const [hedgeOptionsByPosition, setHedgeOptionsByPosition] = useState({ yes: null, no: null })
  // Amount input state (like Kalshi UI)
  const [amountInput, setAmountInput] = useState('')
  const [amountError, setAmountError] = useState(null)
  // Track if strategy has been built (Option A: Smart Defaults)
  const [strategyBuilt, setStrategyBuilt] = useState(false)
  // Ref to prevent infinite loops in useEffect
  const fetchingRef = useRef(false)

  // Use choice data if provided (for "how" events), otherwise use event data
  const displayEvent = choice || event
  
  // Use base ticker (series ticker) instead of full market_ticker with strike appended
  // For "how" events, use base ticker (e.g., "KXBTCMINY-25") and let backend use threshold_price
  // For "when will" events, we still need the date part, so use first two parts of market_ticker
  let eventTicker = null
  
  if (choice?.market_ticker) {
    // Extract base ticker from market_ticker
    // Full ticker format: "KXBTCMINY-25-2-DEC31-80000" or "KXBTCMAXY-25-DEC31-129999.99"
    // Base ticker: "KXBTCMINY-25" (first two parts, series + year)
    const parts = choice.market_ticker.split('-')
    if (parts.length >= 2) {
      // Use first two parts: series ticker + year (e.g., "KXBTCMINY-25")
      eventTicker = parts[0] + '-' + parts[1]
    } else {
      // Fallback to first part only
      eventTicker = parts[0]
    }
    // threshold_price is already in choice.price_threshold or will be extracted from choice.label
  } else if (choice?.event_ticker) {
    // Use choice's event_ticker (should be base ticker)
    eventTicker = choice.event_ticker
  } else if (event?.event_ticker) {
    // Use event's event_ticker
    eventTicker = event.event_ticker
  } else if (event?.market_id) {
    // Final fallback to market_id
    eventTicker = event.market_id
  }
  
  // For "how" events without choices, extract series ticker if it's a full market ticker
  // Also handle "when will" events (KXBTCMAX150)
  // Only apply this to "how" and "when" events, not simple events like "Will BTC price"
  const isHowEvent = eventTicker && (
    eventTicker.startsWith('KXBTCMAXY-') || 
    eventTicker.startsWith('KXBTCMINY-')
  )
  const isWhenEvent = eventTicker && (
    eventTicker.startsWith('KXBTCMAX150-') ||
    eventTicker.startsWith('KXBTCMAX150')
  )
  
  if ((isHowEvent || isWhenEvent) && eventTicker.includes('-') && eventTicker.split('-').length > 2 && !choice) {
    // Market ticker like "KXBTCMAXY-25-DEC31-129999.99" -> base ticker "KXBTCMAXY-25"
    // Or "KXBTCMAX150-25-DEC31" -> base ticker "KXBTCMAX150-25"
    const parts = eventTicker.split('-')
    if (parts.length >= 2) {
      eventTicker = parts[0] + '-' + parts[1]
    } else {
      eventTicker = parts[0]
    }
  }
  // For other events (like "Will BTC price" KXBTC2025100), keep full ticker
  
  // Get YES/NO prices for display
  const yesPrice = choice?.yes_probability || event?.yes_probability || 50
  const noPrice = choice?.no_probability || event?.no_probability || 50
  const yesPriceCents = Math.round(yesPrice)
  const noPriceCents = Math.round(noPrice)

  // Calculate duration from settlement date
  const calculateDuration = () => {
    if (!event?.settlement_date && !event?.days_until_settlement) return null
    
    if (event.days_until_settlement) {
      return event.days_until_settlement
    }
    
    if (event.settlement_date) {
      const today = new Date()
      const settlement = new Date(event.settlement_date)
      const diffTime = settlement - today
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
      return diffDays > 0 ? diffDays : null
    }
    
    return null
  }

  const duration = calculateDuration()
  const settlementDate = event?.settlement_date

  const formatCurrency = (value) => {
    if (!value || isNaN(value) || !isFinite(value)) return '$0.00'
    const num = typeof value === 'string' ? parseFloat(value) : value
    
    // Handle invalid numbers (NaN, Infinity, etc.)
    if (!isFinite(num) || isNaN(num)) {
      return '$0.00'
    }
    
    // Handle very large numbers (scientific notation errors)
    if (num > 1e15 || num < -1e15) {
      return '$0.00' // Return $0 for calculation errors
    }
    
    // For very small values, show more decimals
    if (num > 0 && num < 0.01) {
      return `$${num.toFixed(4)}`
    }
    
    // Format with abbreviation for large numbers
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(1)}M`
    } else if (num >= 1000) {
      return `$${(num / 1000).toFixed(1)}k`
    }
    
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num).replace('$', '$') // Ensure only one $
  }

  const formatTitleNumber = (title) => {
    if (!title) return title;
    // First, remove double dollar signs
    let formatted = title.replace(/\$\$/g, '$');
    
    // Handle numbers with commas: $130,000 or above -> $130k or above
    formatted = formatted.replace(/\$(\d{1,3}),(\d{3})(?:,(\d{3}))?/g, (match, p1, p2, p3) => {
      if (p3) {
        // Millions: $1,234,567 -> $1.2M
        const num = parseFloat(p1 + p2 + p3);
        return `$${(num / 1000000).toFixed(1)}M`;
      } else {
        // Thousands: $130,000 -> $130k (just use p1, don't add p2[0])
        return `$${p1}k`;
      }
    });
    
    // Handle numbers with decimals like "199.99" -> "$199.9k" (but only if it's a price, not a year)
    formatted = formatted.replace(/\$(\d+)\.(\d{2,})/g, (match, whole, decimal) => {
      const num = parseFloat(match.replace('$', ''));
      // Only format if it's >= 1000 and not a year (years are typically 2000-2099)
      if (num >= 1000 && (num < 2000 || num > 2099)) {
        const thousands = (num / 1000).toFixed(1);
        return `$${thousands}k`;
      }
      return match;
    });
    
    // Handle cases like "$1kk" -> "$100k" (1kk = 100k)
    formatted = formatted.replace(/\$(\d+)kk/g, (match, num) => {
      const numVal = parseInt(num) * 100;
      return `$${numVal}k`;
    });
    
    // Handle standalone large numbers that are prices (not years): 100000 -> $100k
    // Exclude years (2000-2099) and numbers that are already formatted
    formatted = formatted.replace(/\$(\d{4,})(?![kM])/g, (match, num) => {
      const numVal = parseInt(num);
      // Don't format years (2000-2099)
      if (numVal >= 2000 && numVal <= 2099) {
        return match;
      }
      if (numVal >= 1000000) {
        return `$${(numVal / 1000000).toFixed(1)}M`;
      } else if (numVal >= 1000) {
        return `$${Math.floor(numVal / 1000)}k`;
      }
      return match;
    });
    
    return formatted;
  }
  
  const formatChoiceLabel = (label) => {
    if (!label) return label;
    return formatTitleNumber(label);
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // Clean Build Strategy Flow: No preview fetch on modal open
  // Tiers are only fetched when user clicks "Build Strategy" button
  // This ensures tiers are calculated with the correct user-entered amount

  // Clean Build Strategy Flow: Reset strategy when position changes
  useEffect(() => {
    if (selectedPosition && eventTicker) {
      // Reset selected option and strategy when position changes
      setSelectedOption(null)
      setStrategyBuilt(false)
      setHedgeOptions([])
    }
  }, [selectedPosition, eventTicker])

  // Clean Build Strategy Flow: Amount starts empty, no auto-fill
  // User must enter amount manually and click "Build Strategy"


  // Helper functions for amount input
  const calculateActualStake = (direction) => {
    // Calculate from contracts * price_per_contract (defaults to 1 contract if not specified)
    // For demo, use a default of $0.65 (typical Kalshi contract)
    if (!event || !direction) return 0.65
    const price = direction === 'yes' ? (event.yes_bid || event.yes_ask || 0.65) : (event.no_bid || event.no_ask || 0.35)
    return Math.max(0.01, price) // Minimum $0.01
  }

  const calculateDisplayedStake = (direction) => {
    // Use user input amount if provided, otherwise actual stake
    if (amountInput && !amountError && !isNaN(parseFloat(amountInput)) && parseFloat(amountInput) > 0) {
      return parseFloat(amountInput)
    }
    return calculateActualStake(direction)
  }

  const calculateMultiplier = (direction) => {
    const actualStake = calculateActualStake(direction)
    const displayedStake = calculateDisplayedStake(direction)
    return actualStake > 0 ? displayedStake / actualStake : 1.0
  }

  // Phase 2: Fetch preview counts AND actual options for both positions in parallel
  const fetchPreviewCountsAndOptions = async () => {
    if (!eventTicker) return
    
    setLoadingPreview(true)
    setLoadingOptions(true)
    
    try {
      // Calculate default stakes for preview
      const yesStake = calculateActualStake('yes')
      const noStake = calculateActualStake('no')
      
      // Extract threshold_price from choice or event
      let thresholdPrice = '100000' // Default fallback
      if (choice?.price_threshold) {
        thresholdPrice = choice.price_threshold.toString()
      } else if (event?.threshold_price) {
        thresholdPrice = event.threshold_price.toString()
      } else if (choice?.label) {
        // Try to extract from label (e.g., "Will Bitcoin be above $100,000" or "$120,000 or above")
        const match = choice.label.match(/\$([\d,]+(?:\.\d+)?)/)
        if (match) {
          thresholdPrice = match[1].replace(/,/g, '')
        }
      } else if (event?.title) {
        // Fallback: try to extract from event title (e.g., "When will Bitcoin hit $150,000?")
        const match = event.title.match(/\$([\d,]+(?:\.\d+)?)/)
        if (match) {
          thresholdPrice = match[1].replace(/,/g, '')
        }
      }
      
      // Extract expiry_date from event - ensure it's just YYYY-MM-DD format
      let expiryDate = new Date().toISOString().split('T')[0] // Default to today
      if (event?.settlement_date) {
        // Extract just the date part if it's a datetime string
        const dateStr = String(event.settlement_date)
        // Handle various formats: "2025-12-31T23:59:59Z", "2025-12-31 23:59:59", "2025-12-31"
        if (dateStr.includes('T')) {
          expiryDate = dateStr.split('T')[0]
        } else if (dateStr.includes(' ')) {
          expiryDate = dateStr.split(' ')[0]
        } else {
          expiryDate = dateStr.substring(0, 10) // Take first 10 chars (YYYY-MM-DD)
        }
      } else if (choice?.settlement_date) {
        const dateStr = String(choice.settlement_date)
        if (dateStr.includes('T')) {
          expiryDate = dateStr.split('T')[0]
        } else if (dateStr.includes(' ')) {
          expiryDate = dateStr.split(' ')[0]
        } else {
          expiryDate = dateStr.substring(0, 10)
        }
      }
      
      // Ensure format is YYYY-MM-DD (exactly 10 characters)
      if (expiryDate.length > 10) {
        expiryDate = expiryDate.substring(0, 10)
      }
      
      // Fetch both preview counts and actual options for both positions in parallel using V3 endpoint
      const paramsYes = new URLSearchParams({
        market_id: eventTicker,
        event_ticker: eventTicker,
        threshold_price: thresholdPrice,
        expiry_date: expiryDate,
        yes_stake_usd: yesStake.toString(),
        no_stake_usd: '0'
      })
      
      const paramsNo = new URLSearchParams({
        market_id: eventTicker,
        event_ticker: eventTicker,
        threshold_price: thresholdPrice,
        expiry_date: expiryDate,
        yes_stake_usd: '0',
        no_stake_usd: noStake.toString()
      })
      
      console.log('🔵 FETCHING PREVIEW COUNTS - Params:', {
        thresholdPrice,
        expiryDate,
        yesStake,
        noStake,
        eventTicker
      })
      
      const [yesResponse, noResponse] = await Promise.all([
        fetch(`${API_BASE}/kalshi/protection-tiers?${paramsYes.toString()}`).catch(() => null),
        fetch(`${API_BASE}/kalshi/protection-tiers?${paramsNo.toString()}`).catch(() => null)
      ])
      
      const yesData = yesResponse?.ok ? await yesResponse.json().catch((err) => {
        console.error('Failed to parse YES response:', err)
        return null
      }) : null
      const noData = noResponse?.ok ? await noResponse.json().catch((err) => {
        console.error('Failed to parse NO response:', err)
        return null
      }) : null
      
      console.log('🟢 PREVIEW RESPONSES:', {
        yesResponseOk: yesResponse?.ok,
        noResponseOk: noResponse?.ok,
        yesStatus: yesResponse?.status,
        noStatus: noResponse?.status,
        yesData,
        noData
      })
      
      // Extract preview counts from V3 response
      const yesCount = yesData?.status === 'available' && yesData?.tiers ? yesData.tiers.length : 0
      const noCount = noData?.status === 'available' && noData?.tiers ? noData.tiers.length : 0
      
      console.log('🟢 PREVIEW COUNTS:', { yesCount, noCount })
      
      setPreviewCounts({
        yes: yesCount,
        no: noCount
      })
      
      // Process and cache actual options for both positions (V3 format)
      const processOptions = (data, direction) => {
        if (data?.status === 'available' && data?.tiers && Array.isArray(data.tiers)) {
          return data.tiers.map(tier => ({
            tier: tier.tier_name || tier.tier || 'standard',
            premium_usd: tier.premium_usd,
            max_payout_usd: tier.max_payout_usd,
            description: tier.description || `Protection tier: ${tier.tier_name || tier.tier}`,
            protection_pct: null,
            estimated_notional: null,
            strikes: tier.strike_range ? (() => {
            // Parse strike range: "BTC $95,000 – $94,000" or "$95,000 – $94,000"
            try {
              // Remove "BTC " prefix if present, then split by dash (en dash, em dash, or hyphen)
              const cleaned = tier.strike_range.replace(/^BTC\s+/i, '').trim()
              const parts = cleaned.split(/[–—-]/).map(s => s.trim())
              const strikes = parts.map(s => {
                // Extract number: remove $ and commas, then parse
                const numStr = s.replace(/[$,]/g, '').trim()
                const num = parseFloat(numStr)
                return isNaN(num) ? null : num
              }).filter(n => n !== null)
              // Fallback to strikes array if parsing fails
              return strikes.length >= 2 ? strikes : (tier.strikes || [])
            } catch {
              // Fallback to strikes array from backend
              return tier.strikes || []
            }
          })() : (tier.strikes || []),
            actual_stake_usd: data.actual_stake_usd,
            displayed_stake_usd: data.displayed_stake_usd,
            stake_multiplier: data.stake_multiplier || 1.0
          }))
        }
        return [] // Return empty array if unavailable (not null, so we know we fetched)
      }
      
      const yesOptions = processOptions(yesData, 'yes')
      const noOptions = processOptions(noData, 'no')
      
      const optionsByPosition = {
        yes: yesOptions,
        no: noOptions
      }
      
      setHedgeOptionsByPosition(optionsByPosition)
      
      // Fix 3: Cache by eventTicker for persistence across modal opens/closes
      setCachedOptions(eventTicker, optionsByPosition)
      
      // If preSelectedPosition is set, immediately load options for that position
      if (preSelectedPosition && optionsByPosition[preSelectedPosition]?.length > 0) {
        setHedgeOptions(optionsByPosition[preSelectedPosition])
      }
      
      console.log('✅ Cached options:', {
        eventTicker,
        yes: yesOptions.length,
        no: noOptions.length,
        preSelectedPosition: preSelectedPosition
      })
      
    } catch (err) {
      console.error('Failed to fetch preview counts and options:', err)
      // Set defaults if fetch fails
      setPreviewCounts({ yes: 0, no: 0 })
      const emptyOptions = { yes: [], no: [] }
      setHedgeOptionsByPosition(emptyOptions)
      // DON'T cache empty results - let it try again next time
      // This prevents showing "no options" immediately on next modal open
      // Only cache successful fetches with at least one option
    } finally {
      setLoadingPreview(false)
      setLoadingOptions(false)
    }
  }

  const fetchHedgeOptions = async () => {
    if (!eventTicker || !selectedPosition) return
    
    // Prevent multiple simultaneous calls
    if (fetchingRef.current || loadingOptions) {
      console.log('⏸️ Already fetching, skipping...')
      return
    }
    
    fetchingRef.current = true
    setLoadingOptions(true)
    setError(null)
    
    // Calculate displayed stake from amount input (Option 1: Real-time Preview)
    const displayedStake = calculateDisplayedStake(selectedPosition)
    const actualStake = calculateActualStake(selectedPosition)
    
    // IMPORTANT: Pass displayedStake (user-entered amount) to backend, not actualStake
    // Backend will use this as displayed_stake_usd for tier calculations
    const yesStake = selectedPosition === 'yes' ? displayedStake : 0
    const noStake = selectedPosition === 'no' ? displayedStake : 0
    
    // Log what we're sending
    console.log('🔵 FETCHING V3 PROTECTION TIERS:', {
      eventTicker,
      selectedPosition,
      displayedStake,
      actualStake,
      yesStake,
      noStake
    })
    
    try {
      // Extract threshold_price from choice or event
      let thresholdPrice = '100000' // Default fallback
      if (choice?.price_threshold) {
        thresholdPrice = choice.price_threshold.toString()
      } else if (event?.threshold_price) {
        thresholdPrice = event.threshold_price.toString()
      } else if (choice?.label) {
        // Try to extract from label (e.g., "Will Bitcoin be above $100,000" or "$120,000 or above")
        const match = choice.label.match(/\$([\d,]+(?:\.\d+)?)/)
        if (match) {
          thresholdPrice = match[1].replace(/,/g, '')
        }
      } else if (event?.title) {
        // Fallback: try to extract from event title (e.g., "When will Bitcoin hit $150,000?")
        const match = event.title.match(/\$([\d,]+(?:\.\d+)?)/)
        if (match) {
          thresholdPrice = match[1].replace(/,/g, '')
        }
      }
      
      // Extract expiry_date from event - ensure it's just YYYY-MM-DD format
      let expiryDate = new Date().toISOString().split('T')[0] // Default to today
      if (event?.settlement_date) {
        // Extract just the date part if it's a datetime string
        const dateStr = String(event.settlement_date)
        // Handle various formats: "2025-12-31T23:59:59Z", "2025-12-31 23:59:59", "2025-12-31"
        if (dateStr.includes('T')) {
          expiryDate = dateStr.split('T')[0]
        } else if (dateStr.includes(' ')) {
          expiryDate = dateStr.split(' ')[0]
        } else {
          expiryDate = dateStr.substring(0, 10) // Take first 10 chars (YYYY-MM-DD)
        }
      } else if (choice?.settlement_date) {
        const dateStr = String(choice.settlement_date)
        if (dateStr.includes('T')) {
          expiryDate = dateStr.split('T')[0]
        } else if (dateStr.includes(' ')) {
          expiryDate = dateStr.split(' ')[0]
        } else {
          expiryDate = dateStr.substring(0, 10)
        }
      }
      
      // Ensure format is YYYY-MM-DD (exactly 10 characters)
      if (expiryDate.length > 10) {
        expiryDate = expiryDate.substring(0, 10)
      }
      
      // Use V3 /kalshi/protection-tiers endpoint
      const params = new URLSearchParams({
        market_id: eventTicker,
        event_ticker: eventTicker,
        threshold_price: thresholdPrice,
        expiry_date: expiryDate,
        yes_stake_usd: yesStake.toString(),
        no_stake_usd: noStake.toString()
      })
      
      const url = `${API_BASE}/kalshi/protection-tiers?${params.toString()}`
      console.log('🔵 FETCHING V3 PROTECTION TIERS - Full URL:', url)
      console.log('🔵 Request params:', {
        market_id: eventTicker,
        event_ticker: eventTicker,
        threshold_price: thresholdPrice,
        expiry_date: expiryDate,
        yes_stake_usd: yesStake.toString(),
        no_stake_usd: noStake.toString(),
        event: event,
        choice: choice
      })
      
      const response = await fetch(url)
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Failed to read error response')
        let errorData
        try {
          errorData = JSON.parse(errorText)
        } catch {
          errorData = { detail: errorText || `HTTP error! status: ${response.status}` }
        }
        console.error('❌ API ERROR:', {
          status: response.status,
          statusText: response.statusText,
          errorData,
          url
        })
        throw new Error(errorData.detail || errorData.message || `HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      
      // Debug logging - make it very visible
      console.log('🟢 V3 PROTECTION TIERS RESPONSE:', {
        status: data.status,
        tiers_count: data.tiers?.length || 0,
        tiers: data.tiers,
        displayed_stake_usd: data.displayed_stake_usd,
        actual_stake_usd: data.actual_stake_usd,
        stake_multiplier: data.stake_multiplier,
        fullResponse: data
      })
      
      // Handle V3 response structure
      if (data.status === 'unavailable') {
        // Show message but allow custom input
        setHedgeOptions([])
        console.warn('Protection unavailable for this market')
        // Set strategyBuilt to true so "No Protection Available" message displays
        setStrategyBuilt(true)
      } else if (data.status === 'available' && data.tiers && Array.isArray(data.tiers)) {
        // Convert V3 tiers to options format for compatibility
        const options = data.tiers.map(tier => ({
          tier: tier.tier_name || tier.tier || 'standard',
          premium_usd: tier.premium_usd,
          max_payout_usd: tier.max_payout_usd,
          description: tier.description || `Protection tier: ${tier.tier_name || tier.tier}`,
          protection_pct: null,
          estimated_notional: null,
          strikes: tier.strike_range ? (() => {
            // Parse strike range: "BTC $82,000 – $92,000" or "$82,000 – $92,000"
            try {
              // Remove "BTC " prefix if present, then split by dash (en dash, em dash, or hyphen)
              const cleaned = tier.strike_range.replace(/^BTC\s+/i, '').trim()
              const parts = cleaned.split(/[–—-]/).map(s => s.trim())
              const strikes = parts.map(s => {
                // Extract number: remove $ and commas, then parse
                const numStr = s.replace(/[$,]/g, '').trim()
                const num = parseFloat(numStr)
                return isNaN(num) ? null : num
              }).filter(n => n !== null)
              // Sort strikes low→high for consistent display
              const sortedStrikes = strikes.sort((a, b) => a - b)
              // Fallback to strikes array if parsing fails
              return sortedStrikes.length >= 2 ? sortedStrikes : (tier.strikes || []).sort((a, b) => parseFloat(a) - parseFloat(b))
            } catch {
              // Fallback to strikes array from backend, sorted low→high
              return (tier.strikes || []).sort((a, b) => parseFloat(a) - parseFloat(b))
            }
          })() : (tier.strikes || []).sort((a, b) => parseFloat(a) - parseFloat(b)),
          actual_stake_usd: data.actual_stake_usd,
          displayed_stake_usd: data.displayed_stake_usd,
          stake_multiplier: data.stake_multiplier || 1.0
        }))
        
        // Deduplicate protection ranges: if Standard and Max have same strike range, only show Max
        // Tier priority: max > standard > light
        const tierPriority = { 'max': 3, 'standard': 2, 'light': 1 }
        const strikeRangeMap = new Map()
        
        // First pass: collect all options by strike range (use sorted strikes for consistent keys)
        options.forEach(option => {
          // Sort strikes low→high before creating key to ensure consistent comparison
          const sortedStrikes = option.strikes && option.strikes.length > 0
            ? [...option.strikes].sort((a, b) => parseFloat(a) - parseFloat(b))
            : []
          
          const strikeKey = sortedStrikes.length >= 2 
            ? `${sortedStrikes[0]}-${sortedStrikes[sortedStrikes.length - 1]}`
            : sortedStrikes.length === 1
            ? `${sortedStrikes[0]}`
            : 'no-strikes'
          
          const currentPriority = tierPriority[option.tier.toLowerCase()] || 0
          const existing = strikeRangeMap.get(strikeKey)
          
          if (!existing || currentPriority > existing.priority) {
            strikeRangeMap.set(strikeKey, { option, priority: currentPriority })
          }
        })
        
        // Second pass: filter options to only include highest priority for each strike range
        const deduplicatedOptions = options.filter(option => {
          // Sort strikes low→high before creating key (same as first pass)
          const sortedStrikes = option.strikes && option.strikes.length > 0
            ? [...option.strikes].sort((a, b) => parseFloat(a) - parseFloat(b))
            : []
          
          const strikeKey = sortedStrikes.length >= 2 
            ? `${sortedStrikes[0]}-${sortedStrikes[sortedStrikes.length - 1]}`
            : sortedStrikes.length === 1
            ? `${sortedStrikes[0]}`
            : 'no-strikes'
          
          const stored = strikeRangeMap.get(strikeKey)
          return stored && stored.option === option
        })
        
        console.log('✅ PROCESSED V3 PROTECTION OPTIONS:', deduplicatedOptions)
        console.log('✅ DEDUPLICATED: Removed', options.length - deduplicatedOptions.length, 'duplicate strike ranges')
        console.log('✅ OPTIONS COUNT:', deduplicatedOptions.length)
        console.log('✅ DEDUPLICATED: Removed', options.length - deduplicatedOptions.length, 'duplicate strike ranges')
        setHedgeOptions(deduplicatedOptions)
        // Set strategyBuilt only after successful fetch (Fix: Build Strategy double-click)
        setStrategyBuilt(true)
      } else {
        console.warn('Unexpected response format:', data)
        setHedgeOptions([])
        // Set strategyBuilt to true so "No Protection Available" message displays
        setStrategyBuilt(true)
      }
    } catch (err) {
      console.error('Failed to fetch hedge options:', err)
      setError(err.message || 'Failed to fetch hedge options')
      // Don't block user - allow custom input if options fail
      setHedgeOptions([])
      // Set strategyBuilt to true so "No Protection Available" message displays
      setStrategyBuilt(true)
    } finally {
      setLoadingOptions(false)
      fetchingRef.current = false
    }
  }

  // Note: We don't auto-fetch on amountInput change to avoid infinite loops
  // Fetching happens on blur of the amount input field instead

  // Trade execution handler - one-click execution with loading and trade details
  const handleExecuteTrade = async () => {
    if (!selectedPosition || !selectedOption) {
      setError('Please select a position and protection tier')
      return
    }
    
    const premiumValue = parseFloat(selectedOption.premium_usd)
    if (!premiumValue || premiumValue <= 0) {
      setError('Invalid premium amount')
      return
    }

    setExecutingTrade(true)
    setError(null)
    
    // Simulate trade execution (2-3 seconds)
    await new Promise(resolve => setTimeout(resolve, 2500))
    
    // Create trade details object
    const tradeData = {
      event: event,
      choice: choice,
      eventTicker: eventTicker,
      position: selectedPosition,
      tier: selectedOption.tier,
      premium: selectedOption.premium_usd,
      maxPayout: selectedOption.max_payout_usd,
      strikes: selectedOption.strikes,
      description: selectedOption.description,
      executedAt: new Date().toISOString()
    }
    
    setTradeDetails(tradeData)
    setExecutingTrade(false)
    
    // DON'T call onHedgeComplete here - wait for user to close trade details modal
    // This ensures trade details are shown before modal closes
  }

  // Helper function to render body content - avoids nested ternary parsing issues
  const renderBodyContent = () => {
    if (tradeDetails) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem'
        }}>
          <div style={{
            width: '4rem',
            height: '4rem',
            borderRadius: '50%',
            backgroundColor: '#10b981',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '1.5rem'
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h3 style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: '#111827',
            margin: 0,
            marginBottom: '0.5rem',
            textAlign: 'center'
          }}>
            Trade Executed
          </h3>
          <p style={{
            fontSize: '0.875rem',
            color: '#6b7280',
            margin: 0,
            marginBottom: '1.5rem',
            textAlign: 'center',
            lineHeight: '1.5'
          }}>
            Your hedge protection is now active.
          </p>
          
          {/* Trade Details */}
          <div style={{
            width: '100%',
            backgroundColor: '#f3f4f6',
            borderRadius: '8px',
            padding: '1.5rem',
            marginBottom: '1.5rem'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
              paddingBottom: '1rem',
              borderBottom: '1px solid #e5e7eb'
            }}>
              <div>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  marginBottom: '0.25rem'
                }}>
                  Premium Paid
                </div>
                <div style={{
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  color: '#111827'
                }}>
                  {formatCurrency(tradeDetails.premium)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  marginBottom: '0.25rem'
                }}>
                  Max Payout
                </div>
                <div style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: '#059669'
                }}>
                  {formatCurrency(tradeDetails.maxPayout)}
                </div>
              </div>
            </div>
            
            {tradeDetails.strikes && tradeDetails.strikes.length >= 2 && (
              <div style={{
                fontSize: '0.875rem',
                color: '#6b7280',
                marginBottom: '0.5rem'
              }}>
                Strike Range: ${parseFloat(tradeDetails.strikes[0]).toLocaleString()} - ${parseFloat(tradeDetails.strikes[tradeDetails.strikes.length - 1]).toLocaleString()}
              </div>
            )}
            
            <div style={{
              fontSize: '0.875rem',
              color: '#6b7280'
            }}>
              Protection Tier: <strong style={{ color: '#111827' }}>{tradeDetails.tier}</strong>
            </div>
          </div>
          
          <button
            onClick={() => {
              // Notify parent to mark event as hedged BEFORE closing
              if (onHedgeComplete && tradeDetails) {
                onHedgeComplete(tradeDetails)
              }
              setTradeDetails(null)
              setSelectedPosition(null)
              setSelectedOption(null)
              setError(null)
              onClose()
            }}
            style={{
              width: '100%',
              padding: '0.875rem 1.5rem',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#1d4ed8'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#2563eb'
            }}
          >
            Close
          </button>
        </div>
      )
    }
    
    if (confirmation && !executing) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem'
        }}>
          <div style={{
            width: '4rem',
            height: '4rem',
            borderRadius: '50%',
            backgroundColor: '#10b981',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '1.5rem'
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <h3 style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: '#111827',
            margin: 0,
            marginBottom: '0.5rem',
            textAlign: 'center'
          }}>
            Hedge Strategy Executed
          </h3>
          <p style={{
            fontSize: '0.875rem',
            color: '#6b7280',
            margin: 0,
            marginBottom: '1.5rem',
            textAlign: 'center',
            lineHeight: '1.5'
          }}>
            Your hedge strategy has been processed.
            <br />
            <strong style={{ color: '#dc2626' }}>Note: This trade was not actually executed.</strong>
            <br />
            This is a demo interface for presentation purposes only.
          </p>
          <div style={{
            backgroundColor: '#f3f4f6',
            padding: '1rem',
            borderRadius: '8px',
            width: '100%',
            marginBottom: '1rem'
          }}>
            <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.25rem' }}>Cost</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827' }}>
              {formatCurrency(confirmation.strategy?.estimated_premium || strategy?.estimated_premium)}
            </div>
          </div>
          {(confirmation.strategy?.expiry_date || strategy?.expiry_date || (confirmation.strategy?.legs && confirmation.strategy.legs[0]?.expiry_date) || (strategy?.legs && strategy.legs[0]?.expiry_date)) && (
            <div style={{
              backgroundColor: '#f3f4f6',
              padding: '1rem',
              borderRadius: '8px',
              width: '100%',
              marginBottom: '1.5rem'
            }}>
              <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.25rem' }}>Expiry Date</div>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                {confirmation.strategy?.expiry_date || strategy?.expiry_date || (confirmation.strategy?.legs && confirmation.strategy.legs[0]?.expiry_date) || (strategy?.legs && strategy.legs[0]?.expiry_date) || 'N/A'}
              </div>
            </div>
          )}
          <button
            onClick={() => {
              // Close modal and notify parent that hedge is complete
              if (onHedgeComplete && confirmation) {
                onHedgeComplete(confirmation)
              }
              onClose()
              setConfirmation(null)
              setStrategy(null)
              setError(null)
              setSelectedPosition(null)
            }}
            style={{
              width: '100%',
              padding: '0.875rem 1.5rem',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#1d4ed8'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#2563eb'
            }}
          >
            Close
          </button>
        </div>
      )
    }
    
    // Return null for other cases - will be handled by the rest of the component
    return null
  }

  return (
    <div 
      onClick={executing || loading ? undefined : onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem'
      }}
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          maxWidth: '600px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '1.5rem',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem'
        }}>
          <div style={{
            width: '3rem',
            height: '3rem',
            borderRadius: '50%',
            backgroundColor: '#fed7aa',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.5rem'
          }}>
            {event?.icon || '₿'}
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: '#111827',
              margin: 0,
              marginBottom: '0.25rem'
            }}>
              {formatTitleNumber(displayEvent?.title || event?.title)}
            </h2>
            {choice && (
              <p style={{
                fontSize: '0.875rem',
                color: '#6b7280',
                margin: 0
              }}>
                {formatChoiceLabel(choice.label)}
              </p>
            )}
          </div>
          <button
            onClick={(loading || executing || executingTrade || tradeDetails) ? undefined : onClose}
            disabled={loading || executing || executingTrade || tradeDetails}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '2rem',
              color: (loading || executing || executingTrade || tradeDetails) ? '#d1d5db' : '#9ca3af',
              cursor: (loading || executing || executingTrade || tradeDetails) ? 'not-allowed' : 'pointer',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              transition: 'all 0.2s',
              opacity: (loading || executing || executingTrade || tradeDetails) ? 0.5 : 1
            }}
            onMouseEnter={(e) => {
              if (!loading && !executing && !executingTrade && !tradeDetails) {
                e.currentTarget.style.backgroundColor = '#f3f4f6'
                e.currentTarget.style.color = '#111827'
              }
            }}
            onMouseLeave={(e) => {
              if (!loading && !executing && !executingTrade && !tradeDetails) {
                e.currentTarget.style.backgroundColor = 'transparent'
                e.currentTarget.style.color = '#9ca3af'
              }
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '1.5rem', position: 'relative' }}>
          {/* Show trade details modal if trade completed */}
          {renderBodyContent() || (!strategy ? (
            <div>
              {/* YES/NO Selection */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#374151',
                  marginBottom: '0.75rem'
                }}>
                  Choose Your Position
                </label>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.75rem'
                }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!loading) {
                        setSelectedPosition('yes')
                        // Clean Build Strategy Flow: Don't auto-fill amount
                        // Reset strategy when position changes
                        setStrategyBuilt(false)
                        setSelectedOption(null)
                        setHedgeOptions([])
                      }
                    }}
                    disabled={loading}
                    style={{
                      backgroundColor: selectedPosition === 'yes' ? '#2563eb' : '#ffffff',
                      color: selectedPosition === 'yes' ? '#ffffff' : '#2563eb',
                      border: `2px solid ${selectedPosition === 'yes' ? '#2563eb' : '#93c5fd'}`,
                      borderRadius: '8px',
                      padding: '1rem',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      fontSize: '1rem',
                      fontWeight: 600,
                      transition: 'all 0.2s',
                      opacity: loading ? 0.5 : 1,
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.25rem'
                    }}
                  >
                    <div style={{ fontSize: '1rem', fontWeight: 700 }}>
                      Yes {yesPriceCents}¢
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!loading) {
                        setSelectedPosition('no')
                        // Clean Build Strategy Flow: Don't auto-fill amount
                        // Reset strategy when position changes
                        setStrategyBuilt(false)
                        setSelectedOption(null)
                        setHedgeOptions([])
                      }
                    }}
                    disabled={loading}
                    style={{
                      backgroundColor: selectedPosition === 'no' ? '#db2777' : '#ffffff',
                      color: selectedPosition === 'no' ? '#ffffff' : '#db2777',
                      border: `2px solid ${selectedPosition === 'no' ? '#db2777' : '#f9a8d4'}`,
                      borderRadius: '8px',
                      padding: '1rem',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      fontSize: '1rem',
                      fontWeight: 600,
                      transition: 'all 0.2s',
                      opacity: loading ? 0.5 : 1,
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.25rem'
                    }}
                  >
                    <div style={{ fontSize: '1rem', fontWeight: 700 }}>
                      No {noPriceCents}¢
                    </div>
                  </button>
                </div>
              </div>

              {/* Amount Input - Like Kalshi UI */}
              {selectedPosition && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: '#374151',
                    marginBottom: '0.5rem'
                  }}>
                    Protection Amount (USD)
                  </label>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}>
                    <div style={{
                      position: 'relative',
                      flex: 1
                    }}>
                      <span style={{
                        position: 'absolute',
                        left: '0.75rem',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: '1rem',
                        fontWeight: 600,
                        color: '#6b7280'
                      }}>
                        $
                      </span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={amountInput}
                        onChange={(e) => {
                          const value = e.target.value
                          setAmountInput(value)
                          setAmountError(null)
                          
                          // Validate amount
                          const numValue = parseFloat(value)
                          if (value && (isNaN(numValue) || numValue <= 0)) {
                            setAmountError('Amount must be greater than $0')
                          } else if (value && numValue < 0.01) {
                            setAmountError('Minimum amount is $0.01')
                          } else {
                            setAmountError(null)
                          }
                          
                          // Clean Build Strategy Flow: Reset strategy when amount changes
                          // User must click "Build Strategy" again to rebuild with new amount
                          if (strategyBuilt) {
                            setStrategyBuilt(false)
                            setSelectedOption(null)
                            setHedgeOptions([])
                          }
                        }}
                        placeholder="Amount"
                        style={{
                          width: '100%',
                          padding: '0.75rem 0.75rem 0.75rem 2rem',
                          fontSize: '1rem',
                          fontWeight: 600,
                          border: `2px solid ${amountError ? '#ef4444' : '#e5e7eb'}`,
                          borderRadius: '8px',
                          outline: 'none',
                          transition: 'all 0.2s'
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = '#2563eb'
                        }}
                        onBlur={(e) => {
                          // Update border color
                          e.target.style.borderColor = amountError ? '#ef4444' : '#e5e7eb'
                          // Format to 2 decimal places on blur
                          if (amountInput && !isNaN(parseFloat(amountInput))) {
                            const numValue = parseFloat(amountInput)
                            if (numValue > 0) {
                              setAmountInput(numValue.toFixed(2))
                            }
                          }
                          // Re-fetch options when user finishes typing
                          if (selectedPosition && amountInput && !amountError) {
                            fetchHedgeOptions()
                          }
                        }}
                      />
                    </div>
                  </div>
                  {amountError && (
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#ef4444',
                      marginTop: '0.25rem'
                    }}>
                      {amountError}
                    </div>
                  )}
                  {amountInput && !amountError && !isNaN(parseFloat(amountInput)) && parseFloat(amountInput) > 0 && (
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#6b7280',
                      marginTop: '0.25rem'
                    }}>
                      Protecting ${parseFloat(amountInput).toFixed(2)} exposure
                    </div>
                  )}
                </div>
              )}

              {/* Build Strategy Button - Option A: Smart Defaults */}
              {selectedPosition && amountInput && !amountError && !isNaN(parseFloat(amountInput)) && parseFloat(amountInput) > 0 && !strategyBuilt && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!loadingOptions && eventTicker) {
                        // Don't set strategyBuilt here - it will be set in fetchHedgeOptions on success
                        fetchHedgeOptions()
                      }
                    }}
                    disabled={loadingOptions || !eventTicker || amountError || !amountInput || parseFloat(amountInput) <= 0}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1.5rem',
                      backgroundColor: loadingOptions ? '#9ca3af' : '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '1rem',
                      fontWeight: 600,
                      cursor: loadingOptions || amountError || !amountInput || parseFloat(amountInput) <= 0 ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s',
                      opacity: loadingOptions || amountError || !amountInput || parseFloat(amountInput) <= 0 ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!loadingOptions && !amountError && amountInput && parseFloat(amountInput) > 0) {
                        e.currentTarget.style.backgroundColor = '#1d4ed8'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!loadingOptions && !amountError && amountInput && parseFloat(amountInput) > 0) {
                        e.currentTarget.style.backgroundColor = '#2563eb'
                      }
                    }}
                  >
                    {loadingOptions ? 'Building Strategy...' : 'Build Strategy'}
                  </button>
                  {amountInput && !amountError && parseFloat(amountInput) > 0 && (
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#6b7280',
                      marginTop: '0.5rem',
                      textAlign: 'center'
                    }}>
                      Click to build protection for ${parseFloat(amountInput).toFixed(2)} exposure
                    </div>
                  )}
                </div>
              )}

              {/* Hedge Options Selection - Phase 1: Only show after position selected, amount entered, and strategy built */}
              {selectedPosition && amountInput && !amountError && !isNaN(parseFloat(amountInput)) && parseFloat(amountInput) > 0 && strategyBuilt && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '0.75rem'
                  }}>
                    <label style={{
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: '#374151'
                    }}>
                      Choose Protection Level
                    </label>
                    {loadingOptions && (
                      <div style={{
                        fontSize: '0.75rem',
                        color: '#2563eb',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem'
                      }}>
                        <span>🔄</span>
                        <span>Updating tiers...</span>
                      </div>
                    )}
                  </div>
                  
                  {loadingOptions ? (
                    <div style={{
                      padding: '2rem',
                      textAlign: 'center',
                      color: '#6b7280',
                      fontSize: '0.875rem',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}>
                      <div style={{ fontSize: '1.5rem' }}>🔄</div>
                      <div>Building protection tiers for ${parseFloat(amountInput).toFixed(2)}...</div>
                    </div>
                  ) : strategyBuilt && hedgeOptions && hedgeOptions.length > 0 ? (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: '0.75rem',
                    marginBottom: '1rem'
                  }}>
                    {hedgeOptions.map((option) => (
                      <div
                        key={option.tier}
                        onClick={() => setSelectedOption(option)}
                        style={{
                          border: selectedOption?.tier === option.tier ? '2px solid #2563eb' : '1px solid #e5e7eb',
                          borderRadius: '8px',
                          padding: '1.25rem',
                          cursor: 'pointer',
                          backgroundColor: selectedOption?.tier === option.tier ? '#eff6ff' : '#ffffff',
                          transition: 'all 0.2s',
                          textAlign: 'center'
                        }}
                        onMouseEnter={(e) => {
                          if (selectedOption?.tier !== option.tier) {
                            e.currentTarget.style.borderColor = '#93c5fd'
                            e.currentTarget.style.backgroundColor = '#f8fafc'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (selectedOption?.tier !== option.tier) {
                            e.currentTarget.style.borderColor = '#e5e7eb'
                            e.currentTarget.style.backgroundColor = '#ffffff'
                          }
                        }}
                      >
                        <div style={{
                          fontSize: '1rem',
                          fontWeight: 600,
                          color: '#111827',
                          marginBottom: '0.625rem',
                          textTransform: 'capitalize'
                        }}>
                          {option.tier}
                        </div>
                        <div style={{
                          fontSize: '1.5rem',
                          fontWeight: 700,
                          color: '#111827',
                          marginBottom: '0.375rem'
                        }}>
                          {formatCurrency(option.premium_usd)}
                        </div>
                        <div style={{
                          fontSize: '0.875rem',
                          color: '#059669',
                          fontWeight: 600,
                          marginBottom: '0.375rem'
                        }}>
                          Pays up to {formatCurrency(option.max_payout_usd)}
                        </div>
                        <div style={{
                          fontSize: '0.8125rem',
                          color: '#6b7280',
                          lineHeight: '1.5',
                          marginBottom: '0.375rem'
                        }}>
                          {selectedPosition === 'yes' 
                            ? `If your Yes bet loses, protection pays up to ${formatCurrency(option.max_payout_usd)}`
                            : `If your No bet loses, protection pays up to ${formatCurrency(option.max_payout_usd)}`}
                        </div>
                        <div style={{
                          fontSize: '0.75rem',
                          color: '#9ca3af',
                          marginTop: '0.375rem',
                          fontWeight: 500
                        }}>
                          {option.strikes && option.strikes.length >= 2 ? (() => {
                            // Sort strikes low→high for consistent display
                            const sortedStrikes = [...option.strikes].sort((a, b) => parseFloat(a) - parseFloat(b))
                            return `Strike range: $${parseFloat(sortedStrikes[0]).toLocaleString()} - $${parseFloat(sortedStrikes[sortedStrikes.length - 1]).toLocaleString()}`
                          })() : option.strikes && option.strikes.length === 1
                            ? `Strike: $${parseFloat(option.strikes[0]).toLocaleString()}`
                            : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : strategyBuilt && !loadingOptions && (!hedgeOptions || hedgeOptions.length === 0) ? (
                    // Show clean message when no options available (after fetch completes and strategy is built)
                    <div style={{
                      padding: '1.5rem',
                      backgroundColor: '#f9fafb',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      color: '#6b7280',
                      fontSize: '0.875rem',
                      textAlign: 'center',
                      marginBottom: '1rem'
                    }}>
                      No Protection Available
                      <div style={{
                        fontSize: '0.75rem',
                        color: '#9ca3af',
                        marginTop: '0.5rem'
                      }}>
                        Protection options are not available for this market at this time.
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Summary Section - Show selected tier details */}
              {selectedOption && (
                <div style={{
                  backgroundColor: '#f0f9ff',
                  border: '2px solid #2563eb',
                  borderRadius: '8px',
                  padding: '1rem',
                  marginBottom: '1.5rem'
                }}>
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: '#2563eb',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        marginBottom: '0.625rem'
                      }}>
                        Selected Protection
                      </div>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.625rem'
                      }}>
                        <div>
                          <div style={{
                            fontSize: '0.9375rem',
                            color: '#6b7280',
                            marginBottom: '0.375rem',
                            fontWeight: 500
                          }}>
                            Tier
                          </div>
                          <div style={{
                            fontSize: '1.125rem',
                            fontWeight: 700,
                            color: '#111827',
                            textTransform: 'capitalize'
                          }}>
                            {selectedOption.tier}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{
                            fontSize: '0.9375rem',
                            color: '#6b7280',
                            marginBottom: '0.375rem',
                            fontWeight: 500
                          }}>
                            Cost
                          </div>
                          <div style={{
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            color: '#111827'
                          }}>
                            {formatCurrency(selectedOption.premium_usd)}
                          </div>
                        </div>
                      </div>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingTop: '0.625rem',
                        borderTop: '1px solid #bfdbfe'
                      }}>
                        <div>
                          <div style={{
                            fontSize: '0.8125rem',
                            color: '#6b7280',
                            marginBottom: '0.25rem',
                            fontWeight: 500
                      }}>
                        Max Payout
                      </div>
                      <div style={{
                        fontSize: '1rem',
                        fontWeight: 600,
                        color: '#059669'
                      }}>
                        {formatCurrency(selectedOption.max_payout_usd)}
                      </div>
                    </div>
                    {selectedOption.strikes && selectedOption.strikes.length >= 2 && (
                      <div style={{ textAlign: 'right' }}>
                        <div style={{
                          fontSize: '0.8125rem',
                          color: '#6b7280',
                          marginBottom: '0.25rem',
                          fontWeight: 500
                        }}>
                          Strike Range
                        </div>
                        <div style={{
                          fontSize: '1rem',
                          fontWeight: 600,
                          color: '#111827'
                        }}>
                          {(() => {
                            // Sort strikes low→high for consistent display
                            const sortedStrikes = [...selectedOption.strikes].sort((a, b) => parseFloat(a) - parseFloat(b))
                            return `$${parseFloat(sortedStrikes[0]).toLocaleString()} - $${parseFloat(sortedStrikes[sortedStrikes.length - 1]).toLocaleString()}`
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div style={{
                  backgroundColor: '#FEE2E2',
                  color: '#DC2626',
                  padding: '1rem',
                  borderRadius: '8px',
                  marginBottom: '1.5rem',
                  fontSize: '0.875rem'
                }}>
                  {error}
                </div>
              )}

              {/* Dynamic Button States: Loading / Unavailable / Execute Trade */}
              {loadingOptions ? (
                // State 1: Loading (only when Build Strategy is clicked)
                <div style={{
                  width: '100%',
                  padding: '1.5rem',
                  textAlign: 'center',
                  color: '#6b7280',
                  fontSize: '0.875rem',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.75rem'
                }}>
                  <div style={{
                    width: '24px',
                    height: '24px',
                    border: '2px solid #2563eb',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite'
                  }}></div>
                  <div>Building hedges...</div>
                </div>
              ) : strategyBuilt && selectedPosition && hedgeOptions && hedgeOptions.length > 0 ? (
                // State 3: Strategy built and tiers available
                // Show Execute Trade button only when position selected AND tier selected
                selectedOption ? (
                  <button
                    type="button"
                    onClick={handleExecuteTrade}
                    disabled={!selectedPosition || !selectedOption || executingTrade}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1.5rem',
                      backgroundColor: (!selectedPosition || !selectedOption || executingTrade) ? '#9ca3af' : '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '1rem',
                      fontWeight: 600,
                      cursor: (!selectedPosition || !selectedOption || executingTrade) ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem'
                    }}
                    onMouseEnter={(e) => {
                      if (selectedPosition && selectedOption && !executingTrade) {
                        e.currentTarget.style.backgroundColor = '#1d4ed8'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedPosition && selectedOption && !executingTrade) {
                        e.currentTarget.style.backgroundColor = '#2563eb'
                      }
                    }}
                  >
                    {executingTrade ? (
                      <>
                        <div style={{
                          width: '16px',
                          height: '16px',
                          border: '2px solid rgba(255, 255, 255, 0.3)',
                          borderTopColor: '#ffffff',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite'
                        }}></div>
                        Executing trade...
                      </>
                    ) : (
                      'Execute Trade'
                    )}
                  </button>
                ) : (
                  // Strategy built but no tier selected yet
                  <div style={{
                    width: '100%',
                    padding: '1rem',
                    textAlign: 'center',
                    color: '#6b7280',
                    fontSize: '0.875rem'
                  }}>
                    Select a protection tier above
                  </div>
                )
              ) : null}
            </div>
          ) : (
            /* Strategy Results */
            <div>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1.5rem',
                paddingBottom: '1rem',
                borderBottom: '1px solid #e5e7eb'
              }}>
                <h3 style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: '#111827',
                  margin: 0
                }}>
                  Hedge Strategy
                </h3>
                <span style={{
                  backgroundColor: strategy.strategy_type === 'PROTECTIVE_PUT' ? '#ef4444' : '#10b981',
                  color: '#ffffff',
                  padding: '0.375rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  fontWeight: 600
                }}>
                  {strategy.strategy_type === 'PROTECTIVE_CALL' 
                    ? 'Protective Call'
                    : strategy.strategy_type === 'COLLAR'
                    ? 'Collar'
                    : 'Protective Put'}
                </span>
              </div>

              {/* Essential Information Only - Simple & Clear */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                marginBottom: '1.5rem'
              }}>
                {/* Cost */}
                <div style={{
                  backgroundColor: '#f3f4f6',
                  padding: '1.25rem',
                  borderRadius: '8px'
                }}>
                  <div style={{
                    fontSize: '0.875rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem'
                  }}>
                    Cost
                  </div>
                  <div style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    color: '#111827'
                  }}>
                    {formatCurrency(strategy.estimated_premium)}
                  </div>
                </div>

                {/* Strike Price */}
                {strategy.strike_price && (
                  <div style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #e5e7eb',
                    padding: '1.25rem',
                    borderRadius: '8px'
                  }}>
                    <div style={{
                      fontSize: '0.875rem',
                      color: '#6b7280',
                      marginBottom: '0.5rem'
                    }}>
                      Strike Price
                    </div>
                    <div style={{
                      fontSize: '1.25rem',
                      fontWeight: 600,
                      color: '#111827'
                    }}>
                      {strategy.strike_price ? new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      }).format(strategy.strike_price) : 'N/A'}
                    </div>
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#6b7280',
                      marginTop: '0.25rem'
                    }}>
                      {strategy.strategy_type === 'PROTECTIVE_PUT' 
                        ? 'Protects if Bitcoin drops below this price'
                        : 'Protects if Bitcoin rises above this price'}
                    </div>
                  </div>
                )}

                {/* Expiry Date */}
                {strategy.expiry_date && (
                  <div style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #e5e7eb',
                    padding: '1.25rem',
                    borderRadius: '8px'
                  }}>
                    <div style={{
                      fontSize: '0.875rem',
                      color: '#6b7280',
                      marginBottom: '0.5rem'
                    }}>
                      Expiry Date
                    </div>
                    <div style={{
                      fontSize: '1.25rem',
                      fontWeight: 600,
                      color: '#111827'
                    }}>
                      {strategy.expiry_date || (strategy.legs && strategy.legs[0]?.expiry_date) || 'N/A'}
                    </div>
                  </div>
                )}


                {/* Payout if In The Money */}
                {strategy.strike_price && strategy.legs && strategy.legs.length > 0 && (() => {
                  const isPut = strategy.strategy_type === 'PROTECTIVE_PUT';
                  const isSpread = strategy.legs.length > 1;
                  
                  // For spreads, extract strikes from legs
                  let strike1 = null;
                  let strike2 = null;
                  let quantity = null;
                  
                  if (isSpread) {
                    // Extract strikes from leg instruments (e.g., "BTC-26DEC25-75000-P")
                    const strikes = [];
                    for (const leg of strategy.legs) {
                      const parts = leg.instrument.split('-');
                      if (parts.length >= 3) {
                        // Try to parse strike from different formats
                        for (let i = parts.length - 1; i >= 0; i--) {
                          const part = parts[i];
                          // Check if it's a number (strike)
                          if (/^\d+$/.test(part)) {
                            strikes.push(parseFloat(part));
                            break;
                          }
                        }
                      }
                      if (quantity === null && leg.quantity) {
                        quantity = parseFloat(leg.quantity);
                      }
                    }
                    
                    if (strikes.length >= 2) {
                      strike1 = Math.min(...strikes);
                      strike2 = Math.max(...strikes);
                    }
                  }
                  
                  // Fallback to single strike if not a spread or parsing failed
                  const strike = strike1 || parseFloat(strategy.strike_price);
                  if (!quantity && strategy.legs[0]?.quantity) {
                    quantity = parseFloat(strategy.legs[0].quantity);
                  }
                  
                  if (!quantity || quantity <= 0) {
                    return null; // Can't calculate payout without quantity
                  }
                  
                  // Calculate payout scenarios
                  let exampleBTCPrice, payout;
                  
                  if (isSpread && strike1 && strike2) {
                    // For spreads, max payout is limited by spread width
                    const spreadWidth = strike2 - strike1;
                    
                    if (isPut) {
                      // PUT spread: Long K2 (higher strike), Short K1 (lower strike)
                      // Max payout = (K2 - K1) * quantity when BTC < K1
                      // The spread pays (K2 - K1) * quantity when fully in the money
                      exampleBTCPrice = strike1 * 0.9; // 10% below lower strike
                      // Max payout is the spread width times quantity
                      payout = spreadWidth * quantity;
                    } else {
                      // CALL spread: Long K1 (lower strike), Short K2 (higher strike)
                      // Max payout = (K2 - K1) * quantity when BTC > K2
                      // The spread pays (K2 - K1) * quantity when fully in the money
                      exampleBTCPrice = strike2 * 1.1; // 10% above upper strike
                      // Max payout is the spread width times quantity
                      payout = spreadWidth * quantity;
                    }
                  } else {
                    // Single leg option
                    if (isPut) {
                      exampleBTCPrice = strike * 0.9; // 10% below strike
                      // For a PUT, payout = (strike - BTC_price) * quantity
                      // At 10% below strike, payout = (strike - 0.9*strike) * quantity = 0.1*strike*quantity
                      payout = Math.max(0, strike - exampleBTCPrice) * quantity;
                    } else {
                      exampleBTCPrice = strike * 1.1; // 10% above strike
                      // For a CALL, payout = (BTC_price - strike) * quantity
                      // At 10% above strike, payout = (1.1*strike - strike) * quantity = 0.1*strike*quantity
                      payout = Math.max(0, exampleBTCPrice - strike) * quantity;
                    }
                  }
                  
                  // Ensure payout is at least equal to premium (for protective strategies)
                  const premium = parseFloat(strategy.estimated_premium || 0);
                  if (payout < premium && premium > 0) {
                    // If calculated payout is less than premium, use premium as minimum
                    // This ensures users always get at least what they paid
                    payout = premium;
                  }
                  
                  // Format payout (handle very large numbers)
                  let payoutDisplay = payout;
                  if (payout > 1e15) {
                    payoutDisplay = premium; // Fallback to premium if calculation error
                  }
                  
                  return (
                    <div style={{
                      backgroundColor: '#ecfdf5',
                      border: '1px solid #10b981',
                      padding: '1.25rem',
                      borderRadius: '8px'
                    }}>
                      <div style={{
                        fontSize: '0.875rem',
                        color: '#059669',
                        marginBottom: '0.5rem',
                        fontWeight: 600
                      }}>
                        Potential Payout (if in the money at expiry)
                      </div>
                      <div style={{
                        fontSize: '1rem',
                        color: '#111827',
                        marginBottom: '0.75rem'
                      }}>
                        {isPut ? (
                          <>
                            If Bitcoin is below <strong>${strike.toLocaleString()}</strong> at expiry:
                          </>
                        ) : (
                          <>
                            If Bitcoin is above <strong>${strike.toLocaleString()}</strong> at expiry:
                          </>
                        )}
                      </div>
                      <div style={{
                        fontSize: '0.875rem',
                        color: '#6b7280',
                        lineHeight: '1.6'
                      }}>
                        {isSpread && strike1 && strike2 ? (
                          <>
                            {isPut ? (
                              <>
                                Spread: ${strike1.toLocaleString()} - ${strike2.toLocaleString()}
                                <br />
                                Example: If BTC = <strong>${exampleBTCPrice.toLocaleString()}</strong> (10% below lower strike)
                                <br />
                                Payout = <strong>{formatCurrency(payoutDisplay)}</strong>
                                <br />
                                <span style={{ fontSize: '0.75rem', fontStyle: 'italic' }}>
                                  Max payout: {formatCurrency((strike2 - strike1) * quantity)} (if BTC {'<'} ${strike1.toLocaleString()})
                                </span>
                              </>
                            ) : (
                              <>
                                Spread: ${strike1.toLocaleString()} - ${strike2.toLocaleString()}
                                <br />
                                Example: If BTC = <strong>${exampleBTCPrice.toLocaleString()}</strong> (10% above upper strike)
                                <br />
                                Payout = <strong>{formatCurrency(payoutDisplay)}</strong>
                                <br />
                                <span style={{ fontSize: '0.75rem', fontStyle: 'italic' }}>
                                  Max payout: {formatCurrency((strike2 - strike1) * quantity)} (if BTC {'>'} ${strike2.toLocaleString()})
                                </span>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            {isPut ? (
                              <>
                                Example: If BTC = <strong>${exampleBTCPrice.toLocaleString()}</strong> (10% below strike)
                                <br />
                                Payout = <strong>{formatCurrency(payoutDisplay)}</strong>
                              </>
                            ) : (
                              <>
                                Example: If BTC = <strong>${exampleBTCPrice.toLocaleString()}</strong> (10% above strike)
                                <br />
                                Payout = <strong>{formatCurrency(payoutDisplay)}</strong>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>


              {/* Execute Button */}
              <button
                onClick={async () => {
                  setExecuting(true)
                  // Simulate execution for 3-5 seconds
                  const executionTime = 3000 + Math.random() * 2000 // 3-5 seconds
                  await new Promise(resolve => setTimeout(resolve, executionTime))
                  
                  // Create confirmation object
                  const confirmData = {
                    event: event,
                    choice: choice,
                    strategy: strategy,
                    executedAt: new Date().toISOString()
                  }
                  setConfirmation(confirmData)
                  setExecuting(false)
                  
                  // Don't notify parent yet - let confirmation display first
                  // Parent will be notified when user clicks "Close" on confirmation
                }}
                disabled={executing}
                style={{
                  width: '100%',
                  padding: '0.875rem 1.5rem',
                  backgroundColor: executing ? '#9ca3af' : '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '1rem',
                  fontWeight: 600,
                  cursor: executing ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onMouseEnter={(e) => {
                  if (!executing) {
                    e.currentTarget.style.backgroundColor = '#1d4ed8'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!executing) {
                    e.currentTarget.style.backgroundColor = '#2563eb'
                  }
                }}
              >
                {executing && (
                  <div style={{
                    width: '16px',
                    height: '16px',
                    border: '2px solid rgba(255, 255, 255, 0.3)',
                    borderTopColor: '#ffffff',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite'
                  }}></div>
                )}
                {executing ? 'Executing...' : 'Execute Hedge'}
              </button>

              {/* Back Button */}
              <button
                onClick={() => {
                  setStrategy(null)
                  setError(null)
                  setSelectedPosition(null)
                  setConfirmation(null)
                }}
                disabled={executing}
                style={{
                  width: '100%',
                  padding: '0.875rem 1.5rem',
                  marginTop: '0.75rem',
                  backgroundColor: executing ? '#f3f4f6' : '#f3f4f6',
                  color: executing ? '#9ca3af' : '#111827',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '1rem',
                  fontWeight: 600,
                  cursor: executing ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: executing ? 0.5 : 1
                }}
                onMouseEnter={(e) => {
                  if (!executing) {
                    e.currentTarget.style.backgroundColor = '#e5e7eb'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!executing) {
                    e.currentTarget.style.backgroundColor = '#f3f4f6'
                  }
                }}
              >
                Back
              </button>
            </div>
          ))}

        </div>
      </div>
    </div>
  )
}
