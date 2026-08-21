/**
 * GEOFENCE — block US + sanctioned jurisdictions from ACTIONS (wrap / close / protection).
 *
 * Legal posture (counsel owns the list; engineering owns the enforcement):
 *   - country resolution chain: trusted proxy header (Cloudflare/Vercel/custom) → cached IP lookup
 *   - FAIL-CLOSED on actions when the location cannot be determined (configurable, default closed):
 *     "we couldn't verify your location" is an honest refusal; silently serving a sanctioned user
 *     is not an option
 *   - loopback/private IPs resolve to LOCAL and are allowed (the operator's own box / dev)
 *   - reads stay open — the geofence stops trading actions, not looking at a web page
 *
 * Default blocklist: US + OFAC comprehensive-sanctions jurisdictions (CU, IR, KP, SY). Region-level
 * carve-outs (e.g. Crimea) are not expressible by country code — counsel decides whether RU/UA
 * belong on the list; it is one env var (EP_GEO_BLOCKED).
 */

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export type GeofenceConfig = {
  /** Master switch (EP_GEOFENCE). Off ⟹ every check allows (dev default). */
  enabled: boolean;
  /** ISO-3166 alpha-2 codes, uppercase (EP_GEO_BLOCKED). */
  blockedCountries: string[];
  /** Trusted proxy headers, checked in order (first match wins). */
  trustedHeaders: string[];
  /** IP lookup URL template with {ip}; empty ⟹ header-only resolution. */
  lookupUrlTemplate: string | null;
  /** Allow actions when the country cannot be determined. Default FALSE (fail-closed). */
  failOpen: boolean;
  /** Lookup cache TTL. */
  cacheTtlMs: number;
};

export const parseGeofenceFromEnv = (env: Record<string, string | undefined>): GeofenceConfig => ({
  enabled: String(env.EP_GEOFENCE ?? "false").toLowerCase() === "true",
  blockedCountries: (env.EP_GEO_BLOCKED ?? "US,CU,IR,KP,SY")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  trustedHeaders: [env.EP_GEO_HEADER, "cf-ipcountry", "x-vercel-ip-country"].filter(Boolean).map((h) => String(h).toLowerCase()),
  lookupUrlTemplate: env.EP_GEO_LOOKUP_URL === "" ? null : env.EP_GEO_LOOKUP_URL ?? "https://ipapi.co/{ip}/country/",
  failOpen: String(env.EP_GEO_FAIL_OPEN ?? "false").toLowerCase() === "true",
  cacheTtlMs: num(env.EP_GEO_CACHE_TTL_MS, 6 * 3_600_000)
});

/** Loopback / RFC-1918 / link-local — the operator's own machine, not a routable client. */
export const isPrivateIp = (ip: string): boolean =>
  /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd|::ffff:127\.)/i.test(ip.trim()) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip.trim()) ||
  ip.trim() === "localhost" ||
  ip.trim() === "";

const VALID_CC = /^[A-Z]{2}$/;

export type CountryResolver = (headers: Record<string, string | string[] | undefined>, ip: string) => Promise<string | null>;

/**
 * Build the resolution chain: trusted header → LOCAL for private IPs → cached lookup → null
 * (unknown). The lookup fetch is injectable for tests and never throws outward.
 */
export const buildCountryResolver = (cfg: GeofenceConfig, fetchImpl: typeof fetch = fetch): CountryResolver => {
  const cache = new Map<string, { country: string | null; tsMs: number }>();
  return async (headers, ip) => {
    for (const h of cfg.trustedHeaders) {
      const v = String(headers[h] ?? "").trim().toUpperCase();
      if (VALID_CC.test(v)) return v;
    }
    if (isPrivateIp(ip)) return "LOCAL";
    if (!cfg.lookupUrlTemplate) return null;
    const cached = cache.get(ip);
    if (cached && Date.now() - cached.tsMs < cfg.cacheTtlMs) return cached.country;
    let country: string | null = null;
    try {
      const res = await fetchImpl(cfg.lookupUrlTemplate.replace("{ip}", encodeURIComponent(ip)));
      if (res.ok) {
        const text = (await res.text()).trim().toUpperCase();
        if (VALID_CC.test(text)) country = text;
      }
    } catch {
      /* unknown stays null — assessGeofence decides what that means */
    }
    cache.set(ip, { country, tsMs: Date.now() });
    return country;
  };
};

export type GeofenceDecision = { allowed: true; country: string | null } | { allowed: false; country: string | null; reason: string };

/** Pure verdict for a resolved country. LOCAL is always allowed (operator's own box). */
export const assessGeofence = (cfg: GeofenceConfig, country: string | null): GeofenceDecision => {
  if (!cfg.enabled) return { allowed: true, country };
  if (country === "LOCAL") return { allowed: true, country };
  if (country == null) {
    return cfg.failOpen
      ? { allowed: true, country }
      : { allowed: false, country, reason: "we couldn't verify your location — protection actions are unavailable until we can" };
  }
  if (cfg.blockedCountries.includes(country)) {
    return { allowed: false, country, reason: `Earn & Protect is not available in your region (${country})` };
  }
  return { allowed: true, country };
};
