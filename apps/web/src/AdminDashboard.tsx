import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type AdminAuth = { token: string };

type PlatformHealth = {
  status: string;
  checks: {
    db: { status: string; detail?: string };
    price: { status: string; marketId?: string; source?: string; detail?: string };
    venue: Record<string, unknown>;
  };
};

type MonitorStatus = {
  status: string;
  healthy: boolean;
  consecutiveFailures: number;
  fillRate?: number;
  lastFillAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
};

type AdminMetrics = {
  totalProtections: number;
  activeProtections: number;
  totalPremiumCollectedUsdc: string;
  totalPayoutDueUsdc: string;
  totalPayoutSettledUsdc: string;
  reserveAfterOpenPayoutLiabilityUsdc: string;
  startingReserveUsdc: string;
  protections?: ProtectionSummary[];
};

type ProtectionSummary = {
  id: string;
  status: string;
  tierName: string;
  slPct: number | null;
  hedgeStatus: string | null;
  regime: string | null;
  dvolAtPurchase: number | null;
  protectedNotional: string;
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
  side: string | null;
  size: string | null;
  executionPrice: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type ExecutionQuality = {
  day: string;
  venue: string;
  hedgeMode: string;
  avgSlippageBps: string | null;
  p95SlippageBps: string | null;
  fillSuccessRatePct: string | null;
  sampleCount: number;
};

type Alert = {
  type: string;
  severity: string;
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

type TreasurySnapshot = {
  balance?: string;
  currency?: string;
  tradingAccountId?: string;
};

// ─── API helpers ─────────────────────────────────────────────────────

const adminApi = async <T = unknown>(
  path: string,
  token: string,
  opts?: RequestInit
): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...opts?.headers,
    },
  });
  let json: any;
  try { json = await res.json(); } catch { throw new Error(res.ok ? "invalid_response" : `HTTP ${res.status}`); }
  if (!res.ok) throw new Error(json?.reason || json?.message || `HTTP ${res.status}`);
  return json as T;
};

const fmtUsd = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return "$0.00";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
};

// ─── Login gate ──────────────────────────────────────────────────────

