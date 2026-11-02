"""
The Atticus one sheet for River Markets: one Letter page for a prime broker, every number from the
live record.

    python3 docs/reports/submission/river/build_onesheet.py            # live numbers
    python3 docs/reports/submission/river/build_onesheet.py --offline  # last saved snapshot

Reads /api/shadow, /api/shadow/parlays and /api/shadow/scoreboard from the public record, saves the
snapshot beside the page (record-<date>.json) so the PDF can be rebuilt without the network, writes
atticus_river_onesheet.html, prints it to PDF with headless Chrome, and writes a PNG preview.

The reader is an execution layer, not a venue and not a holder, so the page is about the flow:
what the other side of retail protection looks like, by venue and by week, and where the screens
cannot fund it. Venue names are in the open (same posture as the public scoreboard).

Rules the script enforces before it prints: the identity holds on the live record (singles and
parlays); no em dash; "address", never "wallet"; no venue named as a partner; no promise words
("will route", "committed", "guarantee", "exclusive"); the RFQ is the "later" step and the page
never says we route through River today.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = "https://atticus-event-shadow.onrender.com"
DEMO = "https://event.earnandprotect.xyz"
WEEKS = 4

GOLD = "#C9A227"
GREEN = "#00B67A"
INK = "#111318"
MUTED = "#4B5058"
FAINT = "#6E747D"
RULE = "#E2E5EA"
CARD = "#F6F7F9"

VENUES = ("Kalshi", "Polymarket", "ProphetX", "Novig")
PROMISE_WORDS = ("will route", "committed", "commit to", "guarantee", "exclusive", "partner")


def fetch(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "atticus-onesheet"}), timeout=25) as r:
        return json.load(r)


def snapshot(offline: bool) -> dict:
    saved = sorted(HERE.glob("record-*.json"))
    if offline:
        if not saved:
            sys.exit("no saved snapshot; run once online")
        return json.loads(saved[-1].read_text())
    shadow = fetch(f"{RECORD}/api/shadow")
    parlays = fetch(f"{RECORD}/api/shadow/parlays")
    scoreboard = fetch(f"{RECORD}/api/shadow/scoreboard?weeks={WEEKS}")
    snap = {
        "at": shadow["at"],
        "shadow": shadow["summary"],
        "parlays": parlays["summary"],
        "scoreboard": {k: scoreboard[k] for k in ("at", "venues", "feeRules", "weeks")},
    }
    (HERE / f"record-{shadow['at'][:10]}.json").write_text(json.dumps(snap, indent=1) + "\n")
    return snap


def usd(cents: int, whole: bool = False) -> str:
    if whole or cents % 100 == 0:
        return f"${cents // 100:,}"
    return f"${cents / 100:,.2f}"


def pct(x: float | None, digits: int = 0) -> str:
    return "n/a" if x is None else f"{x:.{digits}f}%"


LEAGUE_WORDS = {"nfl": "NFL", "nba": "NBA", "mlb": "MLB", "nhl": "NHL", "crypto": "Bitcoin strikes", "epl": "Premier League"}


def numbers(snap: dict) -> dict:
    s = snap["shadow"]
    w = s["writer"]
    ident = s["identity"]
    settled = s["settledCount"]
    p = snap["parlays"]
    sb = snap["scoreboard"]
    weeks = sb["weeks"]
    # the venue table reads the last full week; the current one is partial
    full = weeks[1] if len(weeks) > 1 else weeks[0]
    at = datetime.fromisoformat(snap["at"].replace("Z", "+00:00")).astimezone(timezone.utc)
    first = datetime.fromisoformat(s["firstOpenedAt"].replace("Z", "+00:00"))
    avail = {a["venue"]: a for a in full["availability"]["byVenue"]}
    fees = {f["venue"]: f for f in full["fees"]["byVenue"]}
    singles = {x["venue"]: x for x in full["singles"]["otherSide"]}
    parl = {x["venue"]: x for x in full["parlays"]["otherSide"]}
    refused_total = sum(wk["refusals"]["refused"] for wk in weeks)
    priced_total = sum(wk["refusals"]["priced"] for wk in weeks)
    return {
        "at": at.strftime("%Y-%m-%d %H:%M UTC"),
        "at_short": at.strftime("%b %d, %Y"),
        "since": first.strftime("%b %d, %Y"),
        "protected": settled + s["openCount"],
        "settled": settled,
        "credits": usd(w["creditsPaidCents"]),
        "floor_pct": round(100 * s["floorSaves"] / settled) if settled else 0,
        "pnl": usd(ident["writerPnlCents"]),
        "take": usd(ident["takeBookedCents"]),
        "gap": usd(ident["gapCents"]),
        "holds": ident["holds"] and p["settled"]["identityHolds"],
        "leagues": ", ".join(LEAGUE_WORDS.get(k, k.upper()) for k in w["byLeague"]),
        "tickets": p["tickets"],
        "locks_priced": p["locksPriced"],
        "parlays_settled_with_lock": p["settled"]["withLock"],
        "week": {
            "label": full["label"],
            "n": full["n"],
            "taps": full["taps"],
            "contracts": round(full["contracts"]),
            "notional": usd(full["notionalCents"], whole=True),
            "singles_n": full["singles"]["n"],
            "parlays_n": full["parlays"]["n"],
            "refused": full["refusals"]["refused"],
            "priced": full["refusals"]["priced"],
            "refused_pct": full["refusals"]["refusedPct"],
            "rows": [
                {
                    "venue": v,
                    "singles": singles.get(v),
                    "parlays": parl.get(v),
                    "fee": fees.get(v),
                    "avail": avail.get(v),
                }
                for v in sb["venues"]
                if v in singles or v in parl or v in fees or v in avail
            ],
            "novig_priced": avail.get("Novig", {}).get("pricedPct"),
            "prophetx_priced": avail.get("ProphetX", {}).get("pricedPct"),
            "asked": full["availability"]["n"],
        },
        "weeks": WEEKS,
        "weeks_n": sum(wk["n"] for wk in weeks),
        "weeks_taps": sum(wk["taps"] for wk in weeks),
        "weeks_refused": refused_total,
        "weeks_priced": priced_total,
        "weeks_refused_pct": round(100 * refused_total / priced_total, 1) if priced_total else None,
    }


def venue_table(wk: dict) -> str:
    def share(x: dict | None) -> str:
        if not x:
            return "<span class=dash>none</span>"
        share_txt = "&lt;1%" if 0 <= x["sharePct"] < 1 else f"{x['sharePct']:g}%"
        return f"<b>{share_txt}</b> <i>{x['n']}</i>"

    with_parlays = any(r["parlays"] for r in wk["rows"])

    def fee(x: dict | None) -> str:
        return f"{x['avgFeeCentsPerContract']:.2f}&cent;" if x and x["avgFeeCentsPerContract"] is not None else "<span class=dash>n/a</span>"

    def avail(x: dict | None) -> str:
        return f"<b>{x['pricedPct']:g}%</b> <i>{x['priced']} of {x['asked']}</i>" if x else "<span class=dash>not asked</span>"

    rows = "".join(
        f"<tr><td class=v>{r['venue']}</td><td>{share(r['singles'])}</td>{f'<td>{share(r[chr(112)+chr(97)+chr(114)+chr(108)+chr(97)+chr(121)+chr(115)])}</td>' if with_parlays else ''}<td>{fee(r['fee'])}</td><td>{avail(r['avail'])}</td></tr>"
        for r in wk["rows"]
    )
    parlays_th = "<th>parlays<small>other side won · n</small></th>" if with_parlays else ""
    return f"""<table>
