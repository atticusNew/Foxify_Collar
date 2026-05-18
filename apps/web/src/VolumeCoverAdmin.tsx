/**
 * Volume Cover Live Operations Dashboard
 *
 * Single-page admin UI with 4 widgets:
 *   1. Status strip — DVOL, halt status, Atticus pool, source-of-truth indicator
 *   2. Pair feed — live activate events with timing breakdown
 *   3. Active positions — table with expandable hedge legs + close button
 *   4. Triggers + halt control
 *
 * Refreshes every 2s. Admin token gate at the top (paste-once).
 *
 * Endpoints used (all require X-Admin-Token):
 *   GET  /volume-cover/health
 *   GET  /volume-cover/admin/pair-events?limit=50
 *   GET  /volume-cover/admin/pair-event-stats?windowHours=24
 *   GET  /volume-cover/admin/active-positions-detail?limit=50
 *   GET  /volume-cover/admin/salvage-stats
 *   GET  /volume-cover/admin/cells
 *   POST /volume-cover/admin/halt          (with confirmation)
 *   POST /volume-cover/admin/halt/clear
 *   POST /volume-cover/admin/positions/:id/close (with confirmation)
 *   POST /volume-cover/admin/cells/:cellId/toggle
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type Health = {
  status: string;
  cellsConfigured: number;
  cellsEnabled: number;
  activePositions: number;
  totalActivePayoutLiabilityUsdc: number;
  halt: { halted: boolean; reason: string | null };
};

type PairEvent = {
  id: string;
  foxifyPairId: string;
  cellId: string;
  fingerprintHash: string | null;
  pairEntryBtcPrice: number | null;
  result: "activated" | "idempotent" | "rejected" | "failed";
  rejectReason: string | null;
  positionId: string | null;
  receivedAtIso: string;
  guardsPassedAtIso: string | null;
  hedgeBuySubmittedAtIso: string | null;
  hedgeFillAtIso: string | null;
  responseSentAtIso: string;
  totalLatencyMs: number;
  laddered: boolean;
  ladderSavingsUsdc: number;
};

type LatencyStats = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  windowHours: number;
};

type Leg = {
  id: string;
  venue: string;
  optionKind: string;
  strikeUsdc: number;
  expiryIso: string;
  contracts: number;
  buyPriceUsdc: number;
  sellPriceUsdc: number | null;
  status: string;
  retained: boolean;
  retainedRole: string | null;
  retainedAt: string | null;
  openedAt: string;
  closedAt: string | null;
};

type DetailedPosition = {
  id: string;
  cellId: string;
  foxifyPairId: string;
  pairLongNotionalUsdc: number;
  pairShortNotionalUsdc: number;
  pairEntryBtcPrice: number;
  triggerHighBtc: number;
  triggerLowBtc: number;
  dailyPremiumUsdc: number;
  payoutUsdc: number;
  status: string;
  openedAt: string;
  triggeredAt: string | null;
  triggeredDirection: string | null;
  closedAt: string | null;
  closeReason: string | null;
  legs: Leg[];
};

type ActivePositionsResponse = {
  positions: DetailedPosition[];
  currentSpotBtc: number | null;
  spotSource: string | null;
  generatedAtIso: string;
};

type SalvageStats = {
  rolling7dayAtticusLossUsdc: number;
  rolling5TriggerSalvagePct: number | null;
  rolling5TriggerSampleCount: number;
  rolling24hTriggerCount: number;
};

type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  dailyPremiumUsdc: number;
  enabled: boolean;
  throttleMaxPerDay: number;
};

// ─── Token gate ──────────────────────────────────────────────────────

const TOKEN_KEY = "vc_admin_token";

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <div style={{ padding: 40, maxWidth: 400, margin: "60px auto", fontFamily: "monospace" }}>
      <h2 style={{ marginBottom: 16 }}>VC Admin Token</h2>
      <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        Paste your <code>PILOT_ADMIN_TOKEN</code> to access the dashboard. Stored in localStorage.
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
  `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

const fmtMs = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);

const fmtRelative = (iso: string): string => {
  const t = new Date(iso).getTime();
  const ago = Date.now() - t;
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  return `${Math.floor(ago / 3_600_000)}h ago`;
};

const apiCall = async (token: string, path: string, init: RequestInit = {}) => {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "X-Admin-Token": token,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

// ─── Widgets ─────────────────────────────────────────────────────────

function StatusStrip({
  health,
  spot,
  spotSource,
  salvage,
  latency,
  onHaltClick
}: {
  health: Health | null;
  spot: number | null;
  spotSource: string | null;
  salvage: SalvageStats | null;
  latency: LatencyStats | null;
  onHaltClick: () => void;
}) {
  const halted = health?.halt?.halted ?? false;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr auto",
        gap: 12,
        padding: 12,
        background: halted ? "#3a1010" : "#1a1a1a",
        borderRadius: 6,
        marginBottom: 16,
        fontSize: 13,
        alignItems: "center",
        color: "#ddd"
      }}
    >
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>SPOT (BTC)</div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{spot ? fmt$(spot, 0) : "—"}</div>
        <div style={{ fontSize: 10, color: "#888" }}>
          {spotSource ?? "—"}
        </div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>HALT</div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: halted ? "#ff6b6b" : "#69d171"
          }}
        >
          {halted ? "🛑 HALTED" : "✓ ACTIVE"}
        </div>
        {halted && health?.halt?.reason && (
          <div style={{ fontSize: 10, color: "#ff6b6b" }}>
            {health.halt.reason.slice(0, 30)}
          </div>
        )}
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>POSITIONS</div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          {health?.activePositions ?? "—"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>
          liability {health ? fmt$(health.totalActivePayoutLiabilityUsdc, 0) : "—"}
        </div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>7d LOSS</div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: salvage && salvage.rolling7dayAtticusLossUsdc > 750 ? "#ff6b6b" : "#ddd"
          }}
        >
          {salvage ? fmt$(salvage.rolling7dayAtticusLossUsdc, 0) : "—"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>kill at $1k (early)</div>
      </div>
      <div>
        <div style={{ color: "#888", fontSize: 11 }}>LATENCY (24h P50/P95)</div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          {latency && latency.p50Ms !== null
            ? `${fmtMs(latency.p50Ms)} / ${fmtMs(latency.p95Ms ?? 0)}`
            : "—"}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>
          {latency ? `${latency.count} events` : "—"}
        </div>
      </div>
      <button
        onClick={onHaltClick}
        style={{
          padding: "10px 16px",
          background: halted ? "#69d171" : "#cc0000",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          fontWeight: 700,
          fontSize: 13
        }}
      >
        {halted ? "RESUME" : "HALT"}
      </button>
    </div>
  );
}

function PairFeedWidget({ events }: { events: PairEvent[] }) {
  return (
    <div style={{ background: "#1a1a1a", borderRadius: 6, padding: 12, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0, marginBottom: 12, color: "#ddd" }}>
        Pair Feed (last {events.length})
      </h3>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, color: "#ccc", fontFamily: "monospace" }}>
          <thead>
            <tr style={{ color: "#888", textAlign: "left", borderBottom: "1px solid #333" }}>
              <th style={{ padding: "4px 8px" }}>Time</th>
              <th style={{ padding: "4px 8px" }}>Pair</th>
              <th style={{ padding: "4px 8px" }}>Cell</th>
              <th style={{ padding: "4px 8px" }}>Result</th>
              <th style={{ padding: "4px 8px" }}>Latency</th>
              <th style={{ padding: "4px 8px" }}>Position</th>
              <th style={{ padding: "4px 8px" }}>Ladder</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const color =
                e.result === "activated"
                  ? "#69d171"
                  : e.result === "idempotent"
                  ? "#888"
                  : e.result === "rejected"
                  ? "#e0c060"
                  : "#ff6b6b";
              const slow = e.totalLatencyMs > 3000;
              return (
                <tr key={e.id} style={{ borderBottom: "1px solid #2a2a2a" }}>
                  <td style={{ padding: "4px 8px", color: "#888" }}>
                    {new Date(e.receivedAtIso).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: "4px 8px" }}>{e.foxifyPairId.slice(0, 14)}</td>
                  <td style={{ padding: "4px 8px" }}>{e.cellId}</td>
                  <td style={{ padding: "4px 8px", color }}>
                    {e.result === "activated"
                      ? "✓"
                      : e.result === "idempotent"
                      ? "↻"
                      : e.result === "rejected"
                      ? "⚠"
                      : "✗"}{" "}
                    {e.result}
                    {e.rejectReason && (
                      <span style={{ color: "#888", marginLeft: 6 }}>
                        ({e.rejectReason.slice(0, 30)})
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      color: slow ? "#e0c060" : "#888"
                    }}
                  >
                    {fmtMs(e.totalLatencyMs)}
                  </td>
                  <td style={{ padding: "4px 8px", color: "#888" }}>
                    {e.positionId?.slice(0, 14) ?? "—"}
                  </td>
                  <td style={{ padding: "4px 8px", color: "#888" }}>
                    {e.laddered ? `+${fmt$(e.ladderSavingsUsdc, 0)}` : "—"}
                  </td>
                </tr>
              );
            })}
            {events.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 16, textAlign: "center", color: "#666" }}>
                  No pair events yet — waiting for first activation
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivePositionsWidget({
  positions,
  currentSpot,
  onClosePosition
}: {
  positions: DetailedPosition[];
  currentSpot: number | null;
  onClosePosition: (positionId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ background: "#1a1a1a", borderRadius: 6, padding: 12, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0, marginBottom: 12, color: "#ddd" }}>
        Active Positions ({positions.filter((p) => p.status === "active").length})
        {positions.filter((p) => p.status === "triggered").length > 0 && (
          <span style={{ color: "#e0c060", marginLeft: 8, fontSize: 13 }}>
            + {positions.filter((p) => p.status === "triggered").length} triggered
          </span>
        )}
      </h3>
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, color: "#ccc", fontFamily: "monospace" }}>
          <thead>
            <tr style={{ color: "#888", textAlign: "left", borderBottom: "1px solid #333" }}>
              <th style={{ padding: "4px 8px" }}></th>
              <th style={{ padding: "4px 8px" }}>Pair / ID</th>
              <th style={{ padding: "4px 8px" }}>Cell</th>
              <th style={{ padding: "4px 8px" }}>Status</th>
              <th style={{ padding: "4px 8px" }}>Entry</th>
              <th style={{ padding: "4px 8px" }}>Trigger</th>
              <th style={{ padding: "4px 8px" }}>Distance</th>
              <th style={{ padding: "4px 8px" }}>Premium</th>
              <th style={{ padding: "4px 8px" }}>Opened</th>
              <th style={{ padding: "4px 8px" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const distHigh = currentSpot
                ? ((p.triggerHighBtc - currentSpot) / currentSpot) * 100
                : null;
              const distLow = currentSpot
                ? ((currentSpot - p.triggerLowBtc) / currentSpot) * 100
                : null;
              const minDist =
                distHigh !== null && distLow !== null
                  ? Math.min(distHigh, distLow)
                  : null;
              const distColor =
                minDist === null
                  ? "#888"
                  : minDist < 0.5
                  ? "#ff6b6b"
                  : minDist < 1.0
                  ? "#e0c060"
                  : "#69d171";
              const statusColor =
                p.status === "active"
                  ? "#69d171"
                  : p.status === "triggered"
                  ? "#e0c060"
                  : "#888";
              const isExpanded = expanded.has(p.id);
              return (
                <>
                  <tr key={p.id} style={{ borderBottom: "1px solid #2a2a2a" }}>
                    <td style={{ padding: "4px 8px" }}>
                      <button
                        onClick={() => toggle(p.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#888",
                          cursor: "pointer",
                          fontSize: 14
                        }}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </button>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <div>{p.foxifyPairId.slice(0, 14)}</div>
                      <div style={{ fontSize: 10, color: "#666" }}>{p.id.slice(0, 14)}</div>
                    </td>
                    <td style={{ padding: "4px 8px" }}>{p.cellId}</td>
                    <td style={{ padding: "4px 8px", color: statusColor }}>{p.status}</td>
                    <td style={{ padding: "4px 8px" }}>{fmt$(p.pairEntryBtcPrice, 0)}</td>
                    <td style={{ padding: "4px 8px", color: "#888" }}>
                      {fmt$(p.triggerLowBtc, 0)} / {fmt$(p.triggerHighBtc, 0)}
                    </td>
                    <td style={{ padding: "4px 8px", color: distColor }}>
                      {minDist !== null ? `${minDist.toFixed(2)}%` : "—"}
                    </td>
                    <td style={{ padding: "4px 8px" }}>{fmt$(p.dailyPremiumUsdc, 0)}/d</td>
                    <td style={{ padding: "4px 8px", color: "#888" }}>{fmtRelative(p.openedAt)}</td>
                    <td style={{ padding: "4px 8px" }}>
                      {p.status === "active" && (
                        <button
                          onClick={() => onClosePosition(p.id)}
                          style={{
                            padding: "4px 8px",
                            background: "#444",
                            color: "#fff",
                            border: "none",
                            borderRadius: 3,
                            cursor: "pointer",
                            fontSize: 11
                          }}
                        >
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr style={{ background: "#0d0d0d" }}>
                      <td></td>
                      <td colSpan={9} style={{ padding: "8px 12px" }}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
                          Notional: {fmt$(p.pairLongNotionalUsdc, 0)} long /{" "}
                          {fmt$(p.pairShortNotionalUsdc, 0)} short — Payout: {fmt$(p.payoutUsdc, 0)}
                        </div>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>
                          Hedge legs ({p.legs.length}):
                        </div>
                        <table style={{ width: "100%", fontSize: 11, color: "#bbb" }}>
                          <thead>
                            <tr style={{ color: "#666" }}>
                              <th align="left">Venue</th>
                              <th align="left">Kind</th>
                              <th align="left">Strike</th>
                              <th align="left">Contracts</th>
                              <th align="left">Buy</th>
                              <th align="left">Sell</th>
                              <th align="left">Status</th>
                              <th align="left">Retained role</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.legs.map((l) => (
                              <tr key={l.id}>
                                <td>{l.venue}</td>
                                <td>{l.optionKind}</td>
                                <td>{fmt$(l.strikeUsdc, 0)}</td>
                                <td>{l.contracts.toFixed(2)} BTC</td>
                                <td>{fmt$(l.buyPriceUsdc, 2)}/BTC</td>
                                <td>
                                  {l.sellPriceUsdc !== null
                                    ? `${fmt$(l.sellPriceUsdc, 2)}/BTC`
                                    : "—"}
                                </td>
                                <td
                                  style={{
                                    color:
                                      l.status === "open" && l.retained
                                        ? "#e0c060"
                                        : l.status === "open"
                                        ? "#69d171"
                                        : "#888"
                                  }}
                                >
                                  {l.status}
                                  {l.retained ? " (retained)" : ""}
                                </td>
                                <td style={{ color: "#888" }}>{l.retainedRole ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {positions.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 16, textAlign: "center", color: "#666" }}>
                  No active positions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellsWidget({
  cells,
  onToggle
}: {
  cells: Cell[];
  onToggle: (cellId: string, body: Partial<{ enabled: boolean; throttleMaxPerDay: number; dailyPremiumUsdc: number }>) => void;
}) {
  return (
    <div style={{ background: "#1a1a1a", borderRadius: 6, padding: 12 }}>
      <h3 style={{ marginTop: 0, marginBottom: 12, color: "#ddd" }}>Cells</h3>
      <table style={{ width: "100%", fontSize: 12, color: "#ccc", fontFamily: "monospace" }}>
        <thead>
          <tr style={{ color: "#888", textAlign: "left", borderBottom: "1px solid #333" }}>
            <th style={{ padding: "4px 8px" }}>Cell</th>
            <th style={{ padding: "4px 8px" }}>Notional</th>
            <th style={{ padding: "4px 8px" }}>Trigger</th>
            <th style={{ padding: "4px 8px" }}>Payout</th>
            <th style={{ padding: "4px 8px" }}>Premium/day</th>
            <th style={{ padding: "4px 8px" }}>Throttle</th>
            <th style={{ padding: "4px 8px" }}>Status</th>
            <th style={{ padding: "4px 8px" }}>Toggle</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.cellId} style={{ borderBottom: "1px solid #2a2a2a" }}>
              <td style={{ padding: "4px 8px" }}>{c.cellId}</td>
              <td style={{ padding: "4px 8px" }}>{fmt$(c.notionalUsdc, 0)}</td>
              <td style={{ padding: "4px 8px" }}>±{(c.triggerPct * 100).toFixed(0)}%</td>
              <td style={{ padding: "4px 8px" }}>{fmt$(c.payoutUsdc, 0)}</td>
              <td style={{ padding: "4px 8px" }}>{fmt$(c.dailyPremiumUsdc, 0)}</td>
              <td style={{ padding: "4px 8px" }}>{c.throttleMaxPerDay}/day</td>
              <td
                style={{
                  padding: "4px 8px",
                  color: c.enabled ? "#69d171" : "#888"
                }}
              >
                {c.enabled ? "✓ enabled" : "○ disabled"}
              </td>
              <td style={{ padding: "4px 8px" }}>
                <button
                  onClick={() => onToggle(c.cellId, { enabled: !c.enabled })}
                  style={{
                    padding: "3px 8px",
                    background: c.enabled ? "#444" : "#0066cc",
                    color: "#fff",
                    border: "none",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontSize: 11
                  }}
                >
                  {c.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export function VolumeCoverAdmin() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [health, setHealth] = useState<Health | null>(null);
  const [events, setEvents] = useState<PairEvent[]>([]);
  const [positions, setPositions] = useState<DetailedPosition[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [spotSource, setSpotSource] = useState<string | null>(null);
  const [salvage, setSalvage] = useState<SalvageStats | null>(null);
  const [latency, setLatency] = useState<LatencyStats | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [h, e, ap, sg, lt, cl] = await Promise.all([
        apiCall(token, "/volume-cover/health").catch(() => null),
        apiCall(token, "/volume-cover/admin/pair-events?limit=50").catch(() => ({ events: [] })),
        apiCall(token, "/volume-cover/admin/active-positions-detail?limit=50").catch(() => ({ positions: [], currentSpotBtc: null, spotSource: null })),
        apiCall(token, "/volume-cover/admin/salvage-stats").catch(() => null),
        apiCall(token, "/volume-cover/admin/pair-event-stats?windowHours=24").catch(() => null),
        apiCall(token, "/volume-cover/admin/cells").catch(() => ({ cells: [] }))
      ]);
      setHealth(h);
      setEvents(e.events ?? []);
      setPositions(ap.positions ?? []);
      setSpot(ap.currentSpotBtc);
      setSpotSource(ap.spotSource);
      setSalvage(sg);
      setLatency(lt);
      setCells(cl.cells ?? []);
      setError(null);
      lastFetchRef.current = Date.now();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refresh();
    const id = setInterval(refresh, 2_000);
    return () => clearInterval(id);
  }, [token, refresh]);

  const handleHaltClick = useCallback(async () => {
    if (!token) return;
    const halted = health?.halt?.halted ?? false;
    if (halted) {
      const ok = window.confirm("Resume new activations?");
      if (!ok) return;
      try {
        await apiCall(token, "/volume-cover/admin/halt/clear", { method: "POST", body: "{}" });
        await refresh();
      } catch (err) {
        setError(`Halt clear failed: ${(err as Error).message}`);
      }
    } else {
      const reason = window.prompt("Halt reason (will be logged):");
      if (reason === null) return;
      const confirmText = window.prompt(`Type 'HALT' to confirm halting all new VC activations:`);
      if (confirmText !== "HALT") {
        setError("Halt cancelled — confirmation text not 'HALT'");
        return;
      }
      try {
        await apiCall(token, "/volume-cover/admin/halt", {
          method: "POST",
          body: JSON.stringify({ reason: reason || "operator_halt" })
        });
        await refresh();
      } catch (err) {
        setError(`Halt failed: ${(err as Error).message}`);
      }
    }
  }, [token, health, refresh]);

  const handleClosePosition = useCallback(
    async (positionId: string) => {
      if (!token) return;
      const reason = window.prompt(`Close position ${positionId.slice(0, 14)}? Reason:`);
      if (reason === null) return;
      try {
        await apiCall(token, `/volume-cover/admin/positions/${positionId}/close`, {
          method: "POST",
          body: JSON.stringify({ reason: reason || "admin_close" })
        });
        await refresh();
      } catch (err) {
        setError(`Close failed: ${(err as Error).message}`);
      }
    },
    [token, refresh]
  );

  const handleCellToggle = useCallback(
    async (cellId: string, body: Partial<{ enabled: boolean; throttleMaxPerDay: number; dailyPremiumUsdc: number }>) => {
      if (!token) return;
      try {
        await apiCall(token, `/volume-cover/admin/cells/${cellId}/toggle`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        await refresh();
      } catch (err) {
        setError(`Cell toggle failed: ${(err as Error).message}`);
      }
    },
    [token, refresh]
  );

  if (!token) return <TokenGate onSubmit={setToken} />;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#ddd",
        padding: 16,
        fontFamily: "system-ui, -apple-system, sans-serif"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, color: "#fff" }}>VC Live Operations</h1>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          Updated {fmtRelative(new Date(lastFetchRef.current).toISOString())} ·{" "}
          <button
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken(null);
            }}
            style={{
              background: "none",
              border: "none",
              color: "#888",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline"
            }}
          >
            sign out
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: "#3a1010",
            borderRadius: 4,
            marginBottom: 16,
            color: "#ff8888",
            fontSize: 13,
            fontFamily: "monospace"
          }}
        >
          ⚠ {error}
        </div>
      )}

      <StatusStrip
        health={health}
        spot={spot}
        spotSource={spotSource}
        salvage={salvage}
        latency={latency}
        onHaltClick={handleHaltClick}
      />
      <PairFeedWidget events={events} />
      <ActivePositionsWidget
        positions={positions}
        currentSpot={spot}
        onClosePosition={handleClosePosition}
      />
      <CellsWidget cells={cells} onToggle={handleCellToggle} />
    </div>
  );
}
