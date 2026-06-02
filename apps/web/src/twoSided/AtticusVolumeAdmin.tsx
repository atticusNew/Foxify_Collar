/**
 * Atticus operator admin for the cooperative-volume facility (/cover/admin).
 *
 * Full engine view over the /admin/foxify/v2/* endpoints (admin token). Five tabs:
 *   P&L · Positions · Signal/Strategy · Research · Ops
 *
 * Live tabs (P&L, Positions, Ops) poll every 8s; Research/probe endpoints are
 * heavy so they fetch on demand. Operator controls live in Positions + Ops.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { adminGet, adminPost, clearToken, getToken, settleAll, UnauthorizedError } from "./api";
import { COLORS as C, Empty, ErrorBar, Panel, Pill, Shell, Stat, StatGrid, Table, Tabs, TokenGate, type Col } from "./widgets";
import { fmtHours, fmtPct, fmtSignedUsd, fmtUsd, pnlColor, short } from "./format";

type LivePnl = {
  overall: { n: number; total_cost_usdc: number; total_salvage_usdc: number; foxify_net_usdc: number; atticus_share_usdc: number; pct_profitable: number; wins: { count: number }; losses: { count: number } };
  per_cell: Array<{ cell_id: string; n: number; total_cost_usdc: number; foxify_net_usdc: number; atticus_share_usdc: number; pct_profitable: number }>;
  pairs: Array<{ pair_id_short: string; cell_id: string; hedge_cost_total_usdc: number; salvage_proceeds_usdc: number; foxify_net_usdc: number; reconciled: boolean; exit_mode: string | null }>;
  interpretation: string;
};
type Scorecard = { overall: { n: number; cumulative_net_usdc: number; mean_net_usdc: number; wins: { count: number; sum_usdc: number }; losses: { count: number; sum_usdc: number } }; interpretation: string };
type StuckPairs = { total_non_terminal: number; likely_out_of_band_count: number; pairs: Array<Record<string, unknown>> };
type Diag = Record<string, unknown>;

const JsonView = ({ data }: { data: unknown }) => (
  <pre style={{ fontSize: 11, color: C.text, whiteSpace: "pre-wrap", margin: 0, maxHeight: 520, overflow: "auto" }}>{data == null ? "—" : JSON.stringify(data, null, 2)}</pre>
);

const fieldStyle = { padding: "6px 8px", fontSize: 12, fontFamily: "monospace", background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 3, marginRight: 6 } as const;
const btnStyle = { padding: "6px 12px", background: "#0066cc", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, cursor: "pointer" } as const;

function ActionResult({ r }: { r: { ok: boolean; msg: string } | null }) {
  if (!r) return null;
  return <div style={{ marginTop: 8, fontSize: 12, color: r.ok ? C.green : C.red }}>{r.msg}</div>;
}

export function AtticusVolumeAdmin() {
  const [authed, setAuthed] = useState(() => !!getToken("admin"));
  const [tab, setTab] = useState("pnl");
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);

  // live data
  const [livePnl, setLivePnl] = useState<LivePnl | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [adminMtm, setAdminMtm] = useState<{ pairs: Array<Record<string, unknown>> } | null>(null);
  const [stuck, setStuck] = useState<StuckPairs | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  // research explorer
  const [research, setResearch] = useState<{ label: string; data: unknown } | null>(null);

  const live = useRef(authed);
  live.current = authed;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const refresh = useCallback(async () => {
    if (!live.current) return;
    try {
      const t = tabRef.current;
      if (t === "pnl") {
        const r = await settleAll({ p: adminGet<LivePnl>("/admin/foxify/v2/live-pnl"), s: adminGet<Scorecard>("/admin/foxify/v2/loss-leader-scorecard") });
        if (r.p) setLivePnl(r.p); if (r.s) setScorecard(r.s);
        flagAuth(r.__errors);
      } else if (t === "positions") {
        const r = await settleAll({ m: adminGet<{ pairs: Array<Record<string, unknown>> }>("/admin/foxify/v2/pairs/mtm"), k: adminGet<StuckPairs>("/admin/foxify/v2/stuck-pairs") });
        if (r.m) setAdminMtm(r.m); if (r.k) setStuck(r.k);
        flagAuth(r.__errors);
      } else if (t === "ops") {
        const r = await settleAll({ d: adminGet<Diag>("/admin/foxify/v2/diagnostics") });
        if (r.d) setDiag(r.d);
        flagAuth(r.__errors);
      }
      setUpdated(new Date().toISOString());
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); setErr("Token invalid or expired."); }
      else setErr((e as Error).message);
    }
  }, []);

  const flagAuth = (errs: Record<string, string>) => {
    if (Object.values(errs).includes("unauthorized")) { setAuthed(false); setErr("Token invalid or expired."); }
    else setErr(Object.values(errs)[0] ?? null);
  };

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), 8000);
    return () => clearInterval(id);
  }, [authed, tab, refresh]);

  if (!authed) return <TokenGate role="admin" title="Cooperative Volume — Atticus (operator)" onSubmit={() => setAuthed(true)} />;

  return (
    <Shell title="Cooperative Volume — Atticus (operator)" subtitle="Full engine: P&L, positions, signal, research, ops. Admin-token only." updatedIso={updated} onSignOut={() => { clearToken("admin"); setAuthed(false); }}>
      <ErrorBar msg={err} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "pnl", label: "P&L" }, { id: "positions", label: "Positions" },
        { id: "signal", label: "Signal / Strategy" }, { id: "research", label: "Research" }, { id: "ops", label: "Ops" }
      ]} />

      {tab === "pnl" && <PnlTab livePnl={livePnl} scorecard={scorecard} />}
      {tab === "positions" && <PositionsTab mtm={adminMtm} stuck={stuck} onAction={() => void refresh()} />}
      {tab === "signal" && <SignalTab />}
      {tab === "research" && <ResearchTab research={research} setResearch={setResearch} />}
      {tab === "ops" && <OpsTab diag={diag} onAction={() => void refresh()} />}
    </Shell>
  );
}

// ─── P&L ───
function PnlTab({ livePnl, scorecard }: { livePnl: LivePnl | null; scorecard: Scorecard | null }) {
  const o = livePnl?.overall;
  const pairCols: Col<LivePnl["pairs"][number]>[] = [
    { key: "pair_id_short", label: "Pair" }, { key: "cell_id", label: "Cell" },
    { key: "cost", label: "Cost", align: "right", render: (p) => fmtUsd(p.hedge_cost_total_usdc) },
    { key: "salvage", label: "Salvage", align: "right", render: (p) => fmtUsd(p.salvage_proceeds_usdc) },
    { key: "net", label: "Foxify net", align: "right", render: (p) => <span style={{ color: pnlColor(p.foxify_net_usdc) }}>{fmtSignedUsd(p.foxify_net_usdc)}</span> },
    { key: "exit", label: "Exit", render: (p) => p.exit_mode ?? "—" },
    { key: "rec", label: "", render: (p) => p.reconciled ? <Pill text="reconciled" color={C.amber} /> : null }
  ];
  return (
    <>
      <StatGrid cols={5}>
        <Stat label="LIVE PAIRS (settled)" value={o?.n ?? "—"} sub={`${o?.wins.count ?? 0}W / ${o?.losses.count ?? 0}L`} />
        <Stat label="TOTAL COST" value={fmtUsd(o?.total_cost_usdc)} />
        <Stat label="TOTAL SALVAGE" value={fmtUsd(o?.total_salvage_usdc)} />
        <Stat label="FOXIFY NET" value={fmtSignedUsd(o?.foxify_net_usdc)} color={pnlColor(o?.foxify_net_usdc)} />
        <Stat label="ATTICUS SHARE" value={fmtUsd(o?.atticus_share_usdc)} sub="collected on uplift" />
      </StatGrid>
      <Panel title="Live (real-money) pairs"><Table cols={pairCols} rows={livePnl?.pairs ?? []} keyOf={(p) => p.pair_id_short} /></Panel>
      <Panel title="Live per-cell">
        <Table cols={[
          { key: "cell_id", label: "Cell" }, { key: "n", label: "N", align: "right" },
          { key: "cost", label: "Cost", align: "right", render: (c: LivePnl["per_cell"][number]) => fmtUsd(c.total_cost_usdc) },
          { key: "net", label: "Foxify net", align: "right", render: (c: LivePnl["per_cell"][number]) => <span style={{ color: pnlColor(c.foxify_net_usdc) }}>{fmtSignedUsd(c.foxify_net_usdc)}</span> },
          { key: "win", label: "Win%", align: "right", render: (c: LivePnl["per_cell"][number]) => fmtPct(c.pct_profitable) }
        ]} rows={livePnl?.per_cell ?? []} keyOf={(c) => c.cell_id} />
      </Panel>
      <Panel title="Shadow loss-leader scorecard (cumulative)">
        {scorecard ? (
          <>
            <StatGrid cols={4}>
              <Stat label="N" value={scorecard.overall.n} />
              <Stat label="CUM NET" value={fmtSignedUsd(scorecard.overall.cumulative_net_usdc)} color={pnlColor(scorecard.overall.cumulative_net_usdc)} />
              <Stat label="WINS (convexity)" value={fmtUsd(scorecard.overall.wins.sum_usdc)} sub={`${scorecard.overall.wins.count}`} color={C.green} />
              <Stat label="LOSSES (bleed)" value={fmtUsd(scorecard.overall.losses.sum_usdc)} sub={`${scorecard.overall.losses.count}`} color={C.red} />
            </StatGrid>
            <div style={{ fontSize: 12, color: C.muted }}>{scorecard.interpretation}</div>
          </>
        ) : <Empty text="No scorecard data." />}
      </Panel>
    </>
  );
}

// ─── Positions + controls ───
// Validated production cell set (display-only flag; source of truth = cellConfig.CELL_STATUS).
// Anything NOT here is experimental/deprecated — shown muted so legacy shadow noise (e.g.
// pair_50k_2pct) is obvious and not mistaken for go-live volume.
const PRODUCTION_CELLS = new Set([
  "pair_50k_3pct_atm_3d", "pair_150k_3pct_atm_3d", "pair_10k_atm_2d",
  "pair_25k_5otm_strangle_2d", "pair_25k_5otm_strangle_1d"
]);

type Subtotal = { n: number; cost: number; mark: number; pnl: number };
/** Aggregate cost / close-value / P&L across a set of MTM pairs. */
function aggregate(pairs: Array<Record<string, unknown>>): Subtotal {
  return pairs.reduce<Subtotal>((s, p) => ({
    n: s.n + 1,
    cost: s.cost + (Number(p.cost_paid_usdc) || 0),
    mark: s.mark + (Number(p.estimated_salvage_usdc) || 0),
    pnl: s.pnl + (Number(p.pnl_if_close_now_usdc) || 0)
  }), { n: 0, cost: 0, mark: 0, pnl: 0 });
}
/** Group MTM pairs by cell_id → subtotal, sorted most-negative P&L first. */
function byCell(pairs: Array<Record<string, unknown>>): Array<{ cell: string; sub: Subtotal }> {
  const m = new Map<string, Array<Record<string, unknown>>>();
  for (const p of pairs) {
    const c = String(p.cell_id ?? "—");
    (m.get(c) ?? m.set(c, []).get(c)!).push(p);
  }
  return [...m.entries()].map(([cell, ps]) => ({ cell, sub: aggregate(ps) })).sort((a, b) => a.sub.pnl - b.sub.pnl);
}
/** Compact subtotal line: "N pairs · cost $X · close $Y · P&L ±$Z". */
function SubtotalLine({ label, sub }: { label: string; sub: Subtotal }) {
  return (
    <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
      <b style={{ color: C.text }}>{label}:</b> {sub.n} pairs · cost {fmtUsd(sub.cost)} · close value {fmtUsd(sub.mark)} ·{" "}
      <span style={{ color: pnlColor(sub.pnl) }}>P&L {fmtSignedUsd(sub.pnl)}</span>
    </div>
  );
}

