"""
The Atticus one sheet: one Letter page, visual, every number from the live record.

    python3 docs/reports/submission/alpha51/build_onesheet.py            # live numbers
    python3 docs/reports/submission/alpha51/build_onesheet.py --offline  # last saved snapshot

Reads /api/shadow and /api/shadow/parlays from the public record, saves the
snapshot beside the page (record-<date>.json) so the PDF can be rebuilt without
the network, writes atticus_onesheet.html, and prints it to PDF with headless
Chrome. The phone pictures (phone_sheet.png, phone_parlays.png) are screenshots
of the embedded demo at phone size; retake them with the demo running if the
product changes (see README.md).

Rules: no em dash anywhere; "address", never "wallet"; the venue's name on the
phone is the placeholder "Your Exchange"; nothing on the page a click on the
record or the demo can falsify.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = "https://atticus-event-shadow.onrender.com"
DEMO = "https://event.earnandprotect.xyz"

GOLD = "#C9A227"
GREEN = "#00B67A"
INK = "#111318"
MUTED = "#4B5058"
FAINT = "#6E747D"
RULE = "#E2E5EA"
CARD = "#F6F7F9"


def fetch(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "atticus-onesheet"}), timeout=20) as r:
        return json.load(r)


def snapshot(offline: bool) -> dict:
    saved = sorted(HERE.glob("record-*.json"))
    if offline:
        if not saved:
            sys.exit("no saved snapshot; run once online")
        return json.loads(saved[-1].read_text())
    shadow = fetch(f"{RECORD}/api/shadow")
    parlays = fetch(f"{RECORD}/api/shadow/parlays")
    snap = {"at": shadow["at"], "shadow": shadow["summary"], "parlays": parlays["summary"], "parlaysAt": parlays["at"]}
    (HERE / f"record-{shadow['at'][:10]}.json").write_text(json.dumps(snap, indent=1) + "\n")
    return snap


def usd(cents: int, whole: bool = False) -> str:
    if whole or cents % 100 == 0:
        return f"${cents // 100:,}"
    return f"${cents / 100:,.2f}"


def numbers(snap: dict) -> dict:
    s = snap["shadow"]
    w = s["writer"]
    ident = s["identity"]
    settled = s["settledCount"]
    protected = settled + s["openCount"]
    stake_settled = sum(v["stakeCents"] for v in w["byLeague"].values())
    leagues = [k for k in w["byLeague"]]
    at = datetime.fromisoformat(snap["at"].replace("Z", "+00:00")).astimezone(timezone.utc)
    first = datetime.fromisoformat(s["firstOpenedAt"].replace("Z", "+00:00"))
    p = snap["parlays"]
    return {
        "at": at.strftime("%Y-%m-%d %H:%M UTC"),
        "at_short": at.strftime("%b %d, %Y"),
        "since": first.strftime("%b %d, %Y"),
        "protected": protected,
        "settled": settled,
        "open": s["openCount"],
        "stake_settled": usd(stake_settled, whole=True),
        "credits": usd(w["creditsPaidCents"]),
        "floor_saves": s["floorSaves"],
        "floor_pct": round(100 * s["floorSaves"] / settled) if settled else 0,
        "pnl": usd(ident["writerPnlCents"]),
        "take": usd(ident["takeBookedCents"]),
        "gap": usd(ident["gapCents"]),
        "holds": ident["holds"],
        "cost_realized": f"{abs(s['realizedDeltaBpsOfStake']) / 100:.1f}%",
        "cost_quoted": f"{s['quotedAvgEvBps'] / 100:.1f}%",
        "leagues": leagues,
        "tickets": p["tickets"],
        "tickets_in_play": p["inPlay"],
        "tickets_busted": p["busted"],
        "locks_priced": p["locksPriced"],
        "parlays_since": datetime.fromisoformat(p["firstTicketAt"].replace("Z", "+00:00")).strftime("%b %d") if p.get("firstTicketAt") else None,
    }


LEAGUE_WORDS = {"nfl": "NFL", "nba": "NBA", "mlb": "MLB", "nhl": "NHL", "crypto": "Bitcoin strikes", "epl": "Premier League"}


def page(n: dict) -> str:
    assert n["holds"], "the identity does not hold on the live record; do not print a page that says it does"
    leagues = ", ".join(LEAGUE_WORDS.get(k, k.upper()) for k in n["leagues"])
    parlay_record = (
        f"Since {n['parlays_since']}: {n['tickets']} tickets, {n['tickets_in_play']} in play, "
        f"{n['tickets_busted']} busted on an early pick; the first lock prices when a ticket reaches its last pick."
        if n["parlays_since"]
        else "The parlay record starts with the first ticket built."
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Atticus · one sheet</title>
<style>
@page{{size:Letter;margin:0}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:8.5in;height:11in;background:#fff;color:{INK};font:9pt/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.sheet{{position:relative;width:8.5in;height:11in;padding:.45in .55in .4in;display:flex;flex-direction:column;gap:.14in;overflow:hidden}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid {GOLD};padding-bottom:.12in}}
.top img{{height:.3in;display:block}}
.top .tag{{font-size:8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:700}}
h1{{font-size:20pt;line-height:1.1;letter-spacing:-.015em;font-weight:800}}
.lede{{margin-top:.07in;font-size:10pt;line-height:1.42;color:{MUTED};max-width:7.3in}}
.lede b{{color:{INK};font-weight:700}}
.grid{{display:grid;grid-template-columns:1fr 3.1in;gap:.26in;flex:1;min-height:0}}
h2{{font-size:8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:800;margin-bottom:.07in}}
section{{margin-bottom:.15in}}
section:last-child{{margin-bottom:0}}
.steps{{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:.08in;align-items:center}}
.step{{background:{CARD};border-radius:9px;padding:.08in .1in;min-height:.62in}}
.step .l{{font-size:7.6pt;color:{FAINT};text-transform:uppercase;letter-spacing:.08em;font-weight:700}}
.step .v{{font-size:8.6pt;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;line-height:1.3}}
.step .v i{{font-style:normal;color:{GREEN}}}
.step.tap{{background:{GREEN};color:#fff}}
.step.tap .l{{color:rgba(255,255,255,.8)}}
.arrow{{color:{FAINT};font-size:13pt}}
.cap{{margin-top:.06in;font-size:8.2pt;color:{MUTED};line-height:1.4}}
.tiles{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.1in}}
.tile{{border:1px solid {RULE};border-radius:9px;padding:.08in .1in}}
.tile h3{{font-size:9pt;font-weight:800;line-height:1.25;margin-bottom:3px}}
.tile p{{font-size:8.1pt;color:{MUTED};line-height:1.4}}
.nums{{display:grid;grid-template-columns:repeat(4,1fr);gap:.08in}}
.num{{background:{CARD};border-radius:9px;padding:.09in .1in .08in}}
.num .n{{font-size:14.5pt;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}}
.num .n.g{{color:{GREEN}}}
.num .l{{font-size:7.6pt;color:{FAINT};margin-top:3px;line-height:1.3}}
.ident{{margin-top:.08in;display:flex;gap:.12in;align-items:flex-start;border-left:3px solid {GOLD};padding-left:.12in}}
.ident .big{{font-size:12.5pt;font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.2}}
.ident .big i{{font-style:normal;color:{FAINT};font-weight:600;font-size:9pt}}
.ident p{{font-size:8.3pt;color:{MUTED};line-height:1.4}}
.ident p b{{color:{INK}}}
.prose{{font-size:8.6pt;color:{MUTED};line-height:1.42}}
.prose b{{color:{INK}}}
.right{{display:flex;flex-direction:column;gap:.14in}}
.phones{{display:grid;grid-template-columns:1fr 1fr;gap:.14in}}
.phone{{border-radius:16px;border:1.5px solid #CFD3DA;overflow:hidden;background:#fff;box-shadow:0 6px 18px rgba(17,19,24,.10)}}
.phone img{{display:block;width:100%}}
.pcap{{font-size:7.6pt;color:{MUTED};line-height:1.38;margin-top:5px}}
.pcap b{{color:{INK}}}
.verify{{border:1px solid {RULE};border-radius:9px;padding:.1in .11in;font-size:8pt;line-height:1.45;color:{MUTED}}}
.verify h2{{margin-bottom:.05in}}
.verify .row{{display:flex;gap:.08in;margin-top:3px}}
.verify .row b{{color:{INK};min-width:.95in;font-weight:700}}
.verify a{{color:{INK};text-decoration:none;border-bottom:1px solid {RULE};font-variant-numeric:tabular-nums}}
.foot{{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid {RULE};padding-top:.08in;font-size:7.8pt;color:{FAINT};line-height:1.4}}
.foot b{{color:{INK};font-weight:700}}
.foot .r{{text-align:right}}
</style></head><body><div class="sheet">

<div class="top"><img src="atticus_wordmark_gold.png" alt="Atticus"><div class="tag">One sheet · {n['at_short']}</div></div>

<div>
<h1>Protection inside the venue's app. One tap, paid today.</h1>
<p class="lede">A user holding a position on a prediction market taps <b>Lock in</b>. The position now ends at a <b>floor</b> or a <b>cap</b>, and part of it is <b>paid in cash today</b>. Atticus prices it and hedges it on the other side of the same market. The venue keeps the flow, the ledger and the customer; Atticus never holds funds.</p>
</div>

<div class="grid">
<div class="left">

<section>
<h2>What the user sees</h2>
<div class="steps">
  <div class="step"><div class="l">Before</div><div class="v">Seahawks · 150 contracts<br>ends $0 or $150</div></div>
  <div class="arrow">&#x2192;</div>
  <div class="step tap"><div class="l">One tap</div><div class="v">Lock in · +$4.24 now</div></div>
  <div class="arrow">&#x2192;</div>
  <div class="step"><div class="l">After</div><div class="v">ends $67.24 or $106.24<br><i>$4.24 paid now</i></div></div>
</div>
<p class="cap">The credit shown is net of our take. Settlement is the venue's official result. When the market cannot fund a credit, we refuse and the refusal is recorded beside the fills.</p>
</section>

<section>
<h2>Why a venue adds the button</h2>
<div class="tiles">
  <div class="tile"><h3>A third choice beside hold and cash out</h3><p>Cash out sells the whole position at the spread. The lock keeps it: a floor, upside to a cap, cash today.</p></div>
  <div class="tile"><h3>Revenue with no outcome risk</h3><p>A published take on every protected position, shared with the venue. Our P&amp;L equals that take whoever wins.</p></div>
  <div class="tile"><h3>One JSON quote in, one receipt out</h3><p>Your brand, your ledger, your official result. We supply the sheet. Nothing custodial.</p></div>
</div>
</section>

<section>
<h2>The record, live since {n['since']}</h2>
<div class="nums">
  <div class="num"><div class="n">{n['protected']:,}</div><div class="l">positions protected, {n['settled']:,} settled</div></div>
  <div class="num"><div class="n">{n['stake_settled']}</div><div class="l">stake settled</div></div>
  <div class="num"><div class="n g">{n['credits']}</div><div class="l">paid to users at the tap</div></div>
  <div class="num"><div class="n">{n['floor_pct']}%</div><div class="l">floor saves: user finished above the unprotected outcome</div></div>
</div>
<div class="ident"><div class="big">{n['pnl']} <i>our P&amp;L</i><br>{n['take']} <i>take booked</i></div><p><b>Gap {n['gap']} on all {n['settled']:,} settled positions:</b> our P&amp;L equals the take booked at quote time, to the cent. We earn the published take and nothing on the result. Floor cost {n['cost_realized']} of stake realized, {n['cost_quoted']} quoted. {leagues}; hedged on Kalshi and Polymarket. Every row public, with a receipt.</p></div>
</section>

<section>
<h2>Parlays: the lock at the last pick</h2>
<p class="prose">A parlay is a long shot when bought; no honest floor can be priced on it. Once every pick but one has hit, it is a position on <b>one game at one game's odds</b>, which is what the layer prices. So the lock appears at the last pick and nowhere before. {parlay_record}</p>
</section>

</div>
<div class="right">

<div class="phones">
  <div><div class="phone"><img src="phone_sheet.png" alt="Positions list with the Lock in sheet open"></div><p class="pcap"><b>Positions.</b> Their shell, our sheet: two endings and the cash paid now. Priced live, locked at the tap.</p></div>
  <div><div class="phone"><img src="phone_parlays.png" alt="Parlays tab with one ticket at its last pick"></div><p class="pcap"><b>Parlays.</b> The lock exists only at the last pick; earlier tickets say so, and refusals say why.</p></div>
</div>

<div class="verify">
<h2>See it yourself</h2>
<div class="row"><b>Demo</b><span><a href="{DEMO}/">{DEMO.replace('https://','')}</a><br>Tap Lock in on any row. Add <span style="white-space:nowrap">?tab=parlays</span> for the parlays.</span></div>
<div class="row"><b>Track record</b><span><a href="{RECORD}/">{RECORD.replace('https://','')}</a><br>Every number on this page, live. Identity card at the top; positions export at /api/shadow/positions.csv, one row per position in integer cents.</span></div>
<div class="row"><b>What it is not</b><span>Not a forecast, a signal or a bot. Not custody. Not venue specific: the record settles on Kalshi; the layer runs on any venue with a public book.</span></div>
</div>

</div>
</div>

<div class="foot">
<div><b>Michael William</b>, founder · michael@atticustrade.com<br>Same engine on Bitcoin perpetuals: public shadow facility since July 2026.</div>
<div class="r">Numbers as of {n['at']}.<br>Demo positions and parlay tickets are simulated at live prices; nothing is bought.</div>
</div>

</div></body></html>
"""


