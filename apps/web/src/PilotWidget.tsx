import { useState, useEffect, useCallback } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type ReferencePrice = {
  price: string;
  marketId: string;
  venue: string;
  source: string;
  timestamp: string;
  ageMs: number;
};

type QuoteResponse = {
  status: string;
  protectionType: string;
  tierName: string;
  drawdownFloorPct: string;
  triggerPrice: string;
  floorPrice: string;
  quote: {
    quoteId: string;
    instrumentId: string;
    premium: number;
    expiresAt: string;
    side: string;
    quantity: number;
    venue: string;
    details?: Record<string, unknown>;
  };
  entrySnapshot: {
    price: string;
    marketId: string;
    source: string;
    timestamp: string;
  };
  diagnostics?: Record<string, unknown>;
};

type ProtectionRecord = {
  id: string;
  status: string;
  tierName: string;
  protectedNotional: string;
  foxifyExposureNotional: string;
  entryPrice: string;
  floorPrice: string;
  drawdownFloorPct: string;
  expiryAt: string;
  premium: string;
  autoRenew: boolean;
  payoutDueAmount: string | null;
  payoutSettledAmount: string | null;
  venue: string;
  instrumentId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type MonitorResponse = {
  status: string;
  protection: ProtectionRecord;
  currentPrice?: string;
  currentPriceSource?: string;
  currentPriceTimestamp?: string;
  distanceToFloor?: {
    pct: string;
    usd: string;
    direction: string;
  };
  timeRemaining?: {
    ms: number;
    human: string;
  };
};

type WidgetView = "form" | "active" | "closed";

// ─── Config ──────────────────────────────────────────────────────────

const STOP_LOSS_OPTIONS = [20, 15, 12] as const;
type StopLoss = (typeof STOP_LOSS_OPTIONS)[number];

const STOP_LOSS_TO_TIER: Record<StopLoss, string> = {
  20: "Pro (Bronze)",
  15: "Pro (Silver)",
  12: "Pro (Gold)",
};

const POSITION_MIN = 5000;
const POSITION_MAX = 50000;
const POSITION_STEP = 5000;
const PREMIUM_PER_K = 11;
const TENOR_DAYS = 5;

const FOXIFY_LOGO = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";

// ─── Formatting ──────────────────────────────────────────────────────

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const fmtTimeRemaining = (ms: number): string => {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
};

// ─── API ─────────────────────────────────────────────────────────────

const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.reason || json?.message || `HTTP ${res.status}`);
  return json as T;
};

const fetchRef = () => api<{ status: string; reference: ReferencePrice }>("/pilot/reference-price");

const fetchQuote = (body: Record<string, unknown>) =>
  api<QuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify(body) });

const activateProtection = (body: Record<string, unknown>) =>
  api<{ status: string; protectionId: string; protection: ProtectionRecord }>(
    "/pilot/protections/activate", { method: "POST", body: JSON.stringify(body) }
  );

const fetchMonitor = (id: string) => api<MonitorResponse>(`/pilot/protections/${id}/monitor`);

// ─── Widget ──────────────────────────────────────────────────────────