/** Widest leg bid-ask spread for a pair, as a compact "NN%" (amber when wide). */
function spreadLabel(p: Record<string, unknown>) {
  const ps = Number(p.put_spread_pct); const cs = Number(p.call_spread_pct);
  const vals = [ps, cs].filter((v) => Number.isFinite(v));
  if (vals.length === 0) return "—";
  const wide = Math.max(...vals);
  return <span style={{ color: wide >= 0.15 ? C.amber : C.muted }}>{(wide * 100).toFixed(0)}%</span>;
}

function PositionsTab({ mtm, stuck, onAction }: { mtm: { pairs: Array<Record<string, unknown>> } | null; stuck: StuckPairs | null; onAction: () => void }) {
  const allPairs = mtm?.pairs ?? [];
  // SEPARATE live (real-money) from shadow (paper) — they were mixed before, which made
  // it hard to tell real exposure from the data-engine's paper pairs.
  const livePairs = allPairs.filter((p) => !p.is_shadow);
  const shadowPairs = allPairs.filter((p) => p.is_shadow);
  const cols: Col<Record<string, unknown>>[] = [
    { key: "pair", label: "Pair", render: (p) => short(p.pair_id as string) },
    { key: "cell_id", label: "Cell" },
    { key: "venue", label: "Venue", render: (p) => `${p.put_venue}/${p.call_venue}` },
    { key: "cost", label: "Cost", align: "right", render: (p) => fmtUsd(p.cost_paid_usdc as number) },
    // EXECUTABLE = bid×haircut: what we'd actually receive selling now. Drives TP/close.
    { key: "mark", label: "Mark (exec)", align: "right", render: (p) => fmtUsd(p.estimated_salvage_usdc as number) },
    { key: "pnl", label: "P&L (exec)", align: "right", render: (p) => <span style={{ color: pnlColor(p.pnl_if_close_now_usdc as number) }}>{fmtSignedUsd(p.pnl_if_close_now_usdc as number)}</span> },
    // MID = venue-UI-comparable (Bullish/Deribit show unrealized PnL at mid). On a wide
    // book this is higher than the executable value — the gap is the bid-ask spread.
    { key: "pnl_mid", label: "P&L (mid/UI)", align: "right", render: (p) => p.pnl_if_close_now_mid_usdc == null ? "—" : <span style={{ color: pnlColor(p.pnl_if_close_now_mid_usdc as number) }}>{fmtSignedUsd(p.pnl_if_close_now_mid_usdc as number)}</span> },
    { key: "spread", label: "Spread", align: "right", render: (p) => spreadLabel(p) },
    { key: "quote", label: "Quote", render: (p) => p.valuation_held ? <Pill text="held" color={C.amber} /> : <Pill text="live" color={C.green} /> },
    { key: "ttl", label: "Left", align: "right", render: (p) => fmtHours(p.tenor_remaining_hours as number) },
    { key: "rec", label: "Signal", render: (p) => String(p.recommendation ?? "—") }
  ];
  const liveNet = livePairs.reduce((s, p) => s + (Number(p.pnl_if_close_now_usdc) || 0), 0);
  const liveSub = aggregate(livePairs);
  const shadowSub = aggregate(shadowPairs);
  const shadowByCell = byCell(shadowPairs);
  const cellSubCols: Col<{ cell: string; sub: Subtotal }>[] = [
    { key: "cell", label: "Cell", render: (r) => <span>{r.cell}{PRODUCTION_CELLS.has(r.cell) ? "" : " "}{!PRODUCTION_CELLS.has(r.cell) && <Pill text="non-prod" color={C.muted} />}</span> },
    { key: "n", label: "Pairs", align: "right", render: (r) => String(r.sub.n) },
    { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.sub.cost) },
    { key: "mark", label: "Close value", align: "right", render: (r) => fmtUsd(r.sub.mark) },
    { key: "pnl", label: "P&L", align: "right", render: (r) => <span style={{ color: pnlColor(r.sub.pnl) }}>{fmtSignedUsd(r.sub.pnl)}</span> }
  ];
  const stuckCols: Col<Record<string, unknown>>[] = [
    { key: "pair", label: "Pair", render: (p) => short(p.pair_id as string) },
    { key: "cell_id", label: "Cell" }, { key: "status", label: "Status" },
    { key: "shadow", label: "Type", render: (p) => p.is_shadow ? <Pill text="shadow" color={C.muted} /> : <Pill text="LIVE" color={C.green} /> },
    { key: "age", label: "Age (min)", align: "right", render: (p) => String(p.age_minutes ?? "—") },
    { key: "rt", label: "Runtime", render: (p) => (p.has_runtime ? "yes" : "no") },
    { key: "oob", label: "Out-of-band?", render: (p) => p.likely_out_of_band ? <Pill text="reconcile" color={C.amber} /> : "—" }
  ];
  return (
    <>
      {/* LIVE — real money, kept visually distinct (green border) and first. */}
      <Panel title={`🟢 LIVE positions — real money (${livePairs.length})`} style={{ border: `1px solid ${C.green}55`, borderRadius: 6 }}
        right={<span style={{ fontSize: 12, color: pnlColor(liveNet) }}>net {fmtSignedUsd(liveNet)}</span>}>
        <Table cols={cols} rows={livePairs} keyOf={(p) => p.pair_id as string} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.4 }}>
          <b>P&L (exec)</b> = realizable value at the venue <b>bid</b> (what you'd actually get selling now) — this is what TP/auto-close decides on.
          {" "}<b>P&L (mid/UI)</b> = value at the bid-ask <b>mid</b>, matching the Bullish/Deribit UI's unrealized PnL. On a wide book the UI looks more profitable than is realizable; the difference is the <b>Spread</b> column.
          {" "}<b>Quote=held</b> means the venue's live bid dropped out this poll (its UI mark may be flapping/0) and we're holding the last-good value to keep the mark steady — TP still acts on this stabilized value.
        </div>
        <SubtotalLine label="LIVE subtotal" sub={liveSub} />
      </Panel>
      {/* SHADOW — paper / data engine, clearly separated. Subtotaled + grouped by cell
          so a long list of negatives reads as aggregates, and non-production cells (e.g.
          deprecated pair_50k_2pct) are visibly flagged rather than mistaken for go-live. */}
      <Panel title={`Shadow positions — paper / data engine (${shadowPairs.length})`}>
        <SubtotalLine label="SHADOW subtotal (all)" sub={shadowSub} />
        <div style={{ fontSize: 11, color: C.muted, margin: "4px 0 8px" }}>
          Shadow = paper-executed for model/data accrual — <b>no real money</b>. Negatives here are mostly calm loss-leaders + legacy/deprecated cells; they are NOT a forecast of live P&L. See the per-cell breakdown.
        </div>
        <div style={{ fontSize: 12, color: C.text, fontWeight: 700, margin: "6px 0 2px" }}>By cell (worst P&L first)</div>
        <Table cols={cellSubCols} rows={shadowByCell} keyOf={(r) => r.cell} />
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: C.blue }}>Show all {shadowPairs.length} shadow positions</summary>
          <Table cols={cols} rows={shadowPairs} keyOf={(p) => p.pair_id as string} />
        </details>
      </Panel>
      <Panel title={`Stuck / out-of-band (${stuck?.likely_out_of_band_count ?? 0} flagged of ${stuck?.total_non_terminal ?? 0})`}>
        <Table cols={stuckCols} rows={stuck?.pairs ?? []} keyOf={(p) => p.pair_id as string} />
      </Panel>
      <ReconcileForm onAction={onAction} />
      <RespawnForm onAction={onAction} />
      <ForceTriggerForm onAction={onAction} />
    </>
  );
}

