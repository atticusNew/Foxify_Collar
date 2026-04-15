import { useEffect, useState } from "react";
import { API_BASE } from "./config";

type TreasuryStatus = {
  status: string;
  client: string;
  config: {
    notionalUsd: number;
    floorPct: number;
    tenorDays: number;
    dailyPremiumBps: number;
    executionTime: string;
    venue: string;
  };
  state: {
    active: boolean;
    paused: boolean;
    pausedAt: string | null;
    lastCycleDate: string | null;
    lastExecutionAt: string | null;
    totalCycles: number;
    totalTriggers: number;
  };
  billing: {
    totalPremiumsUsd: string;
    totalPayoutsUsd: string;
    netCostToClient: string;
  };
  currentProtection: {
    id: string;
    cycleDate: string;
    entryPrice: string;
    floorPrice: string;
    premiumUsd: string;
    expiryAt: string;
    triggered: boolean;
    payoutUsd: string | null;
    status: string;
  } | null;
  market: {
    currentSpot: number | null;
    distanceToFloor: { usd: number; pct: number } | null;
  };
};

type HistoryEntry = {
  cycleDate: string;
  entryPrice: string;
  floorPrice: string;
  strike: string;
  premiumUsd: string;
  triggered: boolean;
  payoutUsd: string | null;
  status: string;
};

