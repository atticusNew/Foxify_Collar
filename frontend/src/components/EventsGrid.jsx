import React, { useState, useEffect } from 'react'
import EventCard from './EventCard'
import HedgeModal from './HedgeModal'

export default function EventsGrid({ activeTab = 'BTC', refreshKey = 0, onLoadingChange }) {
  const [events, setEvents] = useState([])
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [selectedChoice, setSelectedChoice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hedgedEvents, setHedgedEvents] = useState({}) // Track hedged events: { eventId: hedgeData }
  const [showHedgeDetailsModal, setShowHedgeDetailsModal] = useState(false)
  const [selectedHedgeData, setSelectedHedgeData] = useState(null)

  // Notify parent of loading state changes
  useEffect(() => {
    if (onLoadingChange) {
      onLoadingChange(loading)
    }
  }, [loading, onLoadingChange])

  // Fetch events from API
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setLoading(true)
        // Use relative path in production (same domain), absolute in development
        const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:8000')
        const response = await fetch(`${API_BASE}/events/btc/top-volume?limit=10`)
        const data = await response.json()
        
        if (data.status === 'success') {
          // Handle empty events (cache not yet populated)
          if (!data.events || data.events.length === 0) {
            setEvents([])
            if (data.message) {
              setError(data.message)
            } else {
              setError('No events available yet. Cache is being populated...')
            }
            setLoading(false)
            return
          }
          
          // Transform API response to event format
          const markets = data.events.map(e => ({
            id: e.market_id || e.event_ticker,
            event_ticker: e.event_ticker,
            market_id: e.market_id,
            title: e.title,
            icon: '₿',
            yes_probability: e.yes_probability || parseFloat(e.yes_percentage?.replace('%', '') || '50'),
            no_probability: e.no_probability || parseFloat(e.no_percentage?.replace('%', '') || '50'),
            yes_percentage: e.yes_percentage,
            no_percentage: e.no_percentage,
            volume_24h_usd: e.volume_24h_usd,
            volume_millions: e.volume_millions,
            settlement_date: e.settlement_date,
            days_until_settlement: e.days_until_settlement,
            threshold_price: e.threshold_price || null, // Include threshold_price from backend
            // Convert choices to contracts (include event_ticker for each choice)
            choices: (e.choices || []).map(choice => ({
              ...choice,
              event_ticker: e.event_ticker,
              market_id: e.market_id
            })),
            is_how_event: e.is_how_event || false,
            is_when_event: e.is_when_event || false
          }))
          setEvents(markets)
        }
      } catch (err) {
        setError(err.message)
        console.error('Failed to fetch events:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchEvents()
  }, [activeTab, refreshKey])

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        gap: '1rem'
      }}>
        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
        <div style={{
          width: '3rem',
          height: '3rem',
          border: '2px solid #2563eb',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }}></div>
        <p style={{
          fontSize: '0.875rem',
          color: '#6b7280',
          margin: 0
        }}>
          Loading BTC price events…
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        minHeight: '50vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f3f4f6',
        padding: '2rem'
      }}>
        <div style={{ textAlign: 'center', maxWidth: '500px' }}>
          <p style={{ color: '#dc2626', fontWeight: 600, marginBottom: '0.5rem' }}>
            {error.includes('cache') || error.includes('populated') ? 'Loading events...' : 'Error loading events'}
          </p>
          <p style={{ color: '#4b5563', marginBottom: '1rem' }}>{error}</p>
          {error.includes('cache') || error.includes('populated') ? (
            <button 
              onClick={() => window.location.reload()} 
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                fontSize: '0.875rem'
              }}
            >
              Refresh Page
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (events.length === 0 && !loading) {
    return (
      <div style={{
        minHeight: '50vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f3f4f6',
        padding: '2rem'
      }}>
        <div style={{ textAlign: 'center', maxWidth: '500px' }}>
          <p style={{ color: '#4b5563', marginBottom: '1rem' }}>
            No BTC events available yet. The cache is being populated...
          </p>
          <button 
            onClick={() => window.location.reload()} 
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#2563eb',
              color: 'white',
              border: 'none',
              borderRadius: '0.375rem',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            Refresh Page
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* 2x2 Grid Layout - Professional card display */}
      <style>{`
        .events-grid-container {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2rem;
          width: 100%;
          max-width: 1400px;
          margin: 0 auto;
          padding: 0 1rem;
        }
        
        .event-card-wrapper {
          width: 100%;
          min-width: 0;
        }
        
        /* Tablet - maintain 2 columns but adjust spacing */
        @media (max-width: 1024px) {
          .events-grid-container {
            gap: 1.5rem;
            padding: 0 0.75rem;
          }
        }
        
        /* Mobile - single column */
        @media (max-width: 768px) {
          .events-grid-container {
            grid-template-columns: 1fr;
            gap: 1.5rem;
            padding: 0 1rem;
          }
        }
      `}</style>
      <div 
        className="events-grid-container"
      >
        {events.map((event) => {
          // Check multiple event IDs to find hedge data (handles ID mismatches)
          const eventId1 = event.market_id
          const eventId2 = event.event_ticker
          const eventId3 = event.id
          // Also check base ticker for "how" events (e.g., KXBTCMAXY-25)
          const eventId4 = eventId2 && eventId2.includes('-') 
            ? eventId2.split('-').slice(0, 2).join('-') 
            : null
          
          // Find hedge data by checking all possible IDs
          const hedgeData = hedgedEvents[eventId1] || 
                          hedgedEvents[eventId2] || 
                          hedgedEvents[eventId3] || 
                          hedgedEvents[eventId4]
          const isHedged = !!hedgeData
          
          return (
            <div 
              key={event.id} 
              className="event-card-wrapper"
            >
              <EventCard 
                event={event} 
                onProtect={(evt, choice, tradeData) => {
                  if (tradeData) {
                    // Trade completed - store hedge data with multiple event ID keys
                    // This ensures matching even if IDs differ (e.g., base ticker vs full ticker)
                    const eventId1 = tradeData.eventTicker
                    const eventId2 = evt?.market_id
                    const eventId3 = evt?.event_ticker
                    const eventId4 = evt?.id
                    
                    setHedgedEvents(prev => {
                      const updated = { ...prev }
                      // Store with all possible IDs to ensure matching
                      if (eventId1) updated[eventId1] = tradeData
                      if (eventId2) updated[eventId2] = tradeData
                      if (eventId3) updated[eventId3] = tradeData
                      if (eventId4) updated[eventId4] = tradeData
                      return updated
                    })
                  } else {
                    // Opening hedge modal
                    setSelectedEvent(evt)
                    setSelectedChoice(choice)
                  }
                }}
                isHedged={isHedged}
                hedgeData={hedgeData}
                onShowHedgeDetails={(data) => {
                  setSelectedHedgeData(data)
                  setShowHedgeDetailsModal(true)
                }}
              />
            </div>
          )
        })}
      </div>

      {/* Hedge Modal */}
      {selectedEvent && (
        <HedgeModal
          event={selectedEvent}
          choice={selectedChoice}
          preSelectedPosition={null}
          onClose={() => {
            setSelectedEvent(null)
            setSelectedChoice(null)
          }}
          onHedgeComplete={(tradeData) => {
            // Store hedge data with multiple event ID keys
            // This ensures matching even if IDs differ (e.g., base ticker vs full ticker)
            const eventId1 = tradeData.eventTicker
            const eventId2 = tradeData.event?.market_id
            const eventId3 = tradeData.event?.event_ticker
            const eventId4 = tradeData.event?.id
            
            setHedgedEvents(prev => {
              const updated = { ...prev }
              // Store with all possible IDs to ensure matching
              if (eventId1) updated[eventId1] = tradeData
              if (eventId2) updated[eventId2] = tradeData
              if (eventId3) updated[eventId3] = tradeData
              if (eventId4) updated[eventId4] = tradeData
              return updated
            })
            setSelectedEvent(null)
            setSelectedChoice(null)
          }}
        />
      )}

      {/* Hedge Details Modal */}
      {showHedgeDetailsModal && selectedHedgeData && (
        <div 
          onClick={() => {
            setShowHedgeDetailsModal(false)
            setSelectedHedgeData(null)
          }}
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
              maxWidth: '500px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              padding: '1.5rem'
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1.5rem',
              paddingBottom: '1rem',
              borderBottom: '1px solid #e5e7eb'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{
                  width: '2.5rem',
                  height: '2.5rem',
                  borderRadius: '50%',
                  backgroundColor: '#10b981',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <h3 style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: '#111827',
                  margin: 0
                }}>
                  Hedge Details
                </h3>
              </div>
              <button
                onClick={() => {
                  setShowHedgeDetailsModal(false)
                  setSelectedHedgeData(null)
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '2rem',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6'
                  e.currentTarget.style.color = '#111827'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                  e.currentTarget.style.color = '#9ca3af'
                }}
              >
                ×
              </button>
            </div>

            {/* Hedge Information */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem'
            }}>
              <div style={{
                backgroundColor: '#f3f4f6',
                padding: '1rem',
                borderRadius: '8px'
              }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  marginBottom: '0.5rem'
                }}>
                  Premium Paid
                </div>
                <div style={{
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  color: '#111827'
                }}>
                  ${parseFloat(selectedHedgeData.premium).toFixed(2)}
                </div>
              </div>

              <div style={{
                backgroundColor: '#ecfdf5',
                padding: '1rem',
                borderRadius: '8px',
                border: '1px solid #10b981'
              }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#059669',
                  marginBottom: '0.5rem',
                  fontWeight: 600
                }}>
                  Max Payout
                </div>
                <div style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: '#059669'
                }}>
                  ${parseFloat(selectedHedgeData.maxPayout).toFixed(2)}
                </div>
              </div>

              {selectedHedgeData.strikes && selectedHedgeData.strikes.length >= 2 && (
                <div style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e5e7eb',
                  padding: '1rem',
                  borderRadius: '8px'
                }}>
                  <div style={{
                    fontSize: '0.875rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem'
                  }}>
                    Strike Range
                  </div>
                  <div style={{
                    fontSize: '1rem',
                    fontWeight: 600,
                    color: '#111827'
                  }}>
                    ${parseFloat(selectedHedgeData.strikes[0]).toLocaleString()} - ${parseFloat(selectedHedgeData.strikes[selectedHedgeData.strikes.length - 1]).toLocaleString()}
                  </div>
                </div>
              )}

              <div style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e5e7eb',
                padding: '1rem',
                borderRadius: '8px'
              }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  marginBottom: '0.5rem'
                }}>
                  Protection Tier
                </div>
                <div style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: '#111827',
                  textTransform: 'capitalize'
                }}>
                  {selectedHedgeData.tier}
                </div>
              </div>

              <div style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e5e7eb',
                padding: '1rem',
                borderRadius: '8px'
              }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  marginBottom: '0.5rem'
                }}>
                  Position
                </div>
                <div style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: '#111827',
                  textTransform: 'capitalize'
                }}>
                  {selectedHedgeData.position === 'yes' ? 'Yes' : 'No'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
