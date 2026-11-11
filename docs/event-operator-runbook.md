Draft for the founder's review. Not sent. 10 November 2026.

# Earn & Protect event product: operator runbook

For the founder, as the only operator. It covers the event product only. The file `RUNBOOK.md` at the top of the repo is the perp product's runbook (the OKX live pilot). It does not apply here.

**How to read the tags.** Each step is tagged with when it applies.

- **[today]**: on the event branch and deployed now.
- **[after #399]**, **[after #400]** and so on: built, awaiting merge. The step does not work until that pull request is merged and the service has redeployed.

**Three rules.** Never paste a token or key into a chat, a document or a command you will share. Pass the operator token in a header, not in a web address, wherever the route allows it. Dashboard button names below are from memory of Render, not from the repo: [founder to confirm on screen].

## 1. Where things are

| Thing | Where |
| --- | --- |
| The service that keeps the record and can send real orders | Render service `atticus-event-shadow`, `https://atticus-event-shadow.onrender.com` |
| The demo board (read only, sends no orders) | Render service `atticus-event-demo-cross-venue` |
| Settings and secrets | Render dashboard, each service's Environment page. Never in git. |
| The record and the lock ledgers | One Render disk on `atticus-event-shadow`, mounted at `/var/data` |
| Operator token | `EVENT_X_ADMIN_TOKEN`. Each of the two services has its own value. |

Files on that disk: `event-shadow-ledger.jsonl` (the public record), `lock-ledger.jsonl` (locks taken with the shared key), `lock-ledger-<alias>.jsonl` (one per named holder), `hedge-receipts.jsonl` (every hedge order, sent or simulated), `event-shadow-lastleg.jsonl` (parlays), and after #399 `lock-pending.jsonl` (real-money lock attempts).

## 2. Set up a terminal [today]

Run these once in a new terminal. The first line reads the token without showing it or saving it in your history. Paste the token from the Render dashboard when the cursor waits, then press Enter.

```
read -rs EVENT_X_ADMIN_TOKEN; export EVENT_X_ADMIN_TOKEN
S=https://atticus-event-shadow.onrender.com
```

Then test the token. This prints `200` when the token is accepted and `403` when it is not.

```
curl -s -o /dev/null -w '%{http_code}\n' -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/holders"
```

Do not skip this test. `/healthz` answers everyone: with a wrong token it gives the short public answer, and every operator field then reads `null`. A `null` below means "token not accepted", unless this test printed `200`.

Every command below assumes these lines. `jq` only makes the answer readable; leave it off if you do not have it.

## 3. Pause

The one switch is the kill switch in step A. It stops every hedge order in every hedge mode (live orders, and the request-for-quote mode, where no request is sent and no quote can be accepted). Hedge orders are the only way money leaves our accounts. It is not a full stop: steps B to D cover the rest, from lightest to heaviest. No route changes any of them. Each is a setting in the Render dashboard, and saving it restarts the service.

**Step A. Stop every hedge order. [today]** On `atticus-event-shadow`, Environment, set:

```
EVENT_HEDGE_KILL_SWITCH=1
```

Save and let the service redeploy. Then check:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '{operatorView: has("ledger"), strategy: .hedge.strategy, live: .hedge.live}'
```

`operatorView` must be `true`. If it is `false`, the token was not accepted and the rest tells you nothing (the answer then also carries `"operator": false` and a note saying the token was not accepted). `.hedge.killSwitch` must read `true`, in any mode. In live mode `live` also shows `"killSwitch": true`. If `live` is `null`, the service is not in live mode (`strategy` is not `live`).

What the kill switch does not stop:

- A tap by a holder who is not real-only (section 9) still writes a lock on the record, with a simulated hedge. That is a floor written with nothing bought behind it. Harmless while you are the only holder. A real-only holder's tap is refused instead and nothing is written. Use step B as well if anyone holds a key and is not real-only.
- A member's own sale on the hosted page. Use step C.
- The Kalshi account routes under `/api/shadow/kalshi/` (subaccounts, transfers, keys). They act only when you call them.

**Step B. Stop new locks. [today]** On `atticus-event-shadow`, remove both `EVENT_SHADOW_LOCK_KEY` and `EVENT_SHADOW_HOLDER_KEYS`. Keep the values in your password manager first. With both gone the lock routes answer "not found". Check:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '.lock.enabled'
```

It must show `false`.

**Step C. Stop the hosted member page. [today]** On `atticus-event-shadow`, remove `MEMBER_APP_HOST`. The page and its routes answer "not found". Check that `.lock.member.configured` in the same health answer is `false`.

**Step D. Stop the whole service.** Suspend `atticus-event-shadow` in the Render dashboard. This also takes the public record offline, so use it only if A to C are not enough.

**The other rails, for narrowing instead of stopping. [today]** All on `atticus-event-shadow`:

| Setting | What it does |
| --- | --- |
| `EVENT_HEDGE_LIVE_SEND=yes` | The only value that sends. Anything else is a dry run: the order is built and recorded, not sent. |
| `EVENT_HEDGE_LIVE_TICKERS=KX...,KX...` | The allowlist. Empty allows nothing. `*` allows any game. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | Largest order. Default 25. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | Largest total in one UTC day. Default 100. |
| `EVENT_HEDGE_STRATEGY=live` | Live mode. Without it every hedge is simulated. |

The values set in Render today: [founder to fill: read them from the health answer in section 4].

## 4. Check health

**Anyone can run this. [today]**

```
curl -s https://atticus-event-shadow.onrender.com/healthz
```

Good looks like: `"ok": true`, and `lastScanAt` and `lastSettleAt` within the last few minutes. The service scans every 5 minutes and settles every 10 by default. When this was read on 10 November 2026 at 22:55 UTC it showed 1,811 positions and a scan less than a minute old.

**The operator's view. [today]**

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '{lastScanAt, lastScanError, lastSettleError, alertsConfigured, live: .hedge.live, lock: {enabled: .lock.enabled, holders: .lock.holders, holderNotes: .lock.holderNotes}}'
```

Check: `lastScanError` and `lastSettleError` are `null`. `alertsConfigured` is `true`. `live` shows the kill switch, dry run, allowlist and caps you expect. `holders` lists only the people you added.

**[after #399]** add this check. Both lists must be empty:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '.lock.hedgeFirst | {unresolved, strays}'
```

**Alerts. [today]** The service sends alerts to Telegram (`EVENT_SHADOW_ALERT_BOT_TOKEN` with `EVENT_SHADOW_ALERT_CHAT_ID`) or to a web address (`EVENT_SHADOW_ALERT_WEBHOOK_URL`). If `alertsConfigured` is `false`, nothing will page you: [founder to fill: which one is set]. Each kind of alert is sent at most once in 6 hours. After #399, a stray hedge is the exception: it is sent every time.

**The hourly check. [after #404]** A GitHub workflow asks each service's `/healthz` once an hour. See the caveat in section 8: until the repo's default branch is changed, the hourly run does not start on its own.

## 5. When a hedge leg misses

### Today, before #399 is merged [today]

The lock is written first. Then the hedge order is sent. If the venue refuses the order, or a rail holds it, the lock stays on the record and the hedge is recorded as a simulated fill with the reason. The holder has been told they are locked. Nothing was bought.

What to check, after every real-money lock:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/hedges?limit=20" | jq '.recent'
```

Find the receipt for the lock. A real fill carries the venue's order id. A simulated one says so and gives the reason. A part fill is recorded as a part fill: the lock stands and only part of it is hedged.

If the hedge was simulated or only part filled, choose one:

1. Send the hedge again at today's price. The lock's terms do not move.

```
curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/hedges/resend?ticker=KX..."
```

Add `&holder=<alias>` if more than one person locked that market. Add `&route=kalshi`, `&route=prophetx` or `&route=novig` to name the venue. It refuses if a real fill is already on the trail, unless you add `&force=1`.

2. Take the lock off the record, so the market can be locked again. The lines move to an archive file. They are not deleted.

```
curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/lock/reset?ticker=KX..."
```

The answer lists any real fills still sitting at the venue for that lock. Those are yours to sell or keep, by hand, on the venue.

### After #399 is merged [after #399]

On a real-money lock the hedge is bought first, whole or not at all, at a limit price. The lock is written only after the whole order fills. There are five endings.

| Ending | What the system does | What you do |
| --- | --- | --- |
| Filled | Writes the lock. | Nothing. |
| Not filled | Writes nothing. Tells the holder. They may tap again. | Nothing. |
| Part filled | Writes no lock. Records the part bought as a stray hedge. Alerts you every time. | Sell the stray on the venue by hand, then clear the line. |
| Unconfirmed (the order went out and the answer was an error) | Writes no lock. Alerts you. | Look for the order on the venue by its id. If it filled, sell it. Then clear the line. |
| Filled, but the lock could not be written to the disk | No lock exists. Records the hedge as a stray. Alerts you. Tells the holder nothing was locked. | Check the disk. Sell the hedge on the venue by hand, then clear the line. |

If the service restarts between sending an order and recording the answer, it alerts you on start with the order to look for.

"Real-money" here means the order would truly leave: live mode, send on, kill switch off, a key for the hedge venue, and the game on the allowlist. In every other case the old paper path runs: the lock is written and the hedge is simulated. A real-only holder (section 9) has no paper path: in every other case their tap is refused and nothing is written.

See the trail:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/lock/pending" | jq '{counts, unresolved, strays}'
```

Clear a line once you have dealt with it on the venue. This adds a line. It removes nothing.

```
curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/lock/pending/clear?id=<the line's id>&note=sold%20on%20the%20venue"
```

No route sells a stray for you. Selling is by hand, on the venue.

**During a game [after #400].** The lock window opens seven days before the start and closes four hours after it. A hedged lock cannot be left early once the game has started. To go back to closing 45 minutes before the start, set `EVENT_X_IN_PLAY=0` on `atticus-event-shadow`. In-play real orders have been tested against a scripted venue only, so treat the first one as a test: smallest size, one game on the allowlist, and check the trail straight after.

## 6. How a holder is paid today [today]

**What the code does.** For each lock it works out who owes what: the credit, owed to the holder from the tap; the floor, owed to the holder if the side lost; the handback, owed by the holder to us if the side won above the cap. It shows this on the holder's receipt, on the public record and on the operator's holders page.

**What the code does not do.** It moves no money. It does not pay a holder. It does not collect a handback. It records a payment only when you tell it one happened. A member's own sale owes nothing either way: the member already has the cash in their own venue account.

**The steps.**

1. See what is owed.

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/holders" | jq '.holders[] | {holder, outstanding}'
```

The same view as a page is at `/holders`. A browser cannot send the header, so the page takes the token in the address (`/holders?token=...`). That leaves the token in your browser history. Prefer the command.

2. Move the money outside the system: [founder to fill: how a holder is paid and how a handback is collected].

3. Record each leg. `leg` is one of `credit`, `floor`, `handback`, `close`. `cents` is a whole number.

```
curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"ticker":"KX...","leg":"floor","cents":1350,"method":"venue transfer","ref":"<your reference>"}' \
  "$S/api/shadow/cash"
```

Add `"holder":"<alias>"` if more than one person locked that market. The route refuses a leg the lock does not owe, and refuses a payment larger than what is outstanding.

4. Run step 1 again. `outstanding` should read zero both ways.

**What the record says today.** Seven hedged locks are on the public record. None has a payment recorded. They show $16.12 owed to the holder and $25.36 owed by the holder to us. That includes the first real lock of 15 October 2026 (ticker `KXNFLGAME-26OCT18TENIND-IND`): $13.85 owed and no payment line. If that money did move, record it with step 3 so the record matches: [founder to confirm: was it paid, when, how].

## 7. Rotate a token or a venue key

**In Render.** Open the service, then Environment. Edit the value. Save. The service redeploys with the new value. [founder to confirm on screen: the button names.] Do it when no real-money lock is in progress, because a restart interrupts the lock path.

| Secret | Service | What else must change |
| --- | --- | --- |
| `EVENT_X_ADMIN_TOKEN` | `atticus-event-shadow` | Your terminal (section 2). After #404, the GitHub secret of the same name (section 8). Any saved link that carries `?token=`. |
| `EVENT_X_ADMIN_TOKEN` | `atticus-event-demo-cross-venue` | A separate value. Any saved operator link to the demo. |
| `EVENT_SHADOW_LOCK_KEY` | `atticus-event-shadow` | The key saved in your browser extension's options. At least 12 characters. |
| `EVENT_SHADOW_HOLDER_KEYS` | `atticus-event-shadow` | Send the holder their new key privately (section 9). |
| `EVENT_SHADOW_SLATE_KEY` | both services, same value | Every slate link already sent stops working. |
| Venue keys: `KALSHI_API_KEY_ID` with `KALSHI_PRIVATE_KEY_PEM`; `NOVIG_TRADE_KEY_ID` with `NOVIG_TRADE_PRIVATE_KEY_PEM`; `AGGREGATOR_TRADE_KEY_ID` with `AGGREGATOR_TRADE_PRIVATE_KEY_HEX`; `AGGREGATOR_KEY_ID` with `AGGREGATOR_PRIVATE_KEY_HEX` | `atticus-event-shadow` | Make the new key on the venue first. Set it in Render. Run the check below. Only then revoke the old key on the venue. |
| `MEMBER_APP_CLIENT_SECRET` | `atticus-event-shadow` | Issued by the venue; rotate there first. |
| `MEMBER_APP_TOKEN_KEY` | `atticus-event-shadow` | This key seals the members' stored connections. Expect every member to have to connect again after a change. Not rehearsed. |

Check a venue key after changing it. This reads only. It places nothing.

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/hedges/preflight" | jq .
```

**Open item.** The handoff records that admin tokens were pasted into a chat in October and recommends rotating `EVENT_X_ADMIN_TOKEN` on both event services and any lock key: [founder to confirm: done or not].

## 8. Back up and restore the ledgers

### Take a backup by hand [today]

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/export" > event-shadow-ledger-$(date +%F).jsonl
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/export?ledger=lock" > event-shadow-lock-ledger-$(date +%F).jsonl
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/export?ledger=lock&holder=<alias>" > event-shadow-lock-ledger-<alias>-$(date +%F).jsonl
```

Run the third line once for each named holder. The files are the ledgers byte for byte. Check that the first file is not empty: the service answers an empty body when the ledger is missing from its disk.

**What the export does not reach.** The hedge receipts, the parlay ledger, archived ledgers, the members' sealed connections and, after #399, the pending trail. Those live only on the disk. You can read the most recent 200 hedge receipts with `GET /api/shadow/hedges?limit=200`, but that is a view, not a copy of the file.

### The nightly backup [after #404]

The workflow "Event shadow ledger backup" runs the three exports above at 10:23 UTC each day and keeps the files for 90 days as a private artifact named `event-shadow-ledger-<date>`, with a `.sha256` file beside each.

Before it can work:

1. In GitHub, under Settings, Secrets and variables, Actions, add the repository secret `EVENT_X_ADMIN_TOKEN` with the same value as on `atticus-event-shadow`.
2. GitHub starts scheduled runs only from the repo's default branch. The default branch today is not the event branch. Until that changes, or the workflow file is also merged to the default branch, nothing runs at night. The manual run does work: Actions, "Event shadow ledger backup", Run workflow.

The same caveat applies to the hourly health check.

### Restore [today for the hand copy; after #404 for the artifact]

Restoring is by hand. No route writes a ledger back, and no restore has been rehearsed in this repo. Rehearse it once before you need it.

1. Get the files. From a hand backup, use your own copies. From the nightly backup, download the artifact from the run's page in GitHub Actions.
2. Check each file from the artifact. On a Mac, use `shasum -a 256 -c` in place of `sha256sum -c`.

```
sha256sum -c event-shadow-ledger.jsonl.sha256
```

3. Stop new writes: steps A, B and C of section 3.
4. Put each file back on the disk under the name the service reads. The backup's names differ from the disk's:

| Backup file | Name on the disk |
| --- | --- |
| `event-shadow-ledger.jsonl` | `/var/data/event-shadow-ledger.jsonl` |
| `event-shadow-lock-ledger.jsonl` | `/var/data/lock-ledger.jsonl` |
| `event-shadow-lock-ledger-<alias>.jsonl` | `/var/data/lock-ledger-<alias>.jsonl` |

How to copy a file onto a Render disk is not in the repo: [founder to confirm: the service's shell or SSH access, and whether the plan allows it].

5. Restart the service and run the checks in section 4. Then open the record page and check the history is back.

Anything written after the backup was taken is lost. For the public record that is simulated history. For a lock ledger it is a real holder's lock, so take a hand backup after every real-money lock until the nightly run is working.

## 9. Add a holder [today]

1. Make a key for them. At least 12 characters, no spaces or commas:

```
openssl rand -hex 16
```

2. On `atticus-event-shadow`, Environment, add the pair to `EVENT_SHADOW_HOLDER_KEYS`. The format is `alias:key`, with pairs separated by commas:

```
EVENT_SHADOW_HOLDER_KEYS=ann:<her key>,bob:<his key>
```

The alias is 2 to 24 characters: lower-case letters, digits, `_` or `-`, starting with a letter or digit. A key must not equal the shared `EVENT_SHADOW_LOCK_KEY` or another holder's key.

3. Save and let the service redeploy. Then check that the alias is listed and nothing was dropped:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '.lock | {holders, holderNotes}'
```

`holderNotes` should be `null`. If it lists a note, that pair was dropped and says why.

4. If the holder is anyone but you, make them real-only. On the same service, add their alias to `EVENT_SHADOW_REAL_ONLY_HOLDERS` (aliases separated by commas, or `*` for every caller including the shared key and you):

```
EVENT_SHADOW_REAL_ONLY_HOLDERS=ann,bob
```

A real-only holder's lock exists only with a real hedge bought behind it. Where the hedge would not truly be bought (the service is not in live mode, the kill switch is on, sending is off, there is no key for the hedge venue, or the game is not on the allowlist) their quote says "Lock in is not open on this position right now" and their tap writes nothing. Leaving early from a lock that holds a real hedge needs a real sale of that hedge; if the sale cannot be sent or sells nothing, the lock stands and they are told so. Everyone not named keeps the paper path, which is what you want for your own demonstrations. Check:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '.lock.realOnly'
```

`holders` lists who is real-only. `notRealOnly` lists the holders with a key who are not: it should list only you. `notes` appears when an entry could not be read; an unreadable entry makes everyone real-only until it is corrected. `refusals` counts the taps refused for this reason.

5. Put the user terms in force. This is two settings on the same service, set once, not per holder:

```
EVENT_SHADOW_TERMS_VERSION=2026-11-20
EVENT_SHADOW_TERMS_URL=https://[founder to fill: where the terms are published]
```

`EVENT_SHADOW_TERMS_VERSION` is the label printed on the document (letters, digits, dot, dash, underscore). `EVENT_SHADOW_TERMS_URL` is where that version can be read, and has to start with `https://`. The terms themselves are a document counsel writes; the service does not hold the text.

With both set, every named holder (a holder with their own key, a member on the hosted page, or you acting for a holder by name) is asked to accept before a quote or a lock. Until they do, their quote reads "Read and accept the terms to lock in." with the link, and their tap writes nothing. They accept with one tap, in the extension or at the top of the hosted page. The shared key and you acting for nobody are not asked. Reading their record and leaving a lock early are never blocked.

Each acceptance is one line in `terms-acceptances.jsonl` on the disk: who, which version, when. Check:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/healthz" | jq '.lock.terms'
```

`accepted` counts the holders with a key who have accepted the version in force. `notAccepted` lists the ones who have not. `notes` appears when a setting could not be read; then nobody can accept and every named holder is refused until it is corrected.

If a holder accepted another way (a signed copy), record it yourself. `how` is required and is the sentence that says what you received:

```
curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"version":"2026-11-20","how":"signed copy received by email on 21 November 2026"}' \
  "$S/api/shadow/terms/accept?holder=ann"
```

When the terms change, change both settings to the new version. Every named holder is asked again. The older lines stay on the file.

6. Send the holder their key by a private channel. They enter it in the extension's options. The alias shows only on your views, never on the public record. Each holder gets their own ledger file, `lock-ledger-<alias>.jsonl`.

To remove a holder, delete their pair and redeploy. Their ledger stays on the disk.

**Before adding anyone who is not you.** Do steps 4 and 5. Without step 5 nothing asks them to accept terms. Without step 4, with the rails off, their tap writes a floor with nothing bought behind it (section 3, step A). Payment is by hand (section 6). And the founder has decided the collar runs only on a signed venue agreement, so this needs counsel's answers first (`docs/event-counsel-questions.md`, questions 3 and 4).

## 10. The Polymarket US key [after #401]

The founder now holds Polymarket US keys. Until #401 is merged and deployed, the service does not read them and the check route answers "not found".

1. In the Render dashboard, open `atticus-event-shadow`, then Environment. Add both:

```
POLYMARKET_US_KEY_ID=<key id>
POLYMARKET_US_SECRET_KEY=<secret key>
```

Paste the values only into the dashboard. Never into git, a chat or a document.

2. Optional: add the same pair on `atticus-event-demo-cross-venue` so the demo board reads the same book. Render does not share settings between services.
3. Do not put this key on `atticus-btc-curve` or `atticus-sports-venues`. The key can trade, so use a key made for this service alone.
4. Save, let the service redeploy, then check on `atticus-event-shadow`:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" "$S/api/shadow/polymarket-us/preflight" | jq '{keySet, keyAccepted, books, say}'
```

The `say` line tells you in words whether the key was accepted and whether books are live. The check route exists on `atticus-event-shadow` only. The demo service has no such route.

What the key does: with it, each game's book comes off the venue's live stream. Without it, and with `REFERENCE_BOOK_POLY_US=public`, the book is the venue's public copy, up to 30 seconds old. Either way this venue is a price reference only. No order is sent there from this service. `REFERENCE_BOOK_POLY_US=0` turns the venue off. The live stream has not yet been checked against the real venue, so run step 4 and read the `say` line before relying on it.

## 11. Merging while the service is live

**[today]** Every merge to the event branch redeploys all six event services, this one included, even when only a document changed. A restart interrupts the lock path. Merge when no real-money lock is in progress.

**[after #403]** Changes to documents, tests and workflows no longer restart the services. Tests run on every pull request to the event branch.

## Blanks for the founder

- [founder to confirm on screen] the Render button names for saving a setting and suspending a service (sections 3 and 7).
- [founder to fill] the live rail values set in Render today (section 3).
- [founder to fill] which alert channel is set (section 4).
- [founder to fill] how a holder is paid and how a handback is collected (section 6).
- [founder to confirm] whether the $13.85 on the first real lock was paid, when and how (section 6).
- [founder to confirm] whether the October token rotation was done (section 7).
- [founder to confirm] how a file is copied onto the Render disk (section 8).

## Sources

All paths are in this repo. "PR branch" means `cursor/event-stx-combo-rfq-default-18af`, which carries #399 to #402, or `cursor/event-ledger-backup-uptime-18af`, which carries #403 and #404. None is merged.

- Root runbook is the perp product's: `RUNBOOK.md`, whose title names the OKX live pilot.
- Services, disk, auto deploy, ledger paths: `render-event-demos.yaml`. Other file names: `LOCK_LEDGER_PATH`, `RECEIPTS_PATH`, `PENDING_PATH` in `services/api/scripts/eventShadowWorker.ts`.
- Operator token and the header: `adminAuthorized` as used in `services/api/scripts/eventShadowWorker.ts`; the commands in that file's opening comment.
- Kill switch, send switch, allowlist, caps and their defaults: `services/api/src/eventCollar/crossVenue/liveHedge.ts` (`DEFAULT_LIVE_RAILS`, `liveRailsFromEnv`).
- A tap with the rails off still writes a paper lock: the branch on `lockMode(...)` in the lock route of `eventShadowWorker.ts` (PR branch), and "What a refused or held hedge does" in `liveHedge.ts`.
- Lock keys and holder keys: `services/api/src/eventCollar/crossVenue/lockGate.ts`. `LOCK_ROUTES_ON` in `eventShadowWorker.ts`.
- Member page off when `MEMBER_APP_HOST` is unset: `memberAppConfigFromEnv` in `services/api/src/eventCollar/crossVenue/memberApp.ts`.
- Health answers: `publicHealthBody` and `healthBody` in `eventShadowWorker.ts`. Scan and settle timing: `SCAN_MS`, `SETTLE_MS`, same file.
- 1,811 positions and the scan time: `https://atticus-event-shadow.onrender.com/healthz`, read 10 November 2026 at 22:55 UTC (`lastScanAt` 22:54:59).
- Alerts: `services/api/src/eventCollar/crossVenue/shadowAlerts.ts` (6 hours per kind; on the PR branch `hedge_stray` is not held back).
- Hedge first and its endings (the four verdicts, plus a filled hedge whose lock record could not be written): `services/api/src/eventCollar/crossVenue/hedgeFirst.ts` (PR branch, #399). Pending routes: `/api/shadow/lock/pending` and `/api/shadow/lock/pending/clear` in `eventShadowWorker.ts` (PR branch).
- Resend and lock reset: `handleHedgeResend`, `handleLockReset` in `eventShadowWorker.ts`.
- In-play window: `services/api/src/eventCollar/crossVenue/lockWindow.ts` (PR branch, #400); "tested against a scripted venue" from the body of #400.
- Payment: `cashDue` and `CASH_LEGS` in `services/api/src/eventCollar/crossVenue/shadowLedger.ts`; `handleCash` and `holdersSummary` in `eventShadowWorker.ts`.
- $16.12, $25.36, seven locks, $13.85: `https://atticus-event-shadow.onrender.com/api/shadow`, read 10 November 2026 at 22:55 UTC. Sum of `cashDue[].outstandingCents` over positions with `source` "lock" and a hedge route: 1,612 cents to the holder, 2,536 cents to the writer; every `paidCents` is 0.
- The handoff's "paid to the holder on 10-18" and the October token note: `docs/AGENT_HANDOFF.md` sections 3 and 8.
- Export route: `/api/shadow/export` in `eventShadowWorker.ts`. Disk names of the lock ledgers: `lockLedgerPathFor`, same file. Nightly backup, its secret, what it does not copy and the default-branch caveat: `.github/workflows/event-ledger-backup.yml` (PR branch, #404). Hourly check: `.github/workflows/event-uptime.yml` (same branch).
- Polymarket US key, where it goes and what it does: `render-event-demos.yaml` (PR branch, #401); the check route and its `say` line in `eventShadowWorker.ts` (PR branch); "Not verified against the venue" from the commit message of #401.
- Build filters and tests on pull requests: `render-event-demos.yaml` and `.github/workflows/event-tests.yml` (PR branch, #403).
