/**
 * Protected Leverage — read-only widget (Phase 1, Sai exchange sales artifact / sandbox).
 *
 * Two products, auto-selected by leverage:
 *  - < 25×  "Cap your loss"   — single protective PUT caps worst case below margin, no liq.
 *  - ≥ 25×  "Stay in your trade" — short-dated put SPREAD around the liq zone (wick insurance).
 *
 * Clean label-left / value-right throughout; succinct copy. READ-ONLY, admin-token gated.
 */

import { useEffect, useState, useCallback } from "react";
import { demoGet, getToken, clearToken, UnauthorizedError } from "./api";
import { TokenGate, Shell, COLORS as C } from "./widgets";

type FloorTier = {
  margin_fraction: number; floor_pct: number; floor_strike: number;
  available: boolean; unavailable_reason: string | null;
  venue: string | null; put_cost_usdc: number | null; cost_per_day_usdc: number | null;
  max_loss_usdc: number | null; recommended: boolean;
};
type CapPosition = { spot: number; size_btc: number; leverage: number; notional_usdc: number; margin_usdc: number; liquidation_price: number; liq_drop_pct: number };
type CapBundle = { as_of: string; position: CapPosition; tenor_days: number; tiers: FloorTier[]; note: string };

type WickVenue = { venue: string; k1_strike: number | null; k2_strike: number | null; single_put_pct_margin: number | null; put_spread_pct_margin: number | null };
type WickBestSingle = { venue: string; cost_usdc: number; pct_margin: number; strike: number } | null;
type WickBestSpread = { long_venue: string; short_venue: string; cost_usdc: number; pct_margin: number; k1_strike: number; k2_strike: number } | null;
type WickResp = {
  as_of: string;
  inputs: { spot: number; collateral: number; leverage: number; tenor_days: number; k1_pct: number; k2_pct: number };
  position: { notional_usdc: number; margin_usdc: number; size_btc: number; liquidation_price: number; liq_drop_pct: number };
  venues: WickVenue[]; best_single: WickBestSingle; best_spread: WickBestSpread; note: string;
};

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
/** Signed move % by side: longs are hurt by a drop (−), shorts by a rally (+). */
const signed = (x: number | null | undefined, side: "long" | "short") => (x == null ? "—" : `${side === "short" ? "+" : "−"}${pct(x)}`);

const MAX_LEV = 40;
const HIGH_LEV = 25;
const tierName = (f: number) => (f <= 0.33 ? "Safer" : f <= 0.6 ? "Balanced" : "Cheapest");

