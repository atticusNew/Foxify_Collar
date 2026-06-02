/**
 * Foxify-facing cooperative-volume dashboard (/cover).
 *
 * Read-layer over the Foxify-token endpoints ONLY (/foxify/v2/*). Built for
 * transparency: Foxify sees the exchange, the ACTUAL cost, the protection window,
 * live MTM + profitability, the exact split, the cell menu offered to their bot,
 * and a manual Close. It NEVER calls an /admin/* endpoint, so no Atticus strategy
 * or ops internals can surface here.
 *
 * Shadow (Atticus paper) pairs are filtered out — Foxify only sees their own
 * real-money protections.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clearToken, foxifyGet, foxifyPost, getToken, settleAll, UnauthorizedError } from "./api";
import { COLORS as C, Empty, ErrorBar, Panel, Pill, Shell, Stat, StatGrid, Table, TokenGate, type Col } from "./widgets";
import { fmtHours, fmtPct, fmtSignedUsd, fmtUsd, pnlColor, short, structureLabel } from "./format";

// ─── Types (defensive — backend is source of truth) ───
type Status = {
  asOf: string;
  todayPairsActivated: number;
  todayPairsTriggered: number;
  todayPairsSettled: number;
  todayFoxifyPnlUsdc: number;
  currentTier: { label: string; atticusPct: number; foxifyPct: number; atticusFloorUsdc: number };
  haltStatus: { foxifyHalt: boolean; atticusHalt: boolean; reason: string | null };
};
type Regime = { dvol: number | null; regime: string | null; halt?: unknown };
type Signal = {
  regime?: string; dvol?: number; good_to_activate?: boolean; recommended_structure?: string;
  recommended_cells?: string[];
  calm_loss_leader?: { eligible_cells?: string[]; max_loss_usdc?: number };
};
type CatalogCell = {
  cell_id: string; structure: string; notional_usdc_per_leg: number;
  trigger_pct_down: number; trigger_pct_up: number; hedge_tenor_days: number;
  put_strike_itm_pct: number; call_strike_itm_pct: number; offered_in_regimes: string[];
};
type MtmPair = {
  pair_id: string; cell_id: string; is_shadow: boolean; cost_paid_usdc: number;
  put_strike: number; call_strike: number; contracts_btc: number;
  current_option_mark_usdc: number; estimated_salvage_usdc: number;
  pnl_if_close_now_usdc: number; pnl_pct: number;
  put_venue: string; call_venue: string;
  trigger_down_price: number; trigger_up_price: number; closest_trigger_pct: number;
  tenor_remaining_hours: number; recommendation: string; recommendation_reason: string;
  greeks?: { delta: number; gamma: number; vega_per_pct: number; theta_per_day: number };
};
type MtmResp = { current_spot: number; total_active: number; total_cost_paid_usdc: number; total_estimated_salvage_usdc: number; total_pnl_if_close_all_now_usdc: number; pairs: MtmPair[] };
type Leg = { legRole: string; venue: string; symbol: string; strikeUsdc: number; contractsBtc: number; buyAskUsdcPerBtc: number; buyCostUsdc: number; sellAskUsdcPerBtc: number | null; sellProceedsUsdc: number | null };
type PairDetail = { pair: { tierAtActivation: string; atticusFloorUsdc: number; hedgeCostTotalUsdc: number; status: string; salvageProceedsUsdc: number | null; upliftUsdc: number | null; atticusShareUsdc: number | null; foxifyShareUsdc: number | null }; legs: Leg[] };

const recColor = (r: string): string =>
  r?.startsWith("STRONG") ? C.green : r === "TAKE_PROFIT_AVAILABLE" ? C.green : r === "TRIGGERED" ? C.amber : r === "EXPIRED" ? C.red : C.muted;

export function FoxifyVolumeDashboard() {
  const [authed, setAuthed] = useState(() => !!getToken("foxify"));
  const [status, setStatus] = useState<Status | null>(null);
  const [regime, setRegime] = useState<Regime | null>(null);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [catalog, setCatalog] = useState<CatalogCell[]>([]);
  const [mtm, setMtm] = useState<MtmResp | null>(null);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ id: string; detail: PairDetail | null; explain: unknown; audit: unknown } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = useRef(authed);
  live.current = authed;

  const refresh = useCallback(async () => {
    if (!live.current) return;
    try {
      const r = await settleAll({
        status: foxifyGet<Status>("/foxify/v2/status"),
        regime: foxifyGet<Regime>("/foxify/v2/regime"),
        signal: foxifyGet<Signal>("/foxify/v2/should_activate"),
        cells: foxifyGet<{ cells: CatalogCell[] }>("/foxify/v2/cells"),
        mtm: foxifyGet<MtmResp>("/foxify/v2/pairs/mtm")
      });
      if (r.status) setStatus(r.status);
      if (r.regime) setRegime(r.regime);
      if (r.signal) setSignal(r.signal);
      if (r.cells) setCatalog(r.cells.cells ?? []);
      if (r.mtm) setMtm(r.mtm);
      const e = Object.values(r.__errors)[0];
      if (Object.values(r.__errors).includes("unauthorized")) { setAuthed(false); setErr("Token invalid or expired."); }
      else setErr(e ?? null);
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); setErr("Token invalid or expired."); }
      else setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  const onClose = useCallback(async (pairId: string) => {
    if (!window.confirm(`Close protection ${short(pairId)}?\n\nThis ends the protection immediately and unwinds the hedge. Inform your bot so it can adjust the underlying perp. This cannot be undone.`)) return;
    try {
      await foxifyPost("/foxify/v2/close", { pairId, foxifyCloseReason: "manual_close_via_dashboard" });
      void refresh();
    } catch (e) { alert(`Close failed: ${(e as Error).message}`); }
  }, [refresh]);

  const openDrill = useCallback(async (id: string) => {
    try {
      const r = await settleAll({
        detail: foxifyGet<PairDetail>(`/foxify/v2/pairs/${id}`),
        explain: foxifyGet(`/foxify/v2/pairs/${id}/explain`),
        audit: foxifyGet(`/foxify/v2/pairs/${id}/feed-audit`)
      });
      setDrill({ id, detail: r.detail, explain: r.explain, audit: r.audit });
    } catch (e) { alert(`Audit fetch failed: ${(e as Error).message}`); }
  }, []);

  if (!authed) return <TokenGate role="foxify" title="Cooperative Volume — Foxify" onSubmit={() => setAuthed(true)} />;

  const realPairs = (mtm?.pairs ?? []).filter((p) => !p.is_shadow);
  const shownPairs = selectedCell ? realPairs.filter((p) => p.cell_id === selectedCell) : realPairs;
  const offered = new Set<string>([...(signal?.recommended_cells ?? []), ...(signal?.calm_loss_leader?.eligible_cells ?? [])]);
  const selCatalog = catalog.find((c) => c.cell_id === selectedCell) ?? null;
  const selRollup = selectedCell ? {
    n: shownPairs.length,
    cost: shownPairs.reduce((s, p) => s + p.cost_paid_usdc, 0),
    mark: shownPairs.reduce((s, p) => s + p.estimated_salvage_usdc, 0),
    pnl: shownPairs.reduce((s, p) => s + p.pnl_if_close_now_usdc, 0)
  } : null;

  const pairCols: Col<MtmPair>[] = [
    { key: "pair_id", label: "Pair", render: (p) => <span style={{ fontFamily: "monospace" }}>{short(p.pair_id)}</span> },
    { key: "cell_id", label: "Cell" },
    { key: "venue", label: "Exchange", render: (p) => p.put_venue === p.call_venue ? p.put_venue : `${p.put_venue}/${p.call_venue}` },
    { key: "cost", label: "Cost paid", align: "right", render: (p) => fmtUsd(p.cost_paid_usdc) },
    { key: "strikes", label: "Strikes (P / C)", render: (p) => `${fmtUsd(p.put_strike, 0)} / ${fmtUsd(p.call_strike, 0)}` },
    { key: "window", label: "Trigger window", render: (p) => `${fmtUsd(p.trigger_down_price, 0)} – ${fmtUsd(p.trigger_up_price, 0)}` },
    { key: "dist", label: "Dist", align: "right", render: (p) => fmtPct(p.closest_trigger_pct) },
    { key: "ttl", label: "Window left", align: "right", render: (p) => fmtHours(p.tenor_remaining_hours) },
    { key: "mark", label: "MTM", align: "right", render: (p) => fmtUsd(p.estimated_salvage_usdc) },
    { key: "pnl", label: "P&L", align: "right", render: (p) => <span style={{ color: pnlColor(p.pnl_if_close_now_usdc) }}>{fmtSignedUsd(p.pnl_if_close_now_usdc)} ({fmtPct(p.pnl_pct)})</span> },
    { key: "rec", label: "Signal", render: (p) => <Pill text={p.recommendation} color={recColor(p.recommendation)} /> },
    { key: "act", label: "", render: (p) => (
      <span style={{ whiteSpace: "nowrap" }}>
        <button onClick={() => openDrill(p.pair_id)} style={{ padding: "3px 8px", marginRight: 6, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 3, fontSize: 11, cursor: "pointer" }}>audit</button>
        <button onClick={() => onClose(p.pair_id)} style={{ padding: "3px 8px", background: "#7a3030", color: "#fff", border: "none", borderRadius: 3, fontSize: 11, cursor: "pointer" }}>Close</button>
      </span>
    ) }
  ];

  const cellCols: Col<CatalogCell>[] = [
    { key: "cell_id", label: "Cell", render: (c) => <span style={{ fontWeight: selectedCell === c.cell_id ? 700 : 400 }}>{c.cell_id}{offered.has(c.cell_id) ? " " : ""}{offered.has(c.cell_id) && <Pill text="offered now" color={C.green} />}</span> },
    { key: "structure", label: "Structure", render: (c) => structureLabel(c.structure) },
    { key: "notional", label: "Notional/leg", align: "right", render: (c) => fmtUsd(c.notional_usdc_per_leg, 0) },
    { key: "trig", label: "Trigger band", align: "right", render: (c) => `±${fmtPct(Math.max(c.trigger_pct_down, c.trigger_pct_up), 1)}` },
    { key: "tenor", label: "Window", align: "right", render: (c) => `${c.hedge_tenor_days}d` },
    { key: "regimes", label: "Offered in", render: (c) => c.offered_in_regimes.length ? c.offered_in_regimes.join(", ") : "—" }
  ];

  const haltOn = status?.haltStatus?.atticusHalt || status?.haltStatus?.foxifyHalt;

  return (
    <Shell title="Cooperative Volume — Foxify" subtitle="Your protections, costs, and the cells offered to your bot — fully transparent." updatedIso={status?.asOf} onSignOut={() => { clearToken("foxify"); setAuthed(false); }}>
      <ErrorBar msg={err} />

      <StatGrid cols={5}>
        <Stat label="SPOT (BTC)" value={mtm?.current_spot ? fmtUsd(mtm.current_spot, 0) : "—"} sub="Atticus source-of-truth" />
        <Stat label="REGIME" value={regime?.regime ?? "—"} sub={regime?.dvol != null ? `DVOL ${regime.dvol.toFixed(1)}` : ""} color={regime?.regime === "calm" ? C.muted : C.amber} />
        <Stat label="SIGNAL" value={signal?.good_to_activate ? "GO" : "STAND DOWN"} sub={signal?.recommended_structure ?? ""} color={signal?.good_to_activate ? C.green : C.muted} />
        <Stat label="ACTIVE" value={realPairs.length} sub="your open protections" />
        <Stat label="P&L TODAY" value={fmtSignedUsd(status?.todayFoxifyPnlUsdc)} sub={`${status?.todayPairsActivated ?? 0} activated · ${status?.todayPairsTriggered ?? 0} triggered`} color={pnlColor(status?.todayFoxifyPnlUsdc)} />
      </StatGrid>

      {haltOn && <ErrorBar msg={`Activations halted: ${status?.haltStatus.reason ?? "operator halt"}. Existing protections are unaffected.`} />}

      <Panel title="Available protection cells (offered to your bot)" right={selectedCell ? <span onClick={() => setSelectedCell(null)} style={{ color: C.blue, cursor: "pointer", fontSize: 12 }}>clear filter</span> : undefined}>
        <div onClick={(e) => {
          const tr = (e.target as HTMLElement).closest("tr[data-cell]");
          if (tr) setSelectedCell((tr as HTMLElement).dataset.cell ?? null);
        }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: C.muted, textAlign: "left" }}>{cellCols.map((c) => <th key={c.key} style={{ padding: "6px 8px", textAlign: c.align ?? "left" }}>{c.label}</th>)}</tr></thead>
            <tbody>
              {catalog.length === 0 ? <tr><td colSpan={cellCols.length}><Empty text="No cells available." /></td></tr> : catalog.map((c) => (
                <tr key={c.cell_id} data-cell={c.cell_id} style={{ borderTop: `1px solid ${C.border}`, color: C.text, cursor: "pointer", background: selectedCell === c.cell_id ? "#16241a" : undefined }}>
                  {cellCols.map((col) => <td key={col.key} style={{ padding: "6px 8px", textAlign: col.align ?? "left" }}>{col.render ? col.render(c) : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ color: C.muted, fontSize: 11, marginTop: 8 }}>Click a cell to filter your active protections below. “offered now” = currently in your bot’s menu for this regime.</div>
      </Panel>

      {selCatalog && selRollup && (
        <Panel title={`Selected cell — ${selCatalog.cell_id}`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, fontSize: 13 }}>
            <Stat label="Structure" value={structureLabel(selCatalog.structure)} sub={`±${fmtPct(Math.max(selCatalog.trigger_pct_down, selCatalog.trigger_pct_up),1)} trigger · ${selCatalog.hedge_tenor_days}d window`} />
            <Stat label="Notional / leg" value={fmtUsd(selCatalog.notional_usdc_per_leg, 0)} />
            <Stat label="Your active in this cell" value={selRollup.n} sub={`${fmtUsd(selRollup.cost)} cost · ${fmtUsd(selRollup.mark)} MTM`} />
            <Stat label="Unrealized P&L (cell)" value={fmtSignedUsd(selRollup.pnl)} color={pnlColor(selRollup.pnl)} />
          </div>
        </Panel>
      )}

      <Panel title={`My active protections (${shownPairs.length})${selectedCell ? ` — ${selectedCell}` : ""}`}>
        <Table cols={pairCols} rows={shownPairs} keyOf={(p) => p.pair_id} />
        {realPairs.length > 0 && (
          <div style={{ color: C.muted, fontSize: 11, marginTop: 8 }}>
            Totals — cost {fmtUsd(realPairs.reduce((s, p) => s + p.cost_paid_usdc, 0))} · MTM {fmtUsd(realPairs.reduce((s, p) => s + p.estimated_salvage_usdc, 0))} ·{" "}
            <span style={{ color: pnlColor(realPairs.reduce((s, p) => s + p.pnl_if_close_now_usdc, 0)) }}>P&L {fmtSignedUsd(realPairs.reduce((s, p) => s + p.pnl_if_close_now_usdc, 0))}</span>
          </div>
        )}
      </Panel>

      {drill && (
        <Panel title={`Pair detail & audit — ${short(drill.id)}`} right={<span onClick={() => setDrill(null)} style={{ color: C.blue, cursor: "pointer", fontSize: 12 }}>close</span>}>
          {drill.detail && (
            <>
              {/* Per-leg ACTUAL fills — exchange + real cost, leg by leg (full transparency). */}
              <div style={{ fontSize: 12, color: C.text, marginBottom: 4, fontWeight: 700 }}>Legs — actual fills</div>
              <Table
                cols={[
                  { key: "legRole", label: "Leg", render: (l: Leg) => l.legRole === "long_put" ? "put" : "call" },
                  { key: "venue", label: "Exchange", render: (l: Leg) => l.venue },
                  { key: "symbol", label: "Instrument" },
                  { key: "contractsBtc", label: "Contracts", align: "right", render: (l: Leg) => l.contractsBtc.toFixed(4) },
                  { key: "buyAsk", label: "Buy $/BTC", align: "right", render: (l: Leg) => fmtUsd(l.buyAskUsdcPerBtc) },
                  { key: "buyCost", label: "Buy cost", align: "right", render: (l: Leg) => fmtUsd(l.buyCostUsdc) },
                  { key: "sellPx", label: "Sell $/BTC", align: "right", render: (l: Leg) => l.sellAskUsdcPerBtc != null ? fmtUsd(l.sellAskUsdcPerBtc) : "—" },
                  { key: "sellProc", label: "Sell proceeds", align: "right", render: (l: Leg) => l.sellProceedsUsdc != null ? fmtUsd(l.sellProceedsUsdc) : "—" }
                ]}
                rows={drill.detail.legs}
                keyOf={(l) => l.legRole}
              />
              {/* The exact split — what Atticus takes vs what flows to Foxify. Shown ON PURPOSE. */}
              <div style={{ marginTop: 10, padding: 10, background: "#13201a", borderRadius: 6, fontSize: 12 }}>
                <div style={{ color: C.muted, marginBottom: 4 }}>Cooperative split (full transparency — this is exactly what Atticus takes)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                  <div><span style={{ color: C.muted }}>Hedge cost paid:</span> {fmtUsd(drill.detail.pair.hedgeCostTotalUsdc)}</div>
                  <div><span style={{ color: C.muted }}>Tier / Atticus floor:</span> {drill.detail.pair.tierAtActivation} / {fmtUsd(drill.detail.pair.atticusFloorUsdc)}</div>
                  {drill.detail.pair.status === "settled" ? (
                    <>
                      <div><span style={{ color: C.muted }}>Salvage / uplift:</span> {fmtUsd(drill.detail.pair.salvageProceedsUsdc ?? 0)} / <span style={{ color: pnlColor(drill.detail.pair.upliftUsdc) }}>{fmtSignedUsd(drill.detail.pair.upliftUsdc ?? 0)}</span></div>
                      <div><span style={{ color: C.muted }}>Atticus / Foxify share:</span> <span style={{ color: C.amber }}>{fmtUsd(drill.detail.pair.atticusShareUsdc ?? 0)}</span> / <span style={{ color: C.green }}>{fmtUsd(drill.detail.pair.foxifyShareUsdc ?? 0)}</span></div>
                    </>
                  ) : (
                    <div style={{ gridColumn: "span 2", color: C.muted }}>Split realizes at settlement — Atticus only collects on positive uplift (loss paths: Atticus $0, Foxify keeps all salvage).</div>
                  )}
                </div>
              </div>
            </>
          )}
          <div style={{ fontSize: 12, color: C.muted, margin: "10px 0 6px" }}>Outcome explanation + the exact feed snapshot used at activation/trigger (full audit trail).</div>
          <pre style={{ fontSize: 11, color: C.text, whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(drill.explain, null, 2)}</pre>
          <pre style={{ fontSize: 11, color: "#9bb", whiteSpace: "pre-wrap", marginTop: 8 }}>{JSON.stringify(drill.audit, null, 2)}</pre>
        </Panel>
      )}
    </Shell>
  );
}
