# Privacy: Atticus Earn & Protect, Lock in (browser extension)

This extension draws a "Lock in" offer on the pages of the sports venues it supports and sends a
lock to the Atticus event service when you tap it. This page says what it reads, what it sends,
what it keeps, and what it never touches.

## What it reads

- The text of the venue's page, on the venue's own site only (the game list, a game's page, the
  order slip, and your positions page), to find the games the service can lock in and the picks
  you hold: team names, the market (Winner / Moneyline), the odds, the stake and the matched
  amount printed on the row.
- Nothing is read on any other site. The extension runs only on the venue hosts named in its
  manifest.

## What it sends, and to whom

Everything goes to the Atticus event service you configure in Options (one URL), and nowhere else.

- When a page loads: a request for the list of games the service can lock in this week.
- When an offer is drawn under a position: the market (a ticker), your contract count, and the
  price you paid, so the service can quote that position.
- When you tap Lock in: the same figures, to open the lock.
- Once per page view, if the anonymous-counts switch is on (it is on by default): the venue name,
  the kind of page (board, game, positions), the extension version, and whole-number counts
  (games found, pills drawn, rows read, offers shown). No page text, no team names, no amounts,
  no account identifiers travel with it. Turn it off in Options.

Each request carries your lock key, a credential issued by the service operator that identifies
your account on the service. It is the only credential the extension holds.

## What it keeps

In the browser's extension storage, on your machine only: the service URL, your lock key, and
the Options switches. Nothing else is stored; nothing is written to the venue's page or storage.

## What it never touches

- Your venue login, session, cookies, or API keys. The extension holds no venue credential and
  never acts on the venue: it places no orders and changes nothing on your venue account. The
  lock is a contract with the Atticus service; the hedge behind it is the service's own.
- Your browsing on any other site.
- Cookies, local storage, or form fields on the venue's page.

## Analytics and third parties

There is no analytics SDK, no advertising, no third-party script. The anonymous counts above are
the only usage data, they go to the Atticus service only, and they are kept in memory on the
service for operational review (what drew, what did not) rather than in a database.

## Changes

Changes to this page ship with the extension version that makes them, and are listed in the
extension's README.

## Contact

The operator of the Atticus event service you are configured against. Their address is on the
service's public record page.