export function ProtectedLeverageWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("demo"));
  const [collateral, setCollateral] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [side, setSide] = useState<"long" | "short">("long");
  const [tenorDays, setTenorDays] = useState(3);
  const [tenorTouched, setTenorTouched] = useState(false); // once the user picks a tenor, stop auto-defaulting
  const [selected, setSelected] = useState<number | null>(null);
  const [activated, setActivated] = useState(false);

  const [cap, setCap] = useState<CapBundle | null>(null);
  const [wick, setWick] = useState<WickResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const highLev = leverage >= HIGH_LEV;

  // High-leverage defaults to 1d (where the gap-proof single put is cheap, ~14% margin);
  // moderate defaults to 3d. The user's explicit tenor pick overrides this.
  const effTenor = tenorTouched ? tenorDays : (leverage >= HIGH_LEV ? 1 : 3);

  const load = useCallback(async () => {
    if (!getToken("demo")) { setAuthed(false); return; }
    setLoading(true); setErr(null);
    try {
      if (leverage >= HIGH_LEV) {
        const liqDrop = 1 / leverage;
        const k1 = Math.max(0.005, +(liqDrop * 0.8).toFixed(4));
        const k2 = Math.min(0.5, +(liqDrop * 1.6).toFixed(4));
        const data = await demoGet<WickResp>(`/admin/foxify/v2/wick-insurance?collateral=${collateral}&leverage=${leverage}&tenor_days=${effTenor}&k1_pct=${k1}&k2_pct=${k2}&side=${side}`);
        setWick(data); setCap(null);
      } else {
        const data = await demoGet<CapBundle>(`/admin/foxify/v2/floor-quote/tiers?collateral=${collateral}&leverage=${leverage}&tenor_days=${effTenor}&side=${side}`);
        setCap(data); setWick(null);
        const rec = data.tiers.findIndex((t) => t.recommended);
        const firstAvail = data.tiers.findIndex((t) => t.available);
        setSelected((prev) => (prev != null && data.tiers[prev]?.available ? prev : rec >= 0 ? rec : firstAvail));
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message); setCap(null); setWick(null);
    } finally { setLoading(false); }
  }, [collateral, leverage, effTenor, side]);

  useEffect(() => {
    if (!authed) return;
    setActivated(false);
    const id = setTimeout(load, 350);
    return () => clearTimeout(id);
  }, [authed, load]);

  // Route-scoped tab title + favicon (reverts on unmount so other dashboards are unaffected).
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Protected Leverage";
    const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    const prevHref = link?.href ?? null;
    const prevType = link?.type ?? null;
    if (link) { link.href = "https://i.ibb.co/8DxSMJFc/EEvm4m-G-bigger.jpg"; link.type = "image/jpeg"; }
    return () => {
      document.title = prevTitle;
      if (link && prevHref) { link.href = prevHref; if (prevType) link.type = prevType; }
    };
  }, []);

  if (!authed) return <TokenGate role="demo" title="Protected Leverage — demo access" onSubmit={() => setAuthed(true)} />;

  const spot = wick?.inputs.spot ?? cap?.position.spot ?? null;
  const notional = wick?.position.notional_usdc ?? cap?.position.notional_usdc ?? null;
  const margin = wick?.position.margin_usdc ?? cap?.position.margin_usdc ?? null;
  const liqPrice = wick?.position.liquidation_price ?? cap?.position.liquidation_price ?? null;
  const liqDrop = wick?.position.liq_drop_pct ?? cap?.position.liq_drop_pct ?? null;
  const havePos = spot != null && margin != null && liqPrice != null && liqDrop != null;

  return (
    <Shell title="Protected Leverage" subtitle="Trade leveraged — without the wipe-out. Read-only demo."
      updatedIso={wick?.as_of ?? cap?.as_of} onSignOut={() => { clearToken("demo"); setAuthed(false); }}>
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        {/* Spot */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, padding: "0 2px" }}>
          <div style={{ fontSize: 13, color: C.muted, letterSpacing: 0.5 }}>BTC / USD{loading && " · …"}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums" }}>{spot != null ? usd(spot) : "—"}</div>
        </div>

        {/* Your position: inputs + derived, one clean section */}
        <Card>
          <SectionLabel>Your position</SectionLabel>
          <FieldRow label="Direction">
            <div style={{ display: "flex", gap: 6 }}>
              <Chip active={side === "long"} label="Long" onClick={() => { setSide("long"); setActivated(false); }} />
              <Chip active={side === "short"} label="Short" onClick={() => { setSide("short"); setActivated(false); }} />
            </div>
          </FieldRow>
          <FieldRow label="Collateral">
            <div style={{ position: "relative", width: 150 }}>
              <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>$</span>
              <input type="number" min={10} step={50} value={collateral}
                onChange={(e) => setCollateral(Math.max(10, Number(e.target.value) || 10))}
                style={{ ...input, paddingLeft: 24, textAlign: "right" }} />
            </div>
          </FieldRow>
          <FieldRow label="Leverage">
            <Stepper value={leverage} onChange={(v) => setLeverage(Math.min(MAX_LEV, Math.max(1, v)))} />
          </FieldRow>
          <FieldRow label="Cover for">
            <div style={{ display: "flex", gap: 6 }}>
              {[1, 3, 7].map((d) => <Chip key={d} active={effTenor === d} label={`${d}d`} onClick={() => { setTenorDays(d); setTenorTouched(true); }} />)}
            </div>
          </FieldRow>
          {havePos && (
            <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <DetailRow label="Position" value={usd(notional)} sub={side === "short" ? "short" : "long"} />
              <DetailRow label="Margin" value={usd(margin)} tag={highLev ? { text: "high leverage", color: C.amber } : { text: "moderate", color: C.muted }} last />
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 13, borderRadius: 6, marginBottom: 14 }}>{err}</div>}

        {/* Without protection */}
        {havePos && (
          <Card>
            <SectionLabel>Without protection</SectionLabel>
            <DetailRow label="Liquidation" value={`${signed(liqDrop, side)} · ${usd(liqPrice)}`} valueColor={C.red} strong />
            <DetailRow label="You lose" value={usd(margin)} valueColor={C.red} sub="your full margin" last />
          </Card>
        )}

        {/* Protection */}
        {highLev && wick && havePos
          ? <WickCard wick={wick} side={side} spot={spot!} liqDrop={liqDrop!} margin={margin!} activated={activated} onActivate={() => setActivated(true)} />
          : (!highLev && cap && havePos) && (
            <CapSection cap={cap} side={side} margin={margin!} liqPrice={liqPrice!} liqDrop={liqDrop!} spot={spot!}
              selected={selected} setSelected={(i) => { setSelected(i); setActivated(false); }}
              activated={activated} onActivate={() => setActivated(true)} loading={loading} />
          )}

        {/* Honest disclaimer */}
        <div style={{ fontSize: 10.5, color: C.muted, textAlign: "center", lineHeight: 1.6, margin: "18px 6px 8px", opacity: 0.75 }}>
          Illustrative demo · live option pricing across OKX / Deribit / Bullish. Simplified liquidation
          (ignores maintenance margin, funding, fees, slippage). True no-liquidation requires exchange
          margin integration; standalone, the option bounds net loss at the same figure. Not financial advice.
        </div>
      </div>
    </Shell>
  );
}

