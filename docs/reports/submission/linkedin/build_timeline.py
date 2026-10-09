"""
Three markets, same three steps: the LinkedIn infographic.

One data model, two layouts (landscape for desktop feeds, portrait for the
phone), emitted as static HTML and screenshotted with headless Chrome at 2x.
Every date and name on the graphic has a source in POST.md; change the data
here, rerun, and re-check the sources before posting.

    python3 docs/reports/submission/linkedin/build_timeline.py

Rules: no em dash anywhere; a filled dot is something that happened, a gold
ring is arriving, a gold diamond is us.
"""

from __future__ import annotations

import html
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

GOLD = "#C9A227"
GOLD_INK = "#9A7A14"
INK = "#111318"
MUTED = "#4B5058"
FAINT = "#6E747D"
RULE = "#D8DBE0"
BG = "#FBFAF7"

TITLE = "Every market takes the same three steps, in the same order."
SUBTITLE = (
    "A venue, then institutional derivatives, then protection for the retail holder. "
    "The gap between the last two shrinks every cycle: 44 years, 9 years, the same year."
)
HEADERS = ["THE VENUE", "INSTITUTIONS ARRIVE", "RETAIL PROTECTION"]

ROWS = [
    {
        "name": "Equities",
        "steps": [
            {"year": "1792", "sub": "NYSE"},
            {"year": "1973", "sub": "CBOE listed options; S&P 500 futures 1982"},
            {"year": "2017", "sub": "Robinhood options; brokers drop commissions 2019", "kind": "done"},
        ],
        "gaps": ["181 yrs", "44 yrs"],
        "diamonds": [],
    },
    {
        "name": "Crypto",
        "steps": [
            {"year": "2009", "sub": "Bitcoin"},
            {"year": "2017", "sub": "CME bitcoin futures; Deribit options 2016"},
            {
                "year": "2026",
                "sub": "Kraken launches simplified dollar options, July 2026: \u201cThe gap in crypto options isn\u2019t demand, it\u2019s design.\u201d",
                "kind": "arriving",
            },
        ],
        "gaps": ["8 yrs", "9 yrs"],
        "diamonds": [
            {"seg": 1, "t": 0.67, "text": "2023  Atticus pitching retail options. Consensus then: options will never be retail."},
        ],
    },
    {
        "name": "Prediction markets",
        "steps": [
            {"year": "2020", "sub": "Polymarket; Kalshi 2021"},
            {
                "year": "2024\u201326",
                "sub": "SIG, first institutional market maker on Kalshi, 2024. In 2026: Kalshi block trades, Cantor and DRW desks, ProphetX clears, a $3M LSU coaching bonus hedged on Kalshi.",
            },
            {
                "year": "now",
                "sub": "Atticus: built. One tap, floor + credit, priced and hedged leg for leg in shadow. Every quote public since Sept 2026.",
                "kind": "now",
            },
        ],
        "gaps": ["4 yrs", "same year"],
        "diamonds": [
            {"seg": 1, "t": 0.76, "text": "Late 2025  Atticus pitching retail protection to event venues, before the institutional step had formed."},
        ],
    },
]

LEGEND = [("dot", "happened"), ("ring", "arriving"), ("diamond", "Atticus")]
FOOT_LEFT = "ATTICUS"
FOOT_RIGHT = "Dates, sources, demo and public record: first comment."


def esc(s: str) -> str:
    return html.escape(s, quote=False)


