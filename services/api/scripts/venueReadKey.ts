/**
 * VENUE READ KEY: mint the read-only key the shadow service uses to confirm a holder's positions,
 * and check it. Run locally, once. Nothing here is committed and nothing prints a private key.
 *
 *   mint   npx tsx scripts/venueReadKey.ts mint --out ./venue-read.pem [--name "atticus read"]
 *          env: VENUE_API_HOST (default https://api.novig.com)
 *               VENUE_MGMT_KEY_ID        the management key's id (from the venue's profile page)
 *               VENUE_MGMT_KEY_PEM_PATH  path to the management key's private PEM (local file)
 *          Generates an Ed25519 keypair, registers the public half with POST /v3/keys (that route
 *          issues the read-only management scope: lists positions, reads the catalog, cannot order,
 *          cannot move money), writes the private half to --out (mode 600) and prints the key id.
 *          Then set on the service: VENUE_API_HOST, VENUE_API_KEY_ID=<printed id>,
 *          VENUE_API_PRIVATE_KEY_PEM=<contents of --out>. The management key stays on your machine.
 *
 *   check  npx tsx scripts/venueReadKey.ts check
 *          Signed venue: env VENUE_API_HOST, VENUE_API_KEY_ID, VENUE_API_PRIVATE_KEY_PEM (or VENUE_API_PRIVATE_KEY_PEM_PATH)
 *          Signs GET /v3/portfolio/positions with the read key and prints each open position in our
 *          units (contracts at $1, entry in cents) with the game and side as the venue names them.
 *
 *          Bearer venue (the partner API, session login): env VENUE_API_HOST (with the /partner path,
 *          production https://cash.api.<venue>/partner), VENUE_API_ACCESS_KEY, VENUE_API_SECRET_KEY.
 *          The pair comes from the venue's website (menu, API Integration). It is an account key, so it can
 *          trade: this script only logs in and reads open plays. Use a dedicated pair; revoke it after.
 *          Prints each open play with its matched stake in our units, or "unmatched" for a resting one.
 *          Which venue is checked follows the env: the key id and PEM select signed, the access key
 *          and secret key select bearer.
 *
 *   The subaccount an order needs (novigAccount.ts). On this venue the management key reads every
 *   wallet and moves money but never places an order; orders come from a `trading` key, which
 *   reaches one subaccount. The service's own hedge on this venue, once that route is built, needs
 *   a subaccount opened here. The management key signs all of these (same env as `mint`).
 *
 *   subaccount-open  npx tsx scripts/venueReadKey.ts subaccount-open --out ./novig-trade.pem [--label "atticus hedge"]
 *                    Generates an Ed25519 keypair, opens the subaccount with the public half
 *                    (POST /v3/account/subaccounts), writes the private half to --out (mode 600) and
 *                    prints the trading key id, which is also the subaccount's address.
 *   subaccounts      Lists the live subaccounts: trading key id, label, balance.
 *   fund             npx tsx scripts/venueReadKey.ts fund --key <trading key id> --dollars 50 --id <unique id> [--defund]
 *                    Moves cash from the cash wallet into the subaccount (or out with --defund) with
 *                    --id as the idempotency key, then reads the transfer back until it is Applied.
 *   transfer         npx tsx scripts/venueReadKey.ts transfer --key <trading key id> --transfer <transfer id>
 *   trade-check      npx tsx scripts/venueReadKey.ts trade-check
 *                    env: VENUE_API_HOST, NOVIG_TRADE_KEY_ID, NOVIG_TRADE_PRIVATE_KEY_PEM (or ..._PEM_PATH), exactly
 *                    as the service has them. Signs the subaccount balance read with the trading key (the
 *                    service's pre-flight read); says whether the pair reaches a subaccount, and why not.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PlaysClient, asVenueMarket, playSize, playsConfigFromEnv } from "../src/eventCollar/crossVenue/venuePlays";
import { VenueClient, positionSize, signedHeaders, signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";
import { NOVIG_TRADE_ENV, NovigAccountClient, mintTradingKeypair, type NovigSubaccount } from "../src/eventCollar/crossVenue/novigAccount";
import { NovigOrderClient } from "../src/eventCollar/crossVenue/novigOrders";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const host = (process.env.VENUE_API_HOST || "https://api.novig.com").replace(/\/+$/, "");

async function mint(): Promise<void> {
  const out = opt("--out");
  const mgmtId = process.env.VENUE_MGMT_KEY_ID?.trim();
  const mgmtPemPath = process.env.VENUE_MGMT_KEY_PEM_PATH?.trim();
  if (!out || !mgmtId || !mgmtPemPath) {
    console.error("mint needs --out <file>, VENUE_MGMT_KEY_ID and VENUE_MGMT_KEY_PEM_PATH");
    process.exit(2);
  }
  const mgmt = signerFromPem(mgmtId, readFileSync(mgmtPemPath, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const body = JSON.stringify({ algorithm: "Ed25519", name: opt("--name") || "atticus read-only", publicKey: publicPem });
  const path = "/v3/keys";
  const headers = { "content-type": "application/json", accept: "application/json", ...signedHeaders(mgmt, { method: "POST", path, query: "", body }) };
  const r = await fetch(`${host}${path}`, { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) {
    console.error(`venue answered ${r.status}: ${text.slice(0, 400)}`);
    process.exit(1);
  }
  const created = JSON.parse(text) as { keyId: string; fingerprint: string };
  writeFileSync(out, privatePem, { mode: 0o600 });
  console.log(`read key created: id ${created.keyId} · fingerprint ${created.fingerprint}`);
  console.log(`private half written to ${out} (never commit it)`);
  console.log(`service env: VENUE_API_HOST=${host}  VENUE_API_KEY_ID=${created.keyId}  VENUE_API_PRIVATE_KEY_PEM=<contents of ${out}>`);
}

async function checkBearer(cfg: { host: string; accessKey: string; secretKey: string }): Promise<void> {
  const client = new PlaysClient(cfg);
  const plays = await client.listOpenPlays();
  console.log(`${cfg.host}: ${plays.length} open play(s)`);
  for (const p of plays) {
    const size = playSize(p);
    const matched = typeof p.matched_stake === "number" ? p.matched_stake : p.stake;
    let line = `  stake $${p.stake} at ${p.odds > 0 ? "+" : ""}${p.odds}, matched $${matched}${p.matching_status ? ` (${p.matching_status})` : ""}`;
    line += size ? ` → ${size.contracts} contracts @ ${size.entryCents}c, pays $${(size.payoutCents / 100).toFixed(2)}` : " → unmatched, not a position yet";
    try {
      const event = await client.findEvent(String(p.sport_event_id));
      const market = event ? (await client.listMarkets(String(p.sport_event_id))).find((m) => String(m.id) === String(p.market_id)) : undefined;
      if (!event) line += " · event not in a covered league";
      else if (!market) line += ` · ${event.display_name || event.name} · market not found`;
      else {
        const vm = asVenueMarket(market, event);
        const side = vm.outcomes.find((o) => o.outcomeId === String(p.outcome_id))?.name ?? "?";
        line += ` · ${event.display_name || event.name} · ${side} · ${vm.marketType} · ${vm.startsTs ? new Date(vm.startsTs).toISOString() : "no start time"}`;
      }
    } catch (err) {
      line += ` · lookup failed: ${String(err instanceof Error ? err.message : err)}`;
    }
    console.log(line);
  }
}

async function check(): Promise<void> {
  const bearer = playsConfigFromEnv();
  const keyId = process.env.VENUE_API_KEY_ID?.trim();
  const pem = process.env.VENUE_API_PRIVATE_KEY_PEM?.trim() || (process.env.VENUE_API_PRIVATE_KEY_PEM_PATH ? readFileSync(process.env.VENUE_API_PRIVATE_KEY_PEM_PATH, "utf8") : "");
  if (!keyId || !pem) {
    if (bearer) return checkBearer(bearer);
    console.error("check needs VENUE_API_KEY_ID and VENUE_API_PRIVATE_KEY_PEM (or VENUE_API_PRIVATE_KEY_PEM_PATH), or VENUE_API_ACCESS_KEY and VENUE_API_SECRET_KEY");
    process.exit(2);
  }
  const client = new VenueClient({ host, signer: signerFromPem(keyId, pem) });
  const raw = await client.listPositions();
  console.log(`${host}: ${raw.length} open position(s)`);
  for (const p of raw) {
    const size = positionSize(p.qty, p.cost);
    let line = `  qty ${p.qty} cost $${p.cost}`;
    if (size) line += ` → ${size.contracts} contracts @ ${size.entryCents}c, pays $${(size.payoutCents / 100).toFixed(2)}`;
    try {
      const m = await client.getMarket(p.marketId);
      const side = m.outcomes.find((o) => o.outcomeId === p.outcomeId)?.name ?? "?";
      line += ` · ${m.description} · ${side} · ${m.marketType} · ${new Date(m.startsTs).toISOString()}`;
    } catch (err) {
      line += ` · market lookup failed: ${String(err instanceof Error ? err.message : err)}`;
    }
    console.log(line);
  }
}

// ── the subaccount a trading key addresses (novigAccount.ts) ───────────────────────────────────
// The management key signs all of these; it stays on the operator's machine like `mint`.

const mgmtClient = (): NovigAccountClient => {
  const mgmtId = process.env.VENUE_MGMT_KEY_ID?.trim();
  const mgmtPemPath = process.env.VENUE_MGMT_KEY_PEM_PATH?.trim();
  if (!mgmtId || !mgmtPemPath) {
    console.error("needs VENUE_MGMT_KEY_ID and VENUE_MGMT_KEY_PEM_PATH (the management key, from the venue's profile page)");
    process.exit(2);
  }
  return new NovigAccountClient({ host, signer: signerFromPem(mgmtId, readFileSync(mgmtPemPath, "utf8")) });
};
const fmtSub = (s: NovigSubaccount): string => `  ${s.keyId}  "${s.label}"  $${(s.balanceCents / 100).toFixed(2)}`;

/** Open a subaccount with a fresh Ed25519 keypair; the private half is the service's trading key. */
async function subaccountOpen(): Promise<void> {
  const out = opt("--out");
  const label = opt("--label") || "atticus hedge";
  if (!out) {
    console.error("subaccount-open needs --out <file> [--label <text>]");
    process.exit(2);
  }
  const client = mgmtClient();
  const kp = mintTradingKeypair();
  const sub = await client.openSubaccount({ label, publicKeyPem: kp.publicKeyPem, algorithm: kp.algorithm });
  writeFileSync(out, kp.privateKeyPem, { mode: 0o600 });
  console.log(`subaccount opened: trading key ${sub.keyId} · label "${sub.label}" · balance $${(sub.balanceCents / 100).toFixed(2)}`);
  console.log(`trading key's private half written to ${out} (never commit it; lost, nothing can sign as this subaccount again)`);
  console.log(`fund it: npx tsx scripts/venueReadKey.ts fund --key ${sub.keyId} --dollars 50 --id <unique-id>`);
  console.log(`service env, when the venue route goes live: ${NOVIG_TRADE_ENV.host}=${host}  ${NOVIG_TRADE_ENV.keyId}=${sub.keyId}  ${NOVIG_TRADE_ENV.pem}=<contents of ${out}>`);
}