/* ── ≥25×: wick insurance. Default = gap-proof single option; spread is the cheaper alt. ── */
function WickCard({ wick, side, spot, liqDrop, margin, activated, onActivate }: {
  wick: WickResp; side: "long" | "short"; spot: number; liqDrop: number; margin: number; activated: boolean; onActivate: () => void;
}) {
  const single = wick.best_single;
  const spread = wick.best_spread;
  const [opt, setOpt] = useState<"full" | "spread">("full");
  const effective: "full" | "spread" = opt === "full" && !single ? "spread" : opt === "spread" && !spread ? "full" : opt;

  if (!single && !spread) return <Card><SectionLabel>Stay in your trade</SectionLabel><div style={{ fontSize: 13, color: C.amber }}>No quotes right now — try again shortly.</div></Card>;

  // Distance of a strike from spot as a positive fraction (below for long, above for short).
  const dist = (strike: number) => (side === "short" ? (strike - spot) / spot : (spot - strike) / spot);
  const moveWord = side === "short" ? "spike" : "wick";
  const singleDrop = single ? dist(single.strike) : null;
  const k2Drop = spread ? dist(spread.k2_strike) : null;
  const exampleDip = effective === "full" ? Math.max(liqDrop + 0.02, (k2Drop ?? liqDrop) + 0.03) : Math.min((liqDrop + (k2Drop ?? liqDrop)) / 2, k2Drop ?? liqDrop);

  return (
    <>
      <Card>
        <SectionLabel>Stay in your trade</SectionLabel>
        <div style={{ display: "grid", gap: 8 }}>
          {single && <OptionRow name="Full protection" recommended sub="Gap-proof · survive any move" cost={single.cost_usdc} pctM={single.pct_margin} selected={effective === "full"} onClick={() => setOpt("full")} />}
          {spread && <OptionRow name={`${moveWord === "spike" ? "Spike" : "Wick"} spread`} sub={`Survive to ${signed(k2Drop, side)} · cheaper, exposed deeper`} cost={spread.cost_usdc} pctM={spread.pct_margin} selected={effective === "spread"} onClick={() => setOpt("spread")} />}
        </div>
      </Card>

      <Card highlight>
        <SectionLabel>With this protection</SectionLabel>
        {effective === "full" && single ? (
          <>
            <DetailRow label="Survive a move of" value="Any size" sub="gap-proof — you can't be wicked out" valueColor={C.green} strong />
            <DetailRow label="Protection starts" value={`${usd(single.strike)} (${signed(singleDrop, side)})`} />
            <DetailRow label="Cost" value={usd2(single.cost_usdc)} sub={`${(single.pct_margin * 100).toFixed(0)}% of margin · ${single.venue.toUpperCase()}`} valueColor={C.green} strong last />
          </>
        ) : spread ? (
          <>
            <DetailRow label={`Survive a ${moveWord} to`} value={signed(k2Drop, side)} sub="exposed if it runs further" valueColor={C.green} strong />
            <DetailRow label="Cost" value={usd2(spread.cost_usdc)} sub={`${(spread.pct_margin * 100).toFixed(0)}% of margin · long ${spread.long_venue.toUpperCase()} / short ${spread.short_venue.toUpperCase()}`} valueColor={C.green} strong last />
          </>
        ) : null}
        <div style={{ ...SUB, textAlign: "center", marginTop: 16 }}>If BTC {moveWord}s {signed(exampleDip, side)} and recovers</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
          <SimBox tone="bad" big="Liquidated" sub={`unprotected — lost ${usd(margin)}`} />
          <SimBox tone="good" big="Still in" sub="protected — keep your trade" />
        </div>
        <ActivateRow activated={activated} onActivate={onActivate} />
      </Card>
      <Pricing note={wick.note} cols={["Venue", "Single", "Spread"]} rows={wick.venues.map((x) => ({ k: x.venue.toUpperCase(), a: x.single_put_pct_margin, b: x.put_spread_pct_margin }))} />
    </>
  );
}

