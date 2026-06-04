/**
 * Protected Leverage — read-only widget (Phase 1, Sai exchange sales artifact / sandbox).
 *
 * TWO products, auto-selected by leverage:
 *  - Moderate leverage (< 25×): "Cap your loss" — a single protective PUT caps your worst
 *    case well below your margin and you can't be liquidated. (GET /floor-quote/tiers)
 *  - High leverage (≥ 25×): "Wick insurance" — a short-dated put SPREAD around the
 *    liquidation zone so a brief spike doesn't force you out; you stay in the trade and keep
 *    the upside. Single puts cost ~your whole margin at 40×, the spread is ~15%. (GET
 *    /wick-insurance — OKX-led; Bullish quotes but is priciest.)
 *
 * Integrated-model truth: a put whose strike sits ABOVE the liquidation price keeps the
 * position open (the put's value covers the margin shortfall). Needs exchange margin
 * integration (Sai); cross-venue today the put bounds NET loss at the same number.
 *
 * READ-ONLY. Admin-token gated for now.
 */

import { useEffect, useState, useCallback } from "react";
import { adminGet, getToken, clearToken, UnauthorizedError } from "./api";
import { TokenGate, Shell, COLORS as C } from "./widgets";

type FloorTier = {
  margin_fraction: number; floor_pct: number; floor_strike: number;
  available: boolean; unavailable_reason: string | null;
  venue: string | null; put_cost_usdc: number | null; cost_per_day_usdc: number | null;
  max_loss_usdc: number | null; recommended: boolean;
};
type CapPosition = { spot: number; size_btc: number; leverage: number; notional_usdc: number; margin_usdc: number; liquidation_price: number; liq_drop_pct: number };
type CapBundle = { as_of: string; position: CapPosition; tenor_days: number; tiers: FloorTier[]; note: string };

type WickVenue = { venue: string; k1_strike: number | null; k2_strike: number | null; single_put_cost_usdc: number | null; single_put_pct_margin: number | null; put_spread_cost_usdc: number | null; put_spread_pct_margin: number | null };
type WickBest = { venue: string; cost_usdc: number; pct_margin: number } | null;
type WickResp = {
  as_of: string;
  inputs: { spot: number; collateral: number; leverage: number; tenor_days: number; k1_pct: number; k2_pct: number; k1_target: number; k2_target: number };
  position: { notional_usdc: number; margin_usdc: number; size_btc: number; liquidation_price: number; liq_drop_pct: number };
  venues: WickVenue[]; best_single: WickBest; best_spread: WickBest; note: string;
};

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

const LEV_PRESETS = [2, 5, 10, 20, 40];
const MAX_LEV = 40;
const HIGH_LEV = 25; // ≥ this → wick-insurance mode
const tierName = (f: number) => (f <= 0.33 ? "Safer" : f <= 0.6 ? "Balanced" : "Cheapest");

