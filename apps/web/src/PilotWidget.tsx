import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type ReferencePrice = { price: string; marketId: string; venue: string; source: string; timestamp: string; ageMs: number };

type QuoteResponse = {
  status: string; protectionType: string; tierName: string; drawdownFloorPct: string;
  triggerPrice: string; floorPrice: string;
  quote: { quoteId: string; instrumentId: string; premium: number; expiresAt: string; side: string; quantity: number; venue: string; details?: Record<string, unknown> };
  entrySnapshot: { price: string; marketId: string; source: string; timestamp: string };
};

type ProtectionRecord = {
  id: string; status: string; tierName: string; protectedNotional: string; entryPrice: string;
  floorPrice: string; drawdownFloorPct: string; expiryAt: string; premium: string; autoRenew: boolean;
  payoutDueAmount: string | null; payoutSettledAmount: string | null; venue: string; instrumentId: string;
  createdAt: string; metadata?: Record<string, unknown>;
};

type MonitorResponse = {
  status: string; protection?: ProtectionRecord; currentPrice?: string;
  distanceToFloor?: { pct: string; usd: string; direction: string };
  timeRemaining?: { ms: number; human: string };
};

type Position = {
  id: string;
  type: "long" | "short";
  size: number;
  stopLoss: number;
  entryPrice: number;
  protectionId: string | null;
  autoRenew: boolean;
  premium: number;
  status: "active" | "closed" | "triggered";
  closedPnl: number | null;
  closedPayout: number | null;
};

// ─── Config ──────────────────────────────────────────────────────────

const STOP_LOSS_OPTIONS = [20, 15, 12] as const;
type StopLoss = (typeof STOP_LOSS_OPTIONS)[number];
const STOP_LOSS_TO_TIER: Record<StopLoss, string> = { 20: "Pro (Bronze)", 15: "Pro (Silver)", 12: "Pro (Gold)" };
const POSITION_MIN = 5000;
const POSITION_MAX = 50000;
const POSITION_STEP = 5000;
const PREMIUM_PER_K = 11;
const TENOR_DAYS = 5;
const INITIAL_BALANCE = 1_000_000;
const BALANCE_KEY = "foxify_pilot_balance";
const SETTLEMENT_KEY = "foxify_pilot_settlement";
const POSITIONS_KEY = "foxify_pilot_positions";
const FOXIFY_LOGO = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";

// ─── Helpers ─────────────────────────────────────────────────────────

const fmtUsd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtTime = (ms: number): string => {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
};

// ─── API ─────────────────────────────────────────────────────────────

const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { "Content-Type": "application/json", ...opts?.headers } });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.reason || json?.message || `HTTP ${res.status}`);
  return json as T;
};
const fetchRef = () => api<{ status: string; reference: ReferencePrice }>("/pilot/reference-price");
const fetchQuote = (body: Record<string, unknown>) => api<QuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify(body) });
const activateProtection = (body: Record<string, unknown>) => api<{ status: string; protectionId: string; protection: ProtectionRecord }>("/pilot/protections/activate", { method: "POST", body: JSON.stringify(body) });
const fetchMonitor = (id: string) => api<MonitorResponse>(`/pilot/protections/${id}/monitor`);

// ─── Persistence ─────────────────────────────────────────────────────

type Settlement = { totalPremiums: number; totalPayouts: number };

const load = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };

// ─── Widget ──────────────────────────────────────────────────────────

