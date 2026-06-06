/**
 * Perp Protect — trader-facing quote widget (demo-gated, read-only).
 *
 * The transactional product (vs the Protected Leverage sales sandbox): the trader enters their REAL
 * open perp position (side / size / entry / leverage) and gets live, cross-venue protection options
 * with an HONEST worst case. Same clean visual language as Protected Leverage (single column, cards,
 * label-left / value-right). Quote only — activation (transaction flow) is a later phase.
 *
 * Differentiators surfaced: works at ALL leverages (incl. low/1×), gap-proof single vs cheaper
 * spread, transparent underwriter pricing ("How it's priced"), and honest pre-liquidation-prevention
 * whipsaw framing. Pricing is sourced cheapest across OKX / Deribit / Bullish.
 */

import { useEffect, useState, useCallback } from "react";
import { demoPost, getToken, clearToken, UnauthorizedError } from "./api";
import { TokenGate, Shell, COLORS as C } from "./widgets";

type Breakdown = {
  hedge_cost_usdc: number; slippage_buffer_usdc: number; tail_load_usdc: number;
  capital_charge_usdc: number; atticus_margin_usdc: number; retail_premium_usdc: number;
};
type FairValue = { implied_vol: number | null; flag: string; note: string } | null;
type Depth = { size_btc: number; long_covered: boolean | null; long_slippage_vs_top_pct: number | null; short_covered: boolean | null; size_liquidity_warning: string | null };
type PPOption = {
  id: string; label: string; structure: "put" | "call" | "put_spread" | "call_spread";
  strike: number; short_strike: number | null;
  premium_usdc: number; hedge_cost_usdc: number; premium_breakdown: Breakdown;
  worst_case_usdc: number; worst_case_pct_margin: number; capped: boolean; exposed_beyond: number | null;
  protects_before_liq: boolean; liquidation_whipsaw_risk_usdc: number | null; whipsaw_exposed: boolean;
  cost_pct_margin: number; cost_per_day_usdc: number; breakeven_price: number; protect_move_pct: number;
  recommended: boolean; note: string; fair_value: FairValue; depth?: Depth;
};
type PPPosition = {
  side: "long" | "short"; spot: number; entry_price: number; size_btc: number; leverage: number;
  notional_usdc: number; margin_usdc: number; liquidation_price: number; liq_move_pct: number; unrealized_pnl_usdc: number;
};
type PPQuote = {
  as_of: string; quote_id: string; quote_expires_at: string;
  position: PPPosition; settlement_style: string; liquidation_prevented: boolean; tenor_days: number;
  options: PPOption[];
  liquidation: { price: number; move_pct: number };
};

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const signed = (x: number | null | undefined, side: "long" | "short") => (x == null ? "—" : `${side === "short" ? "+" : "−"}${pct(x)}`);

const MAX_LEV = 100;
const TENORS = [1, 3, 7];

