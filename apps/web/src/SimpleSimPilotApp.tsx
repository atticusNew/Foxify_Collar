import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "./config";

type StopLossOption = {
  label: string;
  floorPct: number;
  tierName: string;
};

type SimQuote = {
  quoteId: string;
  premium: number;
  expiresAt: string;
};

type QuoteResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  detail?: string;
  quote?: SimQuote;
};

type ReferencePriceResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  reference?: {
    price: string;
    timestamp: string;
    source: string;
  };
};

type SimPosition = {
  id: string;
  status: "open" | "closed" | "triggered";
  side: "long" | "short";
  notionalUsd: string;
  entryPrice: string;
  floorPrice: string | null;
  drawdownPct: string;
  markPrice: string | null;
  pnlUsd: string;
  protectionEnabled: boolean;
  triggerCreditedUsd: string;
};

type SimPositionListResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  positions?: SimPosition[];
};

type SimSummary = {
  premiumPaidUsd: string;
  triggerCreditsUsd: string;
  unrealizedPnlUsd: string;
  currentEquityUsd: string;
  openPositions: string;
};

type SimSummaryResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  summary?: SimSummary;
};

type SimPlatformMetrics = {
  totalPositions: string;
  openPositions: string;
  triggeredPositions: string;
  protectedPositions: string;
  premiumCollectedUsd: string;
  triggerCreditPaidUsd: string;
  treasuryNetUsd: string;
};

type SimLedgerEntry = {
  id: string;
  simPositionId: string;
  entryType: "premium_collected" | "trigger_credit";
  amountUsd: string;
  createdAt: string;
};

type SimPlatformResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  metrics?: SimPlatformMetrics;
  recentLedger?: SimLedgerEntry[];
};

type ViewMode = "entry" | "trader";

const STOP_LOSS_OPTIONS: StopLossOption[] = [
  { label: "20%", floorPct: 0.2, tierName: "Pro (Bronze)" },
  { label: "15%", floorPct: 0.15, tierName: "Pro (Silver)" },
  { label: "12%", floorPct: 0.12, tierName: "Pro (Gold)" }
];

const TENOR_DAYS = 3;
const MARKET_ID = "BTC-USD";
const SIDE: "long" = "long";
const INSTRUMENT_ID = "BTC-USD-7D-P";

