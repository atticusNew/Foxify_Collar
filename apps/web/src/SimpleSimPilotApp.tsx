import { useEffect, useMemo, useState } from "react";
import { API_BASE, PILOT_SIM_TRIGGER_TOKEN } from "./config";

type TierConfig = {
  name: string;
  drawdownFloorPct: number;
};

type SimQuote = {
  quoteId: string;
  premium: number;
  expiresAt: string;
};

type SimQuoteResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  detail?: string;
  quote?: SimQuote;
};

type SimPosition = {
  id: string;
  status: "open" | "closed" | "triggered";
  marketId: string;
  side: "long" | "short";
  notionalUsd: string;
  entryPrice: string;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  protectionEnabled: boolean;
  protectionPremiumUsd: string | null;
  protectedLossUsd: string | null;
  triggerCreditedUsd: string;
  markPrice: string | null;
  pnlUsd: string;
  drawdownPct: string;
  createdAt: string;
};

type SimPositionListResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  positions?: SimPosition[];
};

type SimSummary = {
  startingEquityUsd: string;
  premiumPaidUsd: string;
  triggerCreditsUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;
  currentEquityUsd: string;
  openPositions: string;
  closedPositions: string;
  triggeredPositions: string;
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

type SimPlatformMetricsResponse = {
  status: "ok" | "error";
  reason?: string;
  message?: string;
  metrics?: SimPlatformMetrics;
  recentLedger?: SimLedgerEntry[];
};

const TIERS: TierConfig[] = [
  { name: "Pro (Bronze)", drawdownFloorPct: 0.2 },
  { name: "Pro (Silver)", drawdownFloorPct: 0.15 },
  { name: "Pro (Gold)", drawdownFloorPct: 0.12 },
  { name: "Pro (Platinum)", drawdownFloorPct: 0.12 }
];

const MARKET_ID = "BTC-USD";
const TENOR_DAYS = 7;
const MONITOR_INTERVAL_MS = 30000;

const formatUsd = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "$0.00";
  return `$${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPct = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00%";
  return `${(parsed * 100).toFixed(2)}%`;
};

const parseApiError = (payload: { reason?: string; message?: string; detail?: string } | null): string =>
  payload?.message || payload?.reason || payload?.detail || "request_failed";

export function SimpleSimPilotApp() {
  const [tierName, setTierName] = useState(TIERS[0].name);
  const [side, setSide] = useState<"long" | "short">("long");
  const [notionalInput, setNotionalInput] = useState("10000");
  const [withProtection, setWithProtection] = useState(true);
  const [quote, setQuote] = useState<SimQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [positions, setPositions] = useState<SimPosition[]>([]);
  const [summary, setSummary] = useState<SimSummary | null>(null);
  const [platformMetrics, setPlatformMetrics] = useState<SimPlatformMetrics | null>(null);
  const [ledger, setLedger] = useState<SimLedgerEntry[]>([]);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoMonitorEnabled, setAutoMonitorEnabled] = useState(false);
  const [autoMonitorAt, setAutoMonitorAt] = useState<string | null>(null);

  const selectedTier = useMemo(
    () => TIERS.find((tier) => tier.name === tierName) || TIERS[0],
    [tierName]
  );
  const notionalUsd = Number(notionalInput);
  const isNotionalValid = Number.isFinite(notionalUsd) && notionalUsd > 0;
  const protectedLossUsd = isNotionalValid ? notionalUsd * selectedTier.drawdownFloorPct : 0;
  const instrumentId = side === "short" ? "BTC-USD-7D-C" : "BTC-USD-7D-P";
  const openProtectedCount = useMemo(
    () => positions.filter((position) => position.status === "open" && position.protectionEnabled).length,
    [positions]
  );

  const refreshData = async () => {
    setRefreshBusy(true);
    setRefreshError(null);
    try {
      const [positionsRes, summaryRes, platformRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/sim/positions?limit=100`),
        fetch(`${API_BASE}/pilot/sim/account/summary`),
        fetch(`${API_BASE}/pilot/sim/platform/metrics`)
      ]);
      const positionsPayload = (await positionsRes.json()) as SimPositionListResponse;
      const summaryPayload = (await summaryRes.json()) as SimSummaryResponse;
      const platformPayload = (await platformRes.json()) as SimPlatformMetricsResponse;

      if (!positionsRes.ok || positionsPayload.status !== "ok") {
        throw new Error(parseApiError(positionsPayload));
      }
      if (!summaryRes.ok || summaryPayload.status !== "ok") {
        throw new Error(parseApiError(summaryPayload));
      }
      if (!platformRes.ok || platformPayload.status !== "ok") {
        throw new Error(parseApiError(platformPayload));
      }
      setPositions(positionsPayload.positions || []);
      setSummary(summaryPayload.summary || null);
      setPlatformMetrics(platformPayload.metrics || null);
      setLedger(platformPayload.recentLedger || []);
    } catch (error: unknown) {
      setRefreshError(error instanceof Error ? error.message : "failed_to_refresh");
    } finally {
      setRefreshBusy(false);
    }
  };

  useEffect(() => {
    void refreshData();
  }, []);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [tierName, side, notionalInput, withProtection]);

  const requestQuote = async () => {
    if (!isNotionalValid) {
      setQuoteError("Enter a valid position size.");
      return;
    }
    setQuoteBusy(true);
    setQuoteError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`${API_BASE}/pilot/protections/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protectedNotional: notionalUsd,
          foxifyExposureNotional: notionalUsd,
          instrumentId,
          marketId: MARKET_ID,
          tierName: selectedTier.name,
          drawdownFloorPct: selectedTier.drawdownFloorPct,
          protectionType: side,
          tenorDays: TENOR_DAYS
        })
      });
      const payload = (await response.json()) as SimQuoteResponse;
      if (!response.ok || payload.status !== "ok" || !payload.quote) {
        throw new Error(parseApiError(payload));
      }
      setQuote(payload.quote);
    } catch (error: unknown) {
      setQuoteError(error instanceof Error ? error.message : "quote_failed");
    } finally {
      setQuoteBusy(false);
    }
  };

  const openPosition = async () => {
    if (!isNotionalValid) {
      setActionMessage("Enter a valid position size before opening.");
      return;
    }
    if (withProtection && !quote?.quoteId) {
      setActionMessage("Get a protection quote first.");
      return;
    }
    setActionBusy(true);
    setActionMessage(null);
    try {
      const response = await fetch(`${API_BASE}/pilot/sim/positions/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protectedNotional: notionalUsd,
          tierName: selectedTier.name,
          drawdownFloorPct: selectedTier.drawdownFloorPct,
          side,
          marketId: MARKET_ID,
          withProtection,
          quoteId: withProtection ? quote?.quoteId : undefined,
          tenorDays: TENOR_DAYS
        })
      });
      const payload = (await response.json()) as { status?: string; reason?: string; message?: string };
      if (!response.ok || payload.status !== "ok") {
        throw new Error(parseApiError(payload));
      }
      setActionMessage(
        withProtection
          ? "Position opened with protection. Trigger monitor will credit if floor breaches."
          : "Position opened without protection."
      );
      setQuote(null);
      await refreshData();
    } catch (error: unknown) {
      setActionMessage(error instanceof Error ? error.message : "open_position_failed");
    } finally {
      setActionBusy(false);
    }
  };

  const closePosition = async (id: string) => {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const response = await fetch(`${API_BASE}/pilot/sim/positions/${encodeURIComponent(id)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const payload = (await response.json()) as { status?: string; reason?: string; message?: string };
      if (!response.ok || payload.status !== "ok") {
        throw new Error(parseApiError(payload));
      }
      setActionMessage("Position closed.");
      await refreshData();
    } catch (error: unknown) {
      setActionMessage(error instanceof Error ? error.message : "close_position_failed");
    } finally {
      setActionBusy(false);
    }
  };

  const runTriggerMonitor = async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    setActionBusy(true);
    if (!silent) {
      setActionMessage(null);
    }
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (PILOT_SIM_TRIGGER_TOKEN) {
        headers["x-internal-token"] = PILOT_SIM_TRIGGER_TOKEN;
      }
      const response = await fetch(`${API_BASE}/pilot/internal/sim/trigger-monitor/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ maxRows: 200 })
      });
      const payload = (await response.json()) as {
        status?: string;
        reason?: string;
        message?: string;
        result?: { triggeredCount?: number };
      };
      if (!response.ok || payload.status !== "ok") {
        throw new Error(parseApiError(payload));
      }
      const triggeredCount = Number(payload.result?.triggeredCount ?? 0);
      if (!silent) {
        setActionMessage(
          triggeredCount > 0
            ? `Trigger monitor credited ${triggeredCount} protected position(s).`
            : "Trigger monitor ran. No new trigger credits this cycle."
        );
      }
      setAutoMonitorAt(new Date().toISOString());
      await refreshData();
    } catch (error: unknown) {
      if (!silent) {
        setActionMessage(error instanceof Error ? error.message : "trigger_monitor_failed");
      }
    } finally {
      setActionBusy(false);
    }
  };

  useEffect(() => {
    if (!autoMonitorEnabled) return;
    if (!PILOT_SIM_TRIGGER_TOKEN) return;
    let running = false;
    const id = window.setInterval(() => {
      if (running) return;
      running = true;
      void runTriggerMonitor({ silent: true }).finally(() => {
        running = false;
      });
    }, MONITOR_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [autoMonitorEnabled]);

  return (
    <div className="shell">
      <div className="card card-wide sim-card">
        <div className="title">
          <div className="brand">
            <span className="brand-accent">Atticus</span> Simple Pilot (Deribit Simulation)
          </div>
          <span className="pill">MVP</span>
        </div>
        <div className="subtitle">
          Open a simulated BTC perp position, optionally add drawdown protection, and track trader + platform outcomes in one place.
        </div>

        <div className="section section-compact">
          <h4>1) Open Position</h4>
          <div className="pilot-form sim-form-grid">
            <div className="pilot-form-row">
              <span className="pilot-label">Position size (USD)</span>
              <input
                className="input pilot-input"
                value={notionalInput}
                inputMode="decimal"
                onChange={(event) => setNotionalInput(event.target.value)}
                placeholder="10000"
              />
            </div>
            <div className="pilot-form-row">
              <span className="pilot-label">Tier</span>
              <select className="input pilot-input pilot-select" value={tierName} onChange={(e) => setTierName(e.target.value)}>
                {TIERS.map((tier) => (
                  <option key={tier.name} value={tier.name}>
                    {tier.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="pilot-form-row">
              <span className="pilot-label">Side</span>
              <select
                className="input pilot-input pilot-select"
                value={side}
                onChange={(e) => setSide(e.target.value === "short" ? "short" : "long")}
              >
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
            </div>
            <div className="pilot-form-row">
              <span className="pilot-label">Drawdown floor</span>
              <strong>{formatPct(selectedTier.drawdownFloorPct)}</strong>
            </div>
            <div className="pilot-form-row">
              <span className="pilot-label">Loss protected if floor hits</span>
              <strong>{formatUsd(protectedLossUsd)}</strong>
            </div>
            <div className="pilot-form-row">
              <span className="pilot-label">Add protection</span>
              <label className="pilot-checkbox">
                <input
                  type="checkbox"
                  checked={withProtection}
                  onChange={(event) => setWithProtection(event.target.checked)}
                />
                Yes, cover floor loss for {TENOR_DAYS} days
              </label>
            </div>
          </div>

          {withProtection ? (
            <div className="sim-quote-block">
              <div className="row">
                <span>Protection quote</span>
                <strong>{quote ? formatUsd(quote.premium) : "—"}</strong>
              </div>
              <div className="row">
                <span>Quote expiry</span>
                <strong>{quote?.expiresAt ? new Date(quote.expiresAt).toLocaleString() : "Not quoted yet"}</strong>
              </div>
              <button className="btn btn-primary" onClick={() => void requestQuote()} disabled={quoteBusy || actionBusy}>
                {quoteBusy ? "Pricing..." : "Preview protection price"}
              </button>
              {quoteError ? <div className="disclaimer danger">{quoteError}</div> : null}
              <div className="disclaimer">
                User-facing copy: <strong>If your drawdown floor hits, we credit {formatUsd(protectedLossUsd)}.</strong>{" "}
                Current estimated cost: <strong>{quote ? formatUsd(quote.premium) : "request quote"}</strong> for {TENOR_DAYS} days.
              </div>
            </div>
          ) : null}

          <div className="pilot-actions">
            <button className="cta" onClick={() => void openPosition()} disabled={actionBusy || quoteBusy}>
              {actionBusy ? "Submitting..." : withProtection ? "Open Position + Protection" : "Open Position"}
            </button>
            <button className="btn" onClick={() => void refreshData()} disabled={refreshBusy || actionBusy}>
              {refreshBusy ? "Refreshing..." : "Refresh data"}
            </button>
          </div>
          {actionMessage ? <div className="disclaimer">{actionMessage}</div> : null}
          {refreshError ? <div className="disclaimer danger">{refreshError}</div> : null}
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>2) Trader Dashboard</h4>
            <span className="muted">
              Open protected: <strong>{openProtectedCount}</strong>
            </span>
          </div>
          <div className="stats">
            <div className="stat">
              <div className="label">Current Equity</div>
              <div className="value">{formatUsd(summary?.currentEquityUsd)}</div>
            </div>
            <div className="stat">
              <div className="label">Premium Paid</div>
              <div className="value">{formatUsd(summary?.premiumPaidUsd)}</div>
            </div>
            <div className="stat">
              <div className="label">Trigger Credits</div>
              <div className="value">{formatUsd(summary?.triggerCreditsUsd)}</div>
            </div>
            <div className="stat">
              <div className="label">Unrealized PnL</div>
              <div className="value">{formatUsd(summary?.unrealizedPnlUsd)}</div>
            </div>
          </div>

          <div className="positions">
            {positions.length === 0 ? (
              <div className="empty">No simulated positions yet.</div>
            ) : (
              positions.map((position) => (
                <div key={position.id} className={`position-row ${position.status === "open" ? "position-row-active" : ""}`}>
                  <div className="position-main">
                    <div className="position-main-title">
                      <strong>{position.tierName || "Tier N/A"}</strong>
                      <span className={`pill ${position.status === "triggered" ? "pill-danger" : "pill-warning"}`}>
                        {position.status}
                      </span>
                    </div>
                    <div className="muted">
                      {position.side.toUpperCase()} {formatUsd(position.notionalUsd)} @ {formatUsd(position.entryPrice)} | Floor{" "}
                      {formatUsd(position.floorPrice)} | Drawdown {formatPct(position.drawdownPct)}
                    </div>
                    <div className="muted">
                      Mark {formatUsd(position.markPrice)} | PnL {formatUsd(position.pnlUsd)} | Trigger credit{" "}
                      {formatUsd(position.triggerCreditedUsd)}
                    </div>
                  </div>
                  <div className="position-actions">
                    {position.status === "open" ? (
                      <button className="btn" onClick={() => void closePosition(position.id)} disabled={actionBusy}>
                        Close
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>3) Platform Essentials</h4>
            <div className="section-actions">
              <label className="pilot-inline-check muted">
                <input
                  type="checkbox"
                  checked={autoMonitorEnabled}
                  disabled={!PILOT_SIM_TRIGGER_TOKEN || actionBusy}
                  onChange={(event) => setAutoMonitorEnabled(event.target.checked)}
                />
                Auto monitor (30s)
              </label>
              <button className="btn" onClick={() => void runTriggerMonitor()} disabled={actionBusy || refreshBusy}>
                Run trigger monitor cycle
              </button>
            </div>
          </div>
          {!PILOT_SIM_TRIGGER_TOKEN ? (
            <div className="disclaimer">
              Internal trigger monitor endpoint needs auth. Set <code>VITE_PILOT_INTERNAL_TOKEN</code> for one-click monitor runs
              from this UI, or run your server-side scheduler.
            </div>
          ) : null}
          {autoMonitorAt ? (
            <div className="muted">Last monitor cycle: {new Date(autoMonitorAt).toLocaleString()}</div>
          ) : null}
          <div className="stats">
            <div className="stat">
              <div className="label">Total Positions</div>
              <div className="value">{platformMetrics?.totalPositions || "0"}</div>
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
          </div>
          <div className="row row-tight">
            <span>Treasury net</span>
            <strong>{formatUsd(platformMetrics?.treasuryNetUsd)}</strong>
          </div>
          <div className="divider" />
          <h4>Recent Treasury Ledger</h4>
          <div className="positions">
            {ledger.length === 0 ? (
              <div className="empty">No treasury entries yet.</div>
            ) : (
              ledger.slice(0, 8).map((entry) => (
                <div key={entry.id} className="position-row">
                  <div className="position-main">
                    <strong>{entry.entryType === "premium_collected" ? "Premium Collected" : "Trigger Credit Paid"}</strong>
                    <div className="muted">
                      {formatUsd(entry.amountUsd)} | Position {entry.simPositionId.slice(0, 8)}... |{" "}
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
