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
 *          The pair comes from the venue's website (Settings, Token). It is an account key, so it can
 *          trade: this script only logs in and reads open plays. Use a dedicated pair; revoke it after.
 *          Prints each open play with its matched stake in our units, or "unmatched" for a resting one.
 *          Which venue is checked follows the env: the key id and PEM select signed, the access key
 *          and secret key select bearer.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PlaysClient, asVenueMarket, playSize, playsConfigFromEnv } from "../src/eventCollar/crossVenue/venuePlays";
import { VenueClient, positionSize, signedHeaders, signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";

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

const fail = (err: unknown): void => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
};

if (cmd === "mint") mint().catch(fail);
else if (cmd === "check") check().catch(fail);
else {
  console.error("usage: venueReadKey.ts mint --out <file> | check");
  process.exit(2);
}
