import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "./config";

type TierLevel = {
  name: string;
  drawdownFloorPct: number;
  expiryDays: number;
  renewWindowMinutes: number;
};

type QuoteResult = {
  tierName: string;
  drawdownFloorPct: string;
  floorPrice: string;
  quote: {
    quoteId: string;
    instrumentId: string;
    premium: number;
    expiresAt: string;
    quantity: number;
    venue: string;
  };
  entrySnapshot: {
    price: string;
    marketId?: string;
    source: string;
    timestamp: string;
    requestId?: string;
  };
  entryInputPrice?: string;
  limits?: {
    maxProtectionNotionalUsdc: string;
    maxDailyProtectedNotionalUsdc: string;
    dailyUsedUsdc: string;
    projectedDailyUsdc: string;
    dailyCapExceededOnActivate: boolean;
  };
};

type ProtectionRecord = {
  id: string;
  status: string;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  protectedNotional: string;
  foxifyExposureNotional: string;
  entryPrice: string | null;
  expiryAt: string;
  premium: string | null;
  autoRenew: boolean;
  renewWindowMinutes: number;
  venue: string | null;
  metadata?: Record<string, unknown> | null;
};

const formatUsd = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const DEFAULT_TIERS: TierLevel[] = [
  { name: "Pro (Bronze)", drawdownFloorPct: 0.2, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Silver)", drawdownFloorPct: 0.15, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Gold)", drawdownFloorPct: 0.12, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Platinum)", drawdownFloorPct: 0.12, expiryDays: 7, renewWindowMinutes: 1440 }
];

const formatPct = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00%";
  return `${(parsed * 100).toFixed(2)}%`;
};

const formatCurrencyInput = (value: string): string => {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  const [wholeRaw, ...fractionParts] = cleaned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractionParts.length === 0) return grouped;
  const fraction = fractionParts.join("").slice(0, 8);
  return `${grouped}.${fraction}`;
};

const parseCurrencyNumber = (value: string): number => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const formatCountdown = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const friendlyError = (message: string): string => {
  if (message.includes("daily_notional_cap_exceeded")) {
    return "Daily protection limit reached for this trader. Please try again next UTC day.";
  }
  if (message.includes("protection_notional_cap_exceeded")) {
    return "Protection amount exceeds the pilot maximum. Reduce amount and request a new quote.";
  }
  if (message.includes("quote_expired")) {
    return "Quote expired. Request a fresh quote and confirm again.";
  }
  if (message.includes("quote_mismatch")) {
    return "Protection terms changed after quoting. Request a new quote before confirming.";
  }
  if (message.includes("price_unavailable")) {
    return "Price feed is temporarily unavailable. Please retry in a moment.";
  }
  return message || "Request failed. Please retry.";
};

