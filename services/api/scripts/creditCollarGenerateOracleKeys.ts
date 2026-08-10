/**
 * Generate a PERSISTENT oracle keypair for the shadow service's settlement signing.
 *
 * Why: without ORACLE_PRIVATE_KEY_PEM / ORACLE_PUBLIC_KEY_PEM set, the service generates an
 * ephemeral keypair on every boot — signatures remain internally consistent per run, but can't be
 * verified across restarts, which weakens the public "oracle-signed settlements" claim. Run this
 * ONCE, paste both values into the Render env, and every future settlement verifies against one
 * stable public key (which can also be published for third-party verification).
 *
 *   npx tsx scripts/creditCollarGenerateOracleKeys.ts
 *
 * Paste each PEM into the Render dashboard env as-is (Render env values support multiline —
 * use the value editor, not the single-line quick add). The earlier "DECODER routines::unsupported"
 * failures came from hand-mangled PEMs; these are generated in exactly the encoding the oracle's
 * sign/verify path expects (P-256, PKCS8 private / SPKI public).
 */

import { generateOracleKeyPair } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const { privateKeyPem, publicKeyPem } = generateOracleKeyPair();

console.log("── ORACLE_PRIVATE_KEY_PEM (secret — Render env only, never commit/share) ──");
console.log(privateKeyPem);
console.log("── ORACLE_PUBLIC_KEY_PEM (safe to publish — verifiers use this) ──");
console.log(publicKeyPem);
console.log("── Next steps ──");
console.log("1. Render → service → Environment → add BOTH keys via the multiline value editor.");
console.log("2. Save (one restart). All settlements from then on verify against this public key.");
console.log("3. Optional: publish the public key (docs / one-sheet) so anyone can verify receipts.");