def css(scale: float, w: int, h: int) -> str:
    s = scale
    return f"""
*{{box-sizing:border-box}}
html,body{{margin:0;padding:0}}
body{{width:{w}px;height:{h}px;background:{BG};color:{INK};font-family:Inter,"Helvetica Neue",Helvetica,Arial,sans-serif;overflow:hidden}}
.abs{{position:absolute}}
.title{{font-size:{26*s:.1f}px;font-weight:700;letter-spacing:-.2px;line-height:1.2}}
.subtitle{{font-size:{14*s:.1f}px;color:{MUTED};line-height:1.4}}
.hdr{{font-size:{11.5*s:.1f}px;font-weight:600;letter-spacing:{1.6*s:.1f}px;color:{FAINT};text-transform:uppercase;white-space:nowrap}}
.hrule{{height:1px;background:{RULE}}}
.rowname{{font-size:{19*s:.1f}px;font-weight:700;line-height:1.15}}
.line{{height:{2.5*s:.1f}px;background:{INK};border-radius:2px}}
.dash{{height:0;border-top:{2.5*s:.1f}px dashed {GOLD}}}
.dot{{width:{15*s:.1f}px;height:{15*s:.1f}px;border-radius:50%;background:{INK}}}
.ring{{width:{17*s:.1f}px;height:{17*s:.1f}px;border-radius:50%;background:{BG};border:{3*s:.1f}px solid {GOLD}}}
.ring.now{{width:{21*s:.1f}px;height:{21*s:.1f}px;box-shadow:0 0 0 {4*s:.1f}px rgba(201,162,39,.22)}}
.diamond{{width:{15*s:.1f}px;height:{15*s:.1f}px;background:{GOLD};transform:rotate(45deg);border-radius:2px}}
.year{{font-size:{18*s:.1f}px;font-weight:700;white-space:nowrap;line-height:1}}
.year.gold{{color:{GOLD_INK}}}
.gap{{font-size:{12.5*s:.1f}px;color:{MUTED};white-space:nowrap;line-height:1}}
.gap.gold{{color:{GOLD_INK};font-weight:600}}
.sub{{font-size:{12*s:.1f}px;color:{FAINT};line-height:1.4}}
.sub.gold{{color:{GOLD_INK}}}
.callout{{font-size:{12*s:.1f}px;font-weight:600;color:{GOLD_INK};line-height:1.35}}
.vline{{width:{1.5*s:.1f}px;background:{GOLD}}}
.foot{{font-size:{11.5*s:.1f}px;color:{FAINT};white-space:nowrap}}
.wordmark{{font-size:{13*s:.1f}px;font-weight:800;letter-spacing:{3*s:.1f}px;color:{INK}}}
.legend{{display:flex;gap:{18*s:.1f}px;align-items:center;font-size:{11.5*s:.1f}px;color:{FAINT};white-space:nowrap}}
.legend span{{display:inline-flex;align-items:center;gap:{6*s:.1f}px}}
.legend .dot,.legend .ring,.legend .diamond{{position:static;display:inline-block}}
.legend .dot{{width:{10*s:.1f}px;height:{10*s:.1f}px}}
.legend .ring{{width:{11*s:.1f}px;height:{11*s:.1f}px;border-width:{2.5*s:.1f}px}}
.legend .diamond{{width:{9*s:.1f}px;height:{9*s:.1f}px;margin:0 {3*s:.1f}px}}
"""


def box(cls: str, x: float, y: float, w: float | None = None, content: str = "", extra: str = "") -> str:
    style = f"left:{x:.1f}px;top:{y:.1f}px;" + (f"width:{w:.1f}px;" if w is not None else "") + extra
    return f'<div class="abs {cls}" style="{style}">{content}</div>\n'


def centered(cls: str, cx: float, y: float, w: float, content: str, align: str = "center") -> str:
    if align == "center":
        return box(cls, cx - w / 2, y, w, content, "text-align:center;")
    if align == "left":
        return box(cls, cx - 8, y, w, content, "text-align:left;")
    return box(cls, cx - w + 8, y, w, content, "text-align:right;")


def marker(kind: str, cx: float, cy: float, s: float) -> str:
    if kind == "now":
        d = 21 * s
        return box("ring now", cx - d / 2, cy - d / 2)
    if kind == "arriving":
        d = 17 * s
        return box("ring", cx - d / 2, cy - d / 2)
    d = 15 * s
    return box("dot", cx - d / 2, cy - d / 2)


