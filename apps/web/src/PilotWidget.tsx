import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type FundedLevel = {
  name: string;
  deposit_usdc: string;
  funding_usdc: string;
  drawdown_limit_pct: string;
  fixed_price_usdc: string;
  expiry_days: string;
};

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

// ─── Stop-loss driven tiers ──────────────────────────────────────────

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

// ─── Formatting helpers ──────────────────────────────────────────────

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtBtcPrice = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const fmtTimeRemaining = (ms: number): string => {
  if (ms <= 0) return "Expired";
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHrs = hours % 24;
    return `${days}d ${remHrs}h`;
  }
  return `${hours}h ${mins}m`;
};

const fmtCompact = (v: number) => {
  if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
  return `$${v}`;
};

// ─── API helpers ─────────────────────────────────────────────────────

const api = async <T = unknown>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.reason || json?.message || `HTTP ${res.status}`);
  return json as T;
};

const fetchReferencePrice = () =>
  api<{ status: string; reference: ReferencePrice }>("/pilot/reference-price");

const fetchQuote = (body: {
  protectedNotional: number;
  foxifyExposureNotional: number;
  entryPrice?: number;
  tierName: string;
  drawdownFloorPct: number;
  protectionType: "long" | "short";
}) => api<QuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify(body) });

const activateProtection = (body: {
  quoteId: string;
  protectedNotional: number;
  foxifyExposureNotional: number;
  entryPrice: number;
  tierName: string;
  drawdownFloorPct: number;
  autoRenew: boolean;
  protectionType: "long" | "short";
}) =>
  api<{ status: string; protectionId: string; protection: ProtectionRecord }>(
    "/pilot/protections/activate",
    { method: "POST", body: JSON.stringify(body) }
  );

const fetchProtection = (id: string) =>
  api<MonitorResponse>(`/pilot/protections/${id}/monitor`);

// ─── Quote countdown ────────────────────────────────────────────────

