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

export function PilotApp() {
  const [userId, setUserId] = useState("foxify-user-001");
  const [tiers, setTiers] = useState<TierLevel[]>(DEFAULT_TIERS);
  const [tierName, setTierName] = useState(DEFAULT_TIERS[0].name);
  const [exposureNotional, setExposureNotional] = useState("50000");
  const [protectedNotional, setProtectedNotional] = useState("50000");
  const [entryPrice, setEntryPrice] = useState("100000");
  const [tenorDays, setTenorDays] = useState(String(DEFAULT_TIERS[0].expiryDays));
  const [autoRenew, setAutoRenew] = useState(false);
  const [instrumentId, setInstrumentId] = useState("BTC-USD-7D-P");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [protection, setProtection] = useState<ProtectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.name === tierName) || DEFAULT_TIERS[0],
    [tierName, tiers]
  );

  const exposureValue = Number(exposureNotional || 0);
  const protectedValue = Number(protectedNotional || 0);
  const entryValue = Number(entryPrice || 0);
  const canQuote =
    Number.isFinite(exposureValue) &&
    exposureValue > 0 &&
    Number.isFinite(protectedValue) &&
    protectedValue > 0 &&
    protectedValue <= exposureValue &&
    Number.isFinite(entryValue) &&
    entryValue > 0;
  const quoteFresh =
    quote?.quote?.expiresAt ? Date.parse(quote.quote.expiresAt) > Date.now() : false;
  const canActivate = canQuote && Boolean(quote?.quote?.quoteId) && quoteFresh;

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
          setTenorDays(String(parsed[0].expiryDays));
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
    setTenorDays(String(selectedTier.expiryDays));
  }, [selectedTier.name, selectedTier.expiryDays]);

  useEffect(() => {
    setQuote(null);
  }, [userId, selectedTier.name, selectedTier.drawdownFloorPct, exposureNotional, protectedNotional, entryPrice, instrumentId]);

  useEffect(() => {
    if (!protection?.id) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/pilot/protections/${protection.id}`);
        if (!res.ok) return;
        const payload = await res.json();
        if (payload?.protection) {
          setProtection(payload.protection as ProtectionRecord);
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
    } catch (err: any) {
      setError(String(err?.message || "Price temporarily unavailable, please retry."));
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
          tenorDays: Number(tenorDays || 7),
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
      setShowRenewModal(false);
    } catch (err: any) {
      setError(String(err?.message || "Protection activation failed."));
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
      setError(String(err?.message || "Failed to process renewal decision."));
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

  return (
    <div className="shell">
      <div className="card">
        <div className="title">Foxify Pilot Protection</div>
        <div className="section">
          <h4>Create Protection</h4>
          <div className="recommendation">
            <div className="row">
              <span>User ID (not stored raw)</span>
              <input className="input" value={userId} onChange={(e) => setUserId(e.target.value)} />
            </div>
            <div className="row">
              <span>Tier</span>
              <select
                className="input"
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
            <div className="row row-align">
              <span>Drawdown Floor</span>
              <strong>{formatPct(selectedTier.drawdownFloorPct)}</strong>
            </div>
            <div className="row">
              <span>Foxify Exposure Notional (USDC)</span>
              <input
                className="input"
                value={exposureNotional}
                onChange={(e) => setExposureNotional(e.target.value)}
              />
            </div>
            <div className="row">
              <span>Protected Notional (USDC)</span>
              <input
                className="input"
                value={protectedNotional}
                onChange={(e) => setProtectedNotional(e.target.value)}
              />
            </div>
            <div className="row">
              <span>Entry Price (manual)</span>
              <input
                className="input"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
              />
            </div>
            <div className="row">
              <span>Instrument</span>
              <input
                className="input"
                value={instrumentId}
                onChange={(e) => setInstrumentId(e.target.value)}
              />
            </div>
            <div className="row row-align">
              <span>Tenor (days)</span>
              <strong>{selectedTier.expiryDays} (fixed)</strong>
            </div>
            <div className="row row-align">
              <span>Auto Renew</span>
              <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
            </div>
            {!canQuote && (
              <div className="disclaimer danger">
                Protected notional must be positive and not exceed Foxify exposure.
              </div>
            )}
            <div className="row">
              <button className="btn" disabled={busy || !canQuote} onClick={requestQuote}>
                Get Quote
              </button>
              <button className="cta" disabled={busy || !canActivate} onClick={activateProtection}>
                Activate Protection
              </button>
            </div>
            {quote && !quoteFresh && (
              <div className="disclaimer danger">Quote expired. Please request a new quote.</div>
            )}
          </div>
          {quote && (
            <div className="section">
              <h4>Latest Quote</h4>
              <div className="muted">
                Venue {quote.quote.venue} · Instrument {quote.quote.instrumentId} · Premium $
                {formatUsd(quote.quote.premium)}
              </div>
              <div className="muted">
                Tier {quote.tierName} · Drawdown {formatPct(quote.drawdownFloorPct)} · Floor $
                {formatUsd(quote.floorPrice)}
              </div>
              <div className="muted">
                Entry snapshot {quote.entrySnapshot.price} ({quote.entrySnapshot.source}) at{" "}
                {new Date(quote.entrySnapshot.timestamp).toLocaleString()}
              </div>
              <div className="muted">
                Manual entry input {quote.entryInputPrice || entryPrice} · Quote expires{" "}
                {new Date(quote.quote.expiresAt).toLocaleTimeString()}
              </div>
            </div>
          )}
          {error && <div className="disclaimer danger">{error}</div>}
        </div>

        {protection && (
          <div className="section">
            <h4>Active Protection</h4>
            <div className="muted">Protection ID: {protection.id}</div>
            <div className="muted">Status: {protection.status}</div>
            <div className="muted">Tier: {protection.tierName ?? selectedTier.name}</div>
            <div className="muted">Drawdown Floor: {formatPct(displayedDrawdownPct)}</div>
            <div className="muted">Floor Price: {displayedFloor ? `$${formatUsd(displayedFloor)}` : "—"}</div>
            <div className="muted">Protected Notional: ${formatUsd(protection.protectedNotional)}</div>
            <div className="muted">Exposure Notional: ${formatUsd(protection.foxifyExposureNotional)}</div>
            <div className="muted">
              Entry Price: {protection.entryPrice ? `$${formatUsd(protection.entryPrice)}` : "—"}
            </div>
            <div className="muted">
              Premium Due: {protection.premium ? `$${formatUsd(protection.premium)}` : "—"}
            </div>
            <div className="muted">Expiry At: {new Date(protection.expiryAt).toLocaleString()}</div>
          </div>
        )}
      </div>

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

