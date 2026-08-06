/**
 * Hyperliquid L1-action signing — pure functions, no I/O.
 *
 * Hyperliquid authenticates exchange actions with an EIP-712 signature over a "phantom agent":
 *   1. actionHash = keccak256( msgpack(action) || nonce(8B BE) || vaultFlag )
 *   2. phantomAgent = { source: "a" (mainnet) | "b" (testnet), connectionId: actionHash }
 *   3. digest = EIP-712(domain{name:"Exchange",version:"1",chainId:1337,verifyingContract:0x0}, Agent(phantomAgent))
 *   4. signature = secp256k1.sign(digest, privateKey) → { r, s, v }
 *
 * msgpack field ORDER matters (the server hashes the exact bytes) — callers must build action
 * objects with fields in the documented order (e.g. orders: a, b, p, s, r, t).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encode as msgpackEncode } from "@msgpack/msgpack";

export type HlSignature = { r: string; s: string; v: number };

const u64be = (n: number): Uint8Array => {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

const u256be = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);

/** keccak256( msgpack(action) || nonce || vaultFlag ) — the "connectionId" of the phantom agent. */
export const actionHash = (action: unknown, nonce: number, vaultAddress: string | null = null): Uint8Array => {
  const packed = msgpackEncode(action);
  const vault = vaultAddress == null ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), hexToBytes(vaultAddress.replace(/^0x/, "")));
  return keccak(concatBytes(packed, u64be(nonce), vault));
};

/** EIP-712 digest over the phantom agent (domain "Exchange"/1/1337/0x0, type Agent(string source,bytes32 connectionId)). */
export const phantomAgentDigest = (connectionId: Uint8Array, isMainnet: boolean): Uint8Array => {
  const domainTypeHash = keccak(utf8ToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak(
    concatBytes(domainTypeHash, keccak(utf8ToBytes("Exchange")), keccak(utf8ToBytes("1")), u256be(1337n), new Uint8Array(32))
  );
  const agentTypeHash = keccak(utf8ToBytes("Agent(string source,bytes32 connectionId)"));
  const structHash = keccak(concatBytes(agentTypeHash, keccak(utf8ToBytes(isMainnet ? "a" : "b")), connectionId));
  return keccak(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
};

/** Sign an L1 action. privateKeyHex: 0x-prefixed 32-byte hex. */
export const signL1Action = (action: unknown, nonce: number, privateKeyHex: string, isMainnet: boolean, vaultAddress: string | null = null): HlSignature => {
  const digest = phantomAgentDigest(actionHash(action, nonce, vaultAddress), isMainnet);
  // noble/curves v2: prehash defaults ON (sha256 of the message) — HL signs the raw EIP-712
  // digest, so prehash must be OFF. "recovered" format → 65 bytes [recovery, r, s].
  const bytes = secp256k1.sign(digest, hexToBytes(privateKeyHex.replace(/^0x/, "")), { format: "recovered", prehash: false });
  const sig = secp256k1.Signature.fromBytes(bytes, "recovered");
  return {
    r: "0x" + sig.r.toString(16).padStart(64, "0"),
    s: "0x" + sig.s.toString(16).padStart(64, "0"),
    v: 27 + (sig.recovery ?? 0)
  };
};

/** Ethereum address for a private key (self-check + agent registration flows). */
export const addressFromPrivateKey = (privateKeyHex: string): string => {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex.replace(/^0x/, "")), false);
  return "0x" + bytesToHex(keccak(pub.slice(1)).slice(12));
};

/** Recover the signing address from a signature over an L1 action (test/audit helper). */
export const recoverL1ActionAddress = (action: unknown, nonce: number, sig: HlSignature, isMainnet: boolean, vaultAddress: string | null = null): string => {
  const digest = phantomAgentDigest(actionHash(action, nonce, vaultAddress), isMainnet);
  // noble "recovered" layout: [recoveryByte, r(32), s(32)]
  const rsBytes = concatBytes(new Uint8Array([sig.v - 27]), u256be(BigInt(sig.r)), u256be(BigInt(sig.s)));
  const s = secp256k1.Signature.fromBytes(rsBytes, "recovered");
  const pub = s.recoverPublicKey(digest).toBytes(false);
  return "0x" + bytesToHex(keccak(pub.slice(1)).slice(12));
};
