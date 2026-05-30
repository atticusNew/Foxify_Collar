import { inspectBullishEcdsaKeyMaterial } from "../src/pilot/bullish";

const main = async () => {
  const inspection = inspectBullishEcdsaKeyMaterial({
    publicKey: String(process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || ""),
    privateKey: String(process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || ""),
    metadata: String(process.env.PILOT_BULLISH_ECDSA_METADATA || "")
  });
  console.log(
    JSON.stringify(
      {
        status: "ok",
        metadataUserIdPresent: inspection.metadataUserIdPresent,
        publicKey: inspection.publicKey,
        privateKey: inspection.privateKey
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
        reason: "bullish_key_check_failed",
        message: String((error as Error)?.message || error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
