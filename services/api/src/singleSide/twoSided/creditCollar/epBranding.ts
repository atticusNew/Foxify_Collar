// White-label brand resolution for demo links, and the per-brand product settings.
//
// The deployed instance has ONE env-configured brand (EP_BRAND_FOR). Partner demos need
// per-recipient branding without a Render service per partner, so a `?brand=` query override
// is allowed — but ONLY for names the founder pre-approved via EP_BRAND_ALLOWLIST. Anything
// else falls back to the env default (fail closed): otherwise anyone could screenshot the app
// wearing an arbitrary company's name.

export function parseBrandAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Case-insensitive match against the allowlist; returns the CONFIGURED casing (canonical). */
export function resolveBrandFor(defaultBrand: string, queryBrand: string | null, allowlist: string[]): string {
  if (queryBrand == null || queryBrand.trim() === "") return defaultBrand;
  const wanted = queryBrand.trim().toLowerCase();
  const hit = allowlist.find((b) => b.toLowerCase() === wanted);
  return hit ?? defaultBrand;
}

// ── Per-brand product settings (2026-10-08) ──────────────────────────────────
//
// A brand (the instance's EP_BRAND_FOR, or an allowlisted `?brand=`) may dial three things,
// each inside a published band; everything else is the instance's. Defaults reproduce today's
// product exactly, so an instance with no EP_BRAND_SETTINGS changes nothing.
//
//   tenor band   which listed Friday the cycle runs to: the nearest one at least `tenorMinDays`
//                and at most `tenorMaxDays` out, both inside 3–14 days. Default 3–14, which is
//                the live rule (the nearest Friday at least 3 days out is always under 10 days
//                off). When no Friday sits in the band the live rule is used and the record
//                says so; a band never refuses a wrap.
//   cap odds     EP_CAP_EXCEED_PROB for this brand, inside 10–30%: the most credit among caps
//                the market gives at most this chance of finishing beyond. Default 20%.
//   take waiver  when on, the brand's wraps carry no take: the trader is paid the whole net
//                credit and the notional minimum does not apply. Default off.
//
// P&L IDENTITY under the waiver (re-derived; this changes WHO keeps the take, nothing else).
// Per cycle, with credit C the market funds net of venue fees and take T = EP_TAKE_RATE × C:
//   without waiver   trader = C − T + floor − cap excess − release ;  writer = T
//   with waiver      trader = C     + floor − cap excess − release ;  writer = 0
// The hedge is held leg for leg in both, so the writer carries no outcome risk either way; the
// waiver forgoes the take, it never funds anything. Tenor band and cap odds change WHICH strike
// and WHICH expiry are written, never who keeps a payoff (capRule.ts, perpTenor.ts).

export type BrandSettings = {
  /** the nearest listed Friday at least this many days out (3–14) */
  tenorMinDays: number;
  /** …and at most this many (3–14, ≥ tenorMinDays) */
  tenorMaxDays: number;
  /** the brand's cap odds: market-implied chance of finishing past the cap the rule accepts (0.10–0.30) */
  capExceedProb: number;
  /** no take on this brand's wraps */
  takeWaived: boolean;
};

export const BRAND_SETTINGS_BOUNDS = {
  tenorDays: { min: 3, max: 14 },
  capExceedProb: { min: 0.1, max: 0.3 },
} as const;

export const DEFAULT_BRAND_SETTINGS: BrandSettings = { tenorMinDays: 3, tenorMaxDays: 14, capExceedProb: 0.2, takeWaived: false };

