import React, { useState } from 'react';
import HedgeModal from './HedgeModal';

export default function EventCard({ event, onProtect, isHedged = false, hedgeData = null, onShowHedgeDetails }) {
  const [showHedgeModal, setShowHedgeModal] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState(null);
  const [preSelectedPosition, setPreSelectedPosition] = useState(null); // 'yes' or 'no' - pre-selected when YES/NO button clicked
  const [hedgeConfirmation, setHedgeConfirmation] = useState(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  // Check if this is a multi-choice event ("how" or "when will") with choices
  const isMultiChoiceEvent = event.is_how_event || event.is_when_event || (event.choices && event.choices.length > 0);
  const choices = event.choices || [];
  
  // Get YES/NO percentages for regular events
  const yesPercent = event.yes_percentage || event.yes_probability || '50%';
  const noPercent = event.no_percentage || event.no_probability || '50%';
  
  // Parse percentages to numbers for calculations
  const yesPercentNum = parseFloat(yesPercent.toString().replace('%', '')) || 50;
  const noPercentNum = parseFloat(noPercent.toString().replace('%', '')) || 50;
  
  // Calculate payout amounts (like Kalshi shows: $100 → $X)
  const yesPayout = yesPercentNum > 0 ? Math.round(100 / (yesPercentNum / 100)) : 0;
  const noPayout = noPercentNum > 0 ? Math.round(100 / (noPercentNum / 100)) : 0;

  const formatVolume = (volume) => {
    if (!volume) return '';
    const numVolume = typeof volume === 'string' ? parseFloat(volume.replace(/[$,]/g, '')) : volume;
    if (numVolume === 0) return '';
    // Format as compact number without $ symbol (we'll add it separately)
    const formatted = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(numVolume);
    return formatted;
  };

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
  };
  
  const formatChoiceLabel = (label) => {
    if (!label) return label;
    // Apply same formatting as title
    return formatTitleNumber(label);
  };

  const handleHedgeComplete = (tradeData) => {
    // Pass trade data to parent via onProtect callback
    if (onProtect) {
      onProtect(event, selectedChoice, tradeData)
    }
    setShowHedgeModal(false);
    setSelectedChoice(null);
  };

  const formatCurrency = (value) => {
    if (!value) return '$0.00';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
      return `$${(num / 1000).toFixed(1)}k`;
    }
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num).replace('$', '$');
  };

  return (
    <div style={{
      backgroundColor: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: '12px',
      padding: '1.5rem',
      display: 'flex',
      position: 'relative',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
      transition: 'all 0.2s ease'
    }}>
      {/* Icon */}
      <div style={{
        width: '3.5rem',
        height: '3.5rem',
        borderRadius: '50%',
        backgroundColor: '#fed7aa',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.75rem',
        flexShrink: 0,
        marginBottom: '0.75rem'
      }}>
        {event.icon || '₿'}
      </div>

      {/* Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Title */}
        <h3 style={{
          fontSize: '1.375rem',
          fontWeight: 600,
          color: '#111827',
          marginBottom: '1rem',
          lineHeight: '1.4',
          marginTop: 0
        }}>
          {formatTitleNumber(event.title)}
        </h3>

        {/* Content */}
        <div style={{ flex: 1 }}>
        {isMultiChoiceEvent && choices.length > 0 ? (
          /* For multi-choice events ("how" or "when will"): Show choices with label left, buttons right */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {choices.map((choice, index) => {
              const choiceYesPercent = parseFloat(choice.yes_percentage?.replace('%', '') || '0');
              const choiceNoPercent = parseFloat(choice.no_percentage?.replace('%', '') || '0');
              const choiceYesPayout = choiceYesPercent > 0 ? Math.round(100 / (choiceYesPercent / 100)) : 0;
              const choiceNoPayout = choiceNoPercent > 0 ? Math.round(100 / (choiceNoPercent / 100)) : 0;
              
              return (
                <div key={index} style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  padding: '0.625rem',
                  borderRadius: '6px',
                  backgroundColor: index % 2 === 0 ? 'transparent' : '#f9fafb'
                }}>
                  {/* Left: Label + Percentage Badge */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.625rem',
                    flex: 1,
                    minWidth: 0  // Allow flex item to shrink below content size
                  }}>
                    <span style={{
                      fontSize: '0.9375rem',
                      fontWeight: 600,
                      color: '#111827',
                      flex: 1,
                      wordBreak: 'break-word',
                      lineHeight: '1.35'
                    }}>
                      {formatChoiceLabel(choice.label)}
                    </span>
                    <span style={{
                      backgroundColor: '#f3f4f6',
                      color: '#111827',
                      padding: '0.3125rem 0.625rem',
                      borderRadius: '6px',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      minWidth: '45px',
                      textAlign: 'center'
                    }}>
                      {choice.yes_percentage}
                    </span>
                  </div>

                  {/* Right: YES/NO Buttons + Hedge Button - Stacked vertically on small screens */}
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    alignItems: 'flex-end',
                    flexShrink: 0
                  }}>
                    <div style={{
                      display: 'flex',
                      gap: '0.5rem'
                    }}>
                      <button
                        onClick={() => {
                          setSelectedChoice(choice);
                          setPreSelectedPosition('yes');
                          setShowHedgeModal(true);
                        }}
                        style={{
                          backgroundColor: '#ffffff',
                          border: '1.5px solid #10b981',
                          borderRadius: '6px',
                          padding: '0.5rem 0.75rem',
                          cursor: 'pointer',
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          color: '#10b981',
                          minWidth: '50px',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = '#f0fdf4';
                          e.currentTarget.style.borderColor = '#059669';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = '#ffffff';
                          e.currentTarget.style.borderColor = '#10b981';
                        }}
                      >
                        Yes
                      </button>
                      
                      <button
                        onClick={() => {
                          setSelectedChoice(choice);
                          setPreSelectedPosition('no');
                          setShowHedgeModal(true);
                        }}
                        style={{
                          backgroundColor: '#ffffff',
                          border: '1.5px solid #ef4444',
                          borderRadius: '6px',
                          padding: '0.5rem 0.75rem',
                          cursor: 'pointer',
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          color: '#ef4444',
                          minWidth: '50px',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = '#fef2f2';
                          e.currentTarget.style.borderColor = '#dc2626';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = '#ffffff';
                          e.currentTarget.style.borderColor = '#ef4444';
                        }}
                      >
                        No
                      </button>
                    </div>
                    
                    {!isHedged && (
                      <button
                        onClick={() => {
                          setSelectedChoice(choice);
                          setShowHedgeModal(true);
                        }}
                        style={{
                          backgroundColor: '#059669',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '0.5rem 0.75rem',
                          cursor: 'pointer',
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          transition: 'all 0.2s',
                          width: '100%'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = '#047857';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = '#059669';
                        }}
                      >
                        Hedge
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* For regular events: Show YES/NO buttons side by side */
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.875rem'
          }}>
            <button
              onClick={() => {
                setSelectedChoice(null);
                setPreSelectedPosition('yes');
                setShowHedgeModal(true);
              }}
              style={{
                backgroundColor: '#dbeafe',
                border: '1px solid #93c5fd',
                borderRadius: '8px',
                padding: '1.125rem 0.875rem',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.375rem',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#bfdbfe';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#dbeafe';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <span style={{
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: '#2563eb'
              }}>
                Yes
              </span>
              <span style={{
                fontSize: '1.375rem',
                fontWeight: 700,
                color: '#2563eb'
              }}>
                {yesPercent}
              </span>
              <span style={{
                fontSize: '0.8125rem',
                color: '#6b7280',
                marginTop: '0.125rem'
              }}>
                $100 → <span style={{ color: '#059669', fontWeight: 600 }}>${yesPayout.toLocaleString()}</span>
              </span>
            </button>

            <button
              onClick={() => {
                setSelectedChoice(null);
                setPreSelectedPosition('no');
                setShowHedgeModal(true);
              }}
              style={{
                backgroundColor: '#fce7f3',
                border: '1px solid #f9a8d4',
                borderRadius: '8px',
                padding: '1.125rem 0.875rem',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.375rem',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#fbcfe8';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#fce7f3';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <span style={{
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: '#db2777'
              }}>
                No
              </span>
              <span style={{
                fontSize: '1.375rem',
                fontWeight: 700,
                color: '#db2777'
              }}>
                {noPercent}
              </span>
              <span style={{
                fontSize: '0.8125rem',
                color: '#6b7280',
                marginTop: '0.125rem'
              }}>
                $100 → <span style={{ color: '#059669', fontWeight: 600 }}>${noPayout.toLocaleString()}</span>
              </span>
            </button>
          </div>
        )}
        </div>

        {/* Volume Footer - Light grey, no labels + Hedge Button */}
        {event.volume_24h_usd && (
          <div style={{
            paddingTop: '0.875rem',
            borderTop: '1px solid #e5e7eb',
            marginTop: 'auto',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem'
          }}>
            <div style={{
              color: '#9ca3af',
              fontSize: '0.9375rem',
              fontWeight: 500,
              textAlign: 'left'
            }}>
              ${formatVolume(event.volume_24h_usd)}
            </div>
            {!isMultiChoiceEvent && !isHedged && (
              <button
                onClick={() => {
                  setSelectedChoice(null);
                  setShowHedgeModal(true);
                }}
                style={{
                  backgroundColor: '#059669',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '0.5625rem 1.125rem',
                  cursor: 'pointer',
                  fontSize: '0.9375rem',
                  fontWeight: 600,
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#047857';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#059669';
                }}
              >
                Hedge
              </button>
            )}
          </div>
        )}
      </div>

      {/* Shield Icon - Top Right */}
      {isHedged && hedgeData && (
        <div
          onClick={(e) => {
            e.stopPropagation()
            if (onShowHedgeDetails) {
              onShowHedgeDetails(hedgeData)
            }
          }}
          style={{
            position: 'absolute',
            top: '0.5rem',
            right: '0.5rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s',
            zIndex: 10
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)'
          }}
          title="View hedge details"
        >
          <span style={{ fontSize: '24px', lineHeight: '1' }} role="img" aria-label="shield">🛡️</span>
        </div>
      )}
      
      {/* Hedge Modal */}
      {showHedgeModal && (
        <HedgeModal
          event={event}
          choice={selectedChoice}
          preSelectedPosition={preSelectedPosition}
          onClose={() => {
            setShowHedgeModal(false);
            setSelectedChoice(null);
            setPreSelectedPosition(null); // Reset pre-selected position when modal closes
          }}
          onHedgeComplete={handleHedgeComplete}
        />
      )}

      {/* Confirmation Details Modal */}
      {showConfirmationModal && hedgeConfirmation && (
        <div 
          onClick={() => setShowConfirmationModal(false)}
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
              <h3 style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: '#111827',
                margin: 0
              }}>
                Hedge Confirmation
              </h3>
              <button
                onClick={() => setShowConfirmationModal(false)}
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
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Event</div>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                {formatTitleNumber(hedgeConfirmation.event?.title || '')}
              </div>
            </div>
            {hedgeConfirmation.choice && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Choice</div>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                  {formatChoiceLabel(hedgeConfirmation.choice?.label || '')}
                </div>
              </div>
            )}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Strategy Type</div>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                {hedgeConfirmation.strategy?.strategy_type === 'PROTECTIVE_CALL' 
                  ? 'Protective Call'
                  : hedgeConfirmation.strategy?.strategy_type === 'COLLAR'
                  ? 'Collar'
                  : 'Protective Put'}
              </div>
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Cost</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111827' }}>
                {formatCurrency(hedgeConfirmation.strategy?.estimated_premium)}
              </div>
            </div>
            {hedgeConfirmation.strategy?.strike_price && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Strike Price</div>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                  {new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  }).format(hedgeConfirmation.strategy.strike_price)}
                </div>
              </div>
            )}
            {(hedgeConfirmation.strategy?.expiry_date || (hedgeConfirmation.strategy?.legs && hedgeConfirmation.strategy.legs[0]?.expiry_date)) && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>Expiry Date</div>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                  {hedgeConfirmation.strategy?.expiry_date || (hedgeConfirmation.strategy?.legs && hedgeConfirmation.strategy.legs[0]?.expiry_date) || 'N/A'}
                </div>
              </div>
            )}
            <div style={{
              backgroundColor: '#fef3c7',
              padding: '1rem',
              borderRadius: '8px',
              fontSize: '0.875rem',
              color: '#92400e',
              marginTop: '1rem'
            }}>
              <strong>Note:</strong> This trade was not actually executed. This is a demo interface for presentation purposes only.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