function ReconcileForm({ onAction }: { onAction: () => void }) {
  const [pairId, setPairId] = useState(""); const [salvage, setSalvage] = useState(""); const [netPnl, setNetPnl] = useState("");
  const [costOverride, setCostOverride] = useState(""); const [force, setForce] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const submit = async () => {
    try {
      const body: Record<string, unknown> = { pair_id: pairId.trim(), force };
      if (salvage) body.salvage_proceeds_usdc = Number(salvage);
      if (netPnl) body.net_pnl_usdc = Number(netPnl);
      if (costOverride) body.hedge_cost_override_usdc = Number(costOverride);
      const r = await adminPost<Record<string, unknown>>("/admin/foxify/v2/reconcile-settle", body);
      setRes({ ok: true, msg: `OK — ${JSON.stringify(r)}` }); onAction();
    } catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  return (
    <Panel title="Reconcile-settle (out-of-band close / correct)">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <input style={fieldStyle} placeholder="pair_id" value={pairId} onChange={(e) => setPairId(e.target.value)} />
        <input style={fieldStyle} placeholder="salvage_usdc" value={salvage} onChange={(e) => setSalvage(e.target.value)} />
        <input style={fieldStyle} placeholder="net_pnl_usdc" value={netPnl} onChange={(e) => setNetPnl(e.target.value)} />
        <input style={fieldStyle} placeholder="cost_override" value={costOverride} onChange={(e) => setCostOverride(e.target.value)} />
        <label style={{ fontSize: 12, color: C.text }}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> force (correct settled)</label>
        <button style={btnStyle} disabled={!pairId.trim()} onClick={submit}>Reconcile</button>
      </div>
      <ActionResult r={res} />
    </Panel>
  );
}

function RespawnForm({ onAction }: { onAction: () => void }) {
  const [pairId, setPairId] = useState(""); const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const submit = async () => {
    try { const r = await adminPost<Record<string, unknown>>("/admin/foxify/v2/respawn-close", { pair_id: pairId.trim() }); setRes({ ok: true, msg: `OK — ${JSON.stringify(r)}` }); onAction(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  return (
    <Panel title="Respawn-close (re-drive a stuck unwinding — legs STILL held)">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input style={fieldStyle} placeholder="pair_id" value={pairId} onChange={(e) => setPairId(e.target.value)} />
        <button style={btnStyle} disabled={!pairId.trim()} onClick={submit}>Respawn close</button>
      </div>
      <ActionResult r={res} />
    </Panel>
  );
}

function ForceTriggerForm({ onAction }: { onAction: () => void }) {
  const [pairId, setPairId] = useState(""); const [side, setSide] = useState("down"); const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const submit = async () => {
    try { const r = await adminPost<Record<string, unknown>>("/admin/foxify/v2/force-trigger", { pair_id: pairId.trim(), side, mode: "fast" }); setRes({ ok: true, msg: `OK — ${JSON.stringify(r)}` }); onAction(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  return (
    <Panel title="Force-trigger (SHADOW pairs only)">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input style={fieldStyle} placeholder="pair_id" value={pairId} onChange={(e) => setPairId(e.target.value)} />
        <select style={fieldStyle} value={side} onChange={(e) => setSide(e.target.value)}><option value="down">down</option><option value="up">up</option></select>
        <button style={btnStyle} disabled={!pairId.trim()} onClick={submit}>Force trigger</button>
      </div>
      <ActionResult r={res} />
    </Panel>
  );
}

// ─── Signal / Strategy ───
const REGIMES = ["calm", "moderate", "elevated", "stress"] as const;
type AllowlistAll = Record<string, { default_allowlist?: string[]; effective_allowlist?: string[] }>;

function SignalTab() {
  const [data, setData] = useState<{ signal?: unknown; selector?: unknown; calibration?: unknown } | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistAll | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});

  const loadAllowlist = useCallback(async () => {
    try { setAllowlist(await adminGet<AllowlistAll>("/admin/foxify/v2/cell-allowlist")); } catch (e) { setMsg({ ok: false, msg: (e as Error).message }); }
  }, []);

  useEffect(() => {
    void loadAllowlist();
    void (async () => {
      const r = await settleAll({
        signal: adminGet("/admin/foxify/v2/signal-distribution"),
        selector: adminGet("/admin/foxify/v2/structure-selector"),
        calibration: adminGet("/admin/foxify/v2/regime-calibration")
      });
      setData({ signal: r.signal, selector: r.selector, calibration: r.calibration });
    })();
  }, [loadAllowlist]);

  const toggle = async (regime: string, cellId: string, enabled: boolean) => {
    try {
      await adminPost("/admin/foxify/v2/cell-allowlist", { regime, cell_id: cellId, enabled, reason: "via admin UI" });
      setMsg({ ok: true, msg: `${enabled ? "added" : "removed"} ${cellId} ${enabled ? "to" : "from"} ${regime}` });
      void loadAllowlist();
    } catch (e) { setMsg({ ok: false, msg: (e as Error).message }); }
  };

  return (
    <>
      <Panel title="Cell allowlist — per regime (manual control)">
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Effective allowlist (default ± overrides). Remove a cell or add one by ID — applies a DB override immediately (live activation still gated by env).</div>
        {REGIMES.map((r) => {
          const eff = allowlist?.[r]?.effective_allowlist ?? [];
          return (
            <div key={r} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12, color: r === "calm" ? C.muted : C.text, fontWeight: 700, marginBottom: 4 }}>{r}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                {eff.length === 0 ? <span style={{ color: "#666", fontSize: 11 }}>empty (stand-down)</span> : eff.map((cid) => (
                  <span key={cid} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 10, fontSize: 11, background: "#16241a", color: C.text, border: `1px solid ${C.border}` }}>
                    {cid}
                    <span onClick={() => toggle(r, cid, false)} title="remove" style={{ cursor: "pointer", color: C.red }}>×</span>
                  </span>
                ))}
                <input
                  style={{ ...fieldStyle, width: 200 }}
                  placeholder="add cell_id…"
                  value={addInputs[r] ?? ""}
                  onChange={(e) => setAddInputs((s) => ({ ...s, [r]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && (addInputs[r] ?? "").trim()) { toggle(r, addInputs[r].trim(), true); setAddInputs((s) => ({ ...s, [r]: "" })); } }}
                />
              </div>
            </div>
          );
        })}
        <ActionResult r={msg} />
      </Panel>
      <Panel title="Structure selector"><JsonView data={data?.selector} /></Panel>
      <Panel title="Signal distribution"><JsonView data={data?.signal} /></Panel>
      <Panel title="Regime calibration"><JsonView data={data?.calibration} /></Panel>
    </>
  );
}

// ─── Research (on-demand) ───
function ResearchTab({ research, setResearch }: { research: { label: string; data: unknown } | null; setResearch: (r: { label: string; data: unknown } | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const items: { label: string; path: string }[] = [
    { label: "Close-fill calibration", path: "/admin/foxify/v2/close-fill-calibration" },
    { label: "Realized vs MC", path: "/admin/foxify/v2/realized-vs-mc" },
    { label: "Scaling projection", path: "/admin/foxify/v2/scaling-projection" },
    { label: "Cell costs", path: "/admin/foxify/v2/cell-costs" },
    { label: "Settled summary", path: "/admin/foxify/v2/settled-summary" },
    { label: "Venue routing", path: "/admin/foxify/v2/venue-routing" },
    { label: "Latest cell-sweep", path: "/admin/foxify/v2/cell-sweep/latest" }
  ];
  const run = async (label: string, path: string) => {
    setBusy(label);
    try { const data = await adminGet(path); setResearch({ label, data }); }
    catch (e) { setResearch({ label, data: { error: (e as Error).message } }); }
    finally { setBusy(null); }
  };
  return (
    <>
      <Panel title="Research / diagnostics (fetch on demand)">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {items.map((it) => (
            <button key={it.path} style={{ ...btnStyle, background: busy === it.label ? "#444" : "#0066cc" }} onClick={() => run(it.label, it.path)}>
              {busy === it.label ? "…" : it.label}
            </button>
          ))}
        </div>
      </Panel>
      {research && <Panel title={research.label}><JsonView data={research.data} /></Panel>}
    </>
  );
}

// ─── Ops ───
function OpsTab({ diag, onAction }: { diag: Diag | null; onAction: () => void }) {
  const venue = (diag?.liquidChainCache as { venue_status?: Record<string, { ok?: boolean; quoteCount?: number }> } | undefined)?.venue_status;
  const feed = (diag?.feed as { health?: string } | undefined)?.health;
  const env = diag?.env as Record<string, unknown> | undefined;
  const halt = diag?.halt as { atticusHalt?: boolean } | boolean | undefined;
  const haltOn = typeof halt === "object" ? halt?.atticusHalt : !!halt;
  return (
    <>
      <StatGrid cols={4}>
        <Stat label="FEED" value={feed ?? "—"} color={feed === "healthy" ? C.green : C.amber} />
        <Stat label="DERIBIT" value={venue?.deribit?.ok ? `ok (${venue.deribit.quoteCount})` : "down"} color={venue?.deribit?.ok ? C.green : C.red} />
        <Stat label="BULLISH" value={venue?.bullish?.ok ? `ok (${venue.bullish.quoteCount})` : "down"} color={venue?.bullish?.ok ? C.green : C.red} />
        <Stat label="LIVE EXEC" value={String((env?.live_enabled ?? "—"))} sub="real-money gate" color={env?.live_enabled ? C.amber : C.muted} />
      </StatGrid>
      <RegimeProximityWidget prox={diag?.regime_proximity as Record<string, unknown> | undefined} />
      <HaltControls haltOn={!!haltOn} onAction={onAction} />
      <BackfillForm onAction={onAction} />
      <Panel title="Full diagnostics"><JsonView data={diag} /></Panel>
    </>
  );
}

function RegimeProximityWidget({ prox }: { prox?: Record<string, unknown> }) {
  if (!prox) return null;
  const trend = String(prox.trend ?? "unknown");
  const trendColor = trend === "rising" ? C.green : trend === "falling" ? C.red : C.muted;
  const approaching = prox.approaching_up === true;
  return (
    <Panel title="Regime proximity (pre-position before the cross)">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
        <Stat label="DVOL" value={String(prox.dvol ?? "—")} />
        <Stat label="REGIME" value={String(prox.regime ?? "—")} />
        <Stat label={`→ ${String(prox.next_regime_up ?? "top")}`} value={prox.dvol_to_next_up != null ? `${prox.dvol_to_next_up} away` : "—"} sub={prox.next_threshold_up != null ? `@ ${prox.next_threshold_up}` : ""} color={approaching ? C.amber : C.text} />
        <Stat label="TREND (15m)" value={trend} color={trendColor} />
        <Stat label="APPROACHING" value={approaching ? "YES" : "no"} color={approaching ? C.amber : C.muted} />
      </div>
      {prox.note != null && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{String(prox.note)}</div>}
    </Panel>
  );
}

function HaltControls({ haltOn, onAction }: { haltOn: boolean; onAction: () => void }) {
  const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const halt = async () => {
    if (!window.confirm("HALT all Atticus activations now?")) return;
    try { await adminPost("/admin/foxify/v2/halt", { kind: "atticus", reason: "operator_kill", notes: "via admin UI" }); setRes({ ok: true, msg: "Halted." }); onAction(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  const resume = async () => {
    try { await adminPost("/admin/foxify/v2/resume", { kind: "atticus" }); setRes({ ok: true, msg: "Resumed." }); onAction(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  return (
    <Panel title="Kill switch">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: haltOn ? C.red : C.green }}>{haltOn ? "● HALTED" : "● running"}</span>
        <button style={{ ...btnStyle, background: "#7a3030" }} onClick={halt}>Halt Atticus</button>
        <button style={{ ...btnStyle, background: "#306a30" }} onClick={resume}>Resume</button>
      </div>
      <ActionResult r={res} />
    </Panel>
  );
}

function BackfillForm({ onAction }: { onAction: () => void }) {
  const [days, setDays] = useState("90"); const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const submit = async () => {
    try { const r = await adminPost<Record<string, unknown>>("/admin/foxify/v2/dvol-backfill", { days: Number(days) }); setRes({ ok: true, msg: `OK — ${JSON.stringify(r).slice(0, 200)}` }); onAction(); }
    catch (e) { setRes({ ok: false, msg: (e as Error).message }); }
  };
  return (
    <Panel title="DVOL backfill">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input style={fieldStyle} placeholder="days" value={days} onChange={(e) => setDays(e.target.value)} />
        <button style={btnStyle} onClick={submit}>Run backfill</button>
      </div>
      <ActionResult r={res} />
    </Panel>
  );
}