function useQuoteCountdown(expiresAt: string | null) {
  const [remaining, setRemaining] = useState<number>(0);
  useEffect(() => {
    if (!expiresAt) { setRemaining(0); return; }
    const tick = () => {
      const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setRemaining(ms);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return remaining;
}

// ─── Foxify logo SVG (inline, small) ─────────────────────────────────

const FOXIFY_LOGO = "https://foxify.trade/favicon.ico";

// ─── Main widget ─────────────────────────────────────────────────────

export function PilotWidget() {
  const [view, setView] = useState<WidgetView>("form");
  const [levels, setLevels] = useState<FundedLevel[]>([]);

  // Form state
  const [positionType, setPositionType] = useState<"long" | "short">("long");
  const [positionSize, setPositionSize] = useState<number>(5000);
  const [stopLoss, setStopLoss] = useState<StopLoss>(20);
  const [autoRenew, setAutoRenew] = useState(false);

  // Reference price polling
  const [refPrice, setRefPrice] = useState<ReferencePrice | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Quote state
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quoteExpiresAt = quote?.quote?.expiresAt ?? null;
  const quoteRemaining = useQuoteCountdown(quoteExpiresAt);

  // Activation state
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  // Active protection state
  const [protectionId, setProtectionId] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<MonitorResponse | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);

  // Closed state
  const [closedPnl, setClosedPnl] = useState<number | null>(null);
  const [closedPayout, setClosedPayout] = useState<number | null>(null);
  const [closeReason, setCloseReason] = useState<"breach" | "user" | "expired" | null>(null);

  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Computed from stop loss
  const tierName = STOP_LOSS_TO_TIER[stopLoss] || "Pro (Bronze)";
  const drawdownPct = stopLoss;
  const premiumPerK = 11;
  const tenorDays = 5;

  // Load funded levels (for future dynamic config)
  useEffect(() => {
    fetch("/funded_levels.json")
      .then((r) => r.json())
      .then((data) => { if (data?.levels) setLevels(data.levels); })
      .catch(() => {});
  }, []);

  const levelConfig = levels.find((l) => l.name === tierName);
  const premiumPerKFromConfig = levelConfig ? Number(levelConfig.fixed_price_usdc) : premiumPerK;
  const tenorDaysFromConfig = levelConfig ? Number(levelConfig.expiry_days) : tenorDays;

  // Poll reference price
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await fetchReferencePrice();
        if (active && data.status === "ok") {
          setRefPrice(data.reference);
          setPriceError(null);
        }
      } catch (e: any) {
        if (active) setPriceError(e.message);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Auto-quote when form inputs change
  const requestQuote = useCallback(async () => {
    if (!refPrice) return;
    setQuoteLoading(true);
    setQuoteError(null);
    setActivateError(null);
    try {
      const result = await fetchQuote({
        protectedNotional: positionSize,
        foxifyExposureNotional: positionSize,
        entryPrice: Number(refPrice.price),
        tierName,
        drawdownFloorPct: drawdownPct / 100,
        protectionType: positionType,
      });
      setQuote(result);
    } catch (e: any) {
      setQuoteError(e.message);
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [refPrice, positionSize, tierName, drawdownPct, positionType]);

  useEffect(() => {
    if (view !== "form" || !refPrice) return;
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    quoteTimerRef.current = setTimeout(requestQuote, 400);
    return () => { if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current); };
  }, [view, refPrice, positionSize, positionType, stopLoss, requestQuote]);

  // Re-quote when TTL expires
  useEffect(() => {
    if (view !== "form" || !quote || quoteRemaining > 0) return;
    const id = setTimeout(requestQuote, 500);
    return () => clearTimeout(id);
  }, [view, quote, quoteRemaining, requestQuote]);

  // Poll active protection monitor
  useEffect(() => {
    if (view !== "active" || !protectionId) return;
    let active = true;
    const poll = async () => {
      try {
        const data = await fetchProtection(protectionId);
        if (!active) return;
        setMonitor(data);
        if (data.currentPrice) setLivePrice(Number(data.currentPrice));
        if (data.protection.status === "triggered") {
          setCloseReason("breach");
          setClosedPayout(Number(data.protection.payoutDueAmount || 0));
          setView("closed");
        } else if (data.protection.status === "expired") {
          setCloseReason("expired");
          setView("closed");
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { active = false; clearInterval(id); };
  }, [view, protectionId]);

  useEffect(() => {
    if (view !== "active") return;
    let active = true;
    const poll = async () => {
      try {
        const data = await fetchReferencePrice();
        if (active && data.status === "ok") setLivePrice(Number(data.reference.price));
      } catch {}
    };
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, [view]);

  // ─── Handlers ────────────────────────────────────────────────────

  const handleActivate = async () => {
    if (!quote || !refPrice) return;
    if (quoteRemaining <= 0) {
      await requestQuote();
      return;
    }
    setActivating(true);
    setActivateError(null);
    try {
      const ep = Number(quote.entrySnapshot.price);
      const result = await activateProtection({
        quoteId: quote.quote.quoteId,
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
  };

  const handleOpenWithout = () => {
    if (!refPrice) return;
    const ep = Number(refPrice.price);
    setEntryPrice(ep);
    setLivePrice(ep);
    setProtectionId(null);
    setView("active");
  };

  const handleClose = () => {
    if (entryPrice && livePrice) {
      const pnl = positionType === "long"
        ? ((livePrice - entryPrice) / entryPrice) * positionSize
        : ((entryPrice - livePrice) / entryPrice) * positionSize;
      setClosedPnl(pnl);
    }
    setCloseReason("user");
    setView("closed");
  };

  const handleReset = () => {
    setView("form");
    setQuote(null);
    setQuoteError(null);
    setActivateError(null);
    setProtectionId(null);
    setMonitor(null);
    setEntryPrice(null);
    setLivePrice(null);
    setClosedPnl(null);
    setClosedPayout(null);
    setCloseReason(null);
  };

  // ─── Computed display values ─────────────────────────────────────

  const currentBtcPrice = livePrice || (refPrice ? Number(refPrice.price) : null);
  const computedPremium = (positionSize / 1000) * premiumPerKFromConfig;
  const triggerPriceNum = quote ? Number(quote.triggerPrice) : null;
  const payoutOnTrigger = positionSize * (drawdownPct / 100);

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
  } else if (triggerPriceNum && livePrice) {
    distanceUsd = Math.abs(livePrice - triggerPriceNum);
    distancePct = (distanceUsd / livePrice) * 100;
  }

  const canActivate = !!quote && !activating && quoteRemaining > 0;
  const buttonLabel = activating
    ? "Opening..."
    : !quote && quoteLoading
      ? "Getting quote..."
      : quoteRemaining <= 0 && quote
        ? "Refresh Quote"
        : "Open + Protect";

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 500 }}>
        {/* Header */}
        <div className="title">
          <div className="brand" style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <img
              src={FOXIFY_LOGO}
              alt="Foxify"
              style={{ width: 20, height: 20, borderRadius: 4 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Foxify Protect</span>
          </div>
          {currentBtcPrice && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>BTC</span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {fmtBtcPrice(currentBtcPrice)}
              </span>
              {!priceError && (
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", display: "inline-block" }} />
              )}
            </div>
          )}
        </div>

        {/* ── STATE 1: Open Position Form ── */}
        {view === "form" && (
          <>
            {/* Position type toggle */}
            <div style={{ display: "flex", gap: 0, marginBottom: 14, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
              {(["long", "short"] as const).map((side) => (
                <button
                  key={side}
                  onClick={() => setPositionType(side)}
                  style={{
                    flex: 1, padding: "10px 0", border: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                    background: positionType === side
                      ? side === "long" ? "rgba(54, 211, 141, 0.15)" : "rgba(255, 107, 107, 0.15)"
                      : "var(--card-2)",
                    color: positionType === side
                      ? side === "long" ? "var(--success)" : "var(--danger)"
                      : "var(--muted)",
                    transition: "all 0.15s ease",
                  }}
                >
                  {side}
                </button>
              ))}
            </div>

            {/* Position size -- stepper */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Position Size</span>
              <div style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button
                  onClick={() => setPositionSize((s) => Math.max(POSITION_MIN, s - POSITION_STEP))}
                  disabled={positionSize <= POSITION_MIN}
                  style={{
                    width: 36, height: 36, border: "none", cursor: "pointer",
                    background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: positionSize <= POSITION_MIN ? 0.3 : 1,
                    transition: "opacity 0.1s ease",
                  }}
                >
                  −
                </button>
                <div
                  style={{
                    minWidth: 110, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 15, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums",
                    background: "var(--bg)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)",
                    userSelect: "none",
                  }}
                >
                  {fmtUsd(positionSize)}
                </div>
                <button
                  onClick={() => setPositionSize((s) => Math.min(POSITION_MAX, s + POSITION_STEP))}
                  disabled={positionSize >= POSITION_MAX}
                  style={{
                    width: 36, height: 36, border: "none", cursor: "pointer",
                    background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: positionSize >= POSITION_MAX ? 0.3 : 1,
                    transition: "opacity 0.1s ease",
                  }}
                >
                  +
                </button>
              </div>
            </div>

            {/* Stop loss -- label left, buttons right */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Stop Loss</span>
              <div style={{ display: "flex", gap: 6 }}>
                {STOP_LOSS_OPTIONS.map((sl) => (
                  <button
                    key={sl}
                    onClick={() => setStopLoss(sl)}
                    style={{
                      padding: "7px 16px", border: "1px solid var(--border)",
                      borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                      background: stopLoss === sl ? "rgba(184,90,28,0.18)" : "var(--card-2)",
                      color: stopLoss === sl ? "var(--accent)" : "var(--text)",
                      borderColor: stopLoss === sl ? "var(--accent-2)" : "var(--border)",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {sl}%
                  </button>
                ))}
              </div>
            </div>

            {/* ── Protection Offer ── */}
            <div className="section">
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
                Protect Your Position
              </div>

              {quoteError && (
                <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10 }}>
                  {quoteError}
                  <button
                    onClick={requestQuote}
                    style={{
                      marginLeft: 8, fontSize: 11, color: "var(--accent)", background: "none",
                      border: "none", cursor: "pointer", textDecoration: "underline",
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}

              <div
                style={{
                  background: "rgba(54, 211, 141, 0.06)",
                  border: "1px solid rgba(54, 211, 141, 0.18)",
                  borderRadius: 12, padding: 14, marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 8 }}>
                  If your position hits{" "}
                  <strong style={{ color: "var(--danger)" }}>{drawdownPct}%</strong>{" "}
                  drawdown, you receive{" "}
                  <strong style={{ color: "var(--success)" }}>{fmtUsd(payoutOnTrigger)}</strong>{" "}
                  instantly.
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
                  <span>Premium</span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {fmtUsd(computedPremium)} for {tenorDaysFromConfig} days
                  </span>
                </div>

                {triggerPriceNum && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                    <span>{positionType === "long" ? "Floor Price" : "Ceiling Price"}</span>
                    <span style={{ fontWeight: 500 }}>{fmtBtcPrice(triggerPriceNum)}</span>
                  </div>
                )}

                {quote && quoteRemaining > 0 && (
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, textAlign: "right" }}>
                    Quote valid for {Math.ceil(quoteRemaining / 1000)}s
                  </div>
                )}

                {quoteLoading && !quote && (
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, textAlign: "right" }}>
                    Getting live quote...
                  </div>
                )}
              </div>

              {/* Auto-renew */}
              <label
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  fontSize: 12, color: "var(--muted)", marginBottom: 14, cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoRenew}
                  onChange={(e) => setAutoRenew(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                Auto-renew protection at expiry
              </label>

              {activateError && (
                <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10 }}>
                  {activateError}
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleActivate}
                  disabled={!canActivate && buttonLabel !== "Refresh Quote"}
                  style={{
                    flex: 2, padding: "12px 0", borderRadius: 10, border: "none",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                    color: "#fff",
                    opacity: (!canActivate && buttonLabel !== "Refresh Quote") ? 0.5 : 1,
                    transition: "opacity 0.15s ease",
                  }}
                >
                  {buttonLabel}
                </button>
                <button
                  onClick={handleOpenWithout}
                  disabled={!refPrice}
                  style={{
                    flex: 1, padding: "12px 0", borderRadius: 10,
                    border: "1px solid var(--border)", background: "var(--card-2)",
                    fontSize: 12, color: "var(--muted)", cursor: "pointer",
                    transition: "opacity 0.15s ease",
                    opacity: !refPrice ? 0.5 : 1,
                  }}
                >
                  Open Without
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── STATE 2: Active Position View ── */}
        {view === "active" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 12, fontWeight: 600, textTransform: "uppercase",
                    color: positionType === "long" ? "var(--success)" : "var(--danger)",
                  }}
                >
                  {positionType}
                </span>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{fmtUsd(positionSize)}</span>
                <span className="pill pill-small">{stopLoss}% SL</span>
              </div>
              {protectionId ? (
                <span className="pill" style={{ background: "rgba(54, 211, 141, 0.12)", color: "var(--success)" }}>
                  Protected
                </span>
              ) : (
                <span className="pill" style={{ background: "rgba(255, 107, 107, 0.12)", color: "var(--danger)" }}>
                  Unprotected
                </span>
              )}
            </div>

            <div className="stats">
              <div className="stat">
                <div className="label">Entry Price</div>
                <div className="value" style={{ fontSize: 14 }}>
                  {entryPrice ? fmtBtcPrice(entryPrice) : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="label">Live Price</div>
                <div className="value" style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                  {livePrice ? fmtBtcPrice(livePrice) : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="label">Current P&L</div>
                <div
                  className="value"
                  style={{
                    fontSize: 14,
                    color: currentPnl !== null ? (currentPnl >= 0 ? "var(--success)" : "var(--danger)") : "var(--text)",
                  }}
                >
                  {currentPnl !== null ? `${fmtUsd(currentPnl)} (${fmtPct(currentPnlPct!)})` : "—"}
                </div>
              </div>
              {protectionId && (
                <div className="stat">
                  <div className="label">{positionType === "long" ? "Floor Price" : "Ceiling Price"}</div>
                  <div className="value" style={{ fontSize: 14 }}>
                    {monitor?.protection?.floorPrice
                      ? fmtBtcPrice(Number(monitor.protection.floorPrice))
                      : triggerPriceNum
                        ? fmtBtcPrice(triggerPriceNum)
                        : "—"}
                  </div>
                </div>
              )}
            </div>

            {protectionId && distancePct !== null && (
              <div style={{
                display: "flex", justifyContent: "space-between", fontSize: 12,
                color: "var(--muted)", marginBottom: 12, padding: "0 2px",
              }}>
                <span>Distance to {positionType === "long" ? "floor" : "ceiling"}</span>
                <span style={{ fontWeight: 500, color: distancePct < 5 ? "var(--danger)" : "var(--text)" }}>
                  {distancePct.toFixed(2)}% ({distanceUsd !== null ? fmtUsd(distanceUsd) : "—"})
                </span>
              </div>
            )}

            {protectionId && monitor && (
              <div
                style={{
                  background: "rgba(54, 211, 141, 0.04)",
                  border: "1px solid rgba(54, 211, 141, 0.12)",
                  borderRadius: 10, padding: 12, marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: "var(--success)" }}>
                  Protection Active
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" }}>
                  {monitor.timeRemaining && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Time remaining</span>
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>
                        {fmtTimeRemaining(monitor.timeRemaining.ms)}
                      </span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Premium paid</span>
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>
                      {fmtUsd(Number(monitor.protection.premium || 0))}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Payout if triggered</span>
                    <span style={{ fontWeight: 500, color: "var(--success)" }}>
                      {fmtUsd(payoutOnTrigger)}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Auto-renew</span>
                    <span style={{ fontWeight: 500, color: autoRenew ? "var(--success)" : "var(--muted)" }}>
                      {autoRenew ? "On" : "Off"}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={handleClose}
              style={{
                width: "100%", padding: "12px 0", borderRadius: 10,
                border: "1px solid var(--border)", background: "var(--card-2)",
                fontSize: 13, fontWeight: 500, color: "var(--text)", cursor: "pointer",
              }}
            >
              Close Position
            </button>
          </>
        )}

        {/* ── STATE 3: Position Closed / Triggered ── */}
        {view === "closed" && (
          <>
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              {closeReason === "breach" && (
                <>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>&#10003;</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--success)", marginBottom: 6 }}>
                    Position Closed — Protection Paid
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--success)", marginBottom: 16 }}>
                    {closedPayout !== null ? fmtUsd(closedPayout) : "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    Your {positionType} position hit the {drawdownPct}% stop loss.
                    Protection payout has been credited.
                  </div>
                </>
              )}
              {closeReason === "user" && (
                <>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Position Closed</div>
                  <div
                    style={{
                      fontSize: 22, fontWeight: 700, marginBottom: 16,
                      color: closedPnl !== null ? (closedPnl >= 0 ? "var(--success)" : "var(--danger)") : "var(--text)",
                    }}
                  >
                    P&L: {closedPnl !== null ? fmtUsd(closedPnl) : "—"}
                  </div>
                </>
              )}
              {closeReason === "expired" && (
                <>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--danger)", marginBottom: 6 }}>
                    Protection Expired
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
                    Your protection period has ended. Position is now unprotected.
                  </div>
                </>
              )}
            </div>
            <button
              onClick={handleReset}
              style={{
                width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                color: "#fff",
              }}
            >
              Open New Position
            </button>
          </>
        )}

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "var(--muted)", opacity: 0.5 }}>
          Protection provided by Atticus Strategy, Ltd. &copy; 2026
        </div>
      </div>
    </div>
  );
}