export function ProtectedLeverageWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("admin"));
  const [collateral, setCollateral] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [selected, setSelected] = useState<number | null>(null);
  const [activated, setActivated] = useState(false);

  const [cap, setCap] = useState<CapBundle | null>(null);
  const [wick, setWick] = useState<WickResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const highLev = leverage >= HIGH_LEV;

  const load = useCallback(async () => {
    if (!getToken("admin")) { setAuthed(false); return; }
    setLoading(true); setErr(null);
    try {
      if (leverage >= HIGH_LEV) {
        const liqDrop = 1 / leverage;
        const k1 = Math.max(0.005, +(liqDrop * 0.8).toFixed(4));
        const k2 = Math.min(0.5, +(liqDrop * 1.6).toFixed(4));
        const data = await adminGet<WickResp>(`/admin/foxify/v2/wick-insurance?collateral=${collateral}&leverage=${leverage}&tenor_days=1&k1_pct=${k1}&k2_pct=${k2}`);
        setWick(data); setCap(null);
      } else {
        const data = await adminGet<CapBundle>(`/admin/foxify/v2/floor-quote/tiers?collateral=${collateral}&leverage=${leverage}&tenor_days=3`);
        setCap(data); setWick(null);
        const rec = data.tiers.findIndex((t) => t.recommended);
        const firstAvail = data.tiers.findIndex((t) => t.available);
        setSelected((prev) => (prev != null && data.tiers[prev]?.available ? prev : rec >= 0 ? rec : firstAvail));
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message); setCap(null); setWick(null);
    } finally { setLoading(false); }
  }, [collateral, leverage]);

  useEffect(() => {
    if (!authed) return;
    setActivated(false);
    const id = setTimeout(load, 350);
    return () => clearTimeout(id);
  }, [authed, load]);

  if (!authed) return <TokenGate role="admin" title="Protected Leverage — demo access" onSubmit={() => setAuthed(true)} />;

  // Unified position view across both endpoints.
  const spot = wick?.inputs.spot ?? cap?.position.spot ?? null;
  const notional = wick?.position.notional_usdc ?? cap?.position.notional_usdc ?? null;
  const margin = wick?.position.margin_usdc ?? cap?.position.margin_usdc ?? null;
  const liqPrice = wick?.position.liquidation_price ?? cap?.position.liquidation_price ?? null;
  const liqDrop = wick?.position.liq_drop_pct ?? cap?.position.liq_drop_pct ?? null;
  const havePos = spot != null && margin != null && liqPrice != null && liqDrop != null;

  return (
    <Shell title="Protected Leverage" subtitle="Trade leveraged — without the wipe-out. Read-only demo."
      updatedIso={wick?.as_of ?? cap?.as_of} onSignOut={() => { clearToken("admin"); setAuthed(false); }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {/* Spot header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, padding: "0 2px" }}>
          <div style={{ fontSize: 13, color: C.muted, letterSpacing: 0.5 }}>BTC / USD{loading && " · …"}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums" }}>{spot != null ? usd(spot) : "—"}</div>
        </div>

        {/* Inputs */}
        <Card>
          <FieldRow label="Collateral">
            <div style={{ position: "relative", width: 150 }}>
              <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>$</span>
              <input type="number" min={10} step={50} value={collateral}
                onChange={(e) => setCollateral(Math.max(10, Number(e.target.value) || 10))}
                style={{ ...input, paddingLeft: 24, textAlign: "right" }} />
            </div>
          </FieldRow>
          <FieldRow label="Leverage">
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {LEV_PRESETS.map((l) => <Chip key={l} active={leverage === l} label={`${l}×`} onClick={() => setLeverage(l)} />)}
              <Stepper value={leverage} onChange={(v) => setLeverage(Math.min(MAX_LEV, Math.max(1, v)))} />
            </div>
          </FieldRow>
          {havePos && (
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              Position <b style={{ color: C.text }}>{usd(notional)}</b> · margin <b style={{ color: C.text }}>{usd(margin)}</b>
              <span style={{ marginLeft: 8, color: highLev ? C.amber : C.muted }}>{highLev ? "high leverage" : "moderate leverage"}</span>
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 13, borderRadius: 6, marginBottom: 14 }}>{err}</div>}

        {/* Baseline — the problem (shared, dynamic) */}
        {havePos && (
          <Card>
            <SectionLabel>Without protection</SectionLabel>
            <DetailRow label="Liquidation" value={`−${pct(liqDrop)} · ${usd(liqPrice)}`} valueColor={C.red} strong />
            <DetailRow label="You lose" value={`${usd(margin)} — your full margin`} valueColor={C.red} />
            <DetailRow label="The risk" value={`a brief wick past −${pct(liqDrop)} wipes you, even if it bounces back`} last />
          </Card>
        )}

        {/* Protection */}
        {highLev && wick && havePos && (
          <WickCard wick={wick} spot={spot!} liqDrop={liqDrop!} margin={margin!} activated={activated} onActivate={() => setActivated(true)} />
        )}
        {!highLev && cap && havePos && (
          <CapSection cap={cap} margin={margin!} liqPrice={liqPrice!} liqDrop={liqDrop!} spot={spot!}
            selected={selected} setSelected={(i) => { setSelected(i); setActivated(false); }}
            activated={activated} onActivate={() => setActivated(true)} loading={loading} />
        )}
      </div>
    </Shell>
  );
}

