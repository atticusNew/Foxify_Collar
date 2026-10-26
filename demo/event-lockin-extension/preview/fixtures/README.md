# Fixtures: saved copies of the real venue pages

The stand-in boards (`../kalshi.html`, `../novig.html`, `../positions.html`) approximate the
venues from screenshots. A saved copy of a real page lets the simulation run on the venue's own
markup, so a change on the live site is caught here first.

How to save one (nothing account-specific is on the game list; blank the balance if it shows):

1. On the venue, with the page you want showing (the game list; a game page; the page with a
   pick in the slip), open DevTools (F12), Elements tab.
2. Right-click the `<html>` element, Copy, Copy outerHTML.
3. Paste into a file here named `<venue>-<page>.html`, where `<venue>` is `prophetx`, `kalshi`
   or `novig`: `kalshi-board.html`, `novig-slip.html`, `prophetx-game.html`.
4. Serve this folder's parent (`python3 -m http.server 8812 --bind 127.0.0.1` from the extension
   folder) and open `http://127.0.0.1:8812/preview/fixtures/kalshi-board.html`. The extension
   reads the venue from the file name.

Styles and scripts referenced by the saved page will not load (relative URLs, the venue's CSP), so
the page looks plain; the extension reads text and layout, and the layout holds for text size
checks in most cases. Fixtures are not committed (`.gitignore`): they are the venue's markup.