export function PilotApp() {
  const [userId, setUserId] = useState(() => `foxify-user-${Math.random().toString(36).slice(2, 8)}`);
  const [tiers, setTiers] = useState<TierLevel[]>(DEFAULT_TIERS);
  const [tierName, setTierName] = useState(DEFAULT_TIERS[0].name);
  const [exposureNotional, setExposureNotional] = useState("50,000");
  const [protectedNotional, setProtectedNotional] = useState("50,000");
  const [entryPrice, setEntryPrice] = useState("100,000");
  const [autoRenew, setAutoRenew] = useState(false);
  const [instrumentId, setInstrumentId] = useState("BTC-USD-7D-P");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [protection, setProtection] = useState<ProtectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoteState, setQuoteState] = useState<"idle" | "fetching" | "ready" | "expired">("idle");
  const [quoteTimeLeft, setQuoteTimeLeft] = useState(0);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [showProtectionModal, setShowProtectionModal] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.name === tierName) || DEFAULT_TIERS[0],
    [tierName, tiers]
  );

  const exposureValue = parseCurrencyNumber(exposureNotional || "0");
  const protectedValue = parseCurrencyNumber(protectedNotional || "0");
  const entryValue = parseCurrencyNumber(entryPrice || "0");
  const canQuote =
    Number.isFinite(exposureValue) &&
    exposureValue > 0 &&
    Number.isFinite(protectedValue) &&
    protectedValue > 0 &&
    protectedValue <= exposureValue &&
    Number.isFinite(entryValue) &&
    entryValue > 0;
  const quoteFresh =
    quoteState === "ready" && quote?.quote?.expiresAt ? Date.parse(quote.quote.expiresAt) > Date.now() : false;
  const quoteCapWarning = quote?.limits?.dailyCapExceededOnActivate === true;
  const canActivate = canQuote && Boolean(quote?.quote?.quoteId) && quoteFresh && !quoteCapWarning;

  const renewWindowReached = useMemo(() => {
    if (!protection || protection.autoRenew || protection.status !== "active") return false;
    const expiryMs = Date.parse(protection.expiryAt);
    if (!Number.isFinite(expiryMs)) return false;
    const renewAtMs = expiryMs - protection.renewWindowMinutes * 60 * 1000;
    return Date.now() >= renewAtMs;
  }, [protection]);

  useEffect(() => {
    if (renewWindowReached) {
      setShowRenewModal(true);
    }
  }, [renewWindowReached]);

  useEffect(() => {
    let active = true;
    const loadTiers = async () => {
      try {
        const res = await fetch("/funded_levels.json");
        if (!res.ok) return;
        const payload = (await res.json()) as { levels?: Array<Record<string, unknown>> };
        const parsed = (payload.levels || [])
          .map((item) => {
            const name = typeof item.name === "string" ? item.name : "";
            const drawdown = Number(item.drawdown_limit_pct ?? 0);
            const expiryDays = Number(item.expiry_days ?? 7);
            const renewWindowMinutes = Number(item.renew_window_minutes ?? 1440);
            if (!name || !Number.isFinite(drawdown) || drawdown <= 0) return null;
            return {
              name,
              drawdownFloorPct: drawdown,
              expiryDays: Number.isFinite(expiryDays) && expiryDays > 0 ? Math.floor(expiryDays) : 7,
              renewWindowMinutes:
                Number.isFinite(renewWindowMinutes) && renewWindowMinutes > 0
                  ? Math.floor(renewWindowMinutes)
                  : 1440
            } as TierLevel;
          })
          .filter((item): item is TierLevel => Boolean(item));
        if (!active || parsed.length === 0) return;
        setTiers(parsed);
        if (!parsed.some((tier) => tier.name === tierName)) {
          setTierName(parsed[0].name);
        }
      } catch {
        // keep defaults on tier fetch failure
      }
    };
    loadTiers();
    return () => {
      active = false;
    };
  }, [tierName]);

  useEffect(() => {
    setQuote(null);
    setQuoteState("idle");
    setQuoteTimeLeft(0);
  }, [userId, selectedTier.name, selectedTier.drawdownFloorPct, exposureNotional, protectedNotional, entryPrice, instrumentId]);

  useEffect(() => {
    if (!quote?.quote?.expiresAt) {
      setQuoteTimeLeft(0);
      return;
    }
    const updateTime = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(quote.quote.expiresAt) - Date.now()) / 1000));
      setQuoteTimeLeft(seconds);
      if (seconds <= 0) {
        setQuoteState("expired");
      } else if (quoteState !== "fetching") {
        setQuoteState("ready");
      }
    };
    updateTime();
    const id = setInterval(updateTime, 1000);
    return () => clearInterval(id);
  }, [quote?.quote?.expiresAt, quoteState]);

  useEffect(() => {
    if (!protection?.id) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/pilot/protections/${protection.id}`);
        if (!res.ok) return;
        const payload = await res.json();
        if (payload?.protection) {
          setProtection(payload.protection as ProtectionRecord);
          setLastUpdatedAt(new Date());
        }
      } catch {
        // ignore polling errors in pilot widget
      }
    }, 10000);
    return () => clearInterval(id);
  }, [protection?.id]);

  const requestQuote = async () => {
    if (!canQuote) return;
    setBusy(true);
    setError(null);
    setQuote(null);
    setQuoteState("fetching");
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          protectedNotional: protectedValue,
          foxifyExposureNotional: exposureValue,
          entryPrice: entryValue,
          instrumentId,
          marketId: "BTC-USD",
          tierName: selectedTier.name,
          drawdownFloorPct: selectedTier.drawdownFloorPct
        })
      });
      const payload = await res.json();
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.message || payload?.reason || "quote_failed");
      }
      setQuote(payload as QuoteResult);
      setQuoteState("ready");
    } catch (err: any) {
      setQuoteState("idle");
      setError(friendlyError(String(err?.message || "Price temporarily unavailable, please retry.")));
    } finally {
      setBusy(false);
    }
  };

  const activateProtection = async () => {
    if (!canActivate) {
      setError("Get a fresh quote before activation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          protectedNotional: protectedValue,
          foxifyExposureNotional: exposureValue,
          entryPrice: entryValue,
          instrumentId,
          marketId: "BTC-USD",
          tierName: selectedTier.name,
          drawdownFloorPct: selectedTier.drawdownFloorPct,
          tenorDays: selectedTier.expiryDays,
          renewWindowMinutes: selectedTier.renewWindowMinutes,
          autoRenew,
          quoteId: quote?.quote?.quoteId
        })
      });
      const payload = await res.json();
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.message || payload?.reason || "activation_failed");
      }
      setProtection(payload.protection as ProtectionRecord);
      setLastUpdatedAt(new Date());
      setShowProtectionModal(true);
      setShowRenewModal(false);
    } catch (err: any) {
      setError(friendlyError(String(err?.message || "Protection activation failed.")));
    } finally {
      setBusy(false);
    }
  };

  const submitRenewDecision = async (decision: "renew" | "expire") => {
    if (!protection?.id) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/${protection.id}/renewal-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const payload = await res.json();
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.reason || "renewal_decision_failed");
      }
      if (payload?.protection) {
        setProtection(payload.protection as ProtectionRecord);
      }
      setShowRenewModal(false);
    } catch (err: any) {
      setError(friendlyError(String(err?.message || "Failed to process renewal decision.")));
    } finally {
      setBusy(false);
    }
  };

  const displayedDrawdownPct =
    Number(protection?.drawdownFloorPct ?? quote?.drawdownFloorPct ?? selectedTier.drawdownFloorPct);
  const displayedFloor =
    protection?.floorPrice ??
    quote?.floorPrice ??
    (quote?.entrySnapshot?.price
      ? (
          Number(quote.entrySnapshot.price) *
          (1 - Number(quote.drawdownFloorPct || selectedTier.drawdownFloorPct))
        ).toFixed(10)
      : null);
  const metadataEntrySnapshotPrice =
    protection?.metadata && typeof protection.metadata["entrySnapshotPrice"] === "string"
      ? (protection.metadata["entrySnapshotPrice"] as string)
      : null;
  const referencePrice =
    Number(metadataEntrySnapshotPrice ?? quote?.entrySnapshot?.price ?? protection?.entryPrice ?? entryValue);
  const floorNumber = Number(displayedFloor ?? 0);
  const distanceToTriggerPct =
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(floorNumber)
      ? ((referencePrice - floorNumber) / referencePrice) * 100
      : NaN;
  const indicativeOptionMark = Number(protection?.premium ?? quote?.quote?.premium ?? 0);
  const maxTriggerProtectionValue =
    Number.isFinite(protectedValue) && Number.isFinite(displayedDrawdownPct)
      ? protectedValue * displayedDrawdownPct
      : NaN;
  const renewalChip = protection?.expiryAt
    ? `Renewal window: ${new Date(
        Date.parse(protection.expiryAt) - (protection.renewWindowMinutes || 0) * 60 * 1000
      ).toLocaleString()}`
    : null;
  const configuredFloorPrice =
    Number.isFinite(entryValue) && entryValue > 0 ? entryValue * (1 - selectedTier.drawdownFloorPct) : NaN;

  return (
    <div className="shell">
      <div className="card pilot-card">
        <div className="title">Foxify Pilot Protection</div>
        <div className="subtitle">7-day fixed tenor · quote lock enforced at activation</div>

        <div className="section">
          <h4>Protection Request</h4>
          <div className="recommendation pilot-form">
            <div className="pilot-form-row">
              <span className="pilot-label">Trader ID</span>
              <input className="input pilot-input" value={userId} onChange={(e) => setUserId(e.target.value)} />
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Tier</span>
              <select
                className="input pilot-input pilot-select"
                value={tierName}
                onChange={(e) => setTierName(e.target.value)}
                disabled={busy}
              >
                {tiers.map((tier) => (
                  <option key={tier.name} value={tier.name}>
                    {tier.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Position Size (USD)</span>
              <input
                className="input pilot-input"
                inputMode="decimal"
                value={exposureNotional}
                onChange={(e) => setExposureNotional(formatCurrencyInput(e.target.value))}
              />
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Protection Amount (USD)</span>
              <input
                className="input pilot-input"
                inputMode="decimal"
                value={protectedNotional}
                onChange={(e) => setProtectedNotional(formatCurrencyInput(e.target.value))}
              />
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Entry Price (Manual)</span>
              <input
                className="input pilot-input"
                inputMode="decimal"
                value={entryPrice}
                onChange={(e) => setEntryPrice(formatCurrencyInput(e.target.value))}
              />
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Max Drawdown Protected</span>
              <strong>{formatPct(selectedTier.drawdownFloorPct)}</strong>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Protection Floor Price</span>
              <strong>{Number.isFinite(configuredFloorPrice) ? `$${formatUsd(configuredFloorPrice)}` : "—"}</strong>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Tenor</span>
              <strong>{selectedTier.expiryDays} days (fixed)</strong>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Auto Renew</span>
              <label className="pilot-checkbox">
                <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
                <span>{autoRenew ? "Enabled" : "Disabled"}</span>
              </label>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Advanced Venue Settings</span>
              <button
                className="btn btn-secondary pilot-inline-btn"
                type="button"
                onClick={() => setShowAdvanced((value) => !value)}
                disabled={busy}
              >
                {showAdvanced ? "Hide" : "Show"}
              </button>
            </div>

            {showAdvanced && (
              <div className="pilot-form-row">
                <span className="pilot-label">Venue Instrument (Optional)</span>
                <input
                  className="input pilot-input"
                  value={instrumentId}
                  onChange={(e) => setInstrumentId(e.target.value)}
                />
              </div>
            )}

            {!canQuote && (
              <div className="disclaimer danger">
                Check inputs: protection amount must be positive and cannot exceed position size.
              </div>
            )}
          </div>
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>Quote</h4>
            {quoteState === "fetching" && <span className="pill">Fetching optimal price</span>}
            {quoteState === "ready" && quoteTimeLeft > 0 && (
              <span className="pill pill-warning">Expires in {formatCountdown(quoteTimeLeft)}</span>
            )}
            {quoteState === "expired" && <span className="pill pill-warning">Quote expired</span>}
          </div>
          <div className={`quote-card quote-card-${quoteState}`}>
            {quoteState === "idle" && (
              <div className="muted">Request Quote to fetch a live premium and lock window.</div>
            )}
            {quoteState === "fetching" && (
              <div className="muted">
                <span className="spinner" />
                Fetching optimal protection quote...
              </div>
            )}
            {(quoteState === "ready" || quoteState === "expired") && quote && (
              <>
                <div className="muted">
                  Premium <strong>${formatUsd(quote.quote.premium)}</strong> · Venue {quote.quote.venue}
                </div>
                <div className="muted">
                  Tier {quote.tierName} · Drawdown {formatPct(quote.drawdownFloorPct)} · Floor $
                  {formatUsd(quote.floorPrice)}
                </div>
                <div className="muted">
                  Reference {formatUsd(quote.entrySnapshot.price)} ({quote.entrySnapshot.source}) at{" "}
                  {new Date(quote.entrySnapshot.timestamp).toLocaleString()}
                </div>
              </>
            )}
          </div>
          {quoteCapWarning && (
            <div className="disclaimer danger">
              Daily protection limit reached for this trader. Quote is shown for reference; confirmation is blocked
              until the next UTC day.
            </div>
          )}
        </div>

        <div className="section">
          <div className="pilot-actions">
            <button className="btn btn-secondary pilot-action-btn" disabled={busy || !canQuote} onClick={requestQuote}>
              {quoteState === "fetching" ? "Fetching..." : "Request Quote"}
            </button>
            <button className="cta pilot-action-btn" disabled={busy || !canActivate} onClick={activateProtection}>
              Confirm Protection
            </button>
          </div>
          {error && <div className="disclaimer danger">{error}</div>}
        </div>

        {protection && (
          <div className="section">
            <div className="section-title-row">
              <h4>Protection Active</h4>
              <button className="btn pilot-inline-btn" disabled={busy} onClick={() => setShowProtectionModal(true)}>
                Open Monitor
              </button>
            </div>
            <div className="muted">Protection ID: {protection.id}</div>
            <div className="muted">
              Entry ${formatUsd(protection.entryPrice)} · Floor {displayedFloor ? `$${formatUsd(displayedFloor)}` : "—"}
            </div>
            <div className="muted">
              Premium {protection.premium ? `$${formatUsd(protection.premium)}` : "—"} · Expires{" "}
              {new Date(protection.expiryAt).toLocaleString()}
            </div>
            {renewalChip && <div className="disclaimer">{renewalChip}</div>}
          </div>
        )}
      </div>

      {showProtectionModal && protection && (
        <div className="modal" onClick={() => setShowProtectionModal(false)}>
          <div className="modal-card pilot-monitor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Protection Monitor</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowProtectionModal(false)}>
                x
              </button>
            </div>
            <div className="muted pilot-monitor-subtitle">
              Protected position {protection.id} · Auto-refresh every 10s
              {lastUpdatedAt ? ` · Updated ${lastUpdatedAt.toLocaleTimeString()}` : ""}
            </div>
            <div className="pilot-monitor-grid">
              <div className="pilot-monitor-card">
                <div className="label">Reference BTC Price</div>
                <div className="value">${formatUsd(referencePrice)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Entry Price</div>
                <div className="value">${formatUsd(protection.entryPrice)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Protection Floor Price</div>
                <div className="value">{displayedFloor ? `$${formatUsd(displayedFloor)}` : "—"}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Distance to Trigger</div>
                <div className={`value ${distanceToTriggerPct < 3 ? "danger" : ""}`}>
                  {Number.isFinite(distanceToTriggerPct) ? `${distanceToTriggerPct.toFixed(2)}%` : "—"}
                </div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Option Mark (Indicative)</div>
                <div className="value">${formatUsd(indicativeOptionMark)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Est. Protection Value at Trigger</div>
                <div className="value">
                  {Number.isFinite(maxTriggerProtectionValue) ? `$${formatUsd(maxTriggerProtectionValue)}` : "—"}
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowProtectionModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenewModal && (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-title">
                <h3>Renewal Required</h3>
              </div>
            </div>
            <div className="modal-body">
              <p>
                The renewal window has started and auto-renew is off. Choose how to proceed.
              </p>
              <div className="modal-actions">
                <button className="btn" disabled={busy} onClick={() => submitRenewDecision("expire")}>
                  Let protection expire
                </button>
                <button className="cta" disabled={busy} onClick={() => submitRenewDecision("renew")}>
                  Renew protection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

