import { useEffect, useState } from "react";
import { API_BASE } from "./config";

type AdminData = {
  status: string;
  state: {
    active: boolean;
    paused: boolean;
    pausedAt: string | null;
    notionalUsd: string;
    floorPct: string;
    lastCycleDate: string | null;
    lastExecutionAt: string | null;
    totalPremiumsUsd: string;
    totalHedgeCostsUsd: string;
    totalPayoutsUsd: string;
    totalTpProceedsUsd: string;
    totalCycles: number;
    totalTriggers: number;
  };
  currentSpot: number | null;
  currentProtection: Record<string, unknown> | null;
  recentHistory: Array<{
    cycleDate: string;
    entryPrice: string;
    floorPrice: string;
    strike: string;
    instrumentId: string;
    venue: string;
    premiumUsd: string;
    hedgeCostUsd: string;
    spreadUsd: string;
    triggered: boolean;
    triggerPrice: string | null;
    payoutUsd: string | null;
    tpSold: boolean;
    tpProceedsUsd: string | null;
    externalOrderId: string;
    status: string;
  }>;
  pnl: {
    totalPremiums: number;
    totalHedgeCosts: number;
    totalPayouts: number;
    totalTpProceeds: number;
    grossSpread: number;
    netPnl: number;
    avgHedgeCost: number;
    avgSpread: number;
    triggerRate: number;
  };
};