async function subaccounts(): Promise<void> {
  const rows = await mgmtClient().listSubaccounts();
  console.log(`${host}: ${rows.length} live subaccount(s)` + (rows.length ? " (trading key id, label, balance)" : ""));
  for (const s of rows) console.log(fmtSub(s));
}

/** Move cash into (or out of, --defund) a subaccount, then read the transfer back until it is final. */
async function fund(): Promise<void> {
  const keyId = opt("--key");
  const dollars = Number(opt("--dollars"));
  const id = opt("--id");
  if (!keyId || !(dollars > 0) || !id) {
    console.error("fund needs --key <trading key id> --dollars <amount> --id <unique transfer id> [--defund]");
    process.exit(2);
  }
  const client = mgmtClient();
  const direction = args.includes("--defund") ? "defund" : "fund";
  const sent = await client.fund(keyId, { direction, amountCents: Math.round(dollars * 100), clientTransferId: id });
  console.log(`transfer ${sent.transferId}: ${sent.status} (${sent.direction} $${(sent.amountCents / 100).toFixed(2)})`);
  const done = sent.status === "Requested" ? await client.waitApplied(keyId, sent.transferId, { tries: 10, delayMs: 1000 }) : sent;
  if (done.status === "Applied") console.log(`applied. subaccount balance now $${((await client.balance(keyId)).balanceCents / 100).toFixed(2)}`);
  else if (done.status === "Rejected") console.log(`rejected; the venue found $${((done.actualBalanceCents ?? 0) / 100).toFixed(2)} in the wallet it drew on`);
  else console.log("still Requested after 10 s: read it again with `transfer --key ... --transfer " + done.transferId + "`; if it stays Requested, the venue's docs say contact support, never retry under a new id");
}

