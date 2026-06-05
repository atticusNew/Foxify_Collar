/**
 * PublicProtectWidget — UNGATED, public-safe Protected-Leverage demo (LinkedIn-shareable).
 *
 * Self-contained and ISOLATED from the internal widget: no token gate, no links to internal
 * routes, and it ONLY consumes the sanitized /public/protect snapshot (percentages — no venue
 * names, no instruments, no absolute strikes/market levels; real pricing, ~2-min cached).
 * Dollar figures are scaled locally from the collateral the user enters.
 */

import { useCallback, useEffect, useState } from "react";
import { publicGet } from "./api";
import { COLORS as C } from "./widgets";

type PublicTier = { name: string; recommended: boolean; available: boolean; worst_case_x_margin: number | null; cost_x_margin: number | null; cost_per_day_x_margin: number | null; protect_move_pct: number | null };
type PublicWick = { single: { cost_x_margin: number; gap_proof: true } | null; spread: { cost_x_margin: number; survive_to_pct: number } | null };
type PublicSnap = {
  side: "long" | "short"; leverage: number; tenor_days: number; mode: "cap" | "wick";
  liq_move_pct: number; as_of: string; tiers?: PublicTier[]; wick?: PublicWick;
  presets?: { leverage: number[]; tenor_days: number[] }; note: string;
};

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const signed = (x: number | null | undefined, side: "long" | "short") => (x == null ? "—" : `${side === "short" ? "+" : "−"}${pct(x)}`);

const LEV_PRESETS = [5, 10, 20, 30, 40];
const GOLD = "#d6b56a";
const LABEL = "#9aa3ad";
const SUB: React.CSSProperties = { fontSize: 11, color: C.muted, marginTop: 2 };

export function PublicProtectWidget() {
  const [side, setSide] = useState<"long" | "short">("long");
  const [collateral, setCollateral] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [tenorDays, setTenorDays] = useState(1);
  const [opt, setOpt] = useState<"full" | "spread">("full");
  const [snap, setSnap] = useState<PublicSnap | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Protected Leverage";
    const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    const prevHref = link?.href ?? null;
    if (link) link.href = "https://i.ibb.co/8DxSMJFc/EEvm4m-G-bigger.jpg";
    return () => { document.title = prevTitle; if (link && prevHref) link.href = prevHref; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const data = await publicGet<PublicSnap>(`/public/protect?side=${side}&leverage=${leverage}&tenor_days=${tenorDays}`);
      setSnap(data);
    } catch (e) { setErr((e as Error).message); setSnap(null); }
    finally { setLoading(false); }
  }, [side, leverage, tenorDays]);

  useEffect(() => { const id = setTimeout(load, 250); return () => clearTimeout(id); }, [load]);

  const margin = collateral;
  const notional = collateral * leverage;
  const $m = (x: number | null | undefined) => (x == null ? null : x * margin);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: 16, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18, paddingTop: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>Protected Leverage</div>
          <div style={{ fontSize: 11, color: C.muted }}>interactive demo</div>
        </div>

        {/* Inputs */}
        <Card>
          <Section>Your position</Section>
          <Row label="Direction">
            <div style={{ display: "flex", gap: 6 }}>
              <Chip active={side === "long"} label="Long" onClick={() => { setSide("long"); setOpt("full"); }} />
              <Chip active={side === "short"} label="Short" onClick={() => { setSide("short"); setOpt("full"); }} />
            </div>
          </Row>
          <Row label="Collateral">
            <div style={{ position: "relative", width: 150 }}>
              <span style={{ position: "absolute", left: 12, top: 11, color: C.muted, fontSize: 15 }}>$</span>
              <input type="number" min={10} step={50} value={collateral}
                onChange={(e) => setCollateral(Math.max(10, Number(e.target.value) || 10))}
                style={{ ...inputStyle, paddingLeft: 24, textAlign: "right" }} />
            </div>
          </Row>
          <Row label="Leverage">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {LEV_PRESETS.map((l) => <Chip key={l} active={leverage === l} label={`${l}×`} onClick={() => setLeverage(l)} />)}
            </div>
          </Row>
          <Row label="Cover for">
            <div style={{ display: "flex", gap: 6 }}>
              {[1, 3, 7].map((d) => <Chip key={d} active={tenorDays === d} label={`${d}d`} onClick={() => setTenorDays(d)} />)}
            </div>
          </Row>
          <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
            <Detail label="Position" value={usd(notional)} sub={side} />
            <Detail label="Margin" value={usd(margin)} last />
          </div>
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 13, borderRadius: 6, marginBottom: 14 }}>{/warming/i.test(err) ? "Warming up live pricing — one moment…" : err}</div>}

        {snap && (
          <>
            {/* Without protection */}
            <Card>
              <Section>Without protection</Section>
              <Detail label="Liquidation" value={signed(snap.liq_move_pct, side)} valueColor={C.red} strong />
              <Detail label="You lose" value={usd(margin)} sub="your full margin" valueColor={C.red} last />
            </Card>

            {/* Protection */}
            {snap.mode === "cap" && snap.tiers && (
              <CapView tiers={snap.tiers} side={side} $m={$m} tenor={snap.tenor_days} loading={loading} />
            )}
            {snap.mode === "wick" && snap.wick && (
              <WickView wick={snap.wick} side={side} $m={$m} opt={opt} setOpt={setOpt} loading={loading} />
            )}
          </>
        )}

        {/* Disclaimer */}
        <div style={{ fontSize: 10.5, color: C.muted, textAlign: "center", lineHeight: 1.6, margin: "18px 6px 8px", opacity: 0.8 }}>
          Illustrative simulation for demonstration only — <b>not an offer, not financial advice, and not a live product</b>.
          Pricing is indicative and delayed. Figures are simplified (ignore maintenance margin, funding, fees, slippage).
          “No liquidation” describes the integrated product and requires exchange margin integration. © Atticus.
        </div>
      </div>
    </div>
  );
}