export function PerpProtectWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("demo"));
  const [side, setSide] = useState<"long" | "short">("long");
  const [sizeUsd, setSizeUsd] = useState(30000);
  const [leverage, setLeverage] = useState(10);
  const [tenorDays, setTenorDays] = useState(3);
  const [entryStr, setEntryStr] = useState("");
  const [entryTouched, setEntryTouched] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [quote, setQuote] = useState<PPQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getToken("demo")) { setAuthed(false); return; }
    setLoading(true); setErr(null);
    try {
      const entry = entryTouched ? Number(entryStr) : NaN;
      const body: Record<string, unknown> = { side, size_usd: sizeUsd, leverage, tenor_days: tenorDays };
      if (Number.isFinite(entry) && entry > 0) body.entry_price = entry;
      const data = await demoPost<PPQuote>("/admin/foxify/v2/perp-protect/quote", body);
      setQuote(data);
      const rec = data.options.find((o) => o.recommended) ?? data.options[0] ?? null;
      setSelectedId((prev) => (prev && data.options.some((o) => o.id === prev) ? prev : rec?.id ?? null));
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message); setQuote(null);
    } finally { setLoading(false); }
  }, [side, sizeUsd, leverage, tenorDays, entryTouched, entryStr]);

  useEffect(() => {
    if (!authed) return;
    const id = setTimeout(load, 350);
    return () => clearTimeout(id);
  }, [authed, load]);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Perp Protect";
    return () => { document.title = prevTitle; };
  }, []);

  if (!authed) return <TokenGate role="demo" title="Perp Protect — demo access" onSubmit={() => setAuthed(true)} />;

  const pos = quote?.position ?? null;
  const sel = quote?.options.find((o) => o.id === selectedId) ?? null;
  const entryDisplay = entryTouched ? entryStr : (pos ? String(Math.round(pos.entry_price)) : "");

  return (
    <Shell title="Perp Protect" subtitle="Protect your open perp position — gap-proof, cross-venue. Read-only quote."
      updatedIso={quote?.as_of} onSignOut={() => { clearToken("demo"); setAuthed(false); }}>
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        {/* Spot */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, padding: "0 2px" }}>
          <div style={{ fontSize: 13, color: C.muted, letterSpacing: 0.5 }}>BTC / USD{loading && " · …"}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums" }}>{pos ? usd(pos.spot) : "—"}</div>
        </div>

        {/* Your position */}
        <Card>
          <SectionLabel>Your position</SectionLabel>
          <FieldRow label="Direction">
            <div style={{ display: "flex", gap: 6 }}>
              <Chip active={side === "long"} label="Long" onClick={() => setSide("long")} />
              <Chip active={side === "short"} label="Short" onClick={() => setSide("short")} />
            </div>
          </FieldRow>
          <FieldRow label="Size">
            <div style={{ position: "relative", width: 150 }}>
              <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>$</span>
              <input type="number" min={100} step={1000} value={sizeUsd}
                onChange={(e) => setSizeUsd(Math.max(100, Number(e.target.value) || 100))}
                style={{ ...input, paddingLeft: 24, textAlign: "right" }} />
            </div>
          </FieldRow>
          <FieldRow label="Entry price">
            <div style={{ position: "relative", width: 150 }}>
              <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>$</span>
              <input type="number" min={0} step={100} value={entryDisplay} placeholder="at mark"
                onChange={(e) => { setEntryTouched(true); setEntryStr(e.target.value); }}
                style={{ ...input, paddingLeft: 24, textAlign: "right" }} />
            </div>
          </FieldRow>
          <FieldRow label="Leverage">
            <Stepper value={leverage} onChange={(v) => setLeverage(Math.min(MAX_LEV, Math.max(1, v)))} />
          </FieldRow>
          <FieldRow label="Protect for">
            <div style={{ display: "flex", gap: 6 }}>
              {TENORS.map((d) => <Chip key={d} active={tenorDays === d} label={`${d}d`} onClick={() => setTenorDays(d)} />)}
            </div>
          </FieldRow>
          {pos && (
            <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <DetailRow label="Position" value={usd(pos.notional_usdc)} sub={side === "short" ? "short" : "long"} />
              <DetailRow label="Margin" value={usd(pos.margin_usdc)} sub={`${leverage}× · entry ${usd(pos.entry_price)}`} last />
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 13, borderRadius: 6, marginBottom: 14 }}>{err === "feed_unavailable" ? "Live price feed unavailable — try again shortly." : err}</div>}

        {/* Without protection */}
        {pos && (
          <Card>
            <SectionLabel>Without protection</SectionLabel>
            <DetailRow label="Liquidation" value={`${signed(pos.liq_move_pct, side)} · ${usd(pos.liquidation_price)}`} valueColor={C.red} strong />
            <DetailRow label="You lose" value={usd(pos.margin_usdc)} valueColor={C.red} sub="your full margin (a fast gap can cost more)" last />
          </Card>
        )}

        {/* Choose protection */}
        {quote && pos && (
          quote.options.length === 0
            ? <Card><SectionLabel>Protection</SectionLabel><div style={{ fontSize: 13, color: C.amber }}>No tradable protection right now — try another tenor or size.</div></Card>
            : (
              <Card>
                <SectionLabel>Choose your protection {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</SectionLabel>
                <div style={{ display: "grid", gap: 8 }}>
                  {quote.options.map((o) => <OptionRow key={o.id} o={o} side={side} selected={o.id === selectedId} onClick={() => setSelectedId(o.id)} />)}
                </div>
              </Card>
            )
        )}

        {/* Selected detail */}
        {sel && pos && (
          <Card highlight>
            <SectionLabel>With this protection</SectionLabel>
            <DetailRow label="Premium" value={usd2(sel.premium_usdc)} sub={`${usd2(sel.cost_per_day_usdc)}/day · ${quote.tenor_days}d`} valueColor={C.green} strong />
            <DetailRow label="Most you can lose" value={usd(sel.worst_case_usdc)} sub={sel.capped ? "hard cap" : `exposed beyond ${usd(sel.exposed_beyond)}`} valueColor={C.green} strong />
            <DetailRow label="Protection from" value={`${usd(sel.strike)} (${signed(sel.protect_move_pct, side)})`} sub={sel.short_strike ? `band to ${usd(sel.short_strike)}` : undefined} />
            <DetailRow label="Breakeven" value={usd(sel.breakeven_price)} last={!sel.whipsaw_exposed && !(sel.depth?.size_liquidity_warning)} />
            {sel.whipsaw_exposed && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: C.amber, lineHeight: 1.5, background: C.amber + "12", border: `1px solid ${C.amber}33`, borderRadius: 6, padding: "8px 10px" }}>
                ⚠ A wick to liquidation that then recovers can still cost up to {usd(sel.liquidation_whipsaw_risk_usdc)} until exchange liquidation-prevention is live.
              </div>
            )}
            {sel.depth?.size_liquidity_warning && (
              <div style={{ marginTop: 8, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>⚠ {sel.depth.size_liquidity_warning}</div>
            )}
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
              <span style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>One-click activation coming soon</span>
            </div>
          </Card>
        )}

        {/* How it's priced */}
        {sel && <HowPriced o={sel} />}

        {/* Disclaimer */}
        <div style={{ fontSize: 10.5, color: C.muted, textAlign: "center", lineHeight: 1.6, margin: "18px 6px 8px", opacity: 0.75 }}>
          Read-only quote · live pricing across OKX / Deribit / Bullish. Paid at expiry (European). Simplified
          liquidation (ignores maintenance margin, funding, fees). Not financial advice.
        </div>
      </div>
    </Shell>
  );
}

