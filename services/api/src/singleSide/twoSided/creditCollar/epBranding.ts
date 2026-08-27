// White-label brand resolution for demo links.
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