<tr><th>venue</th><th>singles<small>other side won · n</small></th>{parlays_th}<th>fee<small>&cent; per contract</small></th><th>priced when asked<small>of {wk['asked']} positions</small></th></tr>
{rows}</table>"""


def page(n: dict) -> str:
    assert n["holds"], "the identity does not hold on the live record; do not print a page that says it does"
    wk = n["week"]
    thin = []
    if wk["novig_priced"] is not None:
        thin.append(f"Novig priced {pct(wk['novig_priced'])} of the time it was asked")
    if wk["prophetx_priced"] is not None:
        thin.append(f"ProphetX {pct(wk['prophetx_priced'])}")
    thin_line = "; ".join(thin) if thin else "every venue asked priced"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Atticus for River Markets · one sheet</title>
<style>
@page{{size:Letter;margin:0}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:8.5in;height:11in;background:#fff;color:{INK};font:8.6pt/1.38 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.sheet{{position:relative;width:8.5in;height:11in;padding:.4in .52in .34in;display:flex;flex-direction:column;gap:.11in;overflow:hidden}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid {GOLD};padding-bottom:.1in}}
.top img{{height:.3in;display:block}}
.top .tag{{font-size:8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:700}}
h1{{font-size:17.5pt;line-height:1.12;letter-spacing:-.015em;font-weight:800;max-width:7.4in}}
.lede{{margin-top:.05in;font-size:8.9pt;line-height:1.4;color:{MUTED};max-width:7.4in}}
.lede b{{color:{INK};font-weight:700}}
.grid{{display:grid;grid-template-columns:1fr 2.6in;gap:.22in;align-items:start}}
h2{{font-size:7.8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:800;margin-bottom:.06in}}
section{{margin-bottom:.11in}}
section:last-child{{margin-bottom:0}}
.tiles{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.09in}}
.tile{{border:1px solid {RULE};border-radius:9px;padding:.07in .09in;border-top:3px solid {GREEN}}}
.tile h3{{font-size:8.6pt;font-weight:800;line-height:1.25;margin-bottom:3px}}
.tile p{{font-size:7.5pt;color:{MUTED};line-height:1.38}}
.tile p b{{color:{INK}}}
.nums{{display:grid;grid-template-columns:repeat(4,1fr);gap:.08in}}
.num{{background:{CARD};border-radius:9px;padding:.07in .09in .065in}}
.num .n{{font-size:13pt;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}}
.num .n.g{{color:{GREEN}}}
.num .l{{font-size:7.2pt;color:{FAINT};margin-top:3px;line-height:1.3}}
.ident{{margin-top:.07in;display:flex;gap:.12in;align-items:flex-start;border-left:3px solid {GOLD};padding-left:.11in}}
.ident .big{{font-size:11.5pt;font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.25}}
.ident .big i{{font-style:normal;color:{FAINT};font-weight:600;font-size:8.5pt}}
.ident p{{font-size:7.7pt;color:{MUTED};line-height:1.4}}
.ident p b{{color:{INK}}}
table{{width:100%;border-collapse:collapse;font-size:7.9pt;font-variant-numeric:tabular-nums}}
th{{text-align:right;color:{FAINT};font-weight:700;font-size:7pt;text-transform:uppercase;letter-spacing:.06em;padding:3px 5px;border-bottom:1px solid {RULE};white-space:nowrap;vertical-align:bottom}}
th small{{display:block;font-size:6.6pt;letter-spacing:.02em;text-transform:none;font-weight:600}}
th:first-child,td:first-child{{text-align:left}}
td{{padding:3px 5px;border-bottom:1px solid {RULE};color:{MUTED};text-align:right;white-space:nowrap}}
td.v{{color:{INK};font-weight:800}}
td b{{color:{INK};font-weight:800}}
td i{{font-style:normal;color:{FAINT};font-size:7.2pt}}
td .dash{{color:{FAINT}}}
.cap{{margin-top:.04in;font-size:7.5pt;color:{MUTED};line-height:1.4}}
.cap b{{color:{INK}}}
.right{{display:flex;flex-direction:column;gap:.11in}}
.seq{{border:1px solid {RULE};border-radius:9px;padding:.1in .11in}}
.seq .st{{display:flex;gap:.1in;padding:.06in 0;border-top:1px solid {RULE}}}
.seq .st:first-of-type{{border-top:0;padding-top:0}}
.seq .k{{flex:0 0 .5in;font-size:7.6pt;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:{GREEN};padding-top:2px}}
.seq .k.now{{color:{INK}}}
.seq .k.later{{color:{GOLD}}}
.seq p{{font-size:7.4pt;color:{MUTED};line-height:1.38}}
.seq p b{{color:{INK}}}
.phonebox{{display:flex;gap:.12in;align-items:flex-start}}
.phone{{flex:0 0 .9in;border-radius:12px;border:1.5px solid #CFD3DA;overflow:hidden;background:#fff;box-shadow:0 5px 14px rgba(17,19,24,.10)}}
.phone img{{display:block;width:100%}}
.pcap{{font-size:7.4pt;color:{MUTED};line-height:1.4}}
.pcap b{{color:{INK}}}
.verify{{display:grid;grid-template-columns:repeat(4,1fr);gap:.1in;border:1px solid {RULE};border-radius:9px;padding:.08in .1in;font-size:7.3pt;line-height:1.36;color:{MUTED}}}
.verify .cell{{display:flex;flex-direction:column;gap:2px}}
.verify .cell b{{color:{INK};font-weight:800;font-size:7.6pt;letter-spacing:.08em;text-transform:uppercase}}
.verify a{{color:{INK};text-decoration:none;border-bottom:1px solid {RULE};font-variant-numeric:tabular-nums;align-self:flex-start;word-break:break-all}}
.foot{{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid {RULE};padding-top:.06in;font-size:7.2pt;color:{FAINT};line-height:1.4}}
.foot b{{color:{INK};font-weight:700}}
.foot>div{{max-width:3.5in}}
.foot .r{{text-align:right}}
</style></head><body><div class="sheet">

<div class="top"><img src="atticus_wordmark_gold.png" alt="Atticus"><div class="tag">For River Markets · {n['at_short']}</div></div>

<div>
<h1>The other side of retail protection, pre-game, across your venues.</h1>
<p class="lede">A retail holder on Kalshi, ProphetX or Novig taps <b>Lock in</b> on a position they already hold and gets a <b>floor and a cap</b> for a credit paid now. Atticus prices it and buys the other side on the exchange's book, at the <b>cheapest venue all in, venue fees included</b>. Nothing bilateral: the holder's position stays on the exchange, and so does ours. What comes out is a flow your venues do not carry today: <b>the opposing outcome of what retail already holds, bought pre-game, with no view.</b></p>
</div>

<div class="grid">
<div class="left">

<section>
<h2>What it is worth to an execution layer</h2>
<div class="tiles">
  <div class="tile"><h3>Flow your desks do not have</h3><p>Every order is the opposite side of a position a retail holder owns, placed pre-game with no view: the least informed flow in the market. Today it meets whoever is on the screen.</p></div>
  <div class="tile"><h3>A client already on your venues</h3><p>We built a cross-venue router because none existed: ask every venue, rank all in with fees and settlement rules folded in. That is your stack's work; <b>one integration beats four adapters.</b></p></div>
  <div class="tile"><h3>Demand the screens cannot fill</h3><p>Last week {thin_line}. <b>{wk['refused']} of {wk['priced']} markets</b> were declined: the other side cost too much on the screens to leave a worthwhile credit. Measured weekly, by venue, in public.</p></div>
</div>
</section>

<section>
<h2>The record, live since {n['since']}</h2>
<div class="nums">
  <div class="num"><div class="n">{n['protected']:,}</div><div class="l">positions protected, {n['settled']:,} settled</div></div>
  <div class="num"><div class="n g">{n['credits']}</div><div class="l">paid to holders at the tap</div></div>
  <div class="num"><div class="n">{n['floor_pct']}%</div><div class="l">floor saves: holder finished above the unprotected outcome</div></div>
  <div class="num"><div class="n">{n['weeks_n']:,}</div><div class="l">positions priced in the last {n['weeks']} weeks, {n['weeks_taps']} of them real taps</div></div>
</div>
<div class="ident"><div class="big">{n['pnl']} <i>our P&amp;L</i><br>{n['take']} <i>take booked</i></div><p><b>Gap {n['gap']} on all {n['settled']:,} settled positions:</b> our P&amp;L equals the take booked at quote time, to the cent. We earn the published take and nothing on the result. {n['leagues']}; {n['tickets']} parlay tickets, {n['locks_priced']} locks priced at the last pick. Every row public, with a receipt; refusals recorded beside the fills.</p></div>
</section>

<section>
<h2>Where the other side went · {wk['label']}</h2>
{venue_table(wk)}
<p class="cap"><b>{wk['n']} positions</b> ({wk['singles_n']} singles, {wk['parlays_n']} parlay locks at the last pick), {wk['contracts']:,} contracts, {wk['notional']} of the other side bought, {wk['taps']} real taps. Kalshi prices every time because it is the market's own book; the others are asked for the same position at the same second. Fee: each venue's schedule at the price paid. Edge over the runner-up and refusals by reason are on the scoreboard.</p>
</section>

</div>
<div class="right">

<div class="seq">
<h2>How it fits, in sequence</h2>
<div class="st"><div class="k now">Now</div><p>Live across your venues with our own router. The record and the venue scoreboard are public and weekly: <b>the flow and its venue comparison are there to read</b>, nothing to integrate.</p></div>
<div class="st"><div class="k">Next</div><p>The other side routed through River's execution API in place of four venue adapters; your desks see it on the screens first. One client, one new flow type. <b>Size grows with the venues' holders, not on a promise.</b></p></div>
<div class="st"><div class="k later">Later</div><p>Where the screens are thin, a quote request for the other side at size to your desks, filled on the venue, screen as fallback: the shape our perpetuals stack runs today. Positions and margin consolidated across venues as your capital work ships. <b>The hedge is paid for by the credit</b>: the most capital-efficient leg you will carry.</p></div>
</div>

<div class="phonebox">
  <div class="phone"><img src="phone_positions.png" alt="The positions list with Lock in on every row"></div>
  <p class="pcap"><b>The retail origin.</b> Their venue's shell, our line under every position: one tap, two endings, cash now. The receipt names the venue that took the other side. A browser extension on the venues' pages, or an embed.</p>
</div>

</div>
</div>

<div class="verify">
<div class="cell"><b>Scoreboard</b><a href="{RECORD}/scoreboard">{RECORD.replace('https://','')}/scoreboard</a><span>By week and venue: other side won, edge, fee, availability, refusals. CSV and JSON at the top.</span></div>
<div class="cell"><b>Track record</b><a href="{RECORD}/">{RECORD.replace('https://','')}</a><span>Every number on this page, live. Positions CSV at /api/shadow/positions.csv.</span></div>
<div class="cell"><b>Demo</b><a href="{DEMO}/">{DEMO.replace('https://','')}</a><span>Trader view and Venue view; ?tab=parlays for the parlays.</span></div>
<div class="cell"><b>What it is not</b><span>A market maker, a signal, or custody. No funds held, no view taken; the P&amp;L is the published take whoever wins.</span></div>
</div>

<div class="foot">
<div><b>Michael William</b>, founder · michael@atticustrade.com<br>Same engine on Bitcoin perpetuals: public shadow facility since July 2026, screen read then block RFQ.</div>
<div class="r">Numbers as of {n['at']}.<br>Positions on the record are simulated at live prices except the taps, which are real holders' locks.</div>
</div>

</div></body></html>
"""