/* ── High-leverage: wick insurance (put spread) ── */
function WickCard({ wick, spot, liqDrop, margin, activated, onActivate }: {
  wick: WickResp; spot: number; liqDrop: number; margin: number; activated: boolean; onActivate: () => void;
}) {
  const best = wick.best_spread;
  if (!best) {
    return <Card><SectionLabel>Wick insurance</SectionLabel>
      <div style={{ fontSize: 13, color: C.amber }}>No spread quotes available right now — try again shortly.</div></Card>;
  }
  const v = wick.venues.find((x) => x.venue === best.venue);
  const k1 = v?.k1_strike ?? null, k2 = v?.k2_strike ?? null;
  const k1Drop = k1 != null ? (spot - k1) / spot : null;
  const k2Drop = k2 != null ? (spot - k2) / spot : null;
  const exampleDip = Math.min((liqDrop + (k2Drop ?? liqDrop)) / 2, k2Drop ?? liqDrop); // a wick inside the protected band

  return (
    <Card highlight>
      <SectionLabel>Stay in your trade {/* wick insurance */}</SectionLabel>
      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 14 }}>
        A short-dated put spread keeps a spike from liquidating you. You ride through the wick and keep your position — and all your upside.
      </div>

      <DetailRow label="Protects the wick zone" value={`−${pct(k1Drop)} to −${pct(k2Drop)}  (covers your −${pct(liqDrop)} liquidation)`} strong />
      <DetailRow label="Cost" value={`${usd2(best.cost_usdc)}  ·  ${(best.pct_margin * 100).toFixed(0)}% of your ${usd(margin)} margin`} valueColor={C.green} strong />
      <DetailRow label="Cheapest venue" value={best.venue.toUpperCase()} />
      <DetailRow label="Full-put alternative" value={wick.best_single ? `${usd2(wick.best_single.cost_usdc)} (${(wick.best_single.pct_margin * 100).toFixed(0)}% — dearer)` : "—"} last />

      {/* wick illustration */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
        <SimBox tone="bad" heading={`If BTC wicks −${pct(exampleDip)} & recovers`} big="LIQUIDATED" sub={`unprotected — lost ${usd(margin)}`} />
        <SimBox tone="good" heading={`If BTC wicks −${pct(exampleDip)} & recovers`} big="Still in" sub="protected — you keep the trade" />
      </div>

      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
        {!activated
          ? <button onClick={onActivate} style={btn}>Activate protection</button>
          : <span style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>✓ Protection active</span>}
      </div>
      <Pricing note={wick.note} rows={wick.venues.map((x) => ({ venue: x.venue, a: x.single_put_pct_margin, b: x.put_spread_pct_margin }))} cols={["Venue", "Single %", "Spread %"]} />
    </Card>
  );
}

/* ── Moderate-leverage: cap your loss (single put tiers) ── */
function CapSection({ cap, margin, liqPrice, liqDrop, spot, selected, setSelected, activated, onActivate, loading }: {
  cap: CapBundle; margin: number; liqPrice: number; liqDrop: number; spot: number;
  selected: number | null; setSelected: (i: number) => void; activated: boolean; onActivate: () => void; loading: boolean;
}) {
  const tiers = cap.tiers;
  const sel = selected != null ? tiers[selected] : null;
  const anyAvail = tiers.some((t) => t.available);
  return (
    <>
      <Card>
        <SectionLabel>Choose your protection {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</SectionLabel>
        {anyAvail ? (
          <div style={{ display: "grid", gap: 8 }}>
            {tiers.filter((t) => t.available).map((t) => {
              const idx = tiers.indexOf(t);
              return <TierRow key={t.floor_strike} tier={t} selected={selected === idx} onClick={() => setSelected(idx)} />;
            })}
          </div>
        ) : <div style={{ fontSize: 13, color: C.amber, lineHeight: 1.5 }}>No tradable floor sits inside your liquidation distance — lower your leverage.</div>}
      </Card>

      {sel?.available && (
        <Card highlight>
          <SectionLabel>With this protection</SectionLabel>
          <DetailRow label="Liquidation" value="Removed — you can't be wiped out" valueColor={C.green} strong />
          <DetailRow label="Most you can lose" value={usd(sel.max_loss_usdc)} valueColor={C.green} strong />
          <DetailRow label="Loss capped at" value={`${usd(sel.floor_strike)} (−${pct((spot - sel.floor_strike) / spot)})`} />
          <DetailRow label="Unprotected" value={`Liquidated −${pct(liqDrop)} (${usd(liqPrice)}) · lose ${usd(margin)}`} valueColor={C.red} />
          <DetailRow label="Cost" value={`${usd2(sel.put_cost_usdc)}  ·  ${usd2(sel.cost_per_day_usdc)}/day · ${cap.tenor_days}d`} last />
          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
            {!activated ? <button onClick={onActivate} style={btn}>Activate protection</button> : <span style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>✓ Protection active</span>}
          </div>
        </Card>
      )}
      <Pricing note={cap.note} rows={tiers.map((t) => ({ venue: `${tierName(t.margin_fraction)} · ${(t.venue ?? "—").toUpperCase()}`, a: t.put_cost_usdc, b: null }))} cols={["Tier · venue", "Premium $", ""]} dollars />
    </>
  );
}

/* ── shared presentational ── */
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 15, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "11px 20px", background: C.green, color: "#06210a", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer" };

function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return <div style={{ background: C.panel, borderRadius: 10, padding: 20, marginBottom: 14, border: highlight ? `1px solid ${C.green}55` : `1px solid ${C.border}` }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
    <label style={{ fontSize: 14, color: C.muted }}>{label}</label><div>{children}</div></div>;
}
function DetailRow({ label, value, valueColor, strong, last }: { label: string; value: string; valueColor?: string; strong?: boolean; last?: boolean }) {
  return <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, padding: "9px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
    <span style={{ fontSize: 13, color: C.muted, flexShrink: 0 }}>{label}</span>
    <span style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 700 : 500, color: valueColor ?? C.text, textAlign: "right" }}>{value}</span></div>;
}
function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "7px 13px", borderRadius: 6, fontSize: 14, cursor: "pointer", background: active ? C.blue + "22" : C.panel2, color: active ? C.blue : C.muted, border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400 }}>{label}</div>;
}
function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const custom = !LEV_PRESETS.includes(value);
  return (
    <div style={{ display: "flex", alignItems: "center", border: `1px solid ${custom ? C.blue + "88" : C.border}`, borderRadius: 6, overflow: "hidden", background: C.panel2 }}>
      <button onClick={() => onChange(value - 1)} style={stepBtn}>−</button>
      <input type="number" min={1} max={MAX_LEV} value={value} onChange={(e) => onChange(Math.round(Number(e.target.value) || 1))}
        style={{ width: 40, textAlign: "center", border: "none", background: "transparent", color: custom ? C.blue : C.text, fontSize: 14, fontWeight: 700, outline: "none", MozAppearance: "textfield" as const }} />
      <span style={{ color: C.muted, fontSize: 13, paddingRight: 6 }}>×</span>
      <button onClick={() => onChange(value + 1)} style={stepBtn}>+</button>
    </div>
  );
}
const stepBtn: React.CSSProperties = { width: 28, height: 34, border: "none", background: "transparent", color: C.muted, fontSize: 16, cursor: "pointer", lineHeight: 1 };