/** Selectable protection option (gap-proof full vs cheaper spread). */
function OptionRow({ name, sub, cost, pctM, recommended, selected, onClick }: { name: string; sub: string; cost: number; pctM: number; recommended?: boolean; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{name}
          {recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}</div>
        <div style={SUB}>{sub}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{usd2(cost)}</div>
        <div style={SUB}>{(pctM * 100).toFixed(0)}% of margin</div>
      </div>
    </div>
  );
}

/* ── <25×: cap your loss ── */
function CapSection({ cap, side, margin, liqPrice, liqDrop, spot, selected, setSelected, activated, onActivate, loading }: {
  cap: CapBundle; side: "long" | "short"; margin: number; liqPrice: number; liqDrop: number; spot: number;
  selected: number | null; setSelected: (i: number) => void; activated: boolean; onActivate: () => void; loading: boolean;
}) {
  const tiers = cap.tiers;
  const sel = selected != null ? tiers[selected] : null;
  const anyAvail = tiers.some((t) => t.available);
  const capWord = side === "short" ? "ceiling" : "floor";
  const strikeDist = (strike: number) => (side === "short" ? (strike - spot) / spot : (spot - strike) / spot);
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
        ) : <div style={{ fontSize: 13, color: C.amber, lineHeight: 1.5 }}>No tradable {capWord} inside your liquidation distance — lower your leverage.</div>}
      </Card>

      {sel?.available && (
        <Card highlight>
          <SectionLabel>With this protection</SectionLabel>
          <DetailRow label="Liquidation" value="Removed" valueColor={C.green} strong />
          <DetailRow label="Max loss" value={usd(sel.max_loss_usdc)} sub={`capped at ${usd(sel.floor_strike)} (${signed(strikeDist(sel.floor_strike), side)})`} valueColor={C.green} strong />
          <DetailRow label="Without protection" value={`${signed(liqDrop, side)} (${usd(liqPrice)}) · lose ${usd(margin)}`} valueColor={C.red} />
          <DetailRow label="Cost" value={usd2(sel.put_cost_usdc)} sub={`${usd2(sel.cost_per_day_usdc)}/day · ${cap.tenor_days}d`} last />
          <ActivateRow activated={activated} onActivate={onActivate} />
        </Card>
      )}
      <Pricing note={cap.note} cols={["Tier · venue", "Premium", ""]} rows={tiers.map((t) => ({ k: `${tierName(t.margin_fraction)} · ${(t.venue ?? "—").toUpperCase()}`, a: t.put_cost_usdc, b: null, dollars: true }))} dollars />
    </>
  );
}

/* ── presentational ── */
const LABEL = "#9aa3ad";          // brighter than muted for row labels
const GOLD = "#d6b56a";           // section-header accent (warm gold, matches dark theme)
const SUB: React.CSSProperties = { fontSize: 11, color: C.muted, marginTop: 2 }; // unified subtext
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 15, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box" };