def check(html: str) -> None:
    assert "\u2014" not in html, "em dash"
    low = html.lower()
    assert "wallet" not in low
    text = re.sub(r"<[^>]+>", " ", html)
    for w in PROMISE_WORDS:
        assert w not in text.lower(), f"promise word: {w}"
    for v in VENUES:
        for m in re.finditer(re.escape(v), text):
            window = text[max(0, m.start() - 60) : m.end() + 60].lower()
            assert "partner" not in window, f"{v} named beside 'partner'"
    assert "through river" in text.lower() and "routed through river's execution api" in text.lower()
    # the "now" step must not claim we route through River today
    now = re.search(r"Now</div><p>(.*?)</p>", html, re.S)
    assert now and "river" not in now.group(1).lower(), "the Now step must not name River"


def run_chrome(args: list[str], out: Path) -> None:
    import time

    proc = subprocess.Popen(
        [chrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--user-data-dir=/tmp/chrome-river-onesheet", *args],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # headless Chrome lingers after the file is written; leave once the output has stopped growing
    deadline = time.time() + 90
    last = -1
    while time.time() < deadline:
        if proc.poll() is not None:
            return
        if out.exists():
            size = out.stat().st_size
            if size > 0 and size == last:
                time.sleep(1)
                proc.kill()
                return
            last = size
        time.sleep(1)
    proc.kill()


def chrome() -> str:
    for c in ("google-chrome", "chromium", "chromium-browser", "/usr/local/bin/google-chrome"):
        if shutil.which(c) or Path(c).exists():
            return c
    sys.exit("headless Chrome not found")


def pdf_pages(path: Path) -> int:
    return len(re.findall(rb"/Type\s*/Page[^s]", path.read_bytes()))


def content_bottom(png: Path, scale: int) -> float:
    """The lowest non-white row of the preview, in inches: the page must hold everything above 11in."""
    from PIL import Image

    im = Image.open(png).convert("L")
    w, h = im.size
    px = im.load()
    last = 0
    for y in range(h - 1, -1, -1):
        if any(px[x, y] < 245 for x in range(0, w, 4)):
            last = y
            break
    return last / (96 * scale)


def main() -> None:
    offline = "--offline" in sys.argv
    snap = snapshot(offline)
    n = numbers(snap)
    html = page(n)
    check(html)
    (HERE / "atticus_river_onesheet.html").write_text(html)
    out = HERE / "atticus_river_onesheet.pdf"
    out.unlink(missing_ok=True)
    run_chrome(["--no-pdf-header-footer", f"--print-to-pdf={out}", f"file://{HERE / 'atticus_river_onesheet.html'}"], out)
    if not out.exists():
        sys.exit("Chrome wrote no PDF")
    pages = pdf_pages(out)
    assert pages == 1, f"the sheet ran to {pages} pages; tighten it"
    print("wrote", out, "as of", n["at"])
    # the preview is taken on a taller canvas with the clip off, so anything past the page edge shows and fails the build
    tall = html.replace("overflow:hidden}}", "overflow:visible}}").replace("overflow:hidden}", "overflow:visible}")
    probe = HERE / ".probe.html"
    probe.write_text(tall)
    png = HERE / "atticus_river_onesheet.png"
    png.unlink(missing_ok=True)
    run_chrome(["--window-size=816,1400", "--force-device-scale-factor=2", "--hide-scrollbars", f"--screenshot={png}", f"file://{probe}"], png)
    probe.unlink(missing_ok=True)
    if not png.exists():
        sys.exit("Chrome wrote no preview")
    bottom = content_bottom(png, 2)
    assert bottom <= 11.0, f"content runs to {bottom:.2f}in; the page is 11in"
    from PIL import Image

    Image.open(png).crop((0, 0, 816 * 2, 1056 * 2)).save(png)
    print("wrote", png, f"(content bottom {bottom:.2f}in)")


if __name__ == "__main__":
    main()