function SimBox({ tone, heading, big, sub }: { tone: "good" | "bad"; heading: string; big: string; sub: string }) {
  const col = tone === "good" ? C.green : C.red;
  return <div style={{ background: col + "10", border: `1px solid ${col}33`, borderRadius: 8, padding: "12px 14px", textAlign: "center" }}>
    <div style={{ fontSize: 11, color: C.muted, minHeight: 26 }}>{heading}</div>
    <div style={{ fontSize: 18, fontWeight: 800, color: col, margin: "4px 0" }}>{big}</div>
    <div style={{ fontSize: 11, color: C.muted }}>{sub}</div></div>;
}
function TierRow({ tier, selected, onClick }: { tier: FloorTier; selected: boolean; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{tierName(tier.margin_fraction)}
        {tier.recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}</div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>Worst case {usd(tier.max_loss_usdc)}</div>
    </div>
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.green }}>{usd2(tier.put_cost_usdc)}</div>
      <div style={{ fontSize: 11, color: C.muted }}>{usd2(tier.cost_per_day_usdc)}/day</div>
    </div></div>;
}
function Pricing({ note, rows, cols, dollars }: { note: string; rows: Array<{ venue: string; a: number | null; b: number | null }>; cols: string[]; dollars?: boolean }) {
  const [show, setShow] = useState(false);
  const fmt = (x: number | null) => x == null ? "—" : dollars ? usd2(x) : `${(x * 100).toFixed(0)}%`;
  return (
    <div style={{ marginTop: 14, textAlign: "center" }}>
      <span onClick={() => setShow((s) => !s)} style={{ color: C.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{show ? "Hide pricing" : "How it's priced"}</span>
      {show && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted, background: "#141414", borderRadius: 6, padding: 12, textAlign: "left" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace" }}>
            <thead><tr style={{ color: C.muted, textAlign: "left" }}>{cols.map((c, i) => <th key={i} style={{ padding: "4px 8px" }}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.border}`, color: C.text }}>
                <td style={{ padding: "4px 8px" }}>{r.venue}</td><td style={{ padding: "4px 8px" }}>{fmt(r.a)}</td><td style={{ padding: "4px 8px" }}>{r.b == null ? "" : fmt(r.b)}</td>
              </tr>))}</tbody>
          </table>
          <div style={{ marginTop: 10, lineHeight: 1.5 }}>{note}</div>
        </div>
      )}
    </div>
  );
}
