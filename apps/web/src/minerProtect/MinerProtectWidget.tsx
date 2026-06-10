/**
 * Miner Protect — trader-facing widget (demo-gated, read-only). Plain-language for miners who may
 * not know options: we frame the put as a guaranteed PRICE FLOOR for mined BTC ("insurance"), the
 * premium as an upfront COST, and we keep all upside. Reuses the Protected-Leverage / Perp-Protect
 * visual language + the SAME demo token (role "demo"). Isolated module (no perp/etf coupling).
 */

import { useEffect, useState, useCallback, useMemo } from "react";
import { demoPost, demoGet, getToken, clearToken, UnauthorizedError } from "../twoSided/api";
import { TokenGate, Shell, COLORS as C } from "../twoSided/widgets";

type MinerOption = {
  id: string; label: string; strike: number; premium_usd: number; hedge_cost_usd: number;
  revenue_floor_usd: number; period_cost_usd: number; covers_cost: boolean; protected_margin_usd: number;
  floor_vs_spot_pct: number; cost_pct_revenue: number; recommended: boolean; note: string;
};
type MinerBlock = {
  hashrate_ths: number; efficiency_w_per_th: number; power_kw: number; cost_per_day_usd: number;
  btc_per_day: number; expected_production_btc: number; breakeven_price_usd: number; btc_price: number;
  tenor_days: number; gross_revenue_usd: number; period_cost_usd: number; profitable_at_spot: boolean;
  hashprice_usd_per_th_day: number; hashprice_btc_per_th_day: number; breakeven_hashprice_usd_per_th_day: number;
};
type MinerQuote = { as_of: string; hashprice_source: string; btc_per_th_per_day: number; miner: MinerBlock; options: MinerOption[]; };

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const btc = (x: number | null | undefined) => (x == null ? "—" : `${x.toFixed(x < 1 ? 4 : 2)} BTC`);
const pctSigned = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`);

const TENORS = [30, 60, 90];
const LABEL = "#9aa3ad";
const GOLD = "#d6b56a";

export function MinerProtectWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("demo"));
  const [hashrate, setHashrate] = useState(5000);   // TH/s (≈ small farm; scale to your fleet)
  const [efficiency, setEfficiency] = useState(21); // W/TH
  const [powerCost, setPowerCost] = useState(0.05); // $/kWh
  const [tenorDays, setTenorDays] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [quote, setQuote] = useState<MinerQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [liveSpot, setLiveSpot] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!getToken("demo")) { setAuthed(false); return; }
    setLoading(true); setErr(null);
    try {
      const data = await demoPost<MinerQuote>("/admin/foxify/v2/miner-protect/quote", {
        hashrate_ths: hashrate, efficiency_w_per_th: efficiency, power_cost_usd_per_kwh: powerCost, tenor_days: tenorDays
      });
      setQuote(data);
      const rec = data.options.find((o) => o.recommended) ?? data.options[0] ?? null;
      setSelectedId((prev) => (prev && data.options.some((o) => o.id === prev) ? prev : rec?.id ?? null));
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message); setQuote(null);
    } finally { setLoading(false); }
  }, [hashrate, efficiency, powerCost, tenorDays]);

  useEffect(() => { if (!authed) return; const id = setTimeout(load, 350); return () => clearTimeout(id); }, [authed, load]);
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    const tick = async () => { try { const r = await demoGet<{ spot: number }>("/admin/foxify/v2/perp-protect/spot"); if (!cancelled && r?.spot > 0) setLiveSpot(r.spot); } catch { /* keep last */ } };
    tick(); const id = setInterval(tick, 5000); return () => { cancelled = true; clearInterval(id); };
  }, [authed]);
  useEffect(() => { const t = document.title; document.title = "Miner Protect"; return () => { document.title = t; }; }, []);

  const m = quote?.miner ?? null;
  const sel = useMemo(() => quote?.options.find((o) => o.id === selectedId) ?? null, [quote, selectedId]);
  const spot = liveSpot ?? m?.btc_price ?? null;

  if (!authed) return <TokenGate role="demo" title="Miner Protect — demo access" onSubmit={() => setAuthed(true)} />;

  return (
    <Shell title="Miner Protect" subtitle="Lock in a price floor for your mined bitcoin — keep all the upside." updatedIso={quote?.as_of} onSignOut={() => { clearToken("demo"); setAuthed(false); }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {/* Spot */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, padding: "0 2px" }}>
          <div style={{ fontSize: 13, color: C.muted, letterSpacing: 0.5 }}>BTC / USD{loading && " · …"}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums" }}>{spot ? usd(spot) : "—"}</div>
        </div>

        {/* Your mining */}
        <Card>
          <SectionLabel>Your mining operation</SectionLabel>
          <FieldRow label="Hashrate"><NumUnit value={hashrate} unit="TH/s" min={1} step={100} onChange={setHashrate} /></FieldRow>
          <FieldRow label="Efficiency"><NumUnit value={efficiency} unit="W/TH" min={1} step={1} onChange={setEfficiency} /></FieldRow>
          <FieldRow label="Power cost"><NumUnit value={powerCost} unit="$/kWh" min={0.001} step={0.01} onChange={setPowerCost} prefix="$" /></FieldRow>
          <FieldRow label="Protect for">
            <div style={{ display: "flex", gap: 6 }}>{TENORS.map((d) => <Chip key={d} active={tenorDays === d} label={`${d}d`} onClick={() => setTenorDays(d)} />)}</div>
          </FieldRow>
          {m && (
            <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <DetailRow label="You'll mine" value={btc(m.expected_production_btc)} sub={`~${usd(m.gross_revenue_usd)} at today's price · ${m.tenor_days}d`} />
              <DetailRow label="Running cost" value={usd(m.period_cost_usd)} sub={`${m.power_kw.toLocaleString()} kW · ${usd2(m.cost_per_day_usd)}/day`} last />
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 13, borderRadius: 6, marginBottom: 14 }}>{err === "feed_unavailable" ? "Live price feed unavailable — try again shortly." : err}</div>}

        {/* Breakeven / profitability — incl. hashprice (the miner-native metric) */}
        {m && (
          <Card>
            <SectionLabel>Your breakeven</SectionLabel>
            <DetailRow label="You profit while BTC is above" value={usd(m.breakeven_price_usd)}
              valueColor={m.profitable_at_spot ? C.green : C.red} strong
              sub={m.profitable_at_spot ? `profitable now · BTC ${usd(spot)}` : `underwater now — BTC ${usd(spot)} is below breakeven`} />
            <DetailRow label="Hashprice" value={`$${m.hashprice_usd_per_th_day.toFixed(3)}/TH/day`}
              sub={`profitable above $${m.breakeven_hashprice_usd_per_th_day.toFixed(3)}/TH/day (your revenue per TH)`} last />
          </Card>
        )}

        {/* Choose protection — lead with margin-protecting (stay-profitable) floors, then catastrophe */}
        {quote && m && (
          quote.options.length === 0
            ? <Card><SectionLabel>Protection</SectionLabel><div style={{ fontSize: 13, color: C.amber }}>No tradable floor right now — try another tenor or larger hashrate.</div></Card>
            : (() => {
              const stay = quote.options.filter((o) => o.covers_cost);
              const cat = quote.options.filter((o) => !o.covers_cost);
              return (
                <Card>
                  <SectionLabel>Protect your revenue {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</SectionLabel>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
                    A floor guarantees a minimum dollar value for your mined BTC. If bitcoin drops below it you're paid the difference; if it rises you keep the gains.
                  </div>
                  {stay.length > 0 && (
                    <>
                      <GroupLabel color={C.green}>Stay profitable — covers your {usd(m.period_cost_usd)} costs</GroupLabel>
                      <div style={{ display: "grid", gap: 8, marginBottom: cat.length ? 14 : 0 }}>
                        {stay.map((o) => <FloorRow key={o.id} o={o} selected={o.id === selectedId} onClick={() => setSelectedId(o.id)} />)}
                      </div>
                    </>
                  )}
                  {cat.length > 0 && (
                    <>
                      <GroupLabel color={C.muted}>{stay.length ? "Cheaper · catastrophe cover" : "Limit your losses (below breakeven)"}</GroupLabel>
                      <div style={{ display: "grid", gap: 8 }}>
                        {cat.map((o) => <FloorRow key={o.id} o={o} selected={o.id === selectedId} onClick={() => setSelectedId(o.id)} />)}
                      </div>
                    </>
                  )}
                </Card>
              );
            })()
        )}

        {/* Selected detail — plain value framing */}
        {sel && m && (
          <Card highlight>
            <SectionLabel>With this floor</SectionLabel>
            <div style={{ textAlign: "center", padding: "4px 0 12px" }}>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>Upfront cost</div>
              <div style={{ fontSize: 34, fontWeight: 800, color: C.green, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{usd2(sel.premium_usd)}</div>
              <div style={{ fontSize: 11.5, color: C.muted }}>{(sel.cost_pct_revenue * 100).toFixed(1)}% of your {usd(m.gross_revenue_usd)} revenue · {m.tenor_days}d</div>
            </div>
            <div style={{ fontSize: 13, color: C.text, textAlign: "center", lineHeight: 1.55, background: C.panel2, borderRadius: 8, padding: "10px 12px" }}>
              Guarantees your {btc(sel.hedged_btc != null ? sel.hedged_btc : m.expected_production_btc)} is worth at least <b style={{ color: C.green }}>{usd(sel.revenue_floor_usd)}</b>
              {sel.covers_cost ? <> — <b style={{ color: C.green }}>covers your {usd(sel.period_cost_usd)} costs</b>.</> : <span style={{ color: C.muted }}> (vs {usd(sel.period_cost_usd)} running cost).</span>}
              <span style={{ color: C.muted }}> Keep all upside if BTC rises.</span>
            </div>
            <div style={{ marginTop: 6 }}>
              <DetailRow label="Floor price" value={`${usd(sel.strike)} (${pctSigned(sel.floor_vs_spot_pct)} vs now)`} last />
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
              <span style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>One-click activation coming soon</span>
            </div>
          </Card>
        )}

        {/* How it works — plain explainer for non-options miners */}
        {sel && (
          <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.6, margin: "4px 6px 8px", padding: "12px 14px", background: "#141414", borderRadius: 8 }}>
            <b style={{ color: LABEL }}>How it works.</b> We buy you a price floor (a put option) at the best price across multiple exchanges (OKX / Deribit / Bullish / Bybit). It works like insurance: you pay a small upfront cost, and if bitcoin falls below your floor, the floor pays you the difference — so your mined BTC can't be worth less than the floor. If bitcoin rises, you keep all the gains and only spent the upfront cost.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: C.muted, textAlign: "center", lineHeight: 1.6, margin: "10px 6px 8px", opacity: 0.75 }}>
          Read-only quote · live pricing across OKX / Deribit / Bullish / Bybit. Production estimated from hashrate, efficiency, and current network difficulty/hashprice. Floors the BTC-price leg of revenue (not network difficulty). Not financial advice.
        </div>
      </div>
    </Shell>
  );
}

function GroupLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: 0.4, marginBottom: 8 }}>{children}</div>;
}
function FloorRow({ o, selected, onClick }: { o: MinerOption; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{o.label}
          {o.recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}
          {o.covers_cost && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.blue + "22", color: C.blue, border: `1px solid ${C.blue}55` }}>covers costs</span>}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>guarantees ≥ {usd(o.revenue_floor_usd)} revenue</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{usd2(o.premium_usd)}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>upfront cost</div>
      </div>
    </div>
  );
}

