#!/usr/bin/env python3
"""One-page Atticus → Bullish execution brief. Letter. No Chrome."""
from pathlib import Path
from fpdf import FPDF

OUT = Path("/workspace/docs/gtm/Atticus_Bullish_Execution_Brief.pdf")

W = 215.9
H = 279.4
ML, MR, MT, MB = 11.0, 11.0, 9.0, 8.0
CW = W - ML - MR


class Brief(FPDF):
    def __init__(self):
        super().__init__(format=(W, H), unit="mm")
        self.set_auto_page_break(False)
        self.set_margins(ML, MT, MR)

    def rule(self, y=None):
        y = self.get_y() if y is None else y
        self.set_draw_color(17, 17, 17)
        self.set_line_width(0.35)
        self.line(ML, y, ML + CW - 0.2, y)

    def section(self, title):
        self.ln(2.2)
        self.set_font("Helvetica", "B", 8)
        self.set_text_color(17, 17, 17)
        self.cell(CW, 4.4, title.upper(), ln=1)
        self.rule()
        self.ln(1.2)

    def body(self, text, size=8.3, leading=3.7, style=""):
        self.set_font("Helvetica", style, size)
        self.set_text_color(17, 17, 17)
        self.multi_cell(CW, leading, text)

    def table(self, rows, col_w, aligns=None, header=False, sizes=None):
        aligns = aligns or ["L"] * len(col_w)
        sizes = sizes or [7.5] * len(col_w)
        row_h = 4.45
        self.set_draw_color(210, 210, 210)
        self.set_line_width(0.18)
        self.set_text_color(17, 17, 17)
        for r_i, row in enumerate(rows):
            is_head = header and r_i == 0
            if is_head:
                self.set_fill_color(242, 242, 242)
            y0 = self.get_y()
            x0 = ML
            for i, cell in enumerate(row):
                self.set_xy(x0, y0)
                self.set_font("Helvetica", "B" if is_head else "", sizes[i])
                self.cell(
                    col_w[i],
                    row_h,
                    str(cell),
                    border="B",
                    align=aligns[i],
                    fill=is_head,
                )
                x0 += col_w[i]
            self.set_y(y0 + row_h)