function CapView({ tiers, side, $m, tenor, loading }: { tiers: PublicTier[]; side: "long" | "short"; $m: (x: number | null | undefined) => number | null; tenor: number; loading: boolean }) {
  const [sel, setSel] = useState<number>(() => { const r = tiers.findIndex((t) => t.recommended && t.available); return r >= 0 ? r : tiers.findIndex((t) => t.available); });
  const avail = tiers.filter((t) => t.available);
  const t = tiers[sel] && tiers[sel].available ? tiers[sel] : avail[0];
  return (
    <>
      <Card>
        <Section>Choose your protection {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</Section>
        {avail.length ? (
          <div style={{ display: "grid", gap: 8 }}>
            {tiers.map((row, i) => row.available && (
              <Option key={row.name} name={row.name} recommended={row.recommended} sub={`Worst case ${usd($m(row.worst_case_x_margin))}`}
                cost={usd2($m(row.cost_x_margin))} costSub={`${((row.cost_x_margin ?? 0) * 100).toFixed(0)}% of margin`}
                selected={t === row} onClick={() => setSel(i)} />
            ))}
          </div>
        ) : <div style={{ fontSize: 13, color: C.amber }}>No protection fits inside your liquidation distance — lower your leverage.</div>}
      </Card>
      {t && (
        <Card highlight>
          <Section>With this protection</Section>
          <Detail label="Liquidation" value="Removed" valueColor={C.green} strong />
          <Detail label="Max loss" value={usd($m(t.worst_case_x_margin))} sub={`protection at ${signed(t.protect_move_pct, side)}`} valueColor={C.green} strong />
          <Detail label="Cost" value={usd2($m(t.cost_x_margin))} sub={`${usd2($m(t.cost_per_day_x_margin))}/day · ${tenor}d`} last />
        </Card>
      )}
    </>
  );
}

function WickView({ wick, side, $m, opt, setOpt, loading }: { wick: PublicWick; side: "long" | "short"; $m: (x: number | null | undefined) => number | null; opt: "full" | "spread"; setOpt: (o: "full" | "spread") => void; loading: boolean }) {
  const eff: "full" | "spread" = opt === "full" && !wick.single ? "spread" : opt === "spread" && !wick.spread ? "full" : opt;
  if (!wick.single && !wick.spread) return <Card><Section>Stay in your trade</Section><div style={{ fontSize: 13, color: C.amber }}>No quotes right now — try again shortly.</div></Card>;
  const moveWord = side === "short" ? "spike" : "wick";
  return (
    <>
      <Card>
        <Section>Stay in your trade {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</Section>
        <div style={{ display: "grid", gap: 8 }}>
          {wick.single && <Option name="Full protection" recommended sub="Gap-proof · survive any move" cost={usd2($m(wick.single.cost_x_margin))} costSub={`${(wick.single.cost_x_margin * 100).toFixed(0)}% of margin`} selected={eff === "full"} onClick={() => setOpt("full")} />}
          {wick.spread && <Option name={`${moveWord === "spike" ? "Spike" : "Wick"} spread`} sub={`Survive to ${signed(wick.spread.survive_to_pct, side)} · cheaper`} cost={usd2($m(wick.spread.cost_x_margin))} costSub={`${(wick.spread.cost_x_margin * 100).toFixed(0)}% of margin`} selected={eff === "spread"} onClick={() => setOpt("spread")} />}
        </div>
      </Card>
      <Card highlight>
        <Section>With this protection</Section>
        {eff === "full" && wick.single ? (
          <>
            <Detail label="Survive a move of" value="Any size" sub="gap-proof — you can't be wicked out" valueColor={C.green} strong />
            <Detail label="Cost" value={usd2($m(wick.single.cost_x_margin))} sub={`${(wick.single.cost_x_margin * 100).toFixed(0)}% of margin`} valueColor={C.green} strong last />
          </>
        ) : wick.spread ? (
          <>
            <Detail label={`Survive a ${moveWord} to`} value={signed(wick.spread.survive_to_pct, side)} sub="exposed if it runs further" valueColor={C.green} strong />
            <Detail label="Cost" value={usd2($m(wick.spread.cost_x_margin))} sub={`${(wick.spread.cost_x_margin * 100).toFixed(0)}% of margin`} valueColor={C.green} strong last />
          </>
        ) : null}
      </Card>
    </>
  );
}

// ── presentational ──
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 15, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box" };
function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return <div style={{ background: C.panel, borderRadius: 10, padding: 20, marginBottom: 14, border: highlight ? `1px solid ${C.green}55` : `1px solid ${C.border}` }}>{children}</div>;
}
function Section({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, fontWeight: 800, color: GOLD, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}><label style={{ fontSize: 14, color: LABEL }}>{label}</label><div>{children}</div></div>;
}
function Detail({ label, value, sub, valueColor, strong, last }: { label: string; value: string; sub?: string; valueColor?: string; strong?: boolean; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <span style={{ fontSize: 13, color: LABEL }}>{label}</span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontSize: strong ? 16 : 14, fontWeight: strong ? 700 : 600, color: valueColor ?? C.text }}>{value}</span>
        {sub && <span style={{ display: "block", ...SUB }}>{sub}</span>}
      </span>
    </div>
  );
}
function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <div onClick={onClick} style={{ padding: "7px 13px", borderRadius: 6, fontSize: 14, cursor: "pointer", background: active ? C.blue + "22" : C.panel2, color: active ? C.blue : C.muted, border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400 }}>{label}</div>;
}
function Option({ name, sub, cost, costSub, recommended, selected, onClick }: { name: string; sub: string; cost: string; costSub: string; recommended?: boolean; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ padding: "13px 15px", borderRadius: 8, cursor: "pointer", background: selected ? C.green + "12" : C.panel2, border: `1px solid ${selected ? C.green + "88" : "#333"}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{name}{recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}</div>
        <div style={SUB}>{sub}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{cost}</div>
        <div style={SUB}>{costSub}</div>
      </div>
    </div>
  );
}
