/**
 * WALLET VERIFICATION (public-demo hardening) — one signature, two jobs.
 *
 * Once demo links are public, anyone can paste anyone's address — viewing is fine (read-only by
 * design), but ACTIONS must be owner-only or a stranger could early-close someone's wrap (clawback
 * griefing) or burn their daily quota. The proportionate fix is NOT a login: it is one EIP-191
 * personal_sign over a canonical message that (a) proves control of the wallet and (b) doubles as
 * a SIGNED Terms-of-Service acceptance — a far stronger legal artifact than a checkbox.
 *
 * Armed via EP_REQUIRE_ACTION_SIG=true (default off — private allow-list betas don't need it).
 * The verification is wallet-scoped and stored server-side, so it happens ONCE per wallet in any
 * signing client (web app / Mini App via the wallet extension); the Telegram bot then works for
 * that wallet without signing again.
 */

import { verifyMessage } from "viem";
import type { TosAcceptance, TosRegistry } from "./store/epStores";

/** The exact message the wallet signs — versioned so a ToS bump forces a fresh signature. */
export const verifyMessageText = (account: string, tosVersion: string): string =>
  [
    `Earn & Protect — wallet verification`,
    ``,
    `I control ${account} and accept the Terms of Service (version ${tosVersion}).`,
    `This signature authorizes protection actions for this wallet. It cannot move funds.`
  ].join("\n");

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** Recover the EIP-191 signer and require it to be the claimed account. Never throws. */
export const verifyWalletSignature = async (account: string, tosVersion: string, signature: string): Promise<VerifyResult> => {
  if (!/^0x[0-9a-fA-F]+$/.test(signature ?? "") || signature.length < 100) {
    return { ok: false, error: "not a signature — expected the wallet's personal_sign output (0x…)" };
  }
  try {
    const valid = await verifyMessage({
      address: account as `0x${string}`,
      message: verifyMessageText(account, tosVersion),
      signature: signature as `0x${string}`
    });
    return valid ? { ok: true } : { ok: false, error: "signature does not recover to this wallet" };
  } catch (e) {
    return { ok: false, error: `signature verification failed: ${(e as Error).message}` };
  }
};

/**
 * Is this wallet cleared for ACTIONS under the current gates? Pure.
 *   - signature gate armed  ⟹ needs a signer-verified acceptance of the CURRENT ToS version
 *   - only the ToS gate     ⟹ needs any acceptance of the current version (checkbox is enough)
 *   - neither armed         ⟹ always cleared
 */
export const actionCleared = (
  tos: TosRegistry,
  account: string,
  tosVersion: string,
  requireSignature: boolean,
  tosRequired: boolean
): VerifyResult => {
  if (!requireSignature && !tosRequired) return { ok: true };
  const acc = tos[account.toLowerCase()];
  if (!acc || acc.version !== tosVersion) {
    return { ok: false, error: `tos_required — please accept the Terms of Service (version ${tosVersion}) before protecting` };
  }
  if (requireSignature && acc.signerVerified !== true) {
    return { ok: false, error: "verify_required — verify wallet ownership with a one-time signature before protecting (viewing needs nothing)" };
  }
  return { ok: true };
};

/**
 * May this caller CLOSE protection early? The soft owner-check (no wallet popup):
 *   1. a signer-verified wallet (current ToS version) always may — the cryptographic owner
 *   2. the holder of the account's control token may — issued to whichever client opened
 *      protection, so "the device that turned it on can turn it off"
 *   3. accounts with no token yet (wraps opened before the gate existed) stay closable —
 *      never strand a legacy wrap
 * Everyone else is refused: a stranger who knows the address cannot force a clawback.
 */
export const closeAllowed = (
  pref: { controlToken?: string } | undefined,
  acceptance: TosAcceptance | undefined,
  tosVersion: string,
  providedToken: string
): boolean => {
  if (acceptance?.version === tosVersion && acceptance.signerVerified === true) return true;
  if (!pref?.controlToken) return true; // legacy — no token was ever issued to demand
  return providedToken.length > 0 && providedToken === pref.controlToken;
};