export function PilotWidget() {
  const [view, setView] = useState<WidgetView>("form");

  // Form — start with nothing selected (position type + stop loss must be chosen)
  const [positionType, setPositionType] = useState<"long" | "short" | null>(null);
  const [positionSize, setPositionSize] = useState(5000);
  const [stopLoss, setStopLoss] = useState<StopLoss | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);

  // Price
  const [refPrice, setRefPrice] = useState<ReferencePrice | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Activation flow (quote-on-click, not auto-quote)
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  // Active position
  const [protectionId, setProtectionId] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<MonitorResponse | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);

  // Closed
  const [closedPnl, setClosedPnl] = useState<number | null>(null);
  const [closedPayout, setClosedPayout] = useState<number | null>(null);
  const [closeReason, setCloseReason] = useState<"breach" | "user" | "expired" | null>(null);

  // Derived
  const tierName = stopLoss ? STOP_LOSS_TO_TIER[stopLoss] : "Pro (Bronze)";
  const drawdownPct = stopLoss ?? 20;
  const currentBtcPrice = livePrice || (refPrice ? Number(refPrice.price) : null);
  const computedPremium = (positionSize / 1000) * PREMIUM_PER_K;
  const payoutOnTrigger = positionSize * (drawdownPct / 100);
  const floorPriceLocal = currentBtcPrice && stopLoss
    ? (positionType === "short" ? currentBtcPrice * (1 + drawdownPct / 100) : currentBtcPrice * (1 - drawdownPct / 100))
    : null;
  const formComplete = positionType !== null && stopLoss !== null;

  // Poll BTC price
  useEffect(() => {
    let on = true;
    const poll = async () => {
      try {
        const d = await fetchRef();
        if (on && d.status === "ok") { setRefPrice(d.reference); setPriceError(null); }
      } catch (e: any) { if (on) setPriceError(e.message); }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { on = false; clearInterval(id); };
  }, []);

  // Poll monitor in active view
  useEffect(() => {
    if (view !== "active" || !protectionId) return;
    let on = true;
    const poll = async () => {
      try {
        const d = await fetchMonitor(protectionId);
        if (!on) return;
        setMonitor(d);
        if (d.currentPrice) setLivePrice(Number(d.currentPrice));
        if (d.protection.status === "triggered") {
          setCloseReason("breach");
          setClosedPayout(Number(d.protection.payoutDueAmount || 0));
          setView("closed");
        } else if (d.protection.status === "expired") {
          setCloseReason("expired");
          setView("closed");
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { on = false; clearInterval(id); };
  }, [view, protectionId]);

  // Poll price in active view
  useEffect(() => {
    if (view !== "active") return;
    let on = true;
    const poll = async () => {
      try { const d = await fetchRef(); if (on && d.status === "ok") setLivePrice(Number(d.reference.price)); } catch {}
    };
    const id = setInterval(poll, 3000);
    return () => { on = false; clearInterval(id); };
  }, [view]);

  // ─── Handlers ──────────────────────────────────────────────────────

  const handleOpenProtected = useCallback(async () => {
    if (!refPrice || !formComplete) return;
    setActivating(true);
    setActivateError(null);
    try {
      const ep = Number(refPrice.price);
      const quoteResult = await fetchQuote({
        protectedNotional: positionSize,
        foxifyExposureNotional: positionSize,
        entryPrice: ep,
        tierName,
        drawdownFloorPct: drawdownPct / 100,
        protectionType: positionType,
      });
      const result = await activateProtection({
        quoteId: quoteResult.quote.quoteId,
        protectedNotional: positionSize,
        foxifyExposureNotional: positionSize,
        entryPrice: ep,
        tierName,
        drawdownFloorPct: drawdownPct / 100,
        autoRenew,
        protectionType: positionType,
      });
      setProtectionId(result.protectionId || result.protection?.id);
      setEntryPrice(ep);
      setLivePrice(ep);
      setView("active");
    } catch (e: any) {
      setActivateError(e.message);
    } finally {
      setActivating(false);
    }
  }, [refPrice, formComplete, positionSize, tierName, drawdownPct, positionType, autoRenew]);

  const handleOpenWithout = () => {
    if (!refPrice || !formComplete) return;
    setEntryPrice(Number(refPrice.price));
    setLivePrice(Number(refPrice.price));
    setProtectionId(null);
    setView("active");
  };

  const handleClose = () => {
    if (entryPrice && livePrice) {
      const pnl = positionType === "long"
        ? ((livePrice - entryPrice) / entryPrice) * positionSize
        : ((entryPrice - livePrice) / entryPrice!) * positionSize;
      setClosedPnl(pnl);
    }
    setCloseReason("user");
    setView("closed");
  };

  const handleReset = () => {
    setView("form");
    setPositionType(null);
    setStopLoss(null);
    setActivateError(null);
    setProtectionId(null);
    setMonitor(null);
    setEntryPrice(null);
    setLivePrice(null);
    setClosedPnl(null);
    setClosedPayout(null);
    setCloseReason(null);
  };

  // PnL
  let currentPnl: number | null = null;
  let currentPnlPct: number | null = null;
  if (entryPrice && livePrice) {
    currentPnl = positionType === "long"
      ? ((livePrice - entryPrice) / entryPrice) * positionSize
      : ((entryPrice - livePrice) / entryPrice) * positionSize;
    currentPnlPct = positionType === "long"
      ? ((livePrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - livePrice) / entryPrice) * 100;
  }

  let distancePct: number | null = null;
  let distanceUsd: number | null = null;
  if (monitor?.distanceToFloor) {
    distancePct = Number(monitor.distanceToFloor.pct);
    distanceUsd = Number(monitor.distanceToFloor.usd);
  }

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 500 }}>
        {/* Header */}
        <div className="title">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <img src={FOXIFY_LOGO} alt="" style={{ width: 24, height: 24, borderRadius: 6 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2 }}>Foxify Protect</span>
          </div>
          {currentBtcPrice && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>BTC</span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(currentBtcPrice)}</span>
              {!priceError && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", display: "inline-block" }} />}
            </div>
          )}
        </div>

        {/* ── FORM ── */}
        {view === "form" && (
          <>
            {/* Long / Short */}
            <div style={{ display: "flex", gap: 0, marginBottom: 14, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
              {(["long", "short"] as const).map((side) => (
                <button key={side} onClick={() => setPositionType(side)} style={{
                  flex: 1, padding: "10px 0", border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                  background: positionType === side
                    ? side === "long" ? "rgba(54,211,141,0.15)" : "rgba(255,107,107,0.15)"
                    : "var(--card-2)",
                  color: positionType === side
                    ? side === "long" ? "var(--success)" : "var(--danger)"
                    : "var(--muted)",
                  transition: "all 0.15s ease",
                }}>
                  {side}
                </button>
              ))}
            </div>

            {/* Position Size stepper */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Position Size</span>
              <div style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button onClick={() => setPositionSize(s => Math.max(POSITION_MIN, s - POSITION_STEP))}
                  disabled={positionSize <= POSITION_MIN}
                  style={{
                    width: 36, height: 36, border: "none", cursor: "pointer",
                    background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: positionSize <= POSITION_MIN ? 0.3 : 1,
                  }}>−</button>
                <div style={{
                  minWidth: 110, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums",
                  background: "var(--bg)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)",
                  userSelect: "none",
                }}>{fmtUsd(positionSize)}</div>
                <button onClick={() => setPositionSize(s => Math.min(POSITION_MAX, s + POSITION_STEP))}
                  disabled={positionSize >= POSITION_MAX}
                  style={{
                    width: 36, height: 36, border: "none", cursor: "pointer",
                    background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: positionSize >= POSITION_MAX ? 0.3 : 1,
                  }}>+</button>
              </div>
            </div>

            {/* Stop Loss */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Stop Loss</span>
              <div style={{ display: "flex", gap: 6 }}>
                {STOP_LOSS_OPTIONS.map((sl) => (
                  <button key={sl} onClick={() => setStopLoss(sl)} style={{
                    padding: "7px 16px", border: "1px solid var(--border)",
                    borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                    background: stopLoss === sl ? "rgba(184,90,28,0.18)" : "var(--card-2)",
                    color: stopLoss === sl ? "var(--accent)" : "var(--text)",
                    borderColor: stopLoss === sl ? "var(--accent-2)" : "var(--border)",
                    transition: "all 0.15s ease",
                  }}>{sl}%</button>
                ))}
              </div>
            </div>

            {/* Protection offer — computed locally, no backend quote needed */}
            <div className="section">
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Protect Your Position</div>

              {activateError && (
                <div style={{
                  color: "var(--danger)", fontSize: 12, marginBottom: 10,
                  padding: "8px 10px", background: "rgba(255,107,107,0.08)",
                  borderRadius: 8, border: "1px solid rgba(255,107,107,0.2)",
                  wordBreak: "break-word",
                }}>
                  {activateError}
                </div>
              )}

              {priceError && (
                <div style={{
                  color: "var(--danger)", fontSize: 12, marginBottom: 10,
                  padding: "8px 10px", background: "rgba(255,107,107,0.08)",
                  borderRadius: 8, border: "1px solid rgba(255,107,107,0.2)",
                }}>
                  Price feed unavailable: {priceError}
                </div>
              )}

              <div style={{
                background: "rgba(54,211,141,0.06)", border: "1px solid rgba(54,211,141,0.18)",
                borderRadius: 12, padding: 14, marginBottom: 12, opacity: formComplete ? 1 : 0.5,
              }}>
                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                  {formComplete ? (
                    <>
                      If your position hits <strong style={{ color: "var(--danger)" }}>{drawdownPct}%</strong> drawdown,
                      you receive <strong style={{ color: "var(--success)" }}>{fmtUsd(payoutOnTrigger)}</strong> instantly.
                    </>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>Select position type and stop loss to see protection details.</span>
                  )}
                </div>
                {formComplete && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
                      <span>Premium</span>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmtUsd(computedPremium)} for {TENOR_DAYS} days</span>
                    </div>
                    {floorPriceLocal && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                        <span>{positionType === "long" ? "Floor Price" : "Ceiling Price"}</span>
                        <span style={{ fontWeight: 500 }}>{fmtUsd(floorPriceLocal)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", marginBottom: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
                Auto-renew protection at expiry
              </label>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleOpenProtected} disabled={!formComplete || activating || !refPrice}
                  style={{
                    flex: 2, padding: "12px 0", borderRadius: 10, border: "none",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff",
                    opacity: (!formComplete || activating || !refPrice) ? 0.5 : 1,
                    transition: "opacity 0.15s ease",
                  }}>
                  {activating ? "Opening..." : "Open + Protect"}
                </button>
                <button onClick={handleOpenWithout} disabled={!formComplete || !refPrice}
                  style={{
                    flex: 1, padding: "12px 0", borderRadius: 10,
                    border: "1px solid var(--border)", background: "var(--card-2)",
                    fontSize: 12, color: "var(--muted)", cursor: "pointer",
                    opacity: (!formComplete || !refPrice) ? 0.5 : 1,
                  }}>
                  Open Without
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── ACTIVE ── */}
        {view === "active" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", color: positionType === "long" ? "var(--success)" : "var(--danger)" }}>
                  {positionType}
                </span>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{fmtUsd(positionSize)}</span>
                <span className="pill pill-small">{drawdownPct}% SL</span>
              </div>
              {protectionId ? (
                <span className="pill" style={{ background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Protected</span>
              ) : (
                <span className="pill" style={{ background: "rgba(255,107,107,0.12)", color: "var(--danger)" }}>Unprotected</span>
              )}
            </div>

            <div className="stats">
              <div className="stat">
                <div className="label">Entry Price</div>
                <div className="value" style={{ fontSize: 14 }}>{entryPrice ? fmtUsd(entryPrice) : "—"}</div>
              </div>
              <div className="stat">
                <div className="label">Live Price</div>
                <div className="value" style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{livePrice ? fmtUsd(livePrice) : "—"}</div>
              </div>
              <div className="stat">
                <div className="label">Current P&L</div>
                <div className="value" style={{ fontSize: 14, color: currentPnl !== null ? (currentPnl >= 0 ? "var(--success)" : "var(--danger)") : "var(--text)" }}>
                  {currentPnl !== null ? `${fmtUsd(currentPnl)} (${fmtPct(currentPnlPct!)})` : "—"}
                </div>
              </div>
              {protectionId && (
                <div className="stat">
                  <div className="label">{positionType === "long" ? "Floor Price" : "Ceiling Price"}</div>
                  <div className="value" style={{ fontSize: 14 }}>
                    {monitor?.protection?.floorPrice ? fmtUsd(Number(monitor.protection.floorPrice)) : floorPriceLocal ? fmtUsd(floorPriceLocal) : "—"}
                  </div>
                </div>
              )}
            </div>

            {protectionId && distancePct !== null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 12, padding: "0 2px" }}>
                <span>Distance to {positionType === "long" ? "floor" : "ceiling"}</span>
                <span style={{ fontWeight: 500, color: distancePct < 5 ? "var(--danger)" : "var(--text)" }}>
                  {distancePct.toFixed(2)}% ({distanceUsd !== null ? fmtUsd(distanceUsd) : "—"})
                </span>
              </div>
            )}

            {protectionId && monitor && (
              <div style={{ background: "rgba(54,211,141,0.04)", border: "1px solid rgba(54,211,141,0.12)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: "var(--success)" }}>Protection Active</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" }}>
                  {monitor.timeRemaining && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Time remaining</span>
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>{fmtTimeRemaining(monitor.timeRemaining.ms)}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Premium paid</span>
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>{fmtUsd(Number(monitor.protection.premium || 0))}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Payout if triggered</span>
                    <span style={{ fontWeight: 500, color: "var(--success)" }}>{fmtUsd(payoutOnTrigger)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Auto-renew</span>
                    <span style={{ fontWeight: 500, color: autoRenew ? "var(--success)" : "var(--muted)" }}>{autoRenew ? "On" : "Off"}</span>
                  </div>
                </div>
              </div>
            )}

            <button onClick={handleClose} style={{
              width: "100%", padding: "12px 0", borderRadius: 10,
              border: "1px solid var(--border)", background: "var(--card-2)",
              fontSize: 13, fontWeight: 500, color: "var(--text)", cursor: "pointer",
            }}>Close Position</button>
          </>
        )}

        {/* ── CLOSED ── */}
        {view === "closed" && (
          <>
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              {closeReason === "breach" && (
                <>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>&#10003;</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--success)", marginBottom: 6 }}>Position Closed — Protection Paid</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--success)", marginBottom: 16 }}>{closedPayout !== null ? fmtUsd(closedPayout) : "—"}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Your {positionType} position hit the {drawdownPct}% stop loss. Protection payout has been credited.</div>
                </>
              )}
              {closeReason === "user" && (
                <>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Position Closed</div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 16, color: closedPnl !== null ? (closedPnl >= 0 ? "var(--success)" : "var(--danger)") : "var(--text)" }}>
                    P&L: {closedPnl !== null ? fmtUsd(closedPnl) : "—"}
                  </div>
                </>
              )}
              {closeReason === "expired" && (
                <>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--danger)", marginBottom: 6 }}>Protection Expired</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>Your protection period has ended.</div>
                </>
              )}
            </div>
            <button onClick={handleReset} style={{
              width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
              fontSize: 14, fontWeight: 600, cursor: "pointer",
              background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff",
            }}>Open New Position</button>
          </>
        )}

        <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "var(--muted)", opacity: 0.5 }}>
          Protection provided by Atticus Strategy, Ltd. &copy; 2026
        </div>
      </div>
    </div>
  );
}