const fmt = (v: number | string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const TOKEN_KEY = "foxify_treasury_token";

export function TreasuryDashboard() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<TreasuryStatus | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const headers = { "Content-Type": "application/json", "x-treasury-token": token };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/treasury/status`, { headers });
      if (res.status === 401) { setAuthed(false); return; }
      const d = await res.json();
      if (d.status === "ok") { setData(d); setAuthed(true); setError(null); }
    } catch (e: any) { setError(e.message); }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/treasury/history?limit=30`, { headers });
      const d = await res.json();
      if (d.status === "ok") setHistory(d.protections || []);
    } catch { /* best effort */ }
  };

  const handleAuth = () => {
    localStorage.setItem(TOKEN_KEY, token);
    fetchStatus();
    fetchHistory();
  };

  const handleAction = async (action: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/treasury/${action}`, { method: "POST", headers });
      const d = await res.json();
      if (d.status !== "ok") setError(d.reason || "action_failed");
      await fetchStatus();
      await fetchHistory();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => {
    if (!token) return;
    fetchStatus();
    fetchHistory();
    const id = setInterval(() => { fetchStatus(); fetchHistory(); }, 30000);
    return () => clearInterval(id);
  }, [authed]);

  if (!authed) {
    return (
      <div className="shell">
        <div className="card" style={{ maxWidth: 440, padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Treasury Protection</h2>
          <input
            type="password"
            placeholder="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAuth()}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-2)", color: "var(--text)", fontSize: 14, marginBottom: 12 }}
          />
          <button onClick={handleAuth} style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            Authenticate
          </button>
        </div>
      </div>
    );
  }

  if (!data) return <div className="shell"><div className="card" style={{ padding: 24 }}>Loading...</div></div>;

  const cp = data.currentProtection;
  const dist = data.market.distanceToFloor;
  const safePct = dist ? Math.min(100, Math.max(0, (dist.pct / data.config.floorPct) * 100)) : 100;

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 700, padding: 0 }}>
        {/* Header */}
        <div style={{ padding: "18px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="https://i.ibb.co/SDwxMqS8/Foxify-200x200.png" alt="" style={{ width: 28, height: 28, borderRadius: 6 }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2 }}>{data.client} Treasury Protection</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>
                {fmt(data.config.notionalUsd)} at {data.config.floorPct}% floor · {data.config.tenorDays}-day rolling
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
              background: data.state.paused ? "rgba(255,107,107,0.12)" : "rgba(54,211,141,0.12)",
              color: data.state.paused ? "var(--danger)" : "var(--success)"
            }}>
              {data.state.paused ? "Paused" : "Active"}
            </span>
            {data.market.currentSpot && (
              <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                BTC {fmt(data.market.currentSpot)}
              </span>
            )}
          </div>
        </div>

        {error && (
          <div style={{ margin: "12px 20px", padding: "8px 12px", borderRadius: 8, background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", color: "var(--danger)", fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Current Protection */}
        {cp && (
          <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Today's Protection</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.8 }}>
                <div>Entry Price <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmt(cp.entryPrice)}</span></div>
                <div>Floor Price <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmt(cp.floorPrice)}</span></div>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "right", lineHeight: 1.8 }}>
                <div>Premium <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmt(cp.premiumUsd)}</span></div>
                <div>Coverage <span style={{ color: "var(--success)", fontWeight: 600 }}>Guaranteed payout on breach</span></div>
              </div>
            </div>
            {dist && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 5 }}>
                  <span>Distance to Floor</span>
                  <span style={{ fontWeight: 700, fontSize: 13, color: safePct > 50 ? "var(--success)" : safePct > 25 ? "#f0b90b" : "var(--danger)" }}>
                    {fmt(dist.usd)} ({dist.pct.toFixed(2)}%)
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--card-2)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 4, transition: "width 0.5s, background 0.5s",
                    width: `${safePct}%`,
                    background: safePct > 50 ? "var(--success)" : safePct > 25 ? "#f0b90b" : "var(--danger)"
                  }} />
                </div>
              </div>
            )}
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              Expires {new Date(cp.expiryAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        )}

        {!cp && !data.state.paused && (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            No active protection. Next cycle at {data.config.executionTime}.
          </div>
        )}

        {/* Billing Summary */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Billing Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--card-2)" }}>
              <div style={{ color: "var(--muted)", fontSize: 10 }}>Cycles</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{data.state.totalCycles}</div>
            </div>
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--card-2)" }}>
              <div style={{ color: "var(--muted)", fontSize: 10 }}>Triggers</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: data.state.totalTriggers > 0 ? "var(--danger)" : "var(--text)" }}>{data.state.totalTriggers}</div>
            </div>
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--card-2)" }}>
              <div style={{ color: "var(--muted)", fontSize: 10 }}>Premiums Paid</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{fmt(data.billing.totalPremiumsUsd)}</div>
            </div>
          </div>
          {Number(data.billing.totalPayoutsUsd) > 0 && (
            <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(54,211,141,0.06)", border: "1px solid rgba(54,211,141,0.15)", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span>Protection Payouts Received</span>
              <span style={{ fontWeight: 600, color: "var(--success)" }}>{fmt(data.billing.totalPayoutsUsd)}</span>
            </div>
          )}
        </div>

        {/* History */}
        {history.length > 0 && (
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Protection History</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Date", "Entry", "Floor", "Premium", "Triggered", "Payout"].map((h) => (
                      <th key={h} style={{ padding: "6px 4px", textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((p, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 4px" }}>{new Date(p.cycleDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                      <td style={{ padding: "6px 4px" }}>{p.entryPrice ? fmt(p.entryPrice) : "—"}</td>
                      <td style={{ padding: "6px 4px" }}>{p.floorPrice ? fmt(p.floorPrice) : "—"}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.premiumUsd || 0)}</td>
                      <td style={{ padding: "6px 4px" }}>
                        {p.triggered ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>Yes</span> : <span style={{ color: "var(--muted)" }}>No</span>}
                      </td>
                      <td style={{ padding: "6px 4px" }}>{p.payoutUsd && Number(p.payoutUsd) > 0 ? fmt(p.payoutUsd) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ padding: "14px 20px" }}>
          {data.state.paused ? (
            <button onClick={() => handleAction("resume")} disabled={loading} style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: "var(--success)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>
              Resume Protection
            </button>
          ) : (
            <button onClick={() => handleAction("pause")} disabled={loading} style={{ width: "100%", padding: "8px 0", borderRadius: 8, border: "1px solid rgba(168,168,173,0.2)", background: "transparent", color: "var(--muted)", fontSize: 11, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>
              Pause After Current Cycle
            </button>
          )}
        </div>

        <div style={{ textAlign: "center", paddingBottom: 14, fontSize: 10, color: "var(--muted)", opacity: 0.4 }}>
          Protection provided by Atticus Strategy, Ltd.
        </div>
      </div>
    </div>
  );
}