def build():
    pdf = Brief()
    pdf.add_page()
    pdf.set_text_color(17, 17, 17)

    # Title
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(CW, 7.4, "Atticus  ->  Bullish", ln=1)
    pdf.set_font("Helvetica", "", 7.6)
    pdf.set_text_color(40, 40, 40)
    pdf.multi_cell(
        CW,
        3.3,
        "Execution brief  |  13 Aug 2026  |  BD + market makers  |  Michael William  |  michael@atticustrade.com\n"
        "Live tape:  facility.atticustrade.com/onesheet",
    )

    # Lead bar
    pdf.ln(1.6)
    y = pdf.get_y()
    pdf.set_fill_color(17, 17, 17)
    pdf.rect(ML, y, CW, 13.6, "F")
    pdf.set_xy(ML + 2.5, y + 1.4)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 9.2)
    pdf.cell(CW - 5, 4.2, "OKX fee on this book:  $523 on $3.45M  =  1.52 bps", ln=1)
    pdf.set_x(ML + 2.5)
    pdf.set_font("Helvetica", "", 7.5)
    pdf.multi_cell(
        CW - 5,
        3.3,
        "Regular options tier, on-screen.  Institutional KYB.  No IM posted.  No VIP.  "
        "Live path: RFQ + portfolio margin.  First live flow is uncommitted.",
    )
    pdf.set_y(y + 14.2)
    pdf.set_text_color(17, 17, 17)

    # Tape
    pdf.section("Tape  ·  24 days through 13 Aug")
    pdf.set_font("Helvetica", "", 7.5)
    pdf.multi_cell(
        CW,
        3.2,
        "Real venue options prices. Client settlement is paper. 1 live principal leg; paper stand-ins disclosed. "
        "Neutral pairs only since 5 Aug. Directional overlay retired.",
    )
    pdf.ln(0.6)
    c0, c1, c2 = 68, (CW - 68) / 2, (CW - 68) / 2
    tape = [
        ["", "Full window", "Product book (since 5 Aug)"],
        ["Days", "24", "8"],
        ["Settled", "69 names", "26 names"],
        ["Notional", "$3,450,000", "$1,300,000"],
        ["Avg hold", "24.13h", "~24h"],
        ["Structure net", "$2,544", "$1,033"],
        ["Credit / givebacks", "$2,976 / $432", "-"],
        ["Client all-in", "9.33 bps  |  79% days +", "-"],
        ["Floor / cap", "0.0%  /  2.9%", "0 / 0"],
        ["Halts / manual", "0 / 0", "0 / 0"],
        ["Integrity", "100% signed + reconciled", "same"],
        ["Option fees accrued", "$523  ·  1.52 bps", "in full window"],
        ["Net after fees + capital (0 ops fee)", "-$12.42  ·  -0.036 bps", "pass-through"],
    ]
    pdf.table(tape, [c0, c1, c2], ["L", "R", "R"], header=True, sizes=[7.5, 7.5, 7.5])
    pdf.ln(0.8)
    pdf.set_font("Helvetica", "", 7.4)
    pdf.multi_cell(CW, 3.2, "Quoted credit 10-16 bps/day at smallest tier. Realized 9.33 bps. Scale improves this.")

    # Flow
    pdf.section("Flow for MMs")
    pdf.set_font("Helvetica", "", 7.6)
    pdf.multi_cell(
        CW,
        3.3,
        "Two-sided 24h BTC collar: buy the floor, sell the cap. Uninformed, mechanical, ~1 DTE, rolled daily. "
        "Not a directional book. No self-match - pair spans two perp venues. You price and fill the hedge.",
    )
    pdf.ln(0.5)
    flow = [
        ["Typical name", "$25k-$100k notional"],
        ["Execution now", "On-screen / CLOB (shadow)"],
        ["Live", "RFQ / block first, sanity-check vs screen, portfolio margin"],
        ["Unwind", "Reduce-only IOC + RFQ / block"],
        ["Breaks a fill", "No 1-DTE strike past ~4-5% of spot; thin wings; RFQ timeout"],
    ]
    pdf.table(flow, [42, CW - 42], ["L", "L"], header=False, sizes=[7.5, 7.5])

    # Fees
    pdf.section("OKX fees  ·  the number you asked for")
    pdf.set_font("Helvetica", "", 7.5)
    pdf.multi_cell(
        CW,
        3.25,
        "Accrued at Regular on-screen on real books. Not cash - no IM posted, shadow does not bill. "
        "Benchmark: worst published OKX options tier, before RFQ or VIP.  "
        "fee = min(rate x notional, 7% x premium).  Regular = 3.0 bps maker / 3.0 bps taker, 7% premium cap.  "
        "Headline 3.0 bps; we realized 1.52 bps across both legs (~0.76 bps/leg, ~$7.58/name) because the cap binds "
        "on cheap 1-DTE premium. After fees and capital, structure is flat at zero ops fee - no pad. "
        "OKX combo/RFQ can cut fees up to 50%; unused. First live orders are RFQ.",
    )
    pdf.ln(1.0)
    pdf.set_font("Helvetica", "B", 7.5)
    pdf.cell(CW, 3.3, "$100k name, 12 bps premium = $120", ln=1)
    fee = [
        ["", "Math", "Fee", "Effective"],
        ["OKX Regular (us)", "min(3.0 bps x $100k, 7% x $120)", "$8.40", "0.84 bps/leg"],
        ["OKX VIP 5 taker", "same cap still binds", "$8.40", "0.84 bps/leg"],
        ["Bullish CLOB published", "min(1 bp notional, 10% of premium)", "$10", "1.0 bp/leg"],
    ]
    w = [48, CW - 48 - 28 - 32, 28, 32]
    pdf.table(fee, w, ["L", "L", "R", "R"], header=True, sizes=[7.4, 7.3, 7.4, 7.4])
    pdf.ln(0.8)
    pdf.set_font("Helvetica", "", 7.5)
    pdf.multi_cell(
        CW,
        3.25,
        "Published CLOB taker does not beat this once the cap binds. Bullish wins on spread + RFQ/block + rebate "
        "+ MM quotes on this 1-DTE collar + PM, vs 1.52 bps all-in and current on-screen fills.",
    )

    # Next
    pdf.section("Next")
    pdf.set_font("Helvetica", "", 7.6)
    pdf.multi_cell(
        CW,
        3.3,
        "Not a second live shadow. On request, 5 business days: quote overlay of last ~25 tape collars vs Bullish "
        "mainnet (CLOB + RFQ). Table: fillable Y/N, strike, all-in vs OKX, size that walks. No SimNext.",
    )
    pdf.ln(0.6)
    asks = [
        "1.  Rebate / maker terms - CLOB and RFQ/block",
        "2.  Intro to the MM you want to show this",
        "3.  1-DTE BTC: CLOB vs RFQ, USD vs USDC, strike grid and top-of-book around +/-2% / +/-5% / +/-10%",
        "4.  Onboarding: entity, min size, time-to-live, PM on a long-floor / short-cap 1-DTE pair",
    ]
    for a in asks:
        pdf.set_font("Helvetica", "", 7.6)
        pdf.cell(CW, 3.5, a, ln=1)

    pdf.ln(1.6)
    pdf.rule()
    pdf.ln(1.2)
    pdf.set_font("Helvetica", "B", 7.6)
    pdf.multi_cell(
        CW,
        3.3,
        "Live routing follows terms. We can sit with your MM on this sheet as soon as you set it.",
    )
    pdf.set_font("Helvetica", "", 7.3)
    pdf.cell(CW, 3.3, "Tape (updates every cycle):  facility.atticustrade.com/onesheet", ln=1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(OUT))
    print(f"wrote {OUT}  pages={pdf.page_no()}  bytes={OUT.stat().st_size}")


if __name__ == "__main__":
    build()
