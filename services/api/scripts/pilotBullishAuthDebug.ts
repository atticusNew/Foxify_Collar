import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

const normalizePem = (value: string): string => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const withoutWrappingQuotes =
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("\"") && normalized.endsWith("\""))
      ? normalized.slice(1, -1)
      : normalized;
  const withNewlines = withoutWrappingQuotes.replace(/\\n/g, "\n").trim();
  const beginMatch = withNewlines.match(/-----BEGIN ([A-Z ]+)-----/);
  const endMatch = withNewlines.match(/-----END ([A-Z ]+)-----/);
  if (!beginMatch || !endMatch) return withNewlines;
  const label = beginMatch[1].trim();
  const body = withNewlines
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") || body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
};

const sha256Hex = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

const parseMetadata = (
  encoded: string
): { userId: string | null; userIdType: string; parseError: string | null } => {
  const normalized = String(encoded || "").trim();
  if (!normalized) return { userId: null, userIdType: "missing", parseError: "metadata_missing" };
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const rawUserId = parsed.userId;
    return {
      userId: rawUserId === undefined || rawUserId === null ? null : String(rawUserId),
      userIdType: rawUserId === undefined || rawUserId === null ? "missing" : typeof rawUserId,
      parseError: null
    };
  } catch (error) {
    return {
      userId: null,
      userIdType: "unknown",
      parseError: String((error as Error)?.message || error)
    };
  }
};

const resolveEffectiveHost = (): { value: string; sourceEnv: string } => {
  const candidates: Array<{ key: string; value: string }> = [
    {
      key: "PILOT_BULLISH_REST_BASE_URL",
      value: String(process.env.PILOT_BULLISH_REST_BASE_URL || "").trim()
    },
    {
      key: "PILOT_BULLISH_API_HOSTNAME",
      value: String(process.env.PILOT_BULLISH_API_HOSTNAME || "").trim()
    },
    {
      key: "BULLISH_TESTNET_API_HOSTNAME",
      value: String(process.env.BULLISH_TESTNET_API_HOSTNAME || "").trim()
    },
    {
      key: "BULLISH_API_HOSTNAME",
      value: String(process.env.BULLISH_API_HOSTNAME || "").trim()
    }
  ];
  const hit = candidates.find((entry) => Boolean(entry.value));
  if (hit) return { value: hit.value, sourceEnv: hit.key };
  return {
    value: "https://api.exchange.bullish.com",
    sourceEnv: "default"
  };
};

const fingerprintProvidedPublicKey = (publicPem: string): string => {
  const normalized = normalizePem(publicPem);
  if (!normalized) {
    throw new Error("public_key_missing");
  }
  const keyObject = createPublicKey({
    key: normalized,
    format: "pem",
    type: "spki"
  });
  const der = keyObject.export({ format: "der", type: "spki" }) as Buffer;
  return sha256Hex(der);
};

const fingerprintDerivedPublicKeyFromPrivate = (privatePem: string): string => {
  const normalized = normalizePem(privatePem);
  if (!normalized) {
    throw new Error("private_key_missing");
  }
  const beginLabel = normalized.match(/-----BEGIN ([A-Z ]+)-----/)?.[1]?.trim();
  const type = beginLabel === "EC PRIVATE KEY" ? "sec1" : beginLabel === "PRIVATE KEY" ? "pkcs8" : undefined;
  if (!type) {
    throw new Error(`private_key_type_unsupported:${beginLabel || "unknown"}`);
  }
  const privateKey = createPrivateKey({
    key: normalized,
    format: "pem",
    type
  });
  const derivedPublic = createPublicKey(privateKey);
  const der = derivedPublic.export({ format: "der", type: "spki" }) as Buffer;
  return sha256Hex(der);
};

const main = async () => {
  const host = resolveEffectiveHost();
  const metadata = parseMetadata(String(process.env.PILOT_BULLISH_ECDSA_METADATA || ""));

  const providedPublicKeyFingerprintSha256Hex = fingerprintProvidedPublicKey(
    String(process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "")
  );
  const derivedPublicKeyFingerprintSha256Hex = fingerprintDerivedPublicKeyFromPrivate(
    String(process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "")
  );

  console.log(
    JSON.stringify(
      {
        status: "ok",
        effectiveHost: host,
        decodedMetadataUserId: {
          value: metadata.userId,
          type: metadata.userIdType,
          parseError: metadata.parseError
        },
        derivedPublicKeyFingerprintSha256Hex,
        providedPublicKeyFingerprintSha256Hex,
        publicPrivateMatch: derivedPublicKeyFingerprintSha256Hex === providedPublicKeyFingerprintSha256Hex
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "bullish_auth_debug_failed",
        message: String((error as Error)?.message || error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