function OptionRow({ o, side, selected, onClick }: { o: PPOption; side: "long" | "short"; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{o.label}
          {o.recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}
          {!o.capped && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.muted + "22", color: C.muted, border: `1px solid ${C.muted}55` }}>spread</span>}</div>
        <div style={SUB}>protects from {signed(o.protect_move_pct, side)}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{usd2(o.premium_usdc)}</div>
        <div style={SUB}>worst case {usd(o.worst_case_usdc)}</div>
      </div>
    </div>
  );
}

function HowPriced({ o }: { o: PPOption }) {
  const [show, setShow] = useState(false);
  const b = o.premium_breakdown;
  const rows: Array<[string, number]> = [
    ["Hedge cost (cheapest cross-venue)", b.hedge_cost_usdc],
    ["Execution buffer", b.slippage_buffer_usdc],
    ["Tail / gap load", b.tail_load_usdc],
    ["Capital charge", b.capital_charge_usdc],
    ["Atticus margin", b.atticus_margin_usdc]
  ];
  return (
    <div style={{ marginTop: 12, textAlign: "center" }}>
      <span onClick={() => setShow((s) => !s)} style={{ color: C.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{show ? "Hide pricing" : "How it's priced"}</span>
      {show && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.text, background: "#141414", borderRadius: 6, padding: 12, textAlign: "left" }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.muted }}>
              <span>{k}</span><span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{usd2(v)}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0 0", marginTop: 4, borderTop: `1px solid ${C.border}`, fontWeight: 700 }}>
            <span>Premium</span><span style={{ color: C.green, fontVariantNumeric: "tabular-nums" }}>{usd2(b.retail_premium_usdc)}</span>
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.5, color: C.muted }}>
            {o.fair_value?.implied_vol != null && <>Implied vol {pct(o.fair_value.implied_vol, 0)}{o.fair_value.flag !== "ok" ? ` · ${o.fair_value.note}` : ""}. </>}
            Sourced cheapest across OKX / Deribit / Bullish; size-aware (walks the book for your size).
          </div>
        </div>
      )}
    </div>
  );
}

/* ── presentational (matches Protected Leverage) ── */
const LABEL = "#9aa3ad";
const GOLD = "#d6b56a";
const SUB: React.CSSProperties = { fontSize: 11, color: C.muted, marginTop: 2 };
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
function DetailRow({ label, value, sub, valueColor, strong, last }: {
  label: string; value: string; sub?: string; valueColor?: string; strong?: boolean; last?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <span style={{ fontSize: 13, color: LABEL, flexShrink: 0 }}>{label}</span>
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
          style={{ width: 40, textAlign: "right", border: "none", background: "transparent", color: C.text, fontSize: 16, fontWeight: 700, outline: "none", MozAppearance: "textfield" as const }} />
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
