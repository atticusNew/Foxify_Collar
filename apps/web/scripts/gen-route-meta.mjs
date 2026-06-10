/**
 * Post-build: emit per-route HTML with route-specific link-preview meta (title/description/OG/twitter)
 * so social scrapers (Telegram, etc.) — which read STATIC html and don't run JS — show the correct
 * name per page. Each file loads the SAME app bundle (absolute /assets paths), so humans still get
 * the SPA. Files are written at the directory path (dist/<route>/index.html) AND <route>.html.
 *
 * Activation note: a request to /<route> only serves these instead of the SPA index if the static
 * host routes /<route> → /<route>/index.html BEFORE the /* → /index.html catch-all. Without that,
 * links gracefully fall back to the default index.html preview (no breakage).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const base = readFileSync(join(dist, "index.html"), "utf8");

const ROUTES = [
  { path: "miner-protect", title: "Miner Protect — Atticus", desc: "Lock in a price floor for your mined bitcoin. Stay cash-flow positive — keep all the upside." },
  { path: "perp-protect", title: "Perp Protect — Atticus", desc: "Protect your open perp position — gap-proof, cheapest cross-venue. Honest worst case." }
];

const swap = (html, re, value) => html.replace(re, value);
const withMeta = (html, title, desc) => {
  let h = html;
  h = swap(h, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  h = swap(h, /(<meta name="description" content=")[^"]*(")/, `$1${desc}$2`);
  h = swap(h, /(<meta property="og:title" content=")[^"]*(")/, `$1${title}$2`);
  h = swap(h, /(<meta property="og:description" content=")[^"]*(")/, `$1${desc}$2`);
  h = swap(h, /(<meta name="twitter:title" content=")[^"]*(")/, `$1${title}$2`);
  h = swap(h, /(<meta name="twitter:description" content=")[^"]*(")/, `$1${desc}$2`);
  return h;
};

for (const r of ROUTES) {
  const html = withMeta(base, r.title, r.desc);
  mkdirSync(join(dist, r.path), { recursive: true });
  writeFileSync(join(dist, r.path, "index.html"), html);
  writeFileSync(join(dist, `${r.path}.html`), html);
  console.log(`[route-meta] wrote ${r.path}/index.html + ${r.path}.html`);
}
