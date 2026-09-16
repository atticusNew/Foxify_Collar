/**
 * EARN & PROTECT — /video: the 28-second toggle demo page.
 *
 * A single shareable page for outreach (investor emails, LinkedIn first-comment links): the
 * demo video, the 4→1→1 ladder, and one-click paths into the live app and the public book.
 * The mp4 is a checked-in asset served by us (no YouTube/Drive: no login walls, no permission
 * foot-guns, viewer lands one click from the live product). Both routes 404 until the asset
 * file exists, so the code can ship ahead of the video without a broken page in production.
 */

/** Parse an HTTP Range header against a known file size.
 *  Returns the inclusive byte window to serve with 206, or null to serve the whole file with 200.
 *  Only single ranges are honored (browsers only send single ranges for <video>); malformed or
 *  unsatisfiable headers fall back to the full file — a correct 200 beats a wrong 416. */
export const parseByteRange = (header: string | undefined, size: number): { start: number; end: number } | null => {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // Suffix form "bytes=-N": the final N bytes.
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
};

export const EP_VIDEO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atticus — a live collar on Hyperliquid, one toggle</title>
<meta property="og:title" content="Atticus — a live collar on Hyperliquid, one toggle">
<meta property="og:description" content="4 JSON endpoints give a venue 1 white-label toggle. 1 tap gives the trader a hard floor and a daily credit.">
<style>
  :root{--bg:#0b0f14;--panel:#111722;--line:#1f2937;--text:#e8edf4;--muted:#8b98a9;--accent:#d9ab01;--radius:14px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}
  nav{border-bottom:1px solid var(--line)}
  .nav-in{max-width:760px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:58px}
  .logo{font-weight:800;letter-spacing:2.5px;font-size:15px}.logo b{color:var(--accent)}
  .kicker{color:var(--accent);font-weight:700;font-size:11.5px;letter-spacing:2px;text-transform:uppercase}
  h1{font-size:24px;font-weight:800;margin:30px 0 6px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:22px}
  video{width:100%;border:1px solid var(--line);border-radius:var(--radius);background:#000;display:block}
  .ladder{margin:26px 0 8px;display:grid;gap:10px}
  .ladder .row{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;font-size:15px}
  .ladder .row b{color:var(--accent)}
  .cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}
  .cta a{display:inline-block;padding:11px 18px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none}
  .cta a.primary{background:var(--accent);color:#0b0f14}
  .cta a.ghost{border:1px solid var(--line);color:var(--text)}
  .foot{color:var(--muted);font-size:11.5px;margin-top:30px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<nav><div class="nav-in">
  <div class="logo">ATTICUS <b>·</b> <span class="kicker">Demo</span></div>
  <div class="kicker">28 seconds</div>
</div></nav>
<div class="wrap">
  <h1>A live collar on Hyperliquid. One toggle.</h1>
  <p class="sub">Real position, live venue pricing, executed end to end.</p>
  <video controls autoplay muted playsinline preload="metadata" src="/assets/hl-toggle-demo.mp4?v=2"></video>
  <div class="ladder">
    <div class="row"><b>4</b> JSON endpoints give a venue <b>1</b> white-label toggle.</div>
    <div class="row"><b>1</b> tap gives the trader a hard floor and a daily credit.</div>
    <div class="row">Everything else stays exactly the same — for the venue and the trader.</div>
  </div>
  <div class="cta">
    <a class="primary" href="/">Open the live demo</a>
    <a class="ghost" href="https://facility.atticustrade.com/" target="_blank" rel="noopener">See the track record</a>
  </div>
  <div class="foot">This demo runs as a browser extension over Hyperliquid on a small live position — embedded venue-side it is the same API, and credits scale with position size. Every credit is auditable to an exchange fill. Nothing on this page is investment advice.</div>
</div>
</body>
</html>`;