function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return <div style={{ background: C.panel, borderRadius: 10, padding: 20, marginBottom: 14, border: highlight ? `1px solid ${C.green}55` : `1px solid ${C.border}` }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, fontWeight: 800, color: GOLD, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
    <label style={{ fontSize: 14, color: LABEL }}>{label}</label><div>{children}</div></div>;
}
/** Label left; value (+ optional sub under it, + optional tag) right. */
function DetailRow({ label, value, sub, tag, valueColor, strong, last }: {
  label: string; value: string; sub?: string; tag?: { text: string; color: string }; valueColor?: string; strong?: boolean; last?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <span style={{ fontSize: 13, color: LABEL, flexShrink: 0 }}>{label}{tag && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: tag.color + "22", color: tag.color, border: `1px solid ${tag.color}44` }}>{tag.text}</span>}</span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontSize: strong ? 16 : 14, fontWeight: strong ? 700 : 600, color: valueColor ?? C.text }}>{value}</span>
        {sub && <span style={{ display: "block", ...SUB }}>{sub}</span>}
      </span>
    </div>
  );
}
function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", background: C.panel2 }}>
      <button onClick={() => onChange(value - 1)} style={stepBtn} aria-label="decrease">−</button>
      <div style={{ display: "flex", alignItems: "baseline", padding: "0 2px" }}>
        <input type="number" min={1} max={MAX_LEV} value={value} onChange={(e) => onChange(Math.round(Number(e.target.value) || 1))}
          style={{ width: 38, textAlign: "right", border: "none", background: "transparent", color: C.text, fontSize: 16, fontWeight: 700, outline: "none", MozAppearance: "textfield" as const }} />
        <span style={{ color: C.muted, fontSize: 14, fontWeight: 700 }}>×</span>
      </div>
      <button onClick={() => onChange(value + 1)} style={stepBtn} aria-label="increase">+</button>
    </div>
  );
}
const stepBtn: React.CSSProperties = { width: 34, height: 38, border: "none", background: "transparent", color: C.text, fontSize: 18, cursor: "pointer", lineHeight: 1 };

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "7px 13px", borderRadius: 6, fontSize: 14, cursor: "pointer", background: active ? C.blue + "22" : C.panel2, color: active ? C.blue : C.muted, border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400 }}>{label}</div>;
}

function ActivateRow({ activated, onActivate }: { activated: boolean; onActivate: () => void }) {
  return <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
    {!activated
      ? <button onClick={onActivate} style={{ padding: "11px 20px", background: C.green, color: "#06210a", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Activate protection</button>
      : <span style={{ fontSize: 14, color: C.green, fontWeight: 700 }}>✓ Protection active</span>}
  </div>;
}
function SimBox({ tone, big, sub }: { tone: "good" | "bad"; big: string; sub: string }) {
  const col = tone === "good" ? C.green : C.red;
  return <div style={{ background: col + "10", border: `1px solid ${col}33`, borderRadius: 8, padding: "14px", textAlign: "center" }}>
    <div style={{ fontSize: 19, fontWeight: 800, color: col, marginBottom: 4 }}>{big}</div>
    <div style={{ fontSize: 11, color: C.muted }}>{sub}</div></div>;
}
function TierRow({ tier, selected, onClick }: { tier: FloorTier; selected: boolean; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{tierName(tier.margin_fraction)}
        {tier.recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}</div>
      <div style={SUB}>Worst case {usd(tier.max_loss_usdc)}</div>
    </div>
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{usd2(tier.put_cost_usdc)}</div>
      <div style={SUB}>{usd2(tier.cost_per_day_usdc)}/day</div>
    </div></div>;
}
function Pricing({ note, rows, cols, dollars }: { note: string; rows: Array<{ k: string; a: number | null; b: number | null; dollars?: boolean }>; cols: string[]; dollars?: boolean }) {
  const [show, setShow] = useState(false);
  const fmt = (x: number | null, d?: boolean) => x == null ? "—" : (d ?? dollars) ? usd2(x) : `${(x * 100).toFixed(0)}%`;
  return (
    <div style={{ marginTop: 12, textAlign: "center" }}>
      <span onClick={() => setShow((s) => !s)} style={{ color: C.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{show ? "Hide pricing" : "How it's priced"}</span>
      {show && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted, background: "#141414", borderRadius: 6, padding: 12, textAlign: "left" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace" }}>
            <thead><tr style={{ color: C.muted, textAlign: "left" }}>{cols.map((c, i) => <th key={i} style={{ padding: "4px 8px" }}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.border}`, color: C.text }}>
                <td style={{ padding: "4px 8px" }}>{r.k}</td><td style={{ padding: "4px 8px" }}>{fmt(r.a, r.dollars)}</td><td style={{ padding: "4px 8px" }}>{r.b == null ? "" : fmt(r.b, r.dollars)}</td>
              </tr>))}</tbody>
          </table>
          <div style={{ marginTop: 10, lineHeight: 1.5 }}>{note}</div>
        </div>
      )}
    </div>
  );
}