async function transferStatus(): Promise<void> {
  const keyId = opt("--key");
  const transferId = opt("--transfer");
  if (!keyId || !transferId) {
    console.error("transfer needs --key <trading key id> --transfer <transfer id>");
    process.exit(2);
  }
  const t = await mgmtClient().transfer(keyId, transferId);
  console.log(`transfer ${t.transferId}: ${t.status} (${t.direction} $${(t.amountCents / 100).toFixed(2)})` + (t.actualBalanceCents != null ? ` · wallet held $${(t.actualBalanceCents / 100).toFixed(2)}` : ""));
}

/**
 * Check the trading key as the service will use it: the subaccount's balance read, signed with
 * the key the env names (the same read the service's pre-flight makes). Passes only for the pair
 * a `subaccount-open` wrote: the key id it printed and the PEM in its --out file.
 */
async function tradeCheck(): Promise<void> {
  const keyId = process.env.NOVIG_TRADE_KEY_ID?.trim();
  const pem = process.env.NOVIG_TRADE_PRIVATE_KEY_PEM?.trim() || (process.env.NOVIG_TRADE_PRIVATE_KEY_PEM_PATH ? readFileSync(process.env.NOVIG_TRADE_PRIVATE_KEY_PEM_PATH, "utf8") : "");
  if (!keyId || !pem) {
    console.error("trade-check needs NOVIG_TRADE_KEY_ID and NOVIG_TRADE_PRIVATE_KEY_PEM (or NOVIG_TRADE_PRIVATE_KEY_PEM_PATH); VENUE_API_HOST as the service has it");
    process.exit(2);
  }
  const tail = `…${keyId.slice(-4)}`;
  let signer;
  try {
    signer = signerFromPem(keyId, pem);
  } catch (err) {
    console.log(`trading key ${tail}: the PEM does not parse (${String(err instanceof Error ? err.message : err)}); on the service, paste the whole file including its BEGIN and END lines`);
    process.exit(1);
  }
  const client = new NovigOrderClient({ host, signer });
  try {
    const balanceCents = await client.availableCents();
    console.log(`${host}: trading key ${tail} reaches its subaccount · balance $${(balanceCents / 100).toFixed(2)}`);
    console.log(`this pair is what the service needs: ${NOVIG_TRADE_ENV.host}=${host}  ${NOVIG_TRADE_ENV.keyId}=${keyId}  ${NOVIG_TRADE_ENV.pem}=<this PEM>`);
    if (balanceCents === 0) console.log("the subaccount holds nothing; fund it before a tap: fund --key " + keyId + " --dollars 50 --id <unique id>");
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    console.log(`${host}: trading key ${tail} FAILED the balance read: ${msg}`);
    if (/does not reach a subaccount|SCOPE_INSUFFICIENT|\b403\b/.test(msg)) {
      console.log("  this key id is a management or read-only key, not a subaccount's trading key. Run `subaccounts` with the management key and use the trading key id it lists; the PEM is the --out file from that subaccount-open.");
    } else if (/\b401\b|signature|unauthori[sz]ed|invalid key/i.test(msg)) {
      console.log("  the key id is known but this PEM does not sign for it: the PEM is from another key (a mint, or a different subaccount-open). The id and the PEM must come from the same subaccount-open run.");
    }
    process.exit(1);
  }
  if (process.env.VENUE_MGMT_KEY_ID?.trim() && process.env.VENUE_MGMT_KEY_PEM_PATH?.trim()) {
    const rows = await mgmtClient().listSubaccounts();
    const mine = rows.find((s) => s.keyId === keyId);
    console.log(mine ? `the management key lists it: subaccount "${mine.label}" · $${(mine.balanceCents / 100).toFixed(2)}` : `the management key does not list it among its ${rows.length} subaccount(s)`);
  }
}

const fail = (err: unknown): void => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
};

if (cmd === "mint") mint().catch(fail);
else if (cmd === "check") check().catch(fail);
else if (cmd === "subaccount-open") subaccountOpen().catch(fail);
else if (cmd === "subaccounts") subaccounts().catch(fail);
else if (cmd === "fund") fund().catch(fail);
else if (cmd === "transfer") transferStatus().catch(fail);
else if (cmd === "trade-check") tradeCheck().catch(fail);
else {
  console.error("usage: venueReadKey.ts mint --out <file> | check | subaccount-open --out <file> [--label <text>] | subaccounts | fund --key <id> --dollars <n> --id <unique> [--defund] | transfer --key <id> --transfer <id> | trade-check");
  process.exit(2);
}
