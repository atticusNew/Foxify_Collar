"""
The NEXTPredict leave-behind: one Letter page and one phone-size image, every number
from the live record.

    python3 docs/reports/submission/nextpredict/build_leavebehind.py            # live numbers
    python3 docs/reports/submission/nextpredict/build_leavebehind.py --offline  # last saved snapshot

Reads /api/shadow from the public record, saves the snapshot beside the page
(record-<date>.json) so both files can be rebuilt without the network, writes
atticus_leavebehind.html and prints it to PDF with headless Chrome, then writes
atticus_leavebehind_phone.html and screenshots it at 1080x1920 for sending from a phone.
The QR code points at the public record and is drawn with segno (pip install segno);
without segno the page carries the URL in text and no QR.

Rules: no em dash anywhere; "address", never "wallet"; the venue's name on the phone is
the placeholder "Your Exchange"; nothing on the page a click on the record or the demo can
falsify; no venue other than the public record named; nothing about dealers, netting or
what ships next. One flow total, no venue split.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = "https://atticus-event-shadow.onrender.com"
DEMO = "https://event.earnandprotect.xyz"
CONTACT = "michael@atticustrade.com"
FLOW_WINDOW_DAYS = 30

GOLD = "#C9A227"
GREEN = "#00B67A"
INK = "#111318"
MUTED = "#4B5058"
FAINT = "#6E747D"
RULE = "#E2E5EA"
CARD = "#F6F7F9"


def fetch(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "atticus-leavebehind"}), timeout=20) as r:
        return json.load(r)


def hedge_units_milli(p: dict) -> int:
    """NO units the hedge bought, milli: the record's field, else the pricer's sizing rule rounded up."""
    if isinstance(p.get("hedgeUnitsMilli"), int):
        return p["hedgeUnitsMilli"]
    return math.ceil((p["floorCents"] + 100 - p["capCents"]) * p["contracts"] * 1000 / 100)


def hedge_cost_cents(p: dict) -> int:
    """What the hedge cost at open, fees in: funding minus credit minus take (the credit identity)."""
    return (100 - p["capCents"]) * p["contracts"] - p["creditCents"] - p["takeCents"]


def flow_from_positions(positions: list[dict], at: datetime) -> dict:
    """Mirror of summarizeFlow (shadowLedger.ts): one total over positions opened in the window."""
    since = at.timestamp() - FLOW_WINDOW_DAYS * 86_400
    recent = {"positions": 0, "contractsMilli": 0, "hedgeNotionalCents": 0, "stakeCents": 0}
    total = {"positions": 0, "contractsMilli": 0, "hedgeNotionalCents": 0, "stakeCents": 0}
    for p in positions:
        opened = datetime.fromisoformat(p["at"].replace("Z", "+00:00")).timestamp()
        for w in ([recent, total] if since <= opened <= at.timestamp() else [total]):
            w["positions"] += 1
            w["contractsMilli"] += hedge_units_milli(p)
            w["hedgeNotionalCents"] += hedge_cost_cents(p)
            w["stakeCents"] += 100 * p["contracts"]
    for w in (recent, total):
        w["contracts"] = round(w["contractsMilli"] / 1000)
    return {"windowDays": FLOW_WINDOW_DAYS, "last30Days": recent, "allTime": total}


def snapshot(offline: bool) -> dict:
    saved = sorted(HERE.glob("record-*.json"))
    if offline:
        if not saved:
            sys.exit("no saved snapshot; run once online")
        return json.loads(saved[-1].read_text())
    shadow = fetch(f"{RECORD}/api/shadow")
    at = datetime.fromisoformat(shadow["at"].replace("Z", "+00:00"))
    positions = [*shadow.get("settled", []), *shadow.get("open", []), *shadow.get("closed", [])]
    flow = shadow["summary"].get("flow") or flow_from_positions(positions, at)
    snap = {"at": shadow["at"], "shadow": shadow["summary"], "flow": flow}
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
    stake_settled = sum(v["stakeCents"] for v in w["byLeague"].values())
    sports = s["segments"]["byKind"].get("sports", {})
    at = datetime.fromisoformat(snap["at"].replace("Z", "+00:00")).astimezone(timezone.utc)
    first = datetime.fromisoformat(s["firstOpenedAt"].replace("Z", "+00:00"))
    f = snap["flow"]
    take_bps = round(10_000 * ident["takeBookedCents"] / stake_settled) if stake_settled else 0
    return {
        "at": at.strftime("%Y-%m-%d %H:%M UTC"),
        "at_short": at.strftime("%b %d, %Y"),
        "since": first.strftime("%b %d, %Y"),
        "settled": settled,
        "open": s["openCount"],
        "stake_settled": usd(stake_settled, whole=True),
        "credits": usd(w["creditsPaidCents"]),
        "floor_saves": s["floorSaves"],
        "floor_pct": round(100 * s["floorSaves"] / settled) if settled else 0,
        "pnl": usd(ident["writerPnlCents"]),
        "take": usd(ident["takeBookedCents"]),
        "take_pct": f"{take_bps / 100:.2f}%",
        "gap": usd(ident["gapCents"]),
        "holds": ident["holds"],
        "cost_realized": f"{abs(s['realizedDeltaBpsOfStake']) / 100:.1f}%",
        "cost_sports": f"{abs(sports.get('holderDeltaBpsOfStake') or 0) / 100:.1f}%",
        "sports_settled": sports.get("settled", 0),
        "cost_quoted": f"{s['quotedAvgEvBps'] / 100:.1f}%",
        "flow_days": f["windowDays"],
        "flow_contracts": f"{f['last30Days']['contracts']:,}",
        "flow_usd": usd(f["last30Days"]["hedgeNotionalCents"], whole=True),
        "flow_all_contracts": f"{f['allTime']['contracts']:,}",
    }


def qr_svg(url: str) -> str:
    try:
        import segno  # type: ignore
    except ImportError:
        return ""
    q = segno.make(url, error="m")
    w, h = q.symbol_size(scale=1, border=0)
    svg = q.svg_inline(scale=1, border=0, dark=INK, light=None)
    return svg.replace("<svg ", f'<svg viewBox="0 0 {w} {h}" ', 1)


def page(n: dict, qr: str) -> str:
    assert n["holds"], "the identity does not hold on the live record; do not print a page that says it does"
    qr_block = f'<div class="qr">{qr}</div>' if qr else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Atticus · leave-behind</title>
<style>
@page{{size:Letter;margin:0}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:8.5in;height:11in;background:#fff;color:{INK};font:9.4pt/1.42 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.sheet{{position:relative;width:8.5in;height:11in;padding:.45in .55in .4in;display:flex;flex-direction:column;gap:.14in;overflow:hidden}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid {GOLD};padding-bottom:.12in}}
.top img{{height:.32in;display:block}}
.top .tag{{font-size:8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:700}}
h1{{font-size:27pt;line-height:1.05;letter-spacing:-.02em;font-weight:800}}
h1 i{{font-style:normal;color:{GREEN}}}
.lede{{margin-top:.09in;font-size:10pt;line-height:1.42;color:{MUTED};max-width:7.2in}}
.lede b{{color:{INK};font-weight:700}}
.grid{{display:grid;grid-template-columns:1fr 2.05in;gap:.28in;flex:1;min-height:0}}
h2{{font-size:8pt;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:800;margin-bottom:.08in}}
section{{margin-bottom:.15in}}
.nums{{display:grid;grid-template-columns:repeat(3,1fr);gap:.1in}}
.num{{background:{CARD};border-radius:10px;padding:.1in .11in .09in}}
.num .n{{font-size:17.5pt;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.05}}
.num .n.g{{color:{GREEN}}}
.num .l{{font-size:7.9pt;color:{FAINT};margin-top:4px;line-height:1.32}}
.ident{{margin-top:.1in;display:flex;gap:.14in;align-items:flex-start;border-left:3px solid {GOLD};padding-left:.13in}}
.ident .big{{font-size:13pt;font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.25}}
.ident .big i{{font-style:normal;color:{FAINT};font-weight:600;font-size:9pt}}
.ident p{{font-size:8.8pt;color:{MUTED};line-height:1.42}}
.ident p b{{color:{INK}}}
.tiles{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.1in}}
.tile{{border:1px solid {RULE};border-radius:10px;padding:.1in .11in}}
.tile h3{{font-size:9.4pt;font-weight:800;line-height:1.25;margin-bottom:3px}}
.tile p{{font-size:8.4pt;color:{MUTED};line-height:1.4}}
.prose{{font-size:8.8pt;color:{MUTED};line-height:1.42}}
.prose b{{color:{INK}}}
.right{{display:flex;flex-direction:column;gap:.16in}}
.phone{{border-radius:18px;border:1.5px solid #CFD3DA;overflow:hidden;background:#fff;box-shadow:0 6px 18px rgba(17,19,24,.10)}}
.phone img{{display:block;width:100%}}
.pcap{{font-size:7.6pt;color:{MUTED};line-height:1.36;margin-top:5px}}
.pcap b{{color:{INK}}}
.see{{display:grid;grid-template-columns:.95in 1fr 1fr;gap:.18in;align-items:center;border:1px solid {RULE};border-radius:10px;padding:.11in .14in}}
.see h2{{margin-bottom:2px}}
.see a{{color:{INK};text-decoration:none;border-bottom:1px solid {RULE};font-weight:700;font-size:9.4pt}}
.see p{{font-size:8.1pt;color:{MUTED};line-height:1.4;margin-top:3px}}
.qr{{width:.95in;height:.95in}}
.qr svg{{width:100%;height:100%;display:block}}
.foot{{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid {RULE};padding-top:.09in;font-size:7.9pt;color:{FAINT};line-height:1.4}}
.foot b{{color:{INK};font-weight:700}}
.foot .r{{text-align:right}}
</style></head><body><div class="sheet">

<div class="top"><img src="atticus_wordmark_gold.png" alt="Atticus"><div class="tag">Leave-behind · {n['at_short']}</div></div>

<div>
<h1>Floor. Cap. <i>Cash today.</i></h1>
<p class="lede">A user holding a position on your venue taps <b>Lock in</b>. The position now ends at a <b>floor</b> or a <b>cap</b>, and part of it is <b>paid in cash today</b>. Atticus prices it and buys the other side on a public book, leg for leg. You keep the flow, the ledger and the customer. Atticus never holds funds.</p>
</div>

<div class="grid">
<div class="left">

<section>
<h2>The numbers to carry · live since {n['since']}</h2>
<div class="nums">
  <div class="num"><div class="n">{n['settled']:,}</div><div class="l">positions settled on official results</div></div>
  <div class="num"><div class="n g">{n['gap']}</div><div class="l">gap between our P&amp;L and the published take</div></div>
  <div class="num"><div class="n">{n['floor_pct']}%</div><div class="l">floor saves: {n['floor_saves']} users finished above the unprotected outcome</div></div>
  <div class="num"><div class="n g">{n['credits']}</div><div class="l">paid to users at the tap, on {n['stake_settled']} of stake</div></div>
  <div class="num"><div class="n">{n['cost_sports']}</div><div class="l">realized cost of protection on {n['sports_settled']} settled games ({n['cost_realized']} with crypto strikes)</div></div>
  <div class="num"><div class="n">{n['flow_contracts']}</div><div class="l">contracts put on public books in the last {n['flow_days']} days, {n['flow_usd']} of flow</div></div>
</div>
<div class="ident"><div class="big">{n['pnl']} <i>our P&amp;L</i><br>{n['take']} <i>take booked</i></div><p><b>Same number, to the cent, on all {n['settled']:,} settled positions.</b> We earn the published take ({n['take_pct']} of stake) and nothing on the result: the hedge pays the floor, the cap slice pays the hedge, and nothing depends on who won. Every row is public, in integer cents, with the quote and the settlement beside it.</p></div>
</section>

<section>
<h2>Why a venue adds the button</h2>
<div class="tiles">
  <div class="tile"><h3>A third choice beside hold and cash out</h3><p>Cash out sells the whole position at the spread. The lock keeps it: a floor, upside to a cap, cash today.</p></div>
  <div class="tile"><h3>Revenue with no outcome risk</h3><p>A published take on every protected position, shared with you. Our P&amp;L equals that take whoever wins.</p></div>
  <div class="tile"><h3>Integration in days</h3><p>One JSON quote in, one receipt out. Your brand, your ledger, your official result. Nothing custodial.</p></div>
</div>
</section>

<section>
<h2>Parlays</h2>
<p class="prose">A parlay is a long shot when bought; no honest floor can be priced on it. Once every pick but one has hit it is a position on <b>one game at one game's odds</b>, which is what the layer prices. So the lock appears at the last pick and nowhere before, and the record shows lock against sell against hold on every ticket that got there.</p>
</section>

</div>
<div class="right">

<div><div class="phone"><img src="phone_sheet.png" alt="Positions list with the Lock in sheet open"></div><p class="pcap"><b>Their shell, our sheet.</b> Two endings and the cash paid now, priced live, locked at the tap. The venue name is a placeholder.</p></div>

</div>
</div>

<div class="see">
{qr_block}
<div class="col"><h2>Record</h2><a href="{RECORD}/">{RECORD.replace('https://','')}</a><p>Every number on this page, live. Identity card at the top; CSV at /api/shadow/positions.csv, one row per position in integer cents.</p></div>
<div class="col"><h2>Demo</h2><a href="{DEMO}/">{DEMO.replace('https://','')}</a><p>Tap Lock in on any row. Add ?tab=parlays for the parlays. The venue name is a placeholder; your brand goes there.</p></div>
</div>

<div class="foot">
<div><b>Michael William</b>, founder · {CONTACT}<br>Same engine on Bitcoin perpetuals, public record since July 2026.</div>
<div class="r">Numbers as of {n['at']}.<br>Positions are simulated at live prices against official results; nothing is bought.</div>
</div>

</div></body></html>
"""