/* ── presentational ── */
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 15, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box" };
function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return <div style={{ background: C.panel, borderRadius: 10, padding: 20, marginBottom: 14, border: highlight ? `1px solid ${C.green}55` : `1px solid ${C.border}` }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, fontWeight: 800, color: GOLD, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}><label style={{ fontSize: 14, color: LABEL }}>{label}</label><div>{children}</div></div>;
}
function DetailRow({ label, value, sub, valueColor, strong, last }: { label: string; value: string; sub?: string; valueColor?: string; strong?: boolean; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <span style={{ fontSize: 13, color: LABEL, flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontSize: strong ? 16 : 14, fontWeight: strong ? 700 : 600, color: valueColor ?? C.text }}>{value}</span>
        {sub && <span style={{ display: "block", fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</span>}
      </span>
    </div>
  );
}
function NumUnit({ value, unit, min, step, onChange, prefix }: { value: number; unit: string; min: number; step: number; onChange: (v: number) => void; prefix?: string }) {
  return (
    <div style={{ position: "relative", width: 160, display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", flex: 1 }}>
        {prefix && <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>{prefix}</span>}
        <input type="number" min={min} step={step} value={value}
          onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
          style={{ ...input, paddingLeft: prefix ? 24 : 12, textAlign: "right" }} />
      </div>
      <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{unit}</span>
    </div>
  );
}
function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "7px 13px", borderRadius: 6, fontSize: 14, cursor: "pointer", background: active ? C.blue + "22" : C.panel2, color: active ? C.blue : C.muted, border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400 }}>{label}</div>;
}
