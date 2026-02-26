import React, { useState, useEffect } from 'react';

export default function Header({ activeTab, onTabChange, hedgeDetails, onShowHedgeDetails, onRefresh, isRefreshing = false }) {
  const tabs = ['BTC']; // Only BTC category
  const [showDetailsMenu, setShowDetailsMenu] = useState(false)
  const [tooltipMessage, setTooltipMessage] = useState(null)
  
  // Expose setShowDetailsMenu to window for App.jsx to control
  useEffect(() => {
    window.setHeaderDropdownState = setShowDetailsMenu
    return () => {
      delete window.setHeaderDropdownState
    }
  }, [])

  // Check for hedge details periodically
  useEffect(() => {
    const checkHedgeDetails = () => {
      if (window.hedgeDetailsStrategy && !hedgeDetails) {
        // Trigger parent to update hedgeDetails
        if (onShowHedgeDetails) {
          // This will be handled by App.jsx
        }
      }
    }
    const interval = setInterval(checkHedgeDetails, 100)
    return () => clearInterval(interval)
  }, [hedgeDetails, onShowHedgeDetails])

  return (
    <div style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 40 }}>
      {/* Top Bar */}
      <div style={{ padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <img 
            src="https://i.ibb.co/vxBYx7j3/kalshlogo.png" 
            alt="Kalshi" 
            style={{ height: '32px', width: 'auto', display: 'block' }}
            onError={(e) => {
              // Fallback: hide broken image, show text instead
              e.target.style.display = 'none';
              if (!e.target.nextSibling) {
                const textNode = document.createTextNode('Kalshi');
                e.target.parentNode.appendChild(textNode);
              }
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            style={{
              background: 'none',
              border: 'none',
              cursor: isRefreshing ? 'not-allowed' : 'pointer',
              padding: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              transition: 'all 0.2s',
              color: isRefreshing ? '#9ca3af' : '#4b5563',
              opacity: isRefreshing ? 0.6 : 1
            }}
            onMouseEnter={(e) => {
              if (!isRefreshing) {
                e.currentTarget.style.backgroundColor = '#f3f4f6'
                e.currentTarget.style.color = '#111827'
              }
            }}
            onMouseLeave={(e) => {
              if (!isRefreshing) {
                e.currentTarget.style.backgroundColor = 'transparent'
                e.currentTarget.style.color = '#4b5563'
              }
            }}
            title={isRefreshing ? 'Refreshing events...' : 'Refresh events'}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transition: 'transform 0.3s ease',
                transform: isRefreshing ? 'rotate(360deg)' : 'rotate(0deg)',
                animation: isRefreshing ? 'spin 1s linear infinite' : 'none'
              }}
            >
              <style>{`
                @keyframes spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
          </button>

          {/* Three-bar menu - always visible, no functionality */}
          <button
            type="button"
            onClick={() => {
              setTooltipMessage('Demo: Limited functionality')
              setTimeout(() => setTooltipMessage(null), 2000)
            }}
            style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '4px', 
              alignItems: 'center', 
              justifyContent: 'center', 
              padding: '0.5rem',
              cursor: 'pointer',
              background: 'none',
              border: 'none',
              borderRadius: '6px',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#f3f4f6'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
            }}
          >
            <div style={{ width: '20px', height: '2px', backgroundColor: '#4b5563', borderRadius: '1px' }}></div>
            <div style={{ width: '20px', height: '2px', backgroundColor: '#4b5563', borderRadius: '1px' }}></div>
            <div style={{ width: '20px', height: '2px', backgroundColor: '#4b5563', borderRadius: '1px' }}></div>
          </button>
        </div>
      </div>

      {/* Tooltip Message */}
      {tooltipMessage && (
        <div style={{
          position: 'fixed',
          top: '80px',
          right: '1.5rem',
          backgroundColor: '#111827',
          color: '#ffffff',
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          fontSize: '0.875rem',
          fontWeight: 500,
          zIndex: 1000,
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
          animation: 'fadeIn 0.2s ease-in'
        }}>
          {tooltipMessage}
          <style>{`
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(-10px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}</style>
        </div>
      )}

      {/* Disclaimer */}
      <div style={{ 
        padding: '0.5rem 1.5rem', 
        textAlign: 'center',
        borderTop: '1px solid #e5e7eb',
        backgroundColor: '#f9fafb'
      }}>
        <p style={{
          fontSize: '0.75rem',
          color: '#6b7280',
          margin: 0,
          fontWeight: 400
        }}>
          Live market data and pricing displayed in this demo interface are for presentation purposes only.
        </p>
      </div>

      {/* Categories and Filters */}
      <div style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid #e5e7eb', display: 'flex', gap: '1rem', alignItems: 'center', overflowX: 'auto' }}>
        <span style={{ fontSize: '0.875rem', color: '#111827', fontWeight: 600, whiteSpace: 'nowrap' }}>
          Crypto
        </span>
        <div style={{ width: '1px', height: '16px', backgroundColor: '#e5e7eb' }}></div>
        <span style={{ fontSize: '0.75rem', color: '#4b5563', fontWeight: 600, whiteSpace: 'nowrap' }}>
          Filters:
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span 
            onClick={() => {
              setTooltipMessage('Demo: Filter applied')
              setTimeout(() => setTooltipMessage(null), 2000)
            }}
            style={{
              padding: '0.375rem 0.75rem',
              borderRadius: '9999px',
              whiteSpace: 'nowrap',
              fontSize: '0.75rem',
              fontWeight: 500,
              backgroundColor: '#dbeafe',
              color: '#2563eb',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#bfdbfe'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#dbeafe'
            }}
          >
            BTC
          </span>
          <span 
            onClick={() => {
              setTooltipMessage('Demo: Filter applied')
              setTimeout(() => setTooltipMessage(null), 2000)
            }}
            style={{
              padding: '0.375rem 0.75rem',
              borderRadius: '9999px',
              whiteSpace: 'nowrap',
              fontSize: '0.75rem',
              fontWeight: 500,
              backgroundColor: '#dbeafe',
              color: '#2563eb',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#bfdbfe'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#dbeafe'
            }}
          >
            Expiry &lt;365
          </span>
          <span 
            onClick={() => {
              setTooltipMessage('Demo: Filter applied')
              setTimeout(() => setTooltipMessage(null), 2000)
            }}
            style={{
              padding: '0.375rem 0.75rem',
              borderRadius: '9999px',
              whiteSpace: 'nowrap',
              fontSize: '0.75rem',
              fontWeight: 500,
              backgroundColor: '#dbeafe',
              color: '#2563eb',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#bfdbfe'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#dbeafe'
            }}
          >
            Volume &gt;$0
          </span>
        </div>
      </div>
    </div>
  );
}
