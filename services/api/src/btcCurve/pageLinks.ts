/**
 * The line of links between the pages one service serves (BTC curve, BTC pairs, sports). The
 * host builds the list once, with its access key already in each address; a page shows the
 * line only when it is given one, so a page running on its own has none.
 */

export interface PageLink {
  label: string;
  href: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The pages a host serves, each under the host's key. `mounts` are the pages beside the one at "/". */
export function pageLinks(token: string | undefined, mounts: Array<{ label: string; base: string }>, home = "BTC curve"): PageLink[] {
  const q = token ? `?k=${encodeURIComponent(token)}` : "";
  return [{ label: home, href: `/${q}` }, ...mounts.map((m) => ({ label: m.label, href: `${m.base}${q}` }))];
}

/** `here` is the label of the page being rendered: shown, not linked. */
export function pageLinksHtml(links: PageLink[] | undefined, here: string): string {
  if (!links || links.length < 2) return "";
  const items = links.map((l) => (l.label === here ? `<b>${esc(l.label)}</b>` : `<a href="${esc(l.href)}">${esc(l.label)}</a>`));
  return `<nav style="font-size:13px;margin:0 0 10px;color:#6b7280">${items.join(" · ")}</nav>`;
}