def mockup(n: dict) -> str:
    """Three phones on one wide card, for a message or a slide: the list, the sheet, the parlays tab."""
    shots = [
        ("phone_positions.png", "Their positions list", "Every row they already hold, with a Lock in button beside it. Their brand, their shell."),
        ("phone_sheet.png", "The sheet", "Two endings and the cash paid now, priced live. One tap locks it; the receipt lands in their activity."),
        ("phone_parlays.png", "Parlays", "The lock exists only at the last pick. Earlier tickets say so; refusals say why."),
    ]
    cards = "".join(
        f'<div class="c"><div class="phone"><img src="{src}" alt="{h}"></div><h3>{h}</h3><p>{cap}</p></div>' for src, h, cap in shots
    )
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Atticus · mockup</title><style>
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:1600px;height:1000px;background:{CARD};color:{INK};font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}}
.wrap{{width:1600px;height:1000px;padding:44px 56px 40px}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px}}
.top img{{height:40px;display:block}}
.top .t{{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:700}}
.row{{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}}
.c{{display:flex;flex-direction:column;align-items:center;text-align:center}}
.phone{{width:330px;border-radius:38px;border:2px solid #CFD3DA;overflow:hidden;background:#fff;box-shadow:0 18px 48px rgba(17,19,24,.12)}}
.phone img{{display:block;width:100%}}
h3{{font-size:19px;font-weight:800;margin-top:22px}}
p{{font-size:15px;color:{MUTED};max-width:400px;margin-top:4px}}
.foot{{margin-top:26px;font-size:13px;color:{FAINT};text-align:center}}
</style></head><body><div class="wrap">
<div class="top"><img src="atticus_wordmark_gold.png" alt="Atticus"><div class="t">Protection inside the venue's app · demo at live prices</div></div>
<div class="row">{cards}</div>
<div class="foot">Venue name is a placeholder. Positions and tickets are simulated at live prices; nothing is bought. Live demo: {DEMO.replace('https://','')}</div>
</div></body></html>
"""


def run_chrome(args: list[str]) -> None:
    proc = subprocess.Popen(
        [chrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--user-data-dir=/tmp/chrome-onesheet-print", *args],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        proc.wait(timeout=45)
    except subprocess.TimeoutExpired:
        proc.kill()  # headless Chrome sometimes lingers after the file is written


def chrome() -> str:
    for c in ("google-chrome", "chromium", "chromium-browser", "/usr/local/bin/google-chrome"):
        if shutil.which(c) or Path(c).exists():
            return c
    sys.exit("headless Chrome not found")


def main() -> None:
    offline = "--offline" in sys.argv
    snap = snapshot(offline)
    n = numbers(snap)
    html = page(n)
    assert "\u2014" not in html, "em dash"
    assert "wallet" not in html.lower()
    (HERE / "atticus_onesheet.html").write_text(html)
    out = HERE / "atticus_onesheet.pdf"
    out.unlink(missing_ok=True)
    run_chrome(["--no-pdf-header-footer", f"--print-to-pdf={out}", f"file://{HERE / 'atticus_onesheet.html'}"])
    if not out.exists():
        sys.exit("Chrome wrote no PDF")
    print("wrote", out, "as of", n["at"])

    mock_html = mockup(n)
    assert "\u2014" not in mock_html and "wallet" not in mock_html.lower()
    (HERE / "atticus_mockup.html").write_text(mock_html)
    png = HERE / "atticus_mockup.png"
    png.unlink(missing_ok=True)
    run_chrome(["--window-size=1600,1000", "--force-device-scale-factor=2", "--hide-scrollbars", f"--screenshot={png}", f"file://{HERE / 'atticus_mockup.html'}"])
    if not png.exists():
        sys.exit("Chrome wrote no mockup")
    print("wrote", png)


if __name__ == "__main__":
    main()