const formatUsd = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "$0.00";
  return `$${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatUsdNoDecimals = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "$0";
  return `$${Math.round(parsed).toLocaleString()}`;
};

const formatPct = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00%";
  return `${(parsed * 100).toFixed(2)}%`;
};

const parseError = (payload: { reason?: string; message?: string; detail?: string } | null): string =>
  payload?.message || payload?.reason || payload?.detail || "request_failed";

const formatCsvInput = (value: string): string => {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  const [wholeRaw, ...fractionParts] = cleaned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractionParts.length === 0) return grouped;
  const fraction = fractionParts.join("").slice(0, 2);
  return `${grouped}.${fraction}`;
};

const parseCsvNumber = (value: string): number => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
};

export function SimpleSimPilotApp() {
  const [viewMode, setViewMode] = useState<ViewMode>("entry");
  const [sizeInput, setSizeInput] = useState("10,000");
  const [stopLossPct, setStopLossPct] = useState(STOP_LOSS_OPTIONS[0].floorPct);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<string | null>(null);

  const [positions, setPositions] = useState<SimPosition[]>([]);
  const [summary, setSummary] = useState<SimSummary | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [platformMetrics, setPlatformMetrics] = useState<SimPlatformMetrics | null>(null);
  const [platformLedger, setPlatformLedger] = useState<SimLedgerEntry[]>([]);
  const [platformBusy, setPlatformBusy] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);

  const [protectModalOpen, setProtectModalOpen] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quote, setQuote] = useState<SimQuote | null>(null);
  const [platformModalOpen, setPlatformModalOpen] = useState(false);

  const sizeUsd = parseCsvNumber(sizeInput);
  const isSizeValid = Number.isFinite(sizeUsd) && sizeUsd > 0;
  const selectedStopLoss = useMemo(
    () => STOP_LOSS_OPTIONS.find((opt) => opt.floorPct === stopLossPct) || STOP_LOSS_OPTIONS[0],
    [stopLossPct]
  );
  const protectionAmountUsd = isSizeValid ? sizeUsd * selectedStopLoss.floorPct : 0;
  const floorPriceUsd = btcPrice && Number.isFinite(btcPrice) ? btcPrice * (1 - selectedStopLoss.floorPct) : null;

  const fetchReferencePrice = async () => {
    setPriceBusy(true);
    setPriceError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/reference-price?marketId=${encodeURIComponent(MARKET_ID)}`);
      const payload = (await res.json()) as ReferencePriceResponse;
      if (!res.ok || payload.status !== "ok" || !payload.reference?.price) {
        throw new Error(parseError(payload));
      }
      const price = Number(payload.reference.price);
      if (!Number.isFinite(price)) throw new Error("invalid_reference_price");
      setBtcPrice(price);
      setPriceUpdatedAt(payload.reference.timestamp || new Date().toISOString());
    } catch (error: unknown) {
      setPriceError(error instanceof Error ? error.message : "failed_to_fetch_price");
    } finally {
      setPriceBusy(false);
    }
  };

  const refreshTraderDashboard = async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setRefreshBusy(true);
      setRefreshError(null);
    }
    try {
      const [positionsRes, summaryRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/sim/positions?limit=100`),
        fetch(`${API_BASE}/pilot/sim/account/summary`)
      ]);
      const positionsPayload = (await positionsRes.json()) as SimPositionListResponse;
      const summaryPayload = (await summaryRes.json()) as SimSummaryResponse;
      if (!positionsRes.ok || positionsPayload.status !== "ok") {
        throw new Error(parseError(positionsPayload));
      }
      if (!summaryRes.ok || summaryPayload.status !== "ok") {
        throw new Error(parseError(summaryPayload));
      }
      setPositions(positionsPayload.positions || []);
      setSummary(summaryPayload.summary || null);
    } catch (error: unknown) {
      if (!silent) {
        setRefreshError(error instanceof Error ? error.message : "failed_to_refresh");
      }
    } finally {
      if (!silent) {
        setRefreshBusy(false);
      }
    }
  };

  const refreshPlatformDashboard = async () => {
    setPlatformBusy(true);
    setPlatformError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/sim/platform/metrics`);
      const payload = (await res.json()) as SimPlatformResponse;
      if (!res.ok || payload.status !== "ok") {
        throw new Error(parseError(payload));
      }
      setPlatformMetrics(payload.metrics || null);
      setPlatformLedger(payload.recentLedger || []);
    } catch (error: unknown) {
      setPlatformError(error instanceof Error ? error.message : "failed_to_refresh_platform");
    } finally {
      setPlatformBusy(false);
    }
  };

  const refreshAll = async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    await Promise.all([fetchReferencePrice(), refreshTraderDashboard({ silent })]);
  };

  useEffect(() => {
    void refreshAll();
    const id = window.setInterval(() => {
      void refreshAll({ silent: true });
    }, 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [sizeInput, stopLossPct]);

  useEffect(() => {
    if (!platformModalOpen) return;
    void refreshPlatformDashboard();
  }, [platformModalOpen]);

  const requestQuote = async (): Promise<SimQuote | null> => {
    if (!isSizeValid) {
      setQuoteError("Enter a valid position size.");
      return null;
    }
    setQuoteBusy(true);
    setQuoteError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protectedNotional: sizeUsd,
          foxifyExposureNotional: sizeUsd,
          instrumentId: INSTRUMENT_ID,
          marketId: MARKET_ID,
          tierName: selectedStopLoss.tierName,
          drawdownFloorPct: selectedStopLoss.floorPct,
          protectionType: SIDE,
          tenorDays: TENOR_DAYS
        })
      });
      const payload = (await res.json()) as QuoteResponse;
      if (!res.ok || payload.status !== "ok" || !payload.quote) {
        throw new Error(parseError(payload));
      }
      setQuote(payload.quote);
      return payload.quote;
    } catch (error: unknown) {
      setQuoteError(error instanceof Error ? error.message : "quote_failed");
      return null;
    } finally {
      setQuoteBusy(false);
    }
  };

  const submitOpen = async (withProtection: boolean) => {
    if (!isSizeValid) {
      setActionMessage("Enter a valid position size.");
      return;
    }
    setActionBusy(true);
    setActionMessage(null);
    try {
      let quoteToUse = quote;
      if (withProtection) {
        quoteToUse = await requestQuote();
        if (!quoteToUse?.quoteId) throw new Error("quote_required_before_protect");
      }
      const res = await fetch(`${API_BASE}/pilot/sim/positions/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protectedNotional: sizeUsd,
          tierName: selectedStopLoss.tierName,
          drawdownFloorPct: selectedStopLoss.floorPct,
          side: SIDE,
          marketId: MARKET_ID,
          withProtection,
          quoteId: withProtection ? quoteToUse?.quoteId : undefined,
          tenorDays: TENOR_DAYS
        })
      });
      const payload = (await res.json()) as { status?: string; reason?: string; message?: string };
      if (!res.ok || payload.status !== "ok") throw new Error(parseError(payload));
      setActionMessage(withProtection ? "Position opened with protection." : "Position opened without protection.");
      setProtectModalOpen(false);
      setQuote(null);
      await refreshTraderDashboard();
      setViewMode("trader");
    } catch (error: unknown) {
      setActionMessage(error instanceof Error ? error.message : "open_position_failed");
    } finally {
      setActionBusy(false);
    }
  };

  const openProtectionModal = async () => {
    setProtectModalOpen(true);
    setQuoteError(null);
    if (!quote?.quoteId) {
      await requestQuote();
    }
  };

  const closePosition = async (id: string) => {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/sim/positions/${encodeURIComponent(id)}/close`, { method: "POST" });
      const payload = (await res.json()) as { status?: string; reason?: string; message?: string };
      if (!res.ok || payload.status !== "ok") throw new Error(parseError(payload));
      setActionMessage("Position closed.");
      await refreshTraderDashboard();
    } catch (error: unknown) {
      setActionMessage(error instanceof Error ? error.message : "close_position_failed");
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="shell">
      <div className="card card-wide sim-card">
        <div className="title">
          <div className="brand">
            <span className="brand-accent">Atticus</span> Trader Pilot
          </div>
        </div>
        <div className="subtitle">Simple funded-account protection flow.</div>

        {viewMode === "entry" ? (
          <div className="section section-compact">
            <h4>Open Position</h4>
            <div className="sim-entry-card">
              <div className="sim-widget-grid">
                <div className="sim-widget-row">
                  <span className="pilot-label">Current BTC Price</span>
                  <strong className="sim-widget-value">{btcPrice ? formatUsd(btcPrice) : priceBusy ? "Loading..." : "Unavailable"}</strong>
                </div>
                <div className="sim-widget-row">
                  <span className="pilot-label">Position Size (USD)</span>
                  <input
                    className="input pilot-input sim-widget-value"
                    value={sizeInput}
                    inputMode="decimal"
                    onChange={(event) => setSizeInput(formatCsvInput(event.target.value))}
                    placeholder="10,000"
                  />
                </div>
                <div className="sim-widget-row">
                  <span className="pilot-label">Stop Loss</span>
                  <div className="sim-stoploss-group">
                    {STOP_LOSS_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        className={`btn sim-stoploss-btn ${option.floorPct === stopLossPct ? "active" : ""}`}
                        onClick={() => setStopLossPct(option.floorPct)}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sim-widget-row">
                  <span className="pilot-label">Protection Amount</span>
                  <strong className="sim-widget-value">{formatUsd(protectionAmountUsd)}</strong>
                </div>
                <div className="sim-widget-row">
                  <span className="pilot-label">Current Floor</span>
                  <strong className="sim-widget-value">{floorPriceUsd ? formatUsd(floorPriceUsd) : "—"}</strong>
                </div>
              </div>
              <button className="cta sim-open-btn" onClick={() => void openProtectionModal()} disabled={actionBusy || !isSizeValid}>
                Open Position
              </button>
              {priceUpdatedAt ? <div className="muted">Price updated: {new Date(priceUpdatedAt).toLocaleString()}</div> : null}
              {priceError ? <div className="disclaimer danger">{priceError}</div> : null}
            </div>
          </div>
        ) : (
          <div className="section section-compact">
            <div className="section-title-row">
              <h4>Trader Dashboard</h4>
              <div className="section-actions">
                <button className="btn" onClick={() => setViewMode("entry")} type="button">
                  Add Position
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setPlatformModalOpen(true);
                  }}
                  type="button"
                >
                  Platform Dashboard
                </button>
                <button className="btn" onClick={() => void refreshTraderDashboard()} disabled={refreshBusy || actionBusy} type="button">
                  Refresh
                </button>
              </div>
            </div>

            <div className="sim-dashboard-grid">
              <div className="stat">
                <div className="label">Current Equity</div>
                <div className="value">{formatUsd(summary?.currentEquityUsd)}</div>
              </div>
              <div className="stat">
                <div className="label">Unrealized PnL</div>
                <div className="value">{formatUsd(summary?.unrealizedPnlUsd)}</div>
              </div>
              <div className="stat">
                <div className="label">Premium Paid</div>
                <div className="value">{formatUsd(summary?.premiumPaidUsd)}</div>
              </div>
              <div className="stat">
                <div className="label">Protection Credits</div>
                <div className="value">{formatUsd(summary?.triggerCreditsUsd)}</div>
              </div>
            </div>
            <div className="row">
              <span>Open positions</span>
              <strong>{summary?.openPositions || "0"}</strong>
            </div>
            {actionMessage ? <div className="disclaimer">{actionMessage}</div> : null}
            {refreshError ? <div className="disclaimer danger">{refreshError}</div> : null}
            <div className="positions sim-position-list">
              {positions.length === 0 ? (
                <div className="empty">No positions yet.</div>
              ) : (
                positions.map((position) => (
                  <div key={position.id} className={`position-row ${position.status === "open" ? "position-row-active" : ""}`}>
                    <div className="position-main">
                      <div className="position-main-title">
                        <strong>{formatUsd(position.notionalUsd)} Long</strong>
                        <span className={`pill sim-status-pill ${position.status === "triggered" ? "pill-danger" : "pill-warning"}`}>
                          {position.status}
                        </span>
                        {position.protectionEnabled ? <span className="pill">Protected</span> : <span className="pill pill-warning">Unprotected</span>}
                      </div>
                      <div className="muted">
                        Entry {formatUsd(position.entryPrice)} | Mark {formatUsd(position.markPrice)} | Floor {formatUsd(position.floorPrice)} | Drawdown{" "}
                        {formatPct(position.drawdownPct)}
                      </div>
                      <div className="muted">
                        PnL {formatUsd(position.pnlUsd)} | Credits {formatUsd(position.triggerCreditedUsd)}
                      </div>
                    </div>
                    <div className="position-actions">
                      {position.status === "open" ? (
                        <button className="btn" onClick={() => void closePosition(position.id)} disabled={actionBusy} type="button">
                          Close
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {protectModalOpen ? (
        <div className="modal">
          <div className="modal-card sim-protect-modal">
            <div className="modal-title">
              <h3>Protect this Position</h3>
            </div>
            <div className="sim-protect-grid">
              <div className="sim-protect-line sim-protect-line-strong">
                <span>Position Drops</span>
                <strong>{selectedStopLoss.label}</strong>
              </div>
              <div className="sim-protect-line sim-protect-line-credit">
                <span>Instantly Credited</span>
                <strong>{formatUsdNoDecimals(protectionAmountUsd)}</strong>
              </div>
              <div className="sim-protect-line sim-protect-line-cost">
                <span>Protection Cost</span>
                <strong>
                  {quoteBusy ? "Pricing..." : quote ? `${formatUsdNoDecimals(quote.premium)} per ${TENOR_DAYS} days` : "Unavailable"}
                </strong>
              </div>
            </div>
            {quoteError ? <div className="disclaimer danger">{quoteError}</div> : null}
            <div className="sim-modal-actions">
              <button className="btn btn-primary sim-compact-btn" onClick={() => void submitOpen(true)} disabled={actionBusy || quoteBusy} type="button">
                Open Position + Protection
              </button>
              <button className="btn sim-compact-btn" onClick={() => void submitOpen(false)} disabled={actionBusy} type="button">
                Open Position Only
              </button>
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary sim-compact-btn"
                onClick={() => {
                  setProtectModalOpen(false);
                  setQuoteError(null);
                }}
                disabled={actionBusy}
                type="button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {platformModalOpen ? (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-title">
              <h3>Platform Dashboard</h3>
            </div>
            <div className="sim-dashboard-grid">
              <div className="stat">
                <div className="label">Total Positions</div>
                <div className="value">{platformMetrics?.totalPositions || "0"}</div>
              </div>
              <div className="stat">
                <div className="label">Open Positions</div>
                <div className="value">{platformMetrics?.openPositions || "0"}</div>
              </div>
              <div className="stat">
                <div className="label">Protected Positions</div>
                <div className="value">{platformMetrics?.protectedPositions || "0"}</div>
              </div>
              <div className="stat">
                <div className="label">Triggered Positions</div>
                <div className="value">{platformMetrics?.triggeredPositions || "0"}</div>
              </div>
              <div className="stat">
                <div className="label">Premium Collected</div>
                <div className="value">{formatUsd(platformMetrics?.premiumCollectedUsd)}</div>
              </div>
              <div className="stat">
                <div className="label">Trigger Credits Paid</div>
                <div className="value">{formatUsd(platformMetrics?.triggerCreditPaidUsd)}</div>
              </div>
              <div className="stat">
                <div className="label">Treasury Net</div>
                <div className="value">{formatUsd(platformMetrics?.treasuryNetUsd)}</div>
              </div>
            </div>
            {platformError ? <div className="disclaimer danger">{platformError}</div> : null}
            <div className="positions sim-position-list">
              {(platformLedger || []).slice(0, 6).map((entry) => (
                <div key={entry.id} className="position-row">
                  <div className="position-main">
                    <strong>{entry.entryType === "premium_collected" ? "Premium Collected" : "Trigger Credit"}</strong>
                    <div className="muted">
                      {formatUsd(entry.amountUsd)} | {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setPlatformModalOpen(false);
                  setPlatformError(null);
                }}
                disabled={platformBusy}
                type="button"
              >
                X Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
