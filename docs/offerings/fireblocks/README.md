# Atticus × Fireblocks — Partnership Brief

Pitch collateral for the embedded, non-custodial downside-protection partnership.

## Files

| File | Use |
|---|---|
| `atticus-fireblocks-slide.pdf` | 16:9 slide version (present / screen-share) |
| `atticus-fireblocks.pdf` | A4 portrait one-pager (email / print) |
| `atticus-fireblocks-slide.html` | Editable source for the slide |
| `atticus-fireblocks.html` | Editable source for the one-pager |
| `atticus-fireblocks-slide-preview.png` | Slide preview image |
| `atticus-fireblocks-preview.png` | One-pager preview image |

## Before sending

- **Premiums are indicative estimates** from a Deribit snapshot (dated in the header). The live engine
  shops OKX · Deribit · Bullish and typically fills at or below these — pull fresh quotes and re-date
  the "Live snapshot" line before distribution.
- **Rev-share** is a volume-tiered escalator on **net revenue** (premium − hedge cost):
  Launch 60/40 → Growth 50/50 → Scale 40/60 (Atticus/Fireblocks). Tiers and percentages are negotiable.

## Re-rendering PDFs from HTML

```bash
google-chrome --headless=new --disable-gpu --no-sandbox \
  --print-to-pdf=atticus-fireblocks-slide.pdf --no-pdf-header-footer \
  atticus-fireblocks-slide.html
```