export type BrandSettingsTable = {
  /** the instance's settings (every brand not configured) */
  defaults: BrandSettings;
  /** configured brands, keyed by lowercase name, every value already inside its band */
  byBrand: Record<string, BrandSettings>;
  /** what was clamped or ignored while parsing: logged once at boot, never silent */
  notes: string[];
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * One brand's settings from loose JSON: numbers clamped into their bands, junk ignored, each
 * correction noted. Unknown keys are ignored (a typo cannot widen a band).
 */
export function normalizeBrandSettings(raw: unknown, defaults: BrandSettings, label: string, notes: string[] = []): BrandSettings {
  const out: BrandSettings = { ...defaults };
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    notes.push(`${label}: not an object, defaults kept`);
    return out;
  }
  const r = raw as Record<string, unknown>;
  const num = (k: string): number | null => {
    if (!(k in r)) return null;
    const n = Number(r[k]);
    if (!Number.isFinite(n)) {
      notes.push(`${label}.${k}: not a number, default kept`);
      return null;
    }
    return n;
  };
  const { tenorDays, capExceedProb } = BRAND_SETTINGS_BOUNDS;
  const minD = num("tenorMinDays");
  if (minD != null) {
    out.tenorMinDays = clamp(Math.round(minD), tenorDays.min, tenorDays.max);
    if (out.tenorMinDays !== minD) notes.push(`${label}.tenorMinDays: ${minD} → ${out.tenorMinDays} (band ${tenorDays.min}–${tenorDays.max} whole days)`);
  }
  const maxD = num("tenorMaxDays");
  if (maxD != null) {
    out.tenorMaxDays = clamp(Math.round(maxD), tenorDays.min, tenorDays.max);
    if (out.tenorMaxDays !== maxD) notes.push(`${label}.tenorMaxDays: ${maxD} → ${out.tenorMaxDays} (band ${tenorDays.min}–${tenorDays.max} whole days)`);
  }
  if (out.tenorMaxDays < out.tenorMinDays) {
    notes.push(`${label}: tenorMaxDays ${out.tenorMaxDays} under tenorMinDays ${out.tenorMinDays}, raised to match`);
    out.tenorMaxDays = out.tenorMinDays;
  }
  const odds = num("capExceedProb");
  if (odds != null) {
    // accept 15 as 15%
    const frac = odds > 1 ? odds / 100 : odds;
    out.capExceedProb = clamp(frac, capExceedProb.min, capExceedProb.max);
    if (Math.abs(out.capExceedProb - frac) > 1e-12) notes.push(`${label}.capExceedProb: ${odds} → ${out.capExceedProb} (band ${capExceedProb.min}–${capExceedProb.max})`);
  }
  if ("takeWaived" in r) {
    const v = r.takeWaived;
    if (typeof v === "boolean") out.takeWaived = v;
    else if (v === "true" || v === "1" || v === 1) out.takeWaived = true;
    else if (v === "false" || v === "0" || v === 0) out.takeWaived = false;
    else notes.push(`${label}.takeWaived: not a boolean, default kept`);
  }
  return out;
}

/**
 * EP_BRAND_SETTINGS: a JSON object keyed by brand name, e.g.
 *   {"PRIMEVAULT":{"tenorMinDays":7,"tenorMaxDays":14,"capExceedProb":0.15,"takeWaived":true}}
 * Unparseable JSON leaves every brand on the defaults (noted, never thrown).
 */
export function parseBrandSettings(raw: string | undefined, defaults: BrandSettings = DEFAULT_BRAND_SETTINGS): BrandSettingsTable {
  const notes: string[] = [];
  const table: BrandSettingsTable = { defaults: { ...defaults }, byBrand: {}, notes };
  const text = (raw ?? "").trim();
  if (!text) return table;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    notes.push(`EP_BRAND_SETTINGS: invalid JSON (${(e as Error).message}); every brand on the defaults`);
    return table;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    notes.push("EP_BRAND_SETTINGS: expected an object keyed by brand; every brand on the defaults");
    return table;
  }
  for (const [brand, cfg] of Object.entries(parsed as Record<string, unknown>)) {
    const key = brand.trim().toLowerCase();
    if (!key) continue;
    table.byBrand[key] = normalizeBrandSettings(cfg, defaults, brand.trim(), notes);
  }
  return table;
}

/** The settings a brand runs under: its own when configured, the instance's otherwise. Case-insensitive. */
export function settingsForBrand(table: BrandSettingsTable, brand: string | null | undefined): BrandSettings {
  const key = (brand ?? "").trim().toLowerCase();
  return (key && table.byBrand[key]) || table.defaults;
}

/** True when a brand's settings differ from the instance's in any way (the record then names the brand). */
export const brandDiffers = (s: BrandSettings, d: BrandSettings): boolean =>
  s.tenorMinDays !== d.tenorMinDays || s.tenorMaxDays !== d.tenorMaxDays || Math.abs(s.capExceedProb - d.capExceedProb) > 1e-12 || s.takeWaived !== d.takeWaived;

/** One line per brand for the boot log and the admin status: what is dialed, in plain words. */
export const describeBrandSettings = (s: BrandSettings): string =>
  `cycle to the nearest Friday ${s.tenorMinDays}–${s.tenorMaxDays} days out · cap odds ${Math.round(s.capExceedProb * 100)}%${s.takeWaived ? " · take waived" : ""}`;
