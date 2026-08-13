/**
 * Foxify-facing dashboard.
 *
 * Read-mostly view paired with the operator admin at /volume-cover.
 * Mounted at /foxify. Token-gated by FOXIFY_DASHBOARD_TOKEN (paste-once,
 * stored in localStorage under a separate key from the admin token so
 * the two never mix).
 *
 * 4 panels:
 *   1. Status strip — spot (Atticus source-of-truth), service status,
 *      active count, today's activations vs. cap
 *   2. Active Protections table — with Close button
 *   3. Today's Activity summary
 *   4. Recent Activity log
 *
 * Polls every 5s. Calls /volume-cover/foxify/* endpoints only.
 * NEVER calls any /volume-cover/admin/* endpoint.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type Status = {
  service: string;
  spotBtcUsdc: number | null;
  spotSource: string | null;
  activeCount: number;
  todayActivations: number;
  dailyThrottle: number;
  dailyRemainingActivations: number;
  generatedAtIso: string;
};

type Position = {
  id: string;
  cellId: string;
  foxifyPairId: string;
  status: string;
  pairLongNotionalUsdc: number;
  pairShortNotionalUsdc: number;
  pairEntryBtcPrice: number;
  triggerHighBtc: number;
  triggerLowBtc: number;
  premiumPaidUsdc: number;
  payoutUsdc: number;
  openedAtIso: string;
  triggeredAtIso: string | null;
  triggeredDirection: string | null;
  closedAtIso: string | null;
};

type TodaySummary = {
  reportDate: string;
  activationsToday: number;
  triggeredToday: number;
  closedEarlyToday: number;
  expiredUnusedToday: number;
  premiumPaidUsdc: number;
  payoutsReceivedUsdc: number;
  foxifyNetUsdc: number;
  generatedAtIso: string;
};

type RecentEvent = {
  foxifyPairId: string;
  cellId: string;
  result: string;
  rejectReason: string | null;
  positionId: string | null;
  atIso: string;
  latencyMs: number;
};

// ─── Token gate ──────────────────────────────────────────────────────

const TOKEN_KEY = "foxify_dashboard_token";

function TokenGate({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <div
      style={{
        padding: 40,
        maxWidth: 460,
        margin: "60px auto",
        fontFamily: "monospace"
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16
        }}
      >
        <img
          src="https://i.ibb.co/PsGYPBkn/Foxify-200x200.png"
          alt="Foxify"
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            objectFit: "cover"
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <h2 style={{ margin: 0 }}>Volume Cover — Foxify</h2>
      </div>
      <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        Paste your Foxify dashboard token (provided by Atticus). Stored locally
        in this browser. To rotate, sign out and re-enter.
      </p>
      <input
        type="password"
        autoFocus
        placeholder="paste token here"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && token.trim()) {
            localStorage.setItem(TOKEN_KEY, token.trim());
            onSubmit(token.trim());
          }
        }}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 14,
          fontFamily: "monospace",
          background: "#222",
          color: "#0f0",
          border: "1px solid #444",
          borderRadius: 4,
          boxSizing: "border-box"
        }}
      />
      <button
        disabled={!token.trim()}
        onClick={() => {
          if (token.trim()) {
            localStorage.setItem(TOKEN_KEY, token.trim());
            onSubmit(token.trim());
          }
        }}
        style={{
          marginTop: 12,
          padding: "10px 16px",
          background: "#0066cc",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer"
        }}
      >
        Enter
      </button>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

const fmt$ = (n: number, decimals = 2) =>
  `$${n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;

const fmtRelative = (iso: string): string => {
  const t = new Date(iso).getTime();
  const ago = Date.now() - t;
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
};

const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

const apiCall = async (token: string, path: string, init: RequestInit = {}) => {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "X-Foxify-Token": token,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (r.status === 401) {
    // Token invalid — clear and force re-gate
    localStorage.removeItem(TOKEN_KEY);
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

// ─── Widgets ─────────────────────────────────────────────────────────

function StatusStrip({ status }: { status: Status | null }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 1fr",
        gap: 12,
        padding: 12,
        background: "#1a1a1a",
        borderRadius: 6,
        marginBottom: 16,
        fontSize: 13,
        color: "#ddd"
      }}
    >
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>
          SPOT (BTC) — Atticus SoT
        </div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          {status?.spotBtcUsdc ? fmt$(status.spotBtcUsdc, 0) : "—"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>
          {status?.spotSource ?? "—"}
        </div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>SERVICE</div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: status?.service === "operational" ? "#69d171" : "#ff6b6b"
          }}
        >
          {status?.service === "operational" ? "✓ Operational" : "⚠️ Degraded"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>
          {status?.generatedAtIso
            ? `Updated ${fmtRelative(status.generatedAtIso)}`
            : ""}
        </div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>ACTIVE PROTECTIONS</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          {status?.activeCount ?? "—"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>currently open</div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>TODAY (UTC)</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          {status?.todayActivations ?? 0}/{status?.dailyThrottle ?? 0}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>
          activations / daily cap
          {status && status.dailyRemainingActivations === 0 && (
            <span style={{ color: "#ff6b6b", marginLeft: 6 }}>
              ⚠ cap reached
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivePositionsPanel({
  positions,
  spotBtcUsdc,
  onClose
}: {
  positions: Position[];
  spotBtcUsdc: number | null;
  onClose: (id: string, pairId: string) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 8, color: "#ddd" }}>
        My Active Protections ({positions.length})
      </h3>
      <div
        style={{
          background: "#1a1a1a",
          borderRadius: 6,
          padding: 12,
          overflowX: "auto"
        }}
      >
        {positions.length === 0 ? (
          <div style={{ color: "#666", fontSize: 12, padding: "8px 0" }}>
            No active protections.
          </div>
        ) : (
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Pair ID</th>
                <th style={{ padding: "6px 8px" }}>Cell</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }}>Entry BTC</th>
                <th style={{ padding: "6px 8px" }}>Trigger Levels</th>
                <th style={{ padding: "6px 8px" }}>Distance</th>
                <th style={{ padding: "6px 8px" }}>Premium</th>
                <th style={{ padding: "6px 8px" }}>Opened</th>
                <th style={{ padding: "6px 8px" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const dLow = spotBtcUsdc
                  ? (spotBtcUsdc - p.triggerLowBtc) / spotBtcUsdc
                  : null;
                const dHigh = spotBtcUsdc
                  ? (p.triggerHighBtc - spotBtcUsdc) / spotBtcUsdc
                  : null;
                const closer =
                  dLow !== null && dHigh !== null
                    ? Math.min(Math.abs(dLow), Math.abs(dHigh))
                    : null;
                const closerLabel =
                  closer !== null
                    ? Math.abs(dLow ?? 0) < Math.abs(dHigh ?? 0)
                      ? `-${fmtPct(closer)} to low`
                      : `+${fmtPct(closer)} to high`
                    : "—";
                return (
                  <tr
                    key={p.id}
                    style={{ borderTop: "1px solid #2a2a2a", color: "#ddd" }}
                  >
                    <td
                      style={{
                        padding: "6px 8px",
                        fontFamily: "monospace",
                        fontSize: 11
                      }}
                    >
                      {p.foxifyPairId}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{p.cellId}</td>
                    <td
                      style={{
                        padding: "6px 8px",
                        color: p.status === "active" ? "#69d171" : "#ffa500"
                      }}
                    >
                      {p.status}
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      {fmt$(p.pairEntryBtcPrice, 0)}
                    </td>
                    <td style={{ padding: "6px 8px", fontSize: 11 }}>
                      ≤ {fmt$(p.triggerLowBtc, 0)}
                      <br />≥ {fmt$(p.triggerHighBtc, 0)}
                    </td>
                    <td style={{ padding: "6px 8px", fontSize: 11 }}>
                      {closerLabel}
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      {fmt$(p.premiumPaidUsdc, 2)}
                    </td>
                    <td style={{ padding: "6px 8px", fontSize: 11 }}>
                      {fmtRelative(p.openedAtIso)}
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      {p.status === "active" ? (
                        <button
                          onClick={() => onClose(p.id, p.foxifyPairId)}
                          style={{
                            padding: "4px 10px",
                            background: "#7a3030",
                            color: "#fff",
                            border: "none",
                            borderRadius: 3,
                            fontSize: 11,
                            cursor: "pointer"
                          }}
                        >
                          Close
                        </button>
                      ) : (
                        <span style={{ color: "#666" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TodaySummaryPanel({ today }: { today: TodaySummary | null }) {
  if (!today) return null;
  const net = today.foxifyNetUsdc;
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 8, color: "#ddd" }}>
        Today's Activity ({today.reportDate} UTC)
      </h3>
      <div
        style={{
          background: "#1a1a1a",
          borderRadius: 6,
          padding: 12,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 16,
          fontSize: 13,
          color: "#ddd"
        }}
      >
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Activations</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {today.activationsToday}
          </div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Triggered</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {today.triggeredToday}
          </div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Closed Early</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {today.closedEarlyToday}
          </div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Expired Unused</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {today.expiredUnusedToday}
          </div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Premium Paid</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#ffa500" }}>
            {fmt$(today.premiumPaidUsdc)}
          </div>
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 11 }}>Payouts Received</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#69d171" }}>
            {fmt$(today.payoutsReceivedUsdc)}
          </div>
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <div style={{ color: "#888", fontSize: 11 }}>Net (Foxify-side)</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: net >= 0 ? "#69d171" : "#ff6b6b"
            }}
          >
            {net >= 0 ? "+" : ""}
            {fmt$(net)}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecentActivityPanel({ events }: { events: RecentEvent[] }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 8, color: "#ddd" }}>
        Recent Activity (last {events.length})
      </h3>
      <div
        style={{
          background: "#1a1a1a",
          borderRadius: 6,
          padding: 12,
          overflowX: "auto"
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: "#666", fontSize: 12, padding: "8px 0" }}>
            No recent activity.
          </div>
        ) : (
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Time</th>
                <th style={{ padding: "6px 8px" }}>Pair ID</th>
                <th style={{ padding: "6px 8px" }}>Cell</th>
                <th style={{ padding: "6px 8px" }}>Result</th>
                <th style={{ padding: "6px 8px" }}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr
                  key={`${e.foxifyPairId}-${i}`}
                  style={{ borderTop: "1px solid #2a2a2a", color: "#ddd" }}
                >
                  <td style={{ padding: "6px 8px", fontSize: 11 }}>
                    {fmtRelative(e.atIso)}
                  </td>
                  <td
                    style={{
                      padding: "6px 8px",
                      fontFamily: "monospace",
                      fontSize: 11
                    }}
                  >
                    {e.foxifyPairId}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{e.cellId}</td>
                  <td
                    style={{
                      padding: "6px 8px",
                      color:
                        e.result === "activated"
                          ? "#69d171"
                          : e.result === "rejected"
                          ? "#ff6b6b"
                          : "#ffa500"
                    }}
                  >
                    {e.result}
                    {e.rejectReason ? ` (${e.rejectReason})` : ""}
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 11 }}>
                    {e.latencyMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────

export function FoxifyDashboard() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY)
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [today, setToday] = useState<TodaySummary | null>(null);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const refresh = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const [s, p, t, r] = await Promise.all([
        apiCall(tokenRef.current, "/volume-cover/foxify/status"),
        apiCall(tokenRef.current, "/volume-cover/foxify/positions"),
        apiCall(tokenRef.current, "/volume-cover/foxify/today"),
        apiCall(tokenRef.current, "/volume-cover/foxify/recent?limit=20")
      ]);
      setStatus(s);
      setPositions(p.positions ?? []);
      setToday(t);
      setRecent(r.events ?? []);
      setError(null);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "unauthorized") {
        setToken(null);
        setError("Token invalid or expired. Please re-enter.");
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [token, refresh]);

  const handleClose = useCallback(
    async (positionId: string, pairId: string) => {
      const confirm = window.confirm(
        `Close protection for ${pairId}?\n\n` +
          `This will end the protection on this position immediately and ` +
          `release the hedge. The action cannot be undone. Your bot should ` +
          `also be informed so it can adjust the underlying perp accordingly.\n\n` +
          `Continue?`
      );
      if (!confirm || !tokenRef.current) return;
      try {
        await apiCall(
          tokenRef.current,
          `/volume-cover/foxify/positions/${positionId}/close`,
          {
            method: "POST",
            body: JSON.stringify({ reason: "manual_close_via_dashboard" })
          }
        );
        // Refresh immediately to reflect the close.
        void refresh();
      } catch (err) {
        alert(`Close failed: ${(err as Error).message}`);
      }
    },
    [refresh]
  );

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  if (!token) {
    return (
      <div style={{ background: "#0a0a0a", minHeight: "100vh", color: "#ddd" }}>
        {error && (
          <div
            style={{
              padding: "10px 16px",
              background: "#3a1010",
              color: "#ff6b6b",
              fontSize: 12,
              textAlign: "center"
            }}
          >
            {error}
          </div>
        )}
        <TokenGate onSubmit={setToken} />
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#0a0a0a",
        minHeight: "100vh",
        color: "#ddd",
        padding: 16,
        fontFamily: "system-ui, -apple-system, sans-serif"
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src="https://i.ibb.co/PsGYPBkn/Foxify-200x200.png"
            alt="Foxify"
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              objectFit: "cover"
            }}
            onError={(e) => {
              // If image fails to load, hide it gracefully rather than
              // showing a broken-image icon next to the title.
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <h1 style={{ fontSize: 18, margin: 0 }}>Volume Cover — Foxify</h1>
        </div>
        <div style={{ fontSize: 11, color: "#888" }}>
          {status?.generatedAtIso
            ? `Updated ${fmtRelative(status.generatedAtIso)}`
            : ""}
          <span
            onClick={handleSignOut}
            style={{
              marginLeft: 12,
              color: "#0aa",
              cursor: "pointer",
              textDecoration: "underline"
            }}
          >
            sign out
          </span>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "#3a1010",
            color: "#ff6b6b",
            fontSize: 12,
            marginBottom: 16,
            borderRadius: 6
          }}
        >
          {error}
        </div>
      )}

      <StatusStrip status={status} />
      <ActivePositionsPanel
        positions={positions}
        spotBtcUsdc={status?.spotBtcUsdc ?? null}
        onClose={handleClose}
      />
      <TodaySummaryPanel today={today} />
      <RecentActivityPanel events={recent} />
    </div>
  );
}
