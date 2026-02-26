import React, { useState, useEffect } from 'react'
import axios from 'axios'
import EventCard from './EventCard'
import HedgeModal from './HedgeModal'
import './EventList.css'

// Use relative path in production (same domain), absolute in development
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:8000')

function EventList() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    fetchEvents()
  }, [])

  const fetchEvents = async () => {
    try {
      setLoading(true)
      setError(null)
      // Use volume-based endpoint for top BTC price movement events
      const response = await axios.get(`${API_BASE}/events/btc/top-volume`, {
        params: {
          limit: 6
        },
        timeout: 20000  // 20 second timeout
      })
      
      // Transform response to match expected format - include YES/NO percentages
      const eventsData = response.data?.events || []
      const transformedEvents = eventsData.map(e => ({
        market_id: e.market_id || e.event_ticker,
        ticker: e.event_ticker,
        title: e.title,
        category: e.category || 'Crypto',
        settlement_date: e.settlement_date,
        volume: e.volume_24h_usd?.replace(/[$,]/g, '') || '0',
        open_interest: null,
        threshold_price: null,
        volume_24h_usd: e.volume_24h_usd,
        volume_millions: e.volume_millions,
        days_until_settlement: e.days_until_settlement,
        // YES/NO probabilities from API
        yes_probability: e.yes_probability || e.yes_percentage?.replace('%', '') || null,
        no_probability: e.no_probability || e.no_percentage?.replace('%', '') || null,
        yes_percentage: e.yes_percentage || (e.yes_probability ? `${e.yes_probability}%` : null),
        no_percentage: e.no_percentage || (e.no_probability ? `${e.no_probability}%` : null),
        // Choices for "how" events
        choices: e.choices || [],
        is_how_event: e.is_how_event || (e.choices && e.choices.length > 0)
      }))
      
      setEvents(transformedEvents)
    } catch (err) {
      console.error('Failed to fetch events:', err)
      const errorMessage = err.response?.data?.detail || err.message || 'Failed to fetch events'
      setError(errorMessage)
      console.error('Error details:', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        url: `${API_BASE}/events/ranked`,
        code: err.code
      })
      
      // If timeout, show helpful message
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        setError('Request timed out. The API may be slow fetching from Kalshi. Please try again.')
      }
      
      // Fallback to regular events endpoint if ranked fails
      if (err.response?.status !== 504) {  // Don't retry if it's a timeout
        try {
          const fallbackResponse = await axios.get(`${API_BASE}/events`, {
            params: {
              category: 'crypto',
              max_settlement_days: 90
            },
            timeout: 20000
          })
          setEvents(fallbackResponse.data || [])
          setError(null)
        } catch (fallbackErr) {
          console.error('Fallback also failed:', fallbackErr)
          if (fallbackErr.code === 'ECONNABORTED') {
            setError('API server is not responding. Please check if the server is running on ' + API_BASE)
          }
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const handleHedgeClick = (event) => {
    setSelectedEvent(event)
    setShowModal(true)
  }

  const handleModalClose = () => {
    setShowModal(false)
    setSelectedEvent(null)
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading events...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="error-container">
        <p className="error-message">{error}</p>
        <button onClick={fetchEvents} className="retry-button">
          Retry
        </button>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="empty-container">
        <h3>No BTC Events Found</h3>
        <p>
          {error 
            ? `Unable to connect to API: ${error}`
            : 'The Kalshi demo API has limited BTC price events available. This is normal for demo environments.'
          }
        </p>
        <p style={{ fontSize: '0.9em', color: '#666', marginTop: '1em' }}>
          <strong>Note:</strong> 
          {error 
            ? ` Check if the API server is running on ${API_BASE}`
            : ' In production, this would show real BTC price events from Kalshi. The platform is working correctly - the demo API just has limited events.'
          }
        </p>
        <button onClick={fetchEvents} className="retry-button" style={{ marginTop: '1em' }}>
          Refresh
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="event-list">
        {events.map((event) => (
          <EventCard
            key={event.market_id || event.ticker}
            event={event}
            onHedgeClick={handleHedgeClick}
          />
        ))}
      </div>
      {showModal && selectedEvent && (
        <HedgeModal
          event={selectedEvent}
          onClose={handleModalClose}
        />
      )}
    </>
  )
}

export default EventList