export function PilotWidget() {
  // Form
  const [positionType, setPositionType] = useState<"long" | "short" | null>(null);
  const [positionSize, setPositionSize] = useState(5000);
  const [stopLoss, setStopLoss] = useState<StopLoss | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [formCollapsed, setFormCollapsed] = useState(false);

  // Price
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState(0);

  // Positions (persisted)
  const [positions, setPositions] = useState<Position[]>(() => load(POSITIONS_KEY, []));
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  // Balance & settlement (persisted)
  const [balance, setBalance] = useState(() => load(BALANCE_KEY, INITIAL_BALANCE) as number);
  const [settlement, setSettlement] = useState<Settlement>(() => load(SETTLEMENT_KEY, { totalPremiums: 0, totalPayouts: 0 }));

  // Monitor cache
  const [monitors, setMonitors] = useState<Record<string, MonitorResponse>>({});

  const posIdCounter = useRef(0);

  // Persist on change
  useEffect(() => { save(POSITIONS_KEY, positions); }, [positions]);
  useEffect(() => { save(BALANCE_KEY, balance); }, [balance]);
  useEffect(() => { save(SETTLEMENT_KEY, settlement); }, [settlement]);

  // Derived
  const tierName = stopLoss ? STOP_LOSS_TO_TIER[stopLoss] : "Pro (Bronze)";
  const drawdownPct = stopLoss ?? 20;
  const computedPremium = (positionSize / 1000) * PREMIUM_PER_K;
  const payoutOnTrigger = positionSize * (drawdownPct / 100);
  const floorPriceLocal = livePrice && stopLoss
    ? (positionType === "short" ? livePrice * (1 + drawdownPct / 100) : livePrice * (1 - drawdownPct / 100))
    : null;
  const formComplete = positionType !== null && stopLoss !== null;
  const activePositions = positions.filter(p => p.status === "active");
  const closedPositions = positions.filter(p => p.status === "closed" || p.status === "triggered");

  const unrealizedPnl = activePositions.reduce((sum, p) => {
    if (!livePrice) return sum;
    const pnl = p.type === "long"
      ? ((livePrice - p.entryPrice) / p.entryPrice) * p.size
      : ((p.entryPrice - livePrice) / p.entryPrice) * p.size;
    return sum + pnl;
  }, 0);

  // Poll BTC price every 3s
  useEffect(() => {
    let on = true;
    const poll = async () => {
      try {
        const d = await fetchRef();
        if (on && d.status === "ok") {
          const p = Number(d.reference.price);
          setLivePrice(p);
          setPriceUpdatedAt(Date.now());
          setPriceError(null);
        }
      } catch (e: any) { if (on) setPriceError(e.message); }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { on = false; clearInterval(id); };
  }, []);

  // Poll monitors for active protected positions every 5s
  useEffect(() => {
    const protectedActive = activePositions.filter(p => p.protectionId);
    if (!protectedActive.length) return;
    let on = true;
    const poll = async () => {
      for (const pos of protectedActive) {
        if (!on || !pos.protectionId) continue;
        try {
          const d = await fetchMonitor(pos.protectionId);
          if (!on) return;
          setMonitors(prev => ({ ...prev, [pos.id]: d }));
          if (d.protection?.status === "triggered") {
            const payout = Number(d.protection.payoutDueAmount || 0);
            setPositions(prev => prev.map(p => p.id === pos.id ? { ...p, status: "triggered" as const, closedPayout: payout } : p));
            setBalance(b => { const nb = b + payout; save(BALANCE_KEY, nb); return nb; });
            setSettlement(s => { const ns = { ...s, totalPayouts: s.totalPayouts + payout }; save(SETTLEMENT_KEY, ns); return ns; });
          }
        } catch {}
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { on = false; clearInterval(id); };
  }, [activePositions.map(p => p.id + (p.protectionId || "")).join(",")]);

  // Auto-collapse form when there are active positions
  useEffect(() => {
    if (activePositions.length > 0 && !formCollapsed) setFormCollapsed(false);
  }, [activePositions.length]);

  // ─── Handlers ──────────────────────────────────────────────────────

  const handleOpenProtected = useCallback(async () => {
    if (!livePrice || !formComplete || !positionType || !stopLoss) return;
    setActivating(true);
    setActivateError(null);
    try {
      const ep = livePrice;
      const premium = (positionSize / 1000) * PREMIUM_PER_K;
      const quoteResult = await fetchQuote({
        protectedNotional: positionSize, foxifyExposureNotional: positionSize,
        entryPrice: ep, tierName, drawdownFloorPct: drawdownPct / 100, protectionType: positionType,
      });
      const result = await activateProtection({
        quoteId: quoteResult.quote.quoteId, protectedNotional: positionSize,
        foxifyExposureNotional: positionSize, entryPrice: ep, tierName,
        drawdownFloorPct: drawdownPct / 100, autoRenew, protectionType: positionType,
      });
      const pid = result.protectionId || result.protection?.id || null;
      const newPos: Position = {
        id: `pos_${++posIdCounter.current}_${Date.now()}`, type: positionType, size: positionSize,
        stopLoss: drawdownPct, entryPrice: ep, protectionId: pid, autoRenew, premium,
        status: "active", closedPnl: null, closedPayout: null,
      };
      setPositions(prev => [...prev, newPos]);
      setBalance(b => { const nb = b - premium; save(BALANCE_KEY, nb); return nb; });
      setSettlement(s => { const ns = { ...s, totalPremiums: s.totalPremiums + premium }; save(SETTLEMENT_KEY, ns); return ns; });
      setPositionType(null);
      setStopLoss(null);
      setFormCollapsed(true);
    } catch (e: any) {
      setActivateError(e.message);
    } finally {
      setActivating(false);
    }
  }, [livePrice, formComplete, positionSize, tierName, drawdownPct, positionType, autoRenew]);

  const handleOpenWithout = () => {
    if (!livePrice || !formComplete || !positionType || !stopLoss) return;
    const newPos: Position = {
      id: `pos_${++posIdCounter.current}_${Date.now()}`, type: positionType, size: positionSize,
      stopLoss: drawdownPct, entryPrice: livePrice, protectionId: null, autoRenew: false, premium: 0,
      status: "active", closedPnl: null, closedPayout: null,
    };
    setPositions(prev => [...prev, newPos]);
    setPositionType(null);
    setStopLoss(null);
    setFormCollapsed(true);
  };

  const handleClose = (posId: string) => {
    setPositions(prev => prev.map(p => {
      if (p.id !== posId || p.status !== "active") return p;
      const price = livePrice || p.entryPrice;
      const pnl = p.type === "long"
        ? ((price - p.entryPrice) / p.entryPrice) * p.size
        : ((p.entryPrice - price) / p.entryPrice) * p.size;
      return { ...p, status: "closed" as const, closedPnl: pnl };
    }));
  };

  const handleDismissClosed = (posId: string) => {
    setPositions(prev => prev.filter(p => p.id !== posId));
  };

  // Price pulse animation
  const isPriceFresh = Date.now() - priceUpdatedAt < 1500;

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 500 }}>
        {/* Header */}
        <div className="title">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <img src={FOXIFY_LOGO} alt="" style={{ width: 24, height: 24, borderRadius: 6 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2 }}>Foxify Perp Protect</span>
          </div>
          {livePrice && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>BTC</span>
              <span style={{
                fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                transition: "color 0.3s ease",
                color: isPriceFresh ? "var(--text)" : "var(--muted)",
              }}>{fmtUsd(livePrice)}</span>
              {!priceError && (
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", display: "inline-block",
                  background: isPriceFresh ? "var(--success)" : "var(--muted)",
                  transition: "background 0.3s ease",
                }} />
              )}
            </div>
          )}
        </div>

        {/* Balance */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 12px", marginBottom: 14, borderRadius: 8,
          background: "var(--card-2)", border: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Account Balance</span>
          <span style={{
            fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums",
            color: (balance + unrealizedPnl) >= INITIAL_BALANCE ? "var(--success)" : "var(--text)",
          }}>
            {fmtUsd(balance + unrealizedPnl)}
          </span>
        </div>

        {/* ── FORM (collapsible) ── */}
        <div style={{ marginBottom: activePositions.length > 0 ? 0 : undefined }}>
          <button onClick={() => setFormCollapsed(c => !c)} style={{
            width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 0", border: "none", background: "none", cursor: "pointer", color: "var(--text)",
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>New Position</span>
            <span style={{ fontSize: 12, color: "var(--muted)", transition: "transform 0.2s ease", transform: formCollapsed ? "rotate(0deg)" : "rotate(180deg)" }}>▼</span>
          </button>

          {!formCollapsed && (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {(["long", "short"] as const).map((side) => (
                  <button key={side} onClick={() => setPositionType(side)} style={{
                    flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer",
                    fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                    border: positionType === side
                      ? side === "long" ? "1.5px solid var(--success)" : "1.5px solid var(--danger)"
                      : "1px solid var(--border)",
                    background: positionType === side
                      ? side === "long" ? "rgba(54,211,141,0.15)" : "rgba(255,107,107,0.15)"
                      : "var(--card-2)",
                    color: positionType === side ? side === "long" ? "var(--success)" : "var(--danger)" : "var(--muted)",
                    transition: "all 0.15s ease",
                  }}>{side}</button>
                ))}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Position Size</span>
                <div style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                  <button onClick={() => setPositionSize(s => Math.max(POSITION_MIN, s - POSITION_STEP))} disabled={positionSize <= POSITION_MIN}
                    style={{ width: 36, height: 36, border: "none", cursor: "pointer", background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", opacity: positionSize <= POSITION_MIN ? 0.3 : 1 }}>−</button>
                  <div style={{ minWidth: 110, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", background: "var(--bg)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", userSelect: "none" }}>{fmtUsd(positionSize)}</div>
                  <button onClick={() => setPositionSize(s => Math.min(POSITION_MAX, s + POSITION_STEP))} disabled={positionSize >= POSITION_MAX}
                    style={{ width: 36, height: 36, border: "none", cursor: "pointer", background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", opacity: positionSize >= POSITION_MAX ? 0.3 : 1 }}>+</button>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Stop Loss</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {STOP_LOSS_OPTIONS.map((sl) => (
                    <button key={sl} onClick={() => setStopLoss(sl)} style={{
                      padding: "7px 16px", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                      background: stopLoss === sl ? "rgba(184,90,28,0.18)" : "var(--card-2)",
                      color: stopLoss === sl ? "var(--accent)" : "var(--text)",
                      borderColor: stopLoss === sl ? "var(--accent-2)" : "var(--border)", transition: "all 0.15s ease",
                    }}>{sl}%</button>
                  ))}
                </div>
              </div>

              <div className="section" style={{ marginTop: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Protect Your Position</div>

                {activateError && (
                  <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10, padding: "8px 10px", background: "rgba(255,107,107,0.08)", borderRadius: 8, border: "1px solid rgba(255,107,107,0.2)", wordBreak: "break-word" }}>
                    {activateError}
                  </div>
                )}

                <div style={{ background: "rgba(54,211,141,0.06)", border: "1px solid rgba(54,211,141,0.18)", borderRadius: 12, padding: 14, marginBottom: 12, opacity: formComplete ? 1 : 0.5 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                    {formComplete ? (
                      <>If your position hits <strong style={{ color: "var(--danger)" }}>{drawdownPct}%</strong> drawdown, you receive <strong style={{ color: "var(--success)" }}>{fmtUsd(payoutOnTrigger)}</strong> instantly.</>
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
                  <button onClick={handleOpenProtected} disabled={!formComplete || activating || !livePrice}
                    style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", opacity: (!formComplete || activating || !livePrice) ? 0.5 : 1, transition: "opacity 0.15s ease" }}>
                    {activating ? "Opening..." : "Open + Protect"}
                  </button>
                  <button onClick={handleOpenWithout} disabled={!formComplete || !livePrice}
                    style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-2)", fontSize: 12, color: "var(--muted)", cursor: "pointer", opacity: (!formComplete || !livePrice) ? 0.5 : 1 }}>
                    Open Without
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── ACTIVE POSITIONS ── */}
        {activePositions.length > 0 && (
          <div className="section">
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
              Active Positions ({activePositions.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activePositions.map(pos => {
                const mon = monitors[pos.id];
                const pnl = livePrice
                  ? (pos.type === "long"
                    ? ((livePrice - pos.entryPrice) / pos.entryPrice) * pos.size
                    : ((pos.entryPrice - livePrice) / pos.entryPrice) * pos.size)
                  : null;
                const pnlPct = livePrice
                  ? (pos.type === "long"
                    ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100
                    : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100)
                  : null;
                const floorPrice = pos.type === "long"
                  ? pos.entryPrice * (1 - pos.stopLoss / 100)
                  : pos.entryPrice * (1 + pos.stopLoss / 100);

                return (
                  <div key={pos.id} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-2)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: pos.type === "long" ? "var(--success)" : "var(--danger)" }}>{pos.type}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtUsd(pos.size)}</span>
                        <span style={{ fontSize: 10, color: "var(--muted)" }}>{pos.stopLoss}% SL</span>
                      </div>
                      {pos.protectionId ? (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Protected</span>
                      ) : (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(255,107,107,0.12)", color: "var(--danger)" }}>Unprotected</span>
                      )}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      <span>Entry {fmtUsd(pos.entryPrice)}</span>
                      {pnl !== null && (
                        <span style={{ fontWeight: 600, color: pnl >= 0 ? "var(--success)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
                          {fmtUsd(pnl)} ({fmtPct(pnlPct!)})
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                      <span>{pos.type === "long" ? "Floor" : "Ceiling"}: {fmtUsd(floorPrice)}</span>
                      {pos.protectionId && mon?.timeRemaining && (
                        <span>{fmtTime(mon.timeRemaining.ms)} left</span>
                      )}
                      {pos.premium > 0 && <span>Premium: {fmtUsd(pos.premium)}</span>}
                    </div>
                    <button onClick={() => handleClose(pos.id)} style={{
                      width: "100%", padding: "6px 0", borderRadius: 6, border: "1px solid var(--border)",
                      background: "transparent", fontSize: 11, color: "var(--muted)", cursor: "pointer",
                    }}>Close Position</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── CLOSED POSITIONS ── */}
        {closedPositions.length > 0 && (
          <div className="section">
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--muted)" }}>Recently Closed</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {closedPositions.slice(-5).map(pos => (
                <div key={pos.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 10px", borderRadius: 8, background: "var(--card-2)", border: "1px solid var(--border)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: pos.type === "long" ? "var(--success)" : "var(--danger)" }}>{pos.type}</span>
                    <span style={{ fontSize: 12 }}>{fmtUsd(pos.size)}</span>
                    {pos.status === "triggered" && (
                      <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 999, background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Payout: {fmtUsd(pos.closedPayout || 0)}</span>
                    )}
                    {pos.status === "closed" && pos.closedPnl !== null && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: pos.closedPnl >= 0 ? "var(--success)" : "var(--danger)" }}>
                        P&L: {fmtUsd(pos.closedPnl)}
                      </span>
                    )}
                  </div>
                  <button onClick={() => handleDismissClosed(pos.id)} style={{
                    border: "none", background: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: "0 4px",
                  }}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SETTLEMENT SUMMARY ── */}
        {(settlement.totalPremiums > 0 || settlement.totalPayouts > 0) && (
          <div className="section">
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Pilot Settlement</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Premiums owed</span>
                <span style={{ fontWeight: 500, color: "var(--text)" }}>{fmtUsd(settlement.totalPremiums)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Payouts earned</span>
                <span style={{ fontWeight: 500, color: settlement.totalPayouts > 0 ? "var(--success)" : "var(--text)" }}>{fmtUsd(settlement.totalPayouts)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 2 }}>
                <span style={{ fontWeight: 600 }}>Net</span>
                <span style={{ fontWeight: 700, color: settlement.totalPayouts - settlement.totalPremiums >= 0 ? "var(--success)" : "var(--danger)" }}>
                  {fmtUsd(settlement.totalPayouts - settlement.totalPremiums)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "var(--muted)", opacity: 0.5 }}>
          Protection provided by Atticus Strategy, Ltd. &copy; 2026
        </div>
      </div>
    </div>
  );
}