def phone(n: dict, qr: str) -> str:
    """One 1080x1920 image to send from a phone: the pitch, six numbers, the QR, both URLs."""
    qr_block = f'<div class="qr">{qr}</div>' if qr else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Atticus · leave-behind, phone</title><style>
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:540px;height:960px;background:#fff;color:{INK};font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}}
.wrap{{width:540px;height:960px;padding:40px 36px 30px;display:flex;flex-direction:column;gap:22px}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid {GOLD};padding-bottom:14px}}
.top img{{height:30px;display:block}}
.top .tag{{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:{FAINT};font-weight:700}}
h1{{font-size:44px;line-height:1.02;letter-spacing:-.02em;font-weight:800}}
h1 i{{font-style:normal;color:{GREEN}}}
.lede{{margin-top:12px;font-size:16px;line-height:1.42;color:{MUTED}}}
.lede b{{color:{INK}}}
.nums{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.num{{background:{CARD};border-radius:14px;padding:14px 16px 12px}}
.num .n{{font-size:30px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.05}}
.num .n.g{{color:{GREEN}}}
.num .l{{font-size:12px;color:{FAINT};margin-top:5px;line-height:1.3}}
.ident{{border-left:4px solid {GOLD};padding-left:14px;font-size:14px;color:{MUTED};line-height:1.42}}
.ident b{{color:{INK}}}
.see{{display:flex;gap:18px;align-items:center;border:1px solid {RULE};border-radius:14px;padding:14px 16px}}
.qr{{width:120px;height:120px;flex:none}}
.qr svg{{width:100%;height:100%;display:block}}
.see .t{{font-size:13px;color:{MUTED};line-height:1.45}}
.see .t b{{color:{INK};display:block;font-size:14px}}
.foot{{margin-top:auto;font-size:12px;color:{FAINT};line-height:1.4;border-top:1px solid {RULE};padding-top:12px}}
.foot b{{color:{INK}}}
</style></head><body><div class="wrap">
<div class="top"><img src="atticus_wordmark_gold.png" alt="Atticus"><div class="tag">{n['at_short']}</div></div>
<div><h1>Floor. Cap.<br><i>Cash today.</i></h1>
<p class="lede">One tap inside your app. The position ends at a <b>floor</b> or a <b>cap</b>, part of it <b>paid today</b>. We buy the other side on a public book, leg for leg. You keep the flow, the ledger and the customer.</p></div>
<div class="nums">
  <div class="num"><div class="n">{n['settled']:,}</div><div class="l">positions settled on official results since {n['since']}</div></div>
  <div class="num"><div class="n g">{n['gap']}</div><div class="l">gap between our P&amp;L and the published take</div></div>
  <div class="num"><div class="n">{n['floor_pct']}%</div><div class="l">floor saves: user finished above the unprotected outcome</div></div>
  <div class="num"><div class="n g">{n['credits']}</div><div class="l">paid to users at the tap</div></div>
  <div class="num"><div class="n">{n['cost_sports']}</div><div class="l">realized cost of protection on settled games</div></div>
  <div class="num"><div class="n">{n['flow_contracts']}</div><div class="l">contracts put on public books, last {n['flow_days']} days</div></div>
</div>
<div class="ident"><b>{n['pnl']} our P&amp;L, {n['take']} take booked.</b> Same number on every settled position: we earn the published take and nothing on the result.</div>
<div class="see">{qr_block}<div class="t"><b>{RECORD.replace('https://','')}</b>the live record, every number above<br><b>{DEMO.replace('https://','')}</b>the demo, tap Lock in on any row</div></div>
<div class="foot"><b>Michael William</b> · {CONTACT}<br>Positions are simulated at live prices against official results; nothing is bought. As of {n['at']}.</div>
</div></body></html>
"""


def run_chrome(args: list[str]) -> None:
    proc = subprocess.Popen(
        [chrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--user-data-dir=/tmp/chrome-leavebehind", *args],
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


FORBIDDEN = ("\u2014", "wallet", "polymarket", "kalshi", "dealer", "netting", "roadmap", "rfq", "foxify")


def check(html: str, what: str) -> None:
    low = html.lower()
    for word in FORBIDDEN:
        assert word not in low, f"{what}: '{word}' must not appear on a prospect page"


def main() -> None:
    offline = "--offline" in sys.argv
    snap = snapshot(offline)
    n = numbers(snap)
    qr = qr_svg(f"{RECORD}/")
    if not qr:
        print("segno not installed: pages carry the URL in text and no QR (pip install segno)")

    html = page(n, qr)
    check(html, "leave-behind")
    (HERE / "atticus_leavebehind.html").write_text(html)
    out = HERE / "atticus_leavebehind.pdf"
    out.unlink(missing_ok=True)
    run_chrome(["--no-pdf-header-footer", f"--print-to-pdf={out}", f"file://{HERE / 'atticus_leavebehind.html'}"])
    if not out.exists():
        sys.exit("Chrome wrote no PDF")
    print("wrote", out, "as of", n["at"])

    ph = phone(n, qr)
    check(ph, "phone image")
    (HERE / "atticus_leavebehind_phone.html").write_text(ph)
    png = HERE / "atticus_leavebehind_phone.png"
    png.unlink(missing_ok=True)
    run_chrome(["--window-size=540,960", "--force-device-scale-factor=2", "--hide-scrollbars", f"--screenshot={png}", f"file://{HERE / 'atticus_leavebehind_phone.html'}"])
    if not png.exists():
        sys.exit("Chrome wrote no phone image")
    print("wrote", png)


if __name__ == "__main__":
    main()