function AdminLogin({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await adminApi("/pilot/monitor/status", token.trim());
      sessionStorage.setItem("pilot_admin_token", token.trim());
      onLogin(token.trim());
    } catch (e: any) {
      setError(e?.message === "unauthorized" ? "Invalid admin token" : `Connection failed: ${e?.message || "unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 400 }}>
        <div className="title">
          <span>Admin Dashboard</span>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <input
              type="password"
              placeholder="Admin token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--card-2)",
                color: "var(--text)", fontSize: 14, outline: "none",
              }}
            />
          </div>
          {error && <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
              background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Verifying..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Settlement confirmation dialog ──────────────────────────────────

function ConfirmDialog({
  title, message, onConfirm, onCancel, loading,
}: {
  title: string; message: string;
  onConfirm: () => void; onCancel: () => void; loading: boolean;
}) {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.7)", display: "grid", placeItems: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: 14, padding: 24, maxWidth: 400, width: "90%",
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={loading}
            style={{
              flex: 1, padding: "10px", borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--card-2)", color: "var(--text)", fontSize: 13, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            style={{
              flex: 1, padding: "10px", borderRadius: 8, border: "none",
              background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Processing..." : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main dashboard ──────────────────────────────────────────────────

function Dashboard({ token }: { token: string }) {
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [execQuality, setExecQuality] = useState<ExecutionQuality[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>("");

  // Settlement dialog state
  const [settlementDialog, setSettlementDialog] = useState<{
    type: "premium" | "payout";
    protectionId: string;
    amount: string;
  } | null>(null);
  const [settlementLoading, setSettlementLoading] = useState(false);

  const [activePanel, setActivePanel] = useState<"health" | "protections" | "quality" | "alerts" | "config">("health");

  // Config display
  const [healthConfig, setHealthConfig] = useState<Record<string, unknown> | null>(null);

  const [protectionsList, setProtectionsList] = useState<ProtectionSummary[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const livePriceRef = useRef(0);

  useEffect(() => {
    let on = true;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/pilot/reference-price`);
        const d = await res.json();
        if (on && d.status === "ok") {
          const p = Number(d.reference?.price ?? 0);
          if (p > 0) { setLivePrice(p); livePriceRef.current = Date.now(); }
        }
      } catch { /* best effort */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { on = false; clearInterval(id); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [healthRes, statusRes, metricsRes, qualityRes, alertsRes, protectionsRes] = await Promise.allSettled([
        adminApi<PlatformHealth>("/pilot/health", token).catch(() => null),
        adminApi<MonitorStatus>("/pilot/monitor/status", token),
        adminApi<{ metrics: AdminMetrics }>("/pilot/admin/metrics?scope=all", token),
        adminApi<{ records: ExecutionQuality[] }>("/pilot/admin/diagnostics/execution-quality?lookbackDays=30", token),
        adminApi<{ alerts: Alert[] }>("/pilot/monitor/alerts?limit=20", token),
        adminApi<{ status: string; protections: ProtectionSummary[] }>("/pilot/protections?limit=50", token),
      ]);

      if (healthRes.status === "fulfilled" && healthRes.value) {
        setHealth(healthRes.value);
        setHealthConfig(healthRes.value as unknown as Record<string, unknown>);
      }
      if (statusRes.status === "fulfilled") setMonitorStatus(statusRes.value);
      if (metricsRes.status === "fulfilled") setMetrics(metricsRes.value.metrics);
      if (qualityRes.status === "fulfilled") setExecQuality(qualityRes.value.records || []);
      if (alertsRes.status === "fulfilled") setAlerts(alertsRes.value.alerts || []);
      if (protectionsRes.status === "fulfilled") setProtectionsList(protectionsRes.value.protections || []);
      setLastRefresh(new Date().toLocaleTimeString());
      const failures = [healthRes, statusRes, metricsRes, qualityRes, alertsRes, protectionsRes]
        .filter(r => r.status === "rejected");
      setError(failures.length > 0 ? `${failures.length} endpoint(s) unavailable` : null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleTreasuryCheck = async () => {
    setTreasuryLoading(true);
    try {
      const res = await adminApi<{ treasury: TreasurySnapshot }>("/pilot/monitor/treasury-check", token, { method: "POST" });
      setTreasury(res.treasury);
    } catch {
      setTreasury(null);
    } finally {
      setTreasuryLoading(false);
    }
  };

  const handleSettlement = async () => {
    if (!settlementDialog) return;
    setSettlementLoading(true);
    try {
      const path = settlementDialog.type === "premium"
        ? `/pilot/admin/protections/${settlementDialog.protectionId}/premium-settled`
        : `/pilot/admin/protections/${settlementDialog.protectionId}/payout-settled`;
      const body = settlementDialog.type === "premium"
        ? { amount: Number(settlementDialog.amount) }
        : { amount: Number(settlementDialog.amount) };
      await adminApi(path, token, { method: "POST", body: JSON.stringify(body) });
      setSettlementDialog(null);
      refresh();
    } catch (e: any) {
      alert(`Settlement failed: ${e.message}`);
    } finally {
      setSettlementLoading(false);
    }
  };

  const panels = [
    { id: "health" as const, label: "Health" },
    { id: "protections" as const, label: "Protections" },
    { id: "quality" as const, label: "Execution" },
    { id: "alerts" as const, label: "Alerts" },
    { id: "config" as const, label: "Config" },
  ];

  const statusBadge = (status: string) => {
    const color = status === "ok" || status === "healthy" ? "var(--success)" : "var(--danger)";
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 11, fontWeight: 600, color,
        background: status === "ok" || status === "healthy" ? "rgba(54,211,141,0.12)" : "rgba(255,107,107,0.12)",
        padding: "2px 8px", borderRadius: 999,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
        {status.toUpperCase()}
      </span>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              <span style={{ color: "var(--accent)" }}>Atticus</span> Admin
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              Last refresh: {lastRefresh || "loading..."}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {livePrice && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, background: "var(--card-2)", border: "1px solid var(--border)" }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>BTC</span>
                <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>{fmtUsd(livePrice)}</span>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: (Date.now() - livePriceRef.current) < 5000 ? "var(--success)" : "var(--muted)" }} />
              </div>
            )}
            <button
              onClick={refresh}
              style={{
                padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
                background: "var(--card-2)", color: "var(--text)", fontSize: 12, cursor: "pointer",
              }}
            >
              Refresh
            </button>
            <button
              onClick={() => { sessionStorage.removeItem("pilot_admin_token"); window.location.reload(); }}
              style={{
                padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
                background: "var(--card-2)", color: "var(--muted)", fontSize: 12, cursor: "pointer",
              }}
            >
              Sign Out
            </button>
          </div>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 14, padding: 10, background: "rgba(255,107,107,0.08)", borderRadius: 8 }}>
            {error}
          </div>
        )}

        {/* Nav tabs */}
        <div style={{ display: "flex", gap: 0, marginBottom: 18, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
          {panels.map((p) => (
            <button
              key={p.id}
              onClick={() => setActivePanel(p.id)}
              style={{
                flex: 1, padding: "9px 0", border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
                background: activePanel === p.id ? "rgba(184,90,28,0.15)" : "var(--card-2)",
                color: activePanel === p.id ? "var(--accent)" : "var(--muted)",
                transition: "all 0.15s ease",
              }}
            >
              {p.label}
              {p.id === "alerts" && alerts.length > 0 && (
                <span style={{
                  marginLeft: 4, fontSize: 10, background: "var(--danger)",
                  color: "#fff", borderRadius: 999, padding: "1px 5px",
                }}>
                  {alerts.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ─── Panel: Health ─── */}
        {activePanel === "health" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {/* System health */}
            <div className="card">
              <div className="title" style={{ fontSize: 13 }}>Platform Health</div>
              {health ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Overall</span>
                    {statusBadge(health.status)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Database</span>
                    {statusBadge(health.checks?.db?.status || "unknown")}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Price Feed</span>
                    {statusBadge(health.checks?.price?.status || "unknown")}
                  </div>
                  {health.checks?.price?.source && (
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: -4 }}>
                      Source: {String(health.checks.price.source)}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--muted)", padding: "10px 0" }}>
                  {monitorStatus ? "Health endpoint returned degraded — check Deribit connectivity in Render logs" : "Loading..."}
                </div>
              )}
            </div>

            {/* Monitor */}
            <div className="card">
              <div className="title" style={{ fontSize: 13 }}>Monitor</div>
              {monitorStatus && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Healthy</span>
                    {statusBadge(monitorStatus.healthy ? "ok" : "degraded")}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Consecutive Failures</span>
                    <span style={{
                      fontSize: 14, fontWeight: 600,
                      color: monitorStatus.consecutiveFailures > 0 ? "var(--danger)" : "var(--success)",
                    }}>
                      {monitorStatus.consecutiveFailures}
                    </span>
                  </div>
                  {monitorStatus.fillRate !== undefined && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>Fill Rate</span>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        {(monitorStatus.fillRate * 100).toFixed(1)}%
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Treasury */}
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <div className="title" style={{ fontSize: 13 }}>
                <span>Treasury</span>
                <button
                  onClick={handleTreasuryCheck}
                  disabled={treasuryLoading}
                  style={{
                    padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--card-2)", color: "var(--muted)", fontSize: 11, cursor: "pointer",
                  }}
                >
                  {treasuryLoading ? "Checking..." : "Check Balance"}
                </button>
              </div>
              {metrics && (
                <div className="stats" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                  <div className="stat">
                    <div className="label">Starting Reserve</div>
                    <div className="value" style={{ fontSize: 13 }}>{fmtUsd(metrics.startingReserveUsdc)}</div>
                  </div>
                  <div className="stat">
                    <div className="label">After Liabilities</div>
                    <div className="value" style={{ fontSize: 13 }}>{fmtUsd(metrics.reserveAfterOpenPayoutLiabilityUsdc)}</div>
                  </div>
                  <div className="stat">
                    <div className="label">Premium Collected</div>
                    <div className="value" style={{ fontSize: 13, color: "var(--success)" }}>{fmtUsd(metrics.totalPremiumCollectedUsdc)}</div>
                  </div>
                  <div className="stat">
                    <div className="label">Payouts Due</div>
                    <div className="value" style={{ fontSize: 13, color: "var(--danger)" }}>{fmtUsd(metrics.totalPayoutDueUsdc)}</div>
                  </div>
                </div>
              )}
              {treasury && treasury.balance && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                  Deribit account balance: {fmtUsd(treasury.balance)} {treasury.currency || "USDC"}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Panel: Protections ─── */}
        {activePanel === "protections" && (
          <div className="card card-wide">
            <div className="title" style={{ fontSize: 13 }}>
              <span>
                Protections
                {metrics && (
                  <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>
                    {metrics.activeProtections} active / {metrics.totalProtections} total
                  </span>
                )}
              </span>
            </div>
            {protectionsList.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      {["ID", "Status", "Type", "SL%", "AR", "Notional", "Entry", "Floor", "Strike", "Gap", "Premium", "Hedge", "Spread", "Payout", "TP $", "Time", "TP Status", "Actions"].map((h) => (
                        <th key={h} style={{ padding: "8px 6px", textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {protectionsList.map((p) => {
                      const isActive = p.status === "active" || p.status === "quoted";
                      const isTriggered = p.status === "triggered";
                      const isReconcile = p.status === "reconcile_pending";
                      const isFailed = p.status === "activation_failed";
                      const statusLabel: Record<string, string> = {
                        active: "Protected",
                        triggered: "Triggered",
                        reconcile_pending: "⚠ Processing",
                        activation_failed: "Failed",
                        pending_activation: "Activating",
                        expired_otm: "Expired",
                        expired_itm: "Settled",
                        awaiting_expiry_price: "Expiring",
                        awaiting_renew_decision: "Renewing",
                        cancelled: "Cancelled"
                      };
                      const execPrice = Number(p.executionPrice || 0);
                      const size = Number(p.size || 0);
                      const hedgeCost = execPrice > 0 && size > 0 ? execPrice * size : 0;
                      const clientPremium = Number(p.premium || 0);
                      const spread = clientPremium > 0 && hedgeCost > 0 ? clientPremium - hedgeCost : null;
                      const payout = Number(p.payoutDueAmount || 0);
                      const payoutSettled = Number(p.payoutSettledAmount || 0);
                      const payoutStatus = payout > 0 ? (payoutSettled > 0 ? "Settled" : "Due") : "";
                      const msLeft = new Date(p.expiryAt).getTime() - Date.now();
                      const timeLeft = msLeft <= 0 ? "Expired" : msLeft > 86400000 ? `${Math.floor(msLeft / 86400000)}d ${Math.floor((msLeft % 86400000) / 3600000)}h` : `${Math.floor(msLeft / 3600000)}h ${Math.floor((msLeft % 3600000) / 60000)}m`;
                      const rawSide = String(p.metadata?.protectionType || p.side || "long");
                      const protType = rawSide === "short" ? "short" : "long";
                      const strikeMatch = String(p.instrumentId || "").match(/(\d+)-(P|C)$/);
                      const hedgeStrike = strikeMatch ? Number(strikeMatch[1]) : null;
                      const floorNum = Number(p.floorPrice || 0);
                      const strikeGap = hedgeStrike && floorNum > 0 ? hedgeStrike - floorNum : null;
                      return (
                        <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "8px 6px", fontFamily: "monospace", fontSize: 10 }}>{p.id.slice(0, 8)}...</td>
                          <td style={{ padding: "8px 6px" }}>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999,
                              background: isActive ? "rgba(54,211,141,0.12)" : isTriggered ? "rgba(255,107,107,0.12)" : isReconcile ? "rgba(240,185,11,0.12)" : isFailed ? "rgba(255,107,107,0.08)" : "rgba(168,168,173,0.12)",
                              color: isActive ? "var(--success)" : isTriggered ? "var(--danger)" : isReconcile ? "#f0b90b" : isFailed ? "var(--danger)" : "var(--muted)",
                            }}>
                              {statusLabel[p.status] || p.status}
                            </span>
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: protType === "short" ? "var(--danger)" : "var(--success)" }}>{protType}</td>
                          <td style={{ padding: "8px 6px", fontSize: 11, fontWeight: 600 }}>{p.slPct ? `${p.slPct}%` : p.tierName || "—"}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center" }}>
                            {p.autoRenew ? <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 4px", borderRadius: 999, background: "rgba(96,165,250,0.15)", color: "#60a5fa" }}>↻</span> : <span style={{ fontSize: 9, color: "var(--muted)" }}>—</span>}
                          </td>
                          <td style={{ padding: "8px 6px" }}>{fmtUsd(p.protectedNotional)}</td>
                          <td style={{ padding: "8px 6px" }}>{p.entryPrice ? fmtUsd(p.entryPrice) : "—"}</td>
                          <td style={{ padding: "8px 6px" }}>{p.floorPrice ? fmtUsd(p.floorPrice) : "—"}</td>
                          <td style={{ padding: "8px 6px" }}>{hedgeStrike ? fmtUsd(hedgeStrike) : "—"}</td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: strikeGap !== null ? (strikeGap >= 0 ? "var(--success)" : "var(--danger)") : "var(--muted)" }}>
                            {strikeGap !== null ? `${strikeGap >= 0 ? "+" : ""}${fmtUsd(strikeGap)}` : "—"}
                          </td>
                          <td style={{ padding: "8px 6px" }}>{clientPremium > 0 ? fmtUsd(clientPremium) : "—"}</td>
                          <td style={{ padding: "8px 6px" }}>{hedgeCost > 0 ? fmtUsd(hedgeCost) : "—"}</td>
                          <td style={{ padding: "8px 6px", color: spread !== null ? (spread >= 0 ? "var(--success)" : "var(--danger)") : "var(--muted)" }}>
                            {spread !== null ? fmtUsd(spread) : "—"}
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10 }}>
                            {payout > 0 ? <><span style={{ color: "var(--danger)" }}>{fmtUsd(payout)}</span> <span style={{ fontSize: 9, color: payoutStatus === "Settled" ? "var(--success)" : "var(--muted)" }}>{payoutStatus}</span></> : "—"}
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: "var(--success)" }}>
                            {(() => {
                              const sr = (p.metadata as any)?.sellResult;
                              const tp = sr?.totalProceeds ? Number(sr.totalProceeds) : 0;
                              return tp > 0 ? fmtUsd(tp) : "—";
                            })()}
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: msLeft < 3600000 && msLeft > 0 ? "var(--danger)" : "var(--muted)" }}>{(isActive || isTriggered) ? timeLeft : "—"}</td>
                          <td style={{ padding: "8px 6px", fontSize: 10 }}>
                            {(() => {
                              const isExpired = p.status?.startsWith("expired") || false;
                              const tpLabel =
                                p.hedgeStatus === "tp_sold" ? "TP Sold"
                                : p.hedgeStatus === "expired_settled" ? "Settled"
                                : p.hedgeStatus === "active" && isTriggered ? "Awaiting TP"
                                : p.hedgeStatus === "active" && isExpired ? "Expired (no TP)"
                                : p.hedgeStatus || "—";
                              const tpBg =
                                p.hedgeStatus === "tp_sold" ? "rgba(54,211,141,0.12)"
                                : p.hedgeStatus === "active" && isTriggered ? "rgba(240,185,11,0.12)"
                                : p.hedgeStatus === "active" && isExpired ? "rgba(168,168,173,0.12)"
                                : "rgba(168,168,173,0.08)";
                              const tpColor =
                                p.hedgeStatus === "tp_sold" ? "var(--success)"
                                : p.hedgeStatus === "expired_settled" ? "var(--muted)"
                                : p.hedgeStatus === "active" && isTriggered ? "#f0b90b"
                                : "var(--muted)";
                              return (
                                <span style={{ padding: "1px 5px", borderRadius: 999, fontSize: 9, fontWeight: 600, background: tpBg, color: tpColor }}>
                                  {tpLabel}
                                </span>
                              );
                            })()}
                          </td>
                          <td style={{ padding: "8px 6px" }}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                onClick={() => setSettlementDialog({
                                  type: "premium", protectionId: p.id,
                                  amount: String(p.premium || 0),
                                })}
                                style={{
                                  padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)",
                                  background: "var(--card-2)", color: "var(--success)", fontSize: 10,
                                  cursor: "pointer", whiteSpace: "nowrap",
                                }}
                              >
                                Settle Premium
                              </button>
                              {Number(p.payoutDueAmount || 0) > 0 && (
                                <button
                                  onClick={() => setSettlementDialog({
                                    type: "payout", protectionId: p.id,
                                    amount: String(p.payoutDueAmount || 0),
                                  })}
                                  style={{
                                    padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)",
                                    background: "var(--card-2)", color: "var(--danger)", fontSize: 10,
                                    cursor: "pointer", whiteSpace: "nowrap",
                                  }}
                                >
                                  Settle Payout
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {protectionsList.length > 0 && (() => {
                      const allPremium = protectionsList.reduce((s, p) => s + Number(p.premium || 0), 0);
                      const allHedge = protectionsList.reduce((s, p) => {
                        const ep = Number(p.executionPrice || 0);
                        const sz = Number(p.size || 0);
                        return s + (ep > 0 && sz > 0 ? ep * sz : 0);
                      }, 0);
                      const allPayout = protectionsList.reduce((s, p) => s + Number(p.payoutDueAmount || 0), 0);
                      const allTpRecovery = protectionsList.reduce((s, p) => {
                        const sr = (p.metadata as any)?.sellResult;
                        return s + (sr?.totalProceeds ? Number(sr.totalProceeds) : 0);
                      }, 0);
                      const allSpread = allPremium - allHedge;
                      const netPnl = allPremium - allHedge - allPayout + allTpRecovery;
                      const triggered = protectionsList.filter(p => p.status === "triggered").length;
                      const active = protectionsList.filter(p => p.status === "active").length;
                      const tpSold = protectionsList.filter(p => p.hedgeStatus === "tp_sold").length;
                      return (
                        <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 600, fontSize: 11 }}>
                          <td style={{ padding: "8px 6px" }} colSpan={9}>TOTALS — {active} active, {triggered} triggered, {tpSold} TP sold</td>
                          <td style={{ padding: "8px 6px" }}>{fmtUsd(allPremium)}</td>
                          <td style={{ padding: "8px 6px" }}>{fmtUsd(allHedge)}</td>
                          <td style={{ padding: "8px 6px", color: allSpread >= 0 ? "var(--success)" : "var(--danger)" }}>{fmtUsd(allSpread)}</td>
                          <td style={{ padding: "8px 6px", color: "var(--danger)" }}>{allPayout > 0 ? fmtUsd(allPayout) : "—"}</td>
                          <td style={{ padding: "8px 6px", color: "var(--success)" }}>{allTpRecovery > 0 ? fmtUsd(allTpRecovery) : "—"}</td>
                          <td style={{ padding: "8px 6px", color: netPnl >= 0 ? "var(--success)" : "var(--danger)" }} colSpan={3}>Net: {fmtUsd(netPnl)}</td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>
                No protections found
              </div>
            )}
          </div>
        )}

        {/* ─── Panel: Execution Quality ─── */}
        {activePanel === "quality" && (
          <div className="card card-wide">
            <div className="title" style={{ fontSize: 13 }}>Execution Quality (30d)</div>
            {execQuality.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      {["Date", "Venue", "Hedge Mode", "Fill Rate", "Avg Slippage (bps)", "P95 Slippage", "Samples"].map((h) => (
                        <th key={h} style={{ padding: "8px 6px", textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {execQuality.map((eq, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px 6px" }}>{eq.day}</td>
                        <td style={{ padding: "8px 6px" }}>{eq.venue}</td>
                        <td style={{ padding: "8px 6px" }}>{eq.hedgeMode}</td>
                        <td style={{ padding: "8px 6px", color: Number(eq.fillSuccessRatePct || 0) > 80 ? "var(--success)" : "var(--danger)" }}>
                          {eq.fillSuccessRatePct ? `${Number(eq.fillSuccessRatePct).toFixed(1)}%` : "—"}
                        </td>
                        <td style={{ padding: "8px 6px" }}>
                          {eq.avgSlippageBps ? `${Number(eq.avgSlippageBps).toFixed(2)}` : "—"}
                        </td>
                        <td style={{ padding: "8px 6px" }}>
                          {eq.p95SlippageBps ? `${Number(eq.p95SlippageBps).toFixed(2)}` : "—"}
                        </td>
                        <td style={{ padding: "8px 6px" }}>{eq.sampleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>
                No execution quality data available
              </div>
            )}
          </div>
        )}

        {/* ─── Panel: Alerts ─── */}
        {activePanel === "alerts" && (
          <div className="card card-wide">
            <div className="title" style={{ fontSize: 13 }}>Recent Alerts</div>
            {alerts.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {alerts.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 10, borderRadius: 8,
                      border: `1px solid ${a.severity === "critical" ? "rgba(255,107,107,0.3)" : a.severity === "warning" ? "rgba(242,166,90,0.3)" : "var(--border)"}`,
                      background: a.severity === "critical" ? "rgba(255,107,107,0.04)" : a.severity === "warning" ? "rgba(242,166,90,0.04)" : "var(--card-2)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                        color: a.severity === "critical" ? "var(--danger)" : a.severity === "warning" ? "#f2a65a" : "var(--muted)",
                      }}>
                        {a.type}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--muted)" }}>
                        {new Date(a.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text)" }}>{a.message}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--success)", padding: "20px 0", textAlign: "center" }}>
                No recent alerts
              </div>
            )}
          </div>
        )}

        {/* ─── Panel: Config ─── */}
        {activePanel === "config" && (
          <div className="card card-wide">
            <div className="title" style={{ fontSize: 13 }}>
              <span>Configuration (Read-Only)</span>
            </div>
            {healthConfig || monitorStatus ? (
              <pre style={{
                fontSize: 11, lineHeight: 1.5, color: "var(--muted)",
                background: "var(--card-2)", padding: 14, borderRadius: 8,
                overflow: "auto", maxHeight: 500, border: "1px solid var(--border)",
              }}>
                {JSON.stringify(healthConfig || { monitor: monitorStatus, metrics: metrics }, null, 2)}
              </pre>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>
                No configuration data available. Health endpoint may be degraded.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settlement dialog */}
      {settlementDialog && (
        <ConfirmDialog
          title={settlementDialog.type === "premium" ? "Mark Premium Settled" : "Mark Payout Settled"}
          message={
            settlementDialog.type === "premium"
              ? `Mark premium of ${fmtUsd(settlementDialog.amount)} as settled for protection ${settlementDialog.protectionId.slice(0, 12)}...?`
              : `Mark payout of ${fmtUsd(settlementDialog.amount)} as settled for protection ${settlementDialog.protectionId.slice(0, 12)}...?`
          }
          onConfirm={handleSettlement}
          onCancel={() => setSettlementDialog(null)}
          loading={settlementLoading}
        />
      )}
    </div>
  );
}

// ─── Root export ─────────────────────────────────────────────────────

export function AdminDashboardPage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("pilot_admin_token"));

  if (!token) return <AdminLogin onLogin={setToken} />;
  return <Dashboard token={token} />;
}