def render(
    w: int,
    h: int,
    s: float,
    xs: list[float],
    row_ys: list[float],
    title_y: float,
    subtitle_y: float,
    hdr_y: float,
    foot_y: float,
    portrait: bool,
    name_x: float,
    sub_ws: list[float],
    callout_w: float,
) -> str:
    out = []
    out.append(box("title", name_x, title_y, w - 2 * name_x, esc(TITLE)))
    out.append(box("subtitle", name_x, subtitle_y, w - 2 * name_x, esc(SUBTITLE)))

    aligns = ["left", "center", "right"]
    for i, hdr in enumerate(HEADERS):
        out.append(centered("hdr", xs[i], hdr_y, sub_ws[i], esc(hdr), aligns[i]))
    out.append(box("hrule", xs[0] - 8, hdr_y + 22 * s, xs[2] - xs[0] + 16))

    for r, row in enumerate(ROWS):
        ly = row_ys[r]
        last_kind = row["steps"][2].get("kind", "done")
        if portrait:
            out.append(box("rowname", name_x, ly - 92 * s, 600 * s, esc(row["name"])))
        else:
            out.append(box("rowname", name_x, ly - 12 * s, xs[0] - name_x - 30, esc(row["name"])))

        # segments
        out.append(box("line", xs[0], ly - 1.25 * s, xs[1] - xs[0]))
        if last_kind == "now":
            out.append(box("dash", xs[1], ly - 1.25 * s, xs[2] - xs[1]))
        else:
            out.append(box("line", xs[1], ly - 1.25 * s, xs[2] - xs[1]))

        # gap labels
        for g, gap in enumerate(row["gaps"]):
            mx = (xs[g] + xs[g + 1]) / 2
            gold = " gold" if (g == 1 and last_kind == "now") else ""
            out.append(centered("gap" + gold, mx, ly - 30 * s, 160 * s, esc(gap)))

        # diamonds and callouts
        for d in row["diamonds"]:
            x0, x1 = xs[d["seg"]], xs[d["seg"] + 1]
            cx = x0 + d["t"] * (x1 - x0)
            dd = 15 * s
            out.append(box("diamond", cx - dd / 2, ly - dd / 2))
            out.append(box("vline", cx - 0.75 * s, ly - 62 * s, None, "", f"height:{50*s:.1f}px;"))
            out.append(centered("callout", cx, ly - 102 * s, callout_w, esc(d["text"])))

        # markers, years, subs
        for i, st in enumerate(row["steps"]):
            kind = st.get("kind", "done")
            out.append(marker(kind, xs[i], ly, s))
            gold = " gold" if kind in ("now", "arriving") else ""
            out.append(centered("year" + gold, xs[i], ly - 46 * s, 200 * s, esc(st["year"])))
            out.append(centered("sub" + gold, xs[i], ly + 18 * s, sub_ws[i], esc(st["sub"]), aligns[i]))

    # footer
    out.append(box("wordmark", name_x, foot_y, 300 * s, FOOT_LEFT))
    legend = "".join(f'<span><i class="{k}"></i>{esc(t)}</span>' for k, t in LEGEND)
    if portrait:
        out.append(box("legend", w - name_x - 330 * s, foot_y - 2 * s, 330 * s, legend, "justify-content:flex-end;"))
        out.append(box("foot", w - name_x - 560 * s, foot_y - 26 * s, 560 * s, esc(FOOT_RIGHT), "text-align:right;"))
    else:
        out.append(box("legend", name_x + 150 * s, foot_y - 2 * s, None, legend))
        out.append(box("foot", w - name_x - 560 * s, foot_y, 560 * s, esc(FOOT_RIGHT), "text-align:right;"))

    body = "".join(out)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>{esc(TITLE)}</title>
<style>{css(s, w, h)}</style></head>
<body>{body}</body></html>"""
    if "\u2014" in doc:
        raise SystemExit("em dash in copy")
    return doc


def landscape() -> tuple[str, int, int]:
    w, h, s = 1200, 700, 1.0
    xs = [214.0, 680.0, 1146.0]
    return render(w, h, s, xs, [232.0, 398.0, 572.0], 40.0, 76.0, 128.0, 678.0, False, 40.0, [290.0, 290.0, 318.0], 330.0), w, h


def portrait() -> tuple[str, int, int]:
    w, h, s = 1080, 1350, 1.3
    xs = [110.0, 540.0, 970.0]
    return render(w, h, s, xs, [455.0, 780.0, 1105.0], 56.0, 150.0, 262.0, 1300.0, True, 56.0, [240.0, 270.0, 260.0], 300.0), w, h


def screenshot(html_path: Path, png_path: Path, w: int, h: int) -> None:
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    if not chrome:
        print(f"no chrome found; open {html_path} and screenshot at {w}x{h}", file=sys.stderr)
        return
    cmd = [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--user-data-dir=/tmp/chrome-linkedin-profile",
        f"--window-size={w},{h}",
        "--force-device-scale-factor=2",
        f"--screenshot={png_path}",
        f"file://{html_path}",
    ]
    # Headless Chrome writes the file within seconds and then may hang on exit;
    # wait for the file, give it a moment to flush, and stop the process.
    png_path.unlink(missing_ok=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 120
    while time.time() < deadline and not png_path.exists() and proc.poll() is None:
        time.sleep(0.5)
    time.sleep(2)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    print(f"{png_path} ({'written' if png_path.exists() else 'MISSING'})")


def main() -> None:
    for name, fn in (("timeline_landscape", landscape), ("timeline_portrait", portrait)):
        doc, w, h = fn()
        html_path = HERE / f"{name}.html"
        html_path.write_text(doc, encoding="utf-8")
        screenshot(html_path, HERE / f"{name}.png", w, h)


if __name__ == "__main__":
    main()
