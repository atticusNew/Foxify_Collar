# LinkedIn: three markets, same three steps

What to post, what to put in the first comment, and the five checks before posting. Both images are rebuilt from `build_timeline.py`; every date and name on them has a source below.

## Files

| File | What it is |
|---|---|
| `timeline_portrait.png` | 2160x2700 (4:5). Post this one first; LinkedIn is mostly read on phones and 4:5 takes the most screen. |
| `timeline_landscape.png` | 2400x1400. Second image in the same post, for desktop readers. |
| `timeline_*.html` | The rendered sources. Open in a browser to proofread at any size. |
| `build_timeline.py` | Data and layout. Change a date or a label there, run it, and both PNGs regenerate (headless Chrome, isolated profile). |

Rebuild from the repo root:

```
python3 docs/reports/submission/linkedin/build_timeline.py
```

## Before posting

1. Open `https://atticus-event-shadow.onrender.com/` and read the numbers off the top of the page (events settled, floor saves, our P&L, take booked, gap). The post text below uses the 2026-10-09 17:35 UTC numbers; replace them with the morning's. The graphic has no count on it on purpose, so it does not go stale.
2. The record page must still say "Live prices; nothing is bought." The graphic says "in shadow"; the two must agree.
3. Open the demo `https://atticus-event-demo-cross-venue.onrender.com/` in a private window. No brand parameter, no slate key: this is the public link, and it must show the generic shell, never a partner's name.
4. Confirm the two dates only you can confirm: that you were pitching retail options in 2023 and event protection in late 2025. The investor emails in the outreach playbook say "eighteen months ago we started building" (from August 2026, so early 2025). Pitching in 2023 and building from 2025 are compatible; be ready to say so in one sentence if asked.
5. Put the links in the first comment, not the post body. Links in the body suppress reach. Do not name WagerWire or any listing anywhere; the email to Zach goes the same day.

## The post

> Every market takes the same three steps in the same order: a venue, then institutional derivatives, then protection for the person holding the position. The gap between the second step and the third shrinks every cycle. Equities took 44 years. Crypto took 9. In prediction markets it is happening the same year.
>
> We pitched the crypto retail step in 2023, when the consensus was that options would never be retail. We pitched the event retail step in late 2025, before the institutional step had formed. Both arrived on schedule.
>
> So we built the third step for event markets: one tap on a position, a floor and a credit, hedged leg for leg on the venue that lists the other side. It runs in shadow on live prices, and every quote has been public since September 12. As of this morning: 695 events settled, 297 floor saves, and our P&L equals the take we booked to the cent, because the hedge carries no outcome risk.
>
> Dates, sources, the demo and the public record are in the first comment.

Three paragraphs and a pointer; no hashtags in the body. If you want hashtags, put three in the first comment after the links.

## The first comment

> Sources for the graphic, newest first.
>
> Kraken simplified dollar options, July 2026, and the quote "The gap in crypto options isn't demand, it's design": https://www.coindesk.com/business/2026/07/19/kraken-says-simpler-options-can-unlock-crypto-s-next-derivatives-market
>
> Cantor block trading in event contracts on Kalshi, with Susquehanna pricing, August 2026: https://www.cantor.com/cantor-commences-institutional-block-trading-in-prediction-markets/
>
> A $3M LSU coaching bonus hedged in five Kalshi block trades, August 2026: https://www.cbssports.com/college-football/news/insurance-company-placed-kalshi-trades-worth-up-to-3-million-on-lsus-season-matching-lane-kiffins-bonus/
>
> ProphetX registered as a derivatives clearing organization, June 10, 2026: https://www.cftc.gov/IndustryOversight/IndustryFilings/ClearingOrganizations/59187
>
> DRW's prediction-markets desk, June 2026: https://www.coindesk.com/business/2026/06/06/a-massive-hiring-wave-reveals-trading-firms-are-no-longer-viewing-polymarket-as-a-niche-betting-tool
>
> Susquehanna, first institutional market maker on Kalshi, April 2024: https://www.businesswire.com/news/home/20240403664852/en/Kalshi-Onboards-Its-First-Dedicated-Institutional-Market-Maker
>
> The older dates are the standard ones: NYSE 1792, CBOE 1973, S&P 500 futures 1982, Robinhood options December 2017, brokers to zero commission October 2019, Bitcoin 2009, Deribit 2016, CME bitcoin futures December 2017, Polymarket 2020, Kalshi 2021.
>
> The public record, every quote since September 12, simulated at live prices with nothing bought: https://atticus-event-shadow.onrender.com/
>
> The demo, on live prices: https://atticus-event-demo-cross-venue.onrender.com/

## What changed from the first draft, and why

- "hedged leg for leg. Public record since Sept 2026" became "priced and hedged leg for leg in shadow. Every quote public since Sept 2026." The record page says simulated, nothing bought; the graphic now says the same thing. That one verb was the only claim a click could falsify.
- The crypto 2026 marker was a filled dot like NYSE 1792. It is now a gold ring, "arriving," and it names the event: Kraken's July 2026 launch and the quote. Kraken opened to professional clients by RFQ; the retail thesis is theirs and stated, the retail product is not yet in a retail hand, so a ring is the honest shape.
- Polymarket is 2020, not 2021. Deribit is 2016, not 2017. Robinhood was zero-commission from day one; the 2019 event is the brokers. All three fixed.
- The prediction-markets institutional step is dated 2024 to 2026, with SIG in 2024 and the 2026 items named. "LSU hedge" now says what it was: a $3M coaching bonus hedged in Kalshi blocks, which is the best single data point on the graphic for "institutions hedge on these venues."
- "Consensus: retail options don't work" became "Consensus then: options will never be retail." Same fact, no told-you-so, matching the outreach playbook's language.
- The two-sentence caption moved from the image into the post, where it is readable on a phone and counts as text for the feed.
- A wordmark and a legend were added. The image will be screenshotted and reshared without the post.
- The 2025 diamond moved to where late 2025 falls on the segment.
- Column headers read "The venue / Institutions arrive / Retail protection." "Spot" was wrong for a row whose venue is itself a derivatives exchange.
