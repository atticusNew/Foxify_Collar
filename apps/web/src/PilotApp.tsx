import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "./config";

type QuoteResult = {
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
    source: string;
    timestamp: string;
  };
};

type ProtectionRecord = {
  id: string;
  status: string;
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

export function PilotApp() {
  const [userId, setUserId] = useState("foxify-user-001");
  const [exposureNotional, setExposureNotional] = useState("50000");
  const [protectedNotional, setProtectedNotional] = useState("50000");
  const [tenorDays, setTenorDays] = useState("7");
  const [autoRenew, setAutoRenew] = useState(false);
  const [instrumentId, setInstrumentId] = useState("BTC-USD-7D-P");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [protection, setProtection] = useState<ProtectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);

  const exposureValue = Number(exposureNotional || 0);
  const protectedValue = Number(protectedNotional || 0);
  const canQuote =
    Number.isFinite(exposureValue) &&
    exposureValue > 0 &&
    Number.isFinite(protectedValue) &&
    protectedValue > 0 &&
    protectedValue <= exposureValue;

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
          protectedNotional: protectedValue,
          foxifyExposureNotional: exposureValue,
          instrumentId,
          marketId: "BTC-USD"
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
    if (!canQuote) return;
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
          instrumentId,
          marketId: "BTC-USD",
          tenorDays: Number(tenorDays || 7),
          autoRenew
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
              <span>Instrument</span>
              <input
                className="input"
                value={instrumentId}
                onChange={(e) => setInstrumentId(e.target.value)}
              />
            </div>
            <div className="row">
              <span>Tenor (days)</span>
              <input className="input" value={tenorDays} onChange={(e) => setTenorDays(e.target.value)} />
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
              <button className="cta" disabled={busy || !canQuote} onClick={activateProtection}>
                Activate Protection
              </button>
            </div>
          </div>
          {quote && (
            <div className="section">
              <h4>Latest Quote</h4>
              <div className="muted">
                Venue {quote.quote.venue} · Instrument {quote.quote.instrumentId} · Premium $
                {formatUsd(quote.quote.premium)}
              </div>
              <div className="muted">
                Entry snapshot {quote.entrySnapshot.price} ({quote.entrySnapshot.source}) at{" "}
                {new Date(quote.entrySnapshot.timestamp).toLocaleString()}
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
            <div className="muted">Protected Notional: ${formatUsd(protection.protectedNotional)}</div>
            <div className="muted">Exposure Notional: ${formatUsd(protection.foxifyExposureNotional)}</div>
            <div className="muted">Entry Price: {protection.entryPrice ? `$${formatUsd(protection.entryPrice)}` : "—"}</div>
            <div className="muted">Premium Due: {protection.premium ? `$${formatUsd(protection.premium)}` : "—"}</div>
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

