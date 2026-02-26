import './App.css'
import { useState, useEffect } from 'react'
import Header from './components/Header'
import EventsGrid from './components/EventsGrid'

function App() {
  const [activeTab, setActiveTab] = useState('BTC')
  const [hedgeDetails, setHedgeDetails] = useState(null)
  const [showHedgeDetailsModal, setShowHedgeDetailsModal] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [isEventsLoading, setIsEventsLoading] = useState(true)

  // Listen for hedge details from EventCard
  useEffect(() => {
    const checkHedgeDetails = () => {
      if (window.hedgeDetailsStrategy) {
        setHedgeDetails(window.hedgeDetailsStrategy)
        window.hedgeDetailsStrategy = null
      }
    }
    const interval = setInterval(checkHedgeDetails, 100)
    return () => clearInterval(interval)
  }, [])

  const handleShowHedgeDetails = () => {
    if (hedgeDetails || window.hedgeDetailsStrategy) {
      setShowHedgeDetailsModal(true)
    }
  }
  
  const handleCloseHedgeDetailsModal = () => {
    setShowHedgeDetailsModal(false)
    // Close dropdown menu when modal closes
    if (window.setHeaderDropdownState) {
      window.setHeaderDropdownState(false)
    }
  }

  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1)
  }

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', backgroundColor: '#f3f4f6', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <Header 
        activeTab={activeTab} 
        onTabChange={setActiveTab}
        hedgeDetails={hedgeDetails}
        onShowHedgeDetails={handleShowHedgeDetails}
        onRefresh={handleRefresh}
        isRefreshing={isEventsLoading}
      />
      <style>{`
        @media (max-width: 768px) {
          .main-content {
            padding: 1rem !important;
          }
        }
      `}</style>
      <div className="main-content" style={{ padding: '2rem 1.5rem', maxWidth: '1400px', margin: '0 auto', flex: 1 }}>
        <EventsGrid activeTab={activeTab} refreshKey={refreshKey} onLoadingChange={setIsEventsLoading} />
      </div>
      {/* Footer */}
      <footer style={{
        marginTop: 'auto',
        padding: '1.5rem 1.5rem',
        backgroundColor: '#ffffff',
        borderTop: '1px solid #e5e7eb'
      }}>
        <div style={{
          maxWidth: '1400px',
          margin: '0 auto',
          textAlign: 'center'
        }}>
          <p style={{
            fontSize: '0.75rem',
            color: '#9ca3af',
            margin: '0 0 0.5rem 0',
            fontWeight: 400
          }}>
            © 2025 Atticus Trade, Inc. All rights reserved
          </p>
          <p style={{
            fontSize: '0.75rem',
            color: '#9ca3af',
            margin: 0,
            fontWeight: 400,
            lineHeight: '1.4'
          }}>
            For discussion and demonstration only. Nothing here constitutes trading advice, a solicitation, or an offer of insurance or derivatives
          </p>
        </div>
      </footer>
      
      {/* Hedge Details Modal */}
      {showHedgeDetailsModal && (hedgeDetails || window.hedgeDetailsStrategy) && (
        <div 
          onClick={handleCloseHedgeDetailsModal}
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
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              padding: '1.5rem'
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
              paddingBottom: '1rem',
              borderBottom: '1px solid #e5e7eb'
            }}>
              <h3 style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: '#111827',
                margin: 0
              }}>
                Hedge Details
              </h3>
              <button
                onClick={handleCloseHedgeDetailsModal}
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
              >
                ×
              </button>
            </div>
            {(hedgeDetails || window.hedgeDetailsStrategy)?.notes && (
              <div style={{
                backgroundColor: '#fef3c7',
                padding: '1rem',
                borderRadius: '8px',
                fontSize: '0.875rem',
                color: '#92400e',
                marginBottom: '1rem',
                whiteSpace: 'pre-wrap'
              }}>
                {(hedgeDetails || window.hedgeDetailsStrategy)?.notes}
              </div>
            )}
            {(hedgeDetails || window.hedgeDetailsStrategy)?.legs && (hedgeDetails || window.hedgeDetailsStrategy)?.legs.length > 0 && (
              <div>
                <h4 style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: '#111827',
                  marginBottom: '0.75rem'
                }}>
                  Strategy Legs
                </h4>
                {(hedgeDetails || window.hedgeDetailsStrategy)?.legs.map((leg, index) => (
                  <div key={index} style={{
                    backgroundColor: '#f3f4f6',
                    padding: '1rem',
                    borderRadius: '8px',
                    marginBottom: '0.75rem',
                    fontSize: '0.875rem',
                    color: '#111827'
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{leg.instrument}</div>
                    <div>Action: {leg.action}</div>
                    <div>Quantity: {leg.quantity}</div>
                    <div>Price: {leg.price}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
