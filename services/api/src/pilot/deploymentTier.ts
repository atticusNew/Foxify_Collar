/**
 * Deployment tier — single source of truth for "is this service live or
 * shadow?". Used by:
 *
 *   - server.ts boot to assert invariants (refuse to boot on misconfig)
 *   - volumeCoverRoutes.ts to 403-gate Foxify HMAC routes on shadow
 *   - any future code that needs to behave differently per tier
 *
 * Tiers:
 *
 *   live    — production traffic accepted. The committed default. Foxify
 *             HMAC routes work, real venue fills happen.
 *   shadow  — admin-only. Foxify HMAC routes return 403 regardless of
 *             signature validity. Default to mock-mode hedge fills
 *             (VOLUME_COVER_HEDGE_MOCK=true) unless explicitly overridden
 *             via PILOT_SHADOW_ALLOW_REAL_FILLS=true. Distinct admin
 *             token + HMAC secret expected.
 *
 * Invariants enforced at boot:
 *
 *   1. Tier value must be 'live' or 'shadow' (or unset → defaults to 'live').
 *   2. tier=live AND VOLUME_COVER_HEDGE_MOCK=true → refuse boot. Mock fills
 *      on live would silently fail to hedge real positions.
 *   3. tier=shadow AND VOLUME_COVER_HEDGE_MOCK=false AND
 *      PILOT_SHADOW_ALLOW_REAL_FILLS unset → refuse boot. Defense in depth
 *      against accidental real fills on the experimental tier.
 *   4. tier=shadow AND FOXIFY_API_KEY_HMAC_SECRET equals the value used on
 *      live (we can't detect this directly, but the operator deploy guide
 *      documents the requirement to generate a distinct shadow secret).
 *
 * The boot check fails CLOSED — if any invariant is violated, the
 * service refuses to start and emits a clear error message.
 */

export type DeploymentTier = "live" | "shadow";

export const DEPLOYMENT_TIER_ENV = "PILOT_DEPLOYMENT_TIER";
export const HEDGE_MOCK_ENV = "VOLUME_COVER_HEDGE_MOCK";
export const SHADOW_ALLOW_REAL_FILLS_ENV = "PILOT_SHADOW_ALLOW_REAL_FILLS";

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v.toLowerCase() === "true";

/**
 * Parse the raw PILOT_DEPLOYMENT_TIER env. Unset → 'live' (back-compat
 * with services that pre-date this module). Unrecognized values throw.
 */
export const parseDeploymentTier = (raw: string | undefined): DeploymentTier => {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "live") return "live";
  if (v === "shadow") return "shadow";
  throw new Error(
    `invalid_${DEPLOYMENT_TIER_ENV}:${raw}_expected_live_or_shadow`
  );
};

export const getDeploymentTier = (): DeploymentTier =>
  parseDeploymentTier(process.env[DEPLOYMENT_TIER_ENV]);

export const isShadowTier = (): boolean => getDeploymentTier() === "shadow";
export const isLiveTier = (): boolean => getDeploymentTier() === "live";

export type DeploymentInvariantViolation = {
  code: string;
  message: string;
};

/**
 * Pure check — returns null on success, an array of violations on
 * failure. Used by `assertDeploymentInvariants()`; exported so tests can
 * exercise it without throwing.
 */
export const checkDeploymentInvariants = (
  env: Record<string, string | undefined> = process.env
): DeploymentInvariantViolation[] => {
  const violations: DeploymentInvariantViolation[] = [];
  let tier: DeploymentTier;
  try {
    tier = parseDeploymentTier(env[DEPLOYMENT_TIER_ENV]);
  } catch (err) {
    return [{ code: "invalid_tier", message: (err as Error).message }];
  }
  const mockEnabled = truthy(env[HEDGE_MOCK_ENV]);
  const shadowRealFillsAllowed = truthy(env[SHADOW_ALLOW_REAL_FILLS_ENV]);

  if (tier === "live" && mockEnabled) {
    violations.push({
      code: "live_with_mock_fills",
      message:
        "PILOT_DEPLOYMENT_TIER=live but VOLUME_COVER_HEDGE_MOCK=true. " +
        "Mock fills on the live tier would silently fail to hedge real " +
        "positions. Refusing to boot. Either set " +
        "PILOT_DEPLOYMENT_TIER=shadow or remove VOLUME_COVER_HEDGE_MOCK."
    });
  }

  if (tier === "shadow" && !mockEnabled && !shadowRealFillsAllowed) {
    violations.push({
      code: "shadow_without_mock_or_explicit_override",
      message:
        "PILOT_DEPLOYMENT_TIER=shadow requires VOLUME_COVER_HEDGE_MOCK=true " +
        "by default. To opt into real venue fills on shadow (e.g. for a " +
        "Bullish mainnet round-trip test), set " +
        "PILOT_SHADOW_ALLOW_REAL_FILLS=true explicitly."
    });
  }

  return violations;
};

/**
 * Boot-time invariant check. Throws on first violation; the server
 * crash-loops on Render until the operator fixes the env. Calling this
 * before route registration ensures we never accept traffic in a
 * misconfigured tier.
 */
export const assertDeploymentInvariants = (): void => {
  const violations = checkDeploymentInvariants();
  if (violations.length === 0) return;
  const summary = violations
    .map((v) => `[${v.code}] ${v.message}`)
    .join("\n");
  throw new Error(`deployment_invariants_violated:\n${summary}`);
};

/**
 * Used by request gates (e.g. Foxify HMAC routes) to short-circuit
 * non-live tiers. Returns true if the request should be blocked solely
 * because of the tier.
 */
export const tierBlocksFoxifyTraffic = (): boolean => isShadowTier();