const fmt = (v: number | string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const TOKEN_KEY = "foxify_treasury_admin_token";

export function TreasuryAdmin() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const headers = { "Content-Type": "application/json", "x-admin-token": token };

  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE}/treasury/admin/status`, { headers });
      if (res.status === 401) { setAuthed(false); return; }
      const d = await res.json();
      if (d.status === "ok") { setData(d); setAuthed(true); }
    } catch { /* retry on next poll */ }
  };

  const handleAuth = () => { localStorage.setItem(TOKEN_KEY, token); fetchData(); };

  const doAction = async (path: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/treasury/${path}`, { method: "POST", headers });
      const d = await res.json();
      setActionResult(`${path}: ${d.status} ${d.action || d.protectionId || ""}`);
      await fetchData();
    } catch (e: any) { setActionResult(`Error: ${e.message}`); }
    setLoading(false);
  };

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [authed]);

  if (!authed) {
    return (
      <div className="shell">
        <div className="card" style={{ maxWidth: 440, padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Treasury Admin</h2>
          <input type="password" placeholder="Admin token" value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAuth()}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-2)", color: "var(--text)", fontSize: 14, marginBottom: 12 }} />
          <button onClick={handleAuth} style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            Authenticate
          </button>
        </div>
      </div>
    );
  }

  if (!data) return <div className="shell"><div className="card" style={{ padding: 24 }}>Loading...</div></div>;

  const pnl = data.pnl;
  const cp = data.currentProtection as Record<string, unknown> | null;

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 900, padding: 0 }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Treasury Admin — Atticus Internal</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              {fmt(data.state.notionalUsd)} · {data.state.floorPct}% floor · {data.state.paused ? "PAUSED" : "ACTIVE"}
              {data.currentSpot ? ` · BTC ${fmt(data.currentSpot)}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => doAction("execute-now")} disabled={loading} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>Execute Now</button>
            <button onClick={() => doAction("reset")} disabled={loading} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid var(--danger)", background: "transparent", color: "var(--danger)", fontSize: 11, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>Reset Data</button>
          </div>
        </div>

        {actionResult && (
          <div style={{ margin: "8px 20px", padding: "6px 10px", borderRadius: 6, background: "rgba(54,211,141,0.08)", border: "1px solid rgba(54,211,141,0.2)", fontSize: 11, color: "var(--success)" }}>
            {actionResult}
          </div>
        )}

        {/* P&L Summary */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>P&L Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {[
              { label: "Premiums (revenue)", value: fmt(pnl.totalPremiums), color: "var(--text)" },
              { label: "Hedge Costs", value: fmt(pnl.totalHedgeCosts), color: "var(--danger)" },
              { label: "Mgmt Fee Margin", value: fmt(pnl.grossSpread), color: pnl.grossSpread >= 0 ? "var(--success)" : "var(--danger)" },
              { label: "Net P&L (Atticus)", value: fmt(pnl.netPnl), color: pnl.netPnl >= 0 ? "var(--success)" : "var(--danger)" }
            ].map((item) => (
              <div key={item.label} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--card-2)" }}>
                <div style={{ color: "var(--muted)", fontSize: 10 }}>{item.label}</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: item.color }}>{item.value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 8 }}>
            {[
              { label: "Cycles", value: String(data.state.totalCycles) },
              { label: "Triggers", value: String(data.state.totalTriggers) },
              { label: "Trigger Rate", value: `${pnl.triggerRate.toFixed(1)}%` },
              { label: "Avg Spread", value: fmt(pnl.avgSpread) }
            ].map((item) => (
              <div key={item.label} style={{ padding: "6px 10px", borderRadius: 8, background: "var(--card-2)", fontSize: 11 }}>
                <div style={{ color: "var(--muted)", fontSize: 10 }}>{item.label}</div>
                <div style={{ fontWeight: 600 }}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Current Protection (full internal view) */}
        {cp && (
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Active Protection</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, fontSize: 11 }}>
              {[
                ["Entry", fmt(cp.entryPrice as string)],
                ["Floor", fmt(cp.floorPrice as string)],
                ["Strike", fmt(cp.strike as string)],
                ["Premium", fmt(cp.premiumUsd as string)],
                ["Hedge Cost", fmt(cp.hedgeCostUsd as string)],
                ["Spread", fmt(cp.spreadUsd as string)],
                ["Instrument", String(cp.instrumentId || "—")],
                ["Order ID", String(cp.externalOrderId || "—").slice(0, 12)],
                ["Venue", String(cp.venue || "—")]
              ].map(([label, value]) => (
                <div key={label} style={{ color: "var(--muted)" }}>
                  <span>{label}: </span><span style={{ color: "var(--text)", fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* History with full internal data */}
        {data.recentHistory.length > 0 && (
          <div style={{ padding: "16px 20px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Execution History (Internal)</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Date", "Entry", "Floor", "Strike", "Instrument", "Premium", "Hedge", "Spread", "Triggered", "Payout", "TP Sold", "TP $", "Order ID"].map((h) => (
                      <th key={h} style={{ padding: "6px 4px", textAlign: "left", color: "var(--muted)", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.recentHistory.map((p, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 4px" }}>{new Date(p.cycleDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.entryPrice)}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.floorPrice)}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.strike)}</td>
                      <td style={{ padding: "6px 4px", fontFamily: "monospace" }}>{p.instrumentId?.slice(-15) || "—"}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.premiumUsd)}</td>
                      <td style={{ padding: "6px 4px" }}>{fmt(p.hedgeCostUsd)}</td>
                      <td style={{ padding: "6px 4px", color: Number(p.spreadUsd) >= 0 ? "var(--success)" : "var(--danger)" }}>{fmt(p.spreadUsd)}</td>
                      <td style={{ padding: "6px 4px" }}>{p.triggered ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>Yes</span> : "No"}</td>
                      <td style={{ padding: "6px 4px" }}>{p.payoutUsd && Number(p.payoutUsd) > 0 ? fmt(p.payoutUsd) : "—"}</td>
                      <td style={{ padding: "6px 4px" }}>{p.tpSold ? <span style={{ color: "var(--success)" }}>Yes</span> : "—"}</td>
                      <td style={{ padding: "6px 4px" }}>{p.tpProceedsUsd && Number(p.tpProceedsUsd) > 0 ? fmt(p.tpProceedsUsd) : "—"}</td>
                      <td style={{ padding: "6px 4px", fontFamily: "monospace" }}>{p.externalOrderId?.slice(0, 10) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
