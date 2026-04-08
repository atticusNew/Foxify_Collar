import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, PILOT_TERMS_VERSION } from "./config";

type TierLevel = {
  name: string;
  drawdownFloorPct: number;
  expiryDays: number;
  renewWindowMinutes: number;
};

type ProtectionType = "long" | "short";

type V7QuoteInfo = {
  regime: string;
  regimeSource: string;
  dvol: number | null;
  premiumPer1kUsd: number;
  premiumUsd: number;
  payoutPer10kUsd: number;
  available: boolean;
};

type QuoteResult = {
  protectionType?: ProtectionType;
  tierName: string;
  slPct?: number | null;
  v7?: V7QuoteInfo | null;
  drawdownFloorPct: string;
  floorPrice: string;
  triggerPrice?: string;
  triggerLabel?: string;
  quote: {
    quoteId: string;
    instrumentId: string;
    premium: number;
    expiresAt: string;
    quantity: number;
    venue: string;
    details?: Record<string, unknown>;
  };
  entrySnapshot: {
    price: string;
    marketId?: string;
    source: string;
    timestamp: string;
    requestId?: string;
  };
  entryInputPrice?: string | null;
  limits?: {
    minQuoteNotionalUsdc?: string;
    maxProtectionNotionalUsdc: string;
    maxDailyProtectedNotionalUsdc: string;
    dailyUsedUsdc: string;
    projectedDailyUsdc: string;
    dailyCapExceededOnActivate: boolean;
  };
  diagnostics?: Record<string, unknown>;
};

type MonitorPayload = {
  protectionId: string;
  status: string;
  protectionType: ProtectionType;
  referencePrice: string;
  referenceSource: string;
  referenceTimestamp: string;
  triggerPrice: string;
  distanceToTriggerPct: string;
  optionMarkUsd: string;
  markSource: string;
  markDetails?: Record<string, unknown> | null;
  estimatedTriggerValue: string;
  asOf: string;
};

type ReferencePricePayload = {
  status: "ok" | "error";
  reference?: {
    price: string;
    marketId: string;
    venue?: string;
    source: string;
    timestamp: string;
    requestId?: string;
    ageMs?: number;
    freshnessMaxMs?: number;
  };
  reason?: string;
  message?: string;
};

type AdminProtectionRow = {
  protection_id: string;
  status: string;
  tier_name: string | null;
  drawdown_floor_pct: string | null;
  created_at: string;
  expiry_at: string;
  market_id: string;
  entry_price: string | null;
  floor_price: string | null;
  expiry_price: string | null;
  protected_notional: string;
  premium: string | null;
  payout_due_amount: string | null;
  payout_settled_amount: string | null;
  venue: string | null;
  instrument_id: string | null;
  external_order_id: string | null;
  external_execution_id: string | null;
};

type AdminLedgerEntry = {
  id: string;
  entryType: string;
  amount: string;
  currency: string;
  reference: string | null;
  createdAt: string;
  settledAt: string | null;
};

type AdminBrokerBalanceSnapshot = {
  source: "ibkr_account_summary";
  readOnly: true;
  accountId: string | null;
  currency: string;
  netLiquidationUsd: string;
  availableFundsUsd: string;
  excessLiquidityUsd: string;
  buyingPowerUsd: string;
  asOf: string;
};

type AdminMetrics = {
  totalProtections: string;
  activeProtections: string;
  protectedNotionalTotalUsdc: string;
  protectedNotionalActiveUsdc: string;
  clientPremiumTotalUsdc: string;
  hedgePremiumTotalUsdc: string;
  bookedMarginUsdc: string;
  bookedMarginPct: string;
  premiumDueTotalUsdc: string;
  premiumSettledTotalUsdc: string;
  payoutDueTotalUsdc: string;
  payoutSettledTotalUsdc: string;
  pendingPremiumReceivableUsdc: string;
  openPayoutLiabilityUsdc: string;
  startingReserveUsdc: string;
  availableReserveUsdc: string;
  reserveAfterOpenPayoutLiabilityUsdc: string;
  netSettledCashUsdc: string;
  brokerBalanceSnapshot?: AdminBrokerBalanceSnapshot | null;
};

type AdminScope = "active" | "open" | "all";
type AdminStatusFilter =
  | "all"
  | "pending_activation"
  | "activation_failed"
  | "active"
  | "reconcile_pending"
  | "awaiting_renew_decision"
  | "awaiting_expiry_price"
  | "expired_itm"
  | "expired_otm"
  | "cancelled";

type ProtectionRecord = {
  id: string;
  status: string;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  protectedNotional: string;
  foxifyExposureNotional: string;
  entryPrice: string | null;
  expiryAt: string;
  premium: string | null;
  autoRenew: boolean;
  renewWindowMinutes: number;
  venue: string | null;
  metadata?: Record<string, unknown> | null;
};

type PilotTermsStatusResponse = {
  status: "ok" | "error";
  accepted?: boolean;
  acceptedAt?: string | null;
  termsVersion?: string;
  reason?: string;
  message?: string;
};

const formatUsd = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const DEFAULT_TIERS: TierLevel[] = [
  { name: "SL 1%", drawdownFloorPct: 0.01, expiryDays: 2, renewWindowMinutes: 1440 },
  { name: "SL 2%", drawdownFloorPct: 0.02, expiryDays: 2, renewWindowMinutes: 1440 },
  { name: "SL 3%", drawdownFloorPct: 0.03, expiryDays: 2, renewWindowMinutes: 1440 },
  { name: "SL 5%", drawdownFloorPct: 0.05, expiryDays: 2, renewWindowMinutes: 1440 },
  { name: "SL 10%", drawdownFloorPct: 0.10, expiryDays: 2, renewWindowMinutes: 1440 }
];
const V7_SL_TIERS = [1, 2, 3, 5, 10] as const;
const STATIC_TENOR_CHIPS_DAYS = [1, 2, 7] as const;
const PILOT_DEFAULT_TENOR_DAYS = STATIC_TENOR_CHIPS_DAYS[0];
// Keep UI quote timeout aligned with backend quote budgets and avoid hidden post-countdown retries.
const QUOTE_REQUEST_TIMEOUT_MS = 30000;
const QUOTE_RETRY_DELAY_MS = 450;
const QUOTE_REQUEST_MAX_ATTEMPTS = 3;
const QUOTE_REQUEST_TOTAL_TIMEOUT_MS = QUOTE_REQUEST_TIMEOUT_MS;
const QUOTE_REQUEST_TIMEOUT_SECONDS = Math.ceil(QUOTE_REQUEST_TOTAL_TIMEOUT_MS / 1000);

const formatPct = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00%";
  return `${(parsed * 100).toFixed(2)}%`;
};

const formatCurrencyInput = (value: string): string => {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  const [wholeRaw, ...fractionParts] = cleaned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractionParts.length === 0) return grouped;
  const fraction = fractionParts.join("").slice(0, 8);
  return `${grouped}.${fraction}`;
};

const parseCurrencyNumber = (value: string): number => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const clampInt = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value)));

const formatCountdown = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const formatTargetHorizonLabel = (days: number): string => `${Math.max(1, Math.floor(days))}-Day`;

const formatMatchedHorizonLabel = (days: number): string => {
  if (!Number.isFinite(days)) return "N/A";
  return `${Math.max(1, Math.round(days))}-Day`;
};

const formatExpiryDateLabel = (expiryRaw: string): string => {
  const normalized = String(expiryRaw || "").replace(/[^0-9]/g, "").slice(0, 8);
  if (normalized.length !== 8) return "";
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
};

type QuoteLiquidityStatus = "normal" | "thin";
type ActivateModalMode = "live" | "preview";
const LIQUIDITY_STATUS_TTL_MS = 5 * 60 * 1000;
const LIQUIDITY_THIN_CONFIRMATION_COUNT = 1;
const LIQUIDITY_NORMAL_CONFIRMATION_COUNT = 2;
const MIN_QUOTE_NOTIONAL_USDC = 7500;
const MAX_PROTECTION_NOTIONAL_USDC = 20000;

const formatUsdNoDecimals = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

const friendlyError = (message: string): string => {
  if (message.includes("no_liquidity_window")) {
    return "No liquidity or options available right now, try again";
  }
  if (
    message.includes("service_unavailable") ||
    message.includes("http_503") ||
    message.includes("admin_service_unavailable")
  ) {
    return "Service is temporarily unavailable (503). Please retry shortly.";
  }
  if (message.includes("daily_notional_cap_exceeded")) {
    return "Daily protection limit reached for pilot operations. Please try again next UTC day.";
  }
  if (message.includes("protection_notional_cap_exceeded")) {
    return "Protection amount exceeds the pilot maximum. Reduce amount and request a new quote.";
  }
  if (message.includes("quote_expired")) {
    return "Quote expired. Request a fresh quote and confirm again.";
  }
  if (message.includes("quote_not_found")) {
    return "Quote is no longer available. Tap Refresh Quote.";
  }
  if (message.includes("quote_mismatch")) {
    return "Protection terms changed after quoting. Request a new quote before confirming.";
  }
  if (message.includes("price_unavailable")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("storage_unavailable")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("quote_generation_failed")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("activation_disabled")) {
    return "Activation is paused while quote validation is in progress. You can continue requesting live quotes.";
  }
  if (message.includes("tenor_drift_exceeded")) {
    return "Requested protection length is currently illiquid. Try the recommended tenor.";
  }
  if (message.includes("tenor_temporarily_unavailable")) {
    return "Requested protection length is temporarily unavailable. Try the recommended tenor.";
  }
  if (message.includes("quote_economics_unacceptable")) {
    return "Current hedge premium is not economical for this protection. Try again with a different tenor.";
  }
  if (message.includes("min_tradable_notional_exceeded")) {
    return "Protection amount is currently too small for a tradable contract size. Increase amount or choose another tenor.";
  }
  if (message.includes("quote_liquidity_unavailable")) {
    return "No liquidity or options available right now, try again";
  }
  if (message.includes("quote_min_notional_not_met")) {
    return "Pilot minimum quote size is enforced. Increase protection amount and request a new quote.";
  }
  if (message.includes("venue_quote_timeout")) {
    return "Quote timed out. Live venue response exceeded 20s. Tap Refresh Quote.";
  }
  if (message.includes("venue_execute_timeout")) {
    return "Activation is taking longer than expected. Tap Confirm Protection again.";
  }
  if (message.includes("execution_failed")) {
    return "Venue execution failed. Request a fresh quote and retry.";
  }
  if (message.includes("reconcile_pending")) {
    return "Execution appears submitted, but reconciliation is pending. Contact operations before retrying.";
  }
  if (message.includes("quote_not_activatable")) {
    return "This quote is linked to a failed activation state. Request a fresh quote.";
  }
  if (message.includes("full_coverage_not_met")) {
    return "Coverage check changed. Tap Refresh Quote and confirm again.";
  }
  if (message.includes("activation_failed")) {
    return "Activation could not be confirmed yet. Tap Confirm Protection again.";
  }
  if (message.toLowerCase().includes("failed to fetch")) {
    return "Network issue detected. Please retry.";
  }
  if (message.includes("admin_unauthorized") || message.includes("unauthorized")) {
    return "Admin access denied. Verify admin token and PILOT_ADMIN_IP_ALLOWLIST / trusted proxy IP settings.";
  }
  return "Unable to complete request. Please retry.";
};

const isPriceUnavailableError = (message: string | null): boolean =>
  Boolean(message && message.toLowerCase().includes("quote temporarily unavailable"));

const isQuoteUnavailableError = (message: string | null): boolean => {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("liquidity") ||
    lower.includes("no_top_of_book") ||
    lower.includes("off-market") ||
    lower.includes("after-market") ||
    lower.includes("timed out") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("503") ||
    lower.includes("http_503") ||
    lower.includes("service_unavailable")
  );
};

const parseApiBody = async (res: Response): Promise<{ payload: any; rawText: string }> => {
  const rawText = await res.text();
  if (!rawText) return { payload: null, rawText: "" };
  try {
    return { payload: JSON.parse(rawText), rawText };
  } catch {
    return { payload: null, rawText };
  }
};

const isRetryableQuoteError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("price_unavailable") ||
    lower.includes("quote_generation_failed") ||
    lower.includes("storage_unavailable") ||
    lower.includes("fetch failed") ||
    lower.includes("network issue")
  );
};

const isRetryableActivationError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("venue_execute_timeout") ||
    lower.includes("storage_unavailable") ||
    lower.includes("price_unavailable") ||
    lower.includes("activation_failed") ||
    lower.includes("fetch failed")
  );
};

const classifyLiquidityFromError = (message: string): QuoteLiquidityStatus => {
  const lower = String(message || "").toLowerCase();
  if (
    lower.includes("quote_liquidity_unavailable") ||
    lower.includes("no_top_of_book") ||
    lower.includes("no_liquidity_window") ||
    lower.includes("venue_quote_timeout") ||
    lower.includes("quote_generation_timeout") ||
    lower.includes("service unavailable") ||
    lower.includes("service_unavailable") ||
    lower.includes("http_503") ||
    lower.includes("503")
  ) {
    return "thin";
  }
  return "normal";
};

const formatVenueLabel = (venue: string | null | undefined): string => {
  const normalized = String(venue || "").trim().toLowerCase();
  if (normalized === "deribit_test") return "Deribit (Live Data, Paper Exec)";
  if (normalized === "ibkr_cme_live") return "IBKR CME (Live)";
  if (normalized === "ibkr_cme_paper") return "IBKR CME (Paper)";
  if (normalized === "falconx") return "FalconX Live";
  if (normalized === "mock_falconx") return "Mock FalconX";
  return normalized || "Unknown";
};

const toTermsVersionDisplay = (rawVersion: string): string => {
  const normalized = String(rawVersion || "").trim();
  const match = normalized.match(/^v?(\d+)(?:\.(\d+))?/i);
  if (!match) return "v1.0";
  const major = match[1] || "1";
  const minor = (match[2] || "0").charAt(0) || "0";
  return `v${major}.${minor}`;
};

const PILOT_TERMS_VERSION_DISPLAY = toTermsVersionDisplay(PILOT_TERMS_VERSION);

const FOXIFY_LOGO_URL = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";
const ATTICUS_LOGO_URL = "https://i.ibb.co/KpbRyd7w/atticus-copy.png";
const PILOT_SUPPORT_EMAIL = "michael@atticustrade.com";
const PILOT_SUPPORT_TELEGRAM = "@willialso";

export function PilotApp() {
  const termsLocalStorageKey = `pilot_terms_accepted_${PILOT_TERMS_VERSION}`;
  const [pilotUnlocked, setPilotUnlocked] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(termsLocalStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [termsStatus, setTermsStatus] = useState<"checking" | "required" | "accepted">("checking");
  const [termsBusy, setTermsBusy] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [termsChecked, setTermsChecked] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(termsLocalStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [foxifyLogoFailed, setFoxifyLogoFailed] = useState(false);
  const [atticusLogoFailed, setAtticusLogoFailed] = useState(false);
  const [tiers, setTiers] = useState<TierLevel[]>(DEFAULT_TIERS);
  const [tierName, setTierName] = useState(DEFAULT_TIERS[0].name);
  const [protectionType, setProtectionType] = useState<ProtectionType>("long");
  const [exposureNotional, setExposureNotional] = useState("");
  const [protectedNotional, setProtectedNotional] = useState("");
  const [autoRenew, setAutoRenew] = useState(false);
  const [selectedTenorDays, setSelectedTenorDays] = useState<number>(PILOT_DEFAULT_TENOR_DAYS);
  const staticTenorOptions = STATIC_TENOR_CHIPS_DAYS as readonly number[];
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [protection, setProtection] = useState<ProtectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoteState, setQuoteState] = useState<"idle" | "fetching" | "ready" | "expired">("idle");
  const [quoteRequestTimeLeft, setQuoteRequestTimeLeft] = useState(QUOTE_REQUEST_TIMEOUT_SECONDS);
  const [quoteTimeLeft, setQuoteTimeLeft] = useState(0);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [showActivateConfirmModal, setShowActivateConfirmModal] = useState(false);
  const [activateModalMode, setActivateModalMode] = useState<ActivateModalMode>("live");
  const [activationPreviewNotice, setActivationPreviewNotice] = useState<string | null>(null);
  const [showProtectionModal, setShowProtectionModal] = useState(false);
  const [monitor, setMonitor] = useState<MonitorPayload | null>(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [protectionsHistory, setProtectionsHistory] = useState<ProtectionRecord[]>([]);
  const [showFailedProtections, setShowFailedProtections] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminRows, setAdminRows] = useState<AdminProtectionRow[]>([]);
  const [adminScope, setAdminScope] = useState<AdminScope>("active");
  const [adminStatusFilter, setAdminStatusFilter] = useState<AdminStatusFilter>("all");
  const [adminIncludeArchived, setAdminIncludeArchived] = useState(false);
  const [adminSelectedId, setAdminSelectedId] = useState<string | null>(null);
  const [adminLedger, setAdminLedger] = useState<AdminLedgerEntry[]>([]);
  const [adminDetailProtection, setAdminDetailProtection] = useState<ProtectionRecord | null>(null);
  const [adminMonitor, setAdminMonitor] = useState<MonitorPayload | null>(null);
  const [adminMetrics, setAdminMetrics] = useState<AdminMetrics | null>(null);
  const [adminViewingId, setAdminViewingId] = useState<string | null>(null);
  const [showAdminDetailModal, setShowAdminDetailModal] = useState(false);
  const [adminDetailUpdatedAt, setAdminDetailUpdatedAt] = useState<Date | null>(null);
  const [showHistorySection, setShowHistorySection] = useState(true);
  const [showPilotSummary, setShowPilotSummary] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [monitorUpdatedAt, setMonitorUpdatedAt] = useState<Date | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [liveReference, setLiveReference] = useState<ReferencePricePayload["reference"] | null>(null);
  const [liveReferenceBusy, setLiveReferenceBusy] = useState(false);
  const [liveReferenceError, setLiveReferenceError] = useState<string | null>(null);
  const [liquiditySignalStatus, setLiquiditySignalStatus] = useState<QuoteLiquidityStatus>("normal");
  const [liquiditySignalAtMs, setLiquiditySignalAtMs] = useState<number>(0);
  const liquidityTransitionRef = useRef<{ thinSignals: number; normalSignals: number }>({
    thinSignals: 0,
    normalSignals: 0
  });
  const quoteSectionRef = useRef<HTMLDivElement | null>(null);
  const actionsSectionRef = useRef<HTMLDivElement | null>(null);
  const historyRequestSeqRef = useRef(0);
  const monitorRequestSeqRef = useRef(0);
  const protectionPollSeqRef = useRef(0);
  const recordLiquiditySignal = (nextStatus: QuoteLiquidityStatus): void => {
    const state = liquidityTransitionRef.current;
    if (nextStatus === "thin") {
      state.thinSignals += 1;
      state.normalSignals = 0;
      if (state.thinSignals >= LIQUIDITY_THIN_CONFIRMATION_COUNT) {
        setLiquiditySignalStatus("thin");
        setLiquiditySignalAtMs(Date.now());
      }
      return;
    }
    state.normalSignals += 1;
    state.thinSignals = 0;
    if (state.normalSignals >= LIQUIDITY_NORMAL_CONFIRMATION_COUNT) {
      setLiquiditySignalStatus("normal");
      setLiquiditySignalAtMs(Date.now());
    }
  };
  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.name === tierName) || DEFAULT_TIERS[0],
    [tierName, tiers]
  );

  const minProtectionAmountUsdRaw = Number(quote?.limits?.minQuoteNotionalUsdc ?? NaN);
  const minProtectionAmountUsd =
    Number.isFinite(minProtectionAmountUsdRaw) && minProtectionAmountUsdRaw > 0
      ? minProtectionAmountUsdRaw
      : MIN_QUOTE_NOTIONAL_USDC;
  const maxProtectionAmountUsdRaw = Number(quote?.limits?.maxProtectionNotionalUsdc ?? NaN);
  const maxProtectionAmountUsd =
    Number.isFinite(maxProtectionAmountUsdRaw) && maxProtectionAmountUsdRaw > 0
      ? maxProtectionAmountUsdRaw
      : MAX_PROTECTION_NOTIONAL_USDC;
  const exposureValue = parseCurrencyNumber(exposureNotional || "0");
  const protectedValue = parseCurrencyNumber(protectedNotional || "0");
  const canQuote =
    pilotUnlocked &&
    Number.isFinite(exposureValue) &&
    exposureValue > 0 &&
    Number.isFinite(protectedValue) &&
    protectedValue > 0 &&
    protectedValue >= minProtectionAmountUsd &&
    protectedValue <= maxProtectionAmountUsd &&
    protectedValue <= exposureValue;
  const quotePremiumRatioPct =
    quote && Number.isFinite(quote.quote?.premium) && protectedValue > 0
      ? (Number(quote.quote.premium) / protectedValue) * 100
      : null;
  const quoteFresh =
    quoteState === "ready" && quote?.quote?.expiresAt ? Date.parse(quote.quote.expiresAt) > Date.now() : false;
  const quoteLocked = quoteFresh && Boolean(quote?.quote?.quoteId);
  const quoteCapWarning = quote?.limits?.dailyCapExceededOnActivate === true;
  const canActivate = canQuote && Boolean(quote?.quote?.quoteId) && quoteFresh && !quoteCapWarning;
  const showQuoteSection = quoteState !== "idle" || Boolean(quote) || Boolean(error);

  const renewWindowReached = useMemo(() => {
    if (!protection || protection.autoRenew || protection.status !== "active") return false;
    const expiryMs = Date.parse(protection.expiryAt);
    if (!Number.isFinite(expiryMs)) return false;
    const renewAtMs = expiryMs - protection.renewWindowMinutes * 60 * 1000;
    return Date.now() >= renewAtMs;
  }, [protection]);

  useEffect(() => {
    if (renewWindowReached) {
      setShowRenewModal(true);
    }
  }, [renewWindowReached]);

  useEffect(() => {
    let active = true;
    const loadTiers = async () => {
      try {
        const res = await fetch("/funded_levels.json");
        if (!res.ok) return;
        const payload = (await res.json()) as { levels?: Array<Record<string, unknown>> };
        const parsed = (payload.levels || [])
          .map((item) => {
            const name = typeof item.name === "string" ? item.name : "";
            const drawdown = Number(item.drawdown_limit_pct ?? 0);
            const expiryDays = Number(item.expiry_days ?? 7);
            const renewWindowMinutes = Number(item.renew_window_minutes ?? 1440);
            if (!name || !Number.isFinite(drawdown) || drawdown <= 0) return null;
            return {
              name,
              drawdownFloorPct: drawdown,
              expiryDays: Number.isFinite(expiryDays) && expiryDays > 0 ? Math.floor(expiryDays) : 7,
              renewWindowMinutes:
                Number.isFinite(renewWindowMinutes) && renewWindowMinutes > 0
                  ? Math.floor(renewWindowMinutes)
                  : 1440
            } as TierLevel;
          })
          .filter((item): item is TierLevel => Boolean(item));
        if (!active || parsed.length === 0) return;
        setTiers(parsed);
        if (!parsed.some((tier) => tier.name === tierName)) {
          setTierName(parsed[0].name);
        }
      } catch {
        // keep defaults on tier fetch failure
      }
    };
    loadTiers();
    return () => {
      active = false;
    };
  }, [tierName]);

  useEffect(() => {
    setQuote(null);
    setQuoteState("idle");
    setQuoteTimeLeft(0);
  }, [
    protectionType,
    selectedTier.name,
    selectedTier.drawdownFloorPct,
    selectedTenorDays,
    exposureNotional,
    protectedNotional
  ]);

  useEffect(() => {
    if (!staticTenorOptions.includes(selectedTenorDays)) {
      setSelectedTenorDays(PILOT_DEFAULT_TENOR_DAYS);
    }
  }, [selectedTenorDays, staticTenorOptions]);

  useEffect(() => {
    if (!pilotUnlocked) return;
    setSelectedTenorDays((prev) => (staticTenorOptions.includes(prev) ? prev : PILOT_DEFAULT_TENOR_DAYS));
  }, [pilotUnlocked, staticTenorOptions]);

  useEffect(() => {
    setTermsError(null);
    let cancelled = false;
    const controller = new AbortController();
    setTermsStatus("checking");
    const loadTermsStatus = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/pilot/terms/status?termsVersion=${encodeURIComponent(PILOT_TERMS_VERSION)}`,
          { signal: controller.signal }
        );
        const payload = (await res.json()) as PilotTermsStatusResponse;
        if (cancelled) return;
        if (!res.ok || payload.status !== "ok") {
          throw new Error(payload.reason || payload.message || "terms_status_failed");
        }
        if (payload.accepted) {
          setTermsStatus("accepted");
          setTermsChecked(true);
          setPilotUnlocked(true);
          if (typeof window !== "undefined") {
            try {
              window.localStorage.setItem(termsLocalStorageKey, "1");
            } catch {
              // best-effort cache only
            }
          }
          return;
        }
        setTermsStatus("required");
        setTermsChecked(false);
        setPilotUnlocked(false);
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(termsLocalStorageKey);
          } catch {
            // best-effort cache only
          }
        }
      } catch (error: any) {
        if (cancelled || error?.name === "AbortError") return;
        setTermsStatus("required");
        const locallyAccepted = (() => {
          if (typeof window === "undefined") return false;
          try {
            return window.localStorage.getItem(termsLocalStorageKey) === "1";
          } catch {
            return false;
          }
        })();
        if (!locallyAccepted) {
          setTermsChecked(false);
          setPilotUnlocked(false);
        }
        setTermsError("Unable to verify terms right now. You can still continue after confirming acceptance.");
      }
    };
    void loadTermsStatus();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [termsLocalStorageKey]);

  useEffect(() => {
    if (!pilotUnlocked) {
      setLiveReference(null);
      setLiveReferenceBusy(false);
      setLiveReferenceError(null);
      return;
    }
    let active = true;
    const loadReference = async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      if (!silent) {
        setLiveReferenceBusy(true);
      }
      try {
        const res = await fetch(`${API_BASE}/pilot/reference-price?marketId=BTC-USD`);
        const payload = (await res.json()) as ReferencePricePayload;
        if (!active) return;
        if (!res.ok || payload.status !== "ok" || !payload.reference) {
          throw new Error(payload.reason || payload.message || "price_unavailable");
        }
        setLiveReference(payload.reference);
        setLiveReferenceError(null);
      } catch (error: any) {
        if (!active) return;
        setLiveReferenceError(friendlyError(String(error?.message || "price_unavailable")));
      } finally {
        if (!silent && active) {
          setLiveReferenceBusy(false);
        }
      }
    };
    void loadReference();
    const id = setInterval(() => {
      void loadReference({ silent: true });
    }, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pilotUnlocked]);

  useEffect(() => {
    if (!quote?.quote?.expiresAt) {
      setQuoteTimeLeft(0);
      return;
    }
    const updateTime = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(quote.quote.expiresAt) - Date.now()) / 1000));
      setQuoteTimeLeft(seconds);
      if (seconds <= 0) {
        setQuoteState("expired");
      } else if (quoteState !== "fetching") {
        setQuoteState("ready");
      }
    };
    updateTime();
    const id = setInterval(updateTime, 1000);
    return () => clearInterval(id);
  }, [quote?.quote?.expiresAt, quoteState]);

  useEffect(() => {
    if (quoteState !== "fetching") {
      setQuoteRequestTimeLeft(QUOTE_REQUEST_TIMEOUT_SECONDS);
      return;
    }
    setQuoteRequestTimeLeft(QUOTE_REQUEST_TIMEOUT_SECONDS);
    const startedAt = Date.now();
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, QUOTE_REQUEST_TIMEOUT_SECONDS - elapsed);
      setQuoteRequestTimeLeft(remaining);
    }, 250);
    return () => clearInterval(id);
  }, [quoteState]);

  useEffect(() => {
    if (!protection?.id) return;
    const polledProtectionId = protection.id;
    const pollSeq = ++protectionPollSeqRef.current;
    const pollProtection = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/pilot/protections/${polledProtectionId}`
        );
        if (!res.ok) return;
        const payload = await res.json();
        if (protectionPollSeqRef.current !== pollSeq) return;
        if (payload?.protection && payload.protection.id === polledProtectionId) {
          setProtection(payload.protection as ProtectionRecord);
          setLastUpdatedAt(new Date());
        }
      } catch {
        // ignore polling errors in pilot widget
      }
    };
    void pollProtection();
    const id = setInterval(() => {
      void pollProtection();
    }, 10000);
    return () => {
      clearInterval(id);
      protectionPollSeqRef.current += 1;
    };
  }, [protection?.id, pilotUnlocked]);

  const refreshProtectionHistory = async (opts?: { clearExisting?: boolean; silent?: boolean }) => {
    const requestSeq = ++historyRequestSeqRef.current;
    const clearExisting = opts?.clearExisting === true;
    const silent = opts?.silent === true;
    if (!silent) {
      setHistoryBusy(true);
    }
    if (clearExisting) {
      setProtectionsHistory([]);
    }
    if (!pilotUnlocked) {
      if (requestSeq === historyRequestSeqRef.current) {
        setProtectionsHistory([]);
        if (!silent) setHistoryBusy(false);
      }
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/pilot/protections?limit=20`);
      if (!res.ok) return;
      const payload = await res.json();
      if (requestSeq !== historyRequestSeqRef.current) return;
      if (Array.isArray(payload?.protections)) {
        setProtectionsHistory(payload.protections as ProtectionRecord[]);
      }
    } catch {
      // ignore history refresh errors in pilot widget
    } finally {
      if (!silent && requestSeq === historyRequestSeqRef.current) {
        setHistoryBusy(false);
      }
    }
  };

  const refreshMonitor = async (protectionId: string) => {
    const requestSeq = ++monitorRequestSeqRef.current;
    setMonitorBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/pilot/protections/${protectionId}/monitor`
      );
      if (!res.ok) return;
      const payload = await res.json();
      if (requestSeq !== monitorRequestSeqRef.current) return;
      if (payload?.monitor && payload.monitor.protectionId === protectionId) {
        setMonitor(payload.monitor as MonitorPayload);
        setMonitorUpdatedAt(new Date());
      }
    } catch {
      // ignore monitor refresh errors in pilot widget
    } finally {
      if (requestSeq === monitorRequestSeqRef.current) {
        setMonitorBusy(false);
      }
    }
  };

  const loadAdminRows = async (
    token: string,
    opts?: { scope?: AdminScope; status?: AdminStatusFilter; includeArchived?: boolean }
  ) => {
    setAdminBusy(true);
    setAdminError(null);
    try {
      const scope = opts?.scope ?? adminScope;
      const status = opts?.status ?? adminStatusFilter;
      const includeArchived = opts?.includeArchived ?? adminIncludeArchived;
      const params = new URLSearchParams({
        format: "json",
        limit: "200",
        scope,
        status,
        includeArchived: includeArchived ? "true" : "false"
      });
      const [rowsRes, metricsRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/protections/export?${params.toString()}`, {
          headers: { "x-admin-token": token, "x-admin-actor": "web-admin" }
        }),
        fetch(`${API_BASE}/pilot/admin/metrics?scope=${encodeURIComponent(scope)}`, {
          headers: { "x-admin-token": token, "x-admin-actor": "web-admin" }
        })
      ]);
      const [rowsParsed, metricsParsed] = await Promise.all([parseApiBody(rowsRes), parseApiBody(metricsRes)]);
      const rowsPayload = rowsParsed.payload;
      const metricsPayload = metricsParsed.payload;
      if (!rowsRes.ok || rowsPayload?.status !== "ok" || !Array.isArray(rowsPayload?.rows)) {
        const reason = String(rowsPayload?.reason || "");
        if (reason === "unauthorized_admin" || rowsRes.status === 401) {
          throw new Error("admin_unauthorized");
        }
        if (rowsRes.status === 503) {
          throw new Error("admin_service_unavailable");
        }
        throw new Error(reason || `admin_load_failed:http_${rowsRes.status}`);
      }
      if (!metricsRes.ok || metricsPayload?.status !== "ok" || !metricsPayload?.metrics) {
        const reason = String(metricsPayload?.reason || "");
        if (reason === "unauthorized_admin" || metricsRes.status === 401) {
          throw new Error("admin_unauthorized");
        }
        if (metricsRes.status === 503) {
          throw new Error("admin_service_unavailable");
        }
        throw new Error(reason || `admin_metrics_failed:http_${metricsRes.status}`);
      }
      const rows = rowsPayload.rows as AdminProtectionRow[];
      const brokerBalanceSnapshotRaw = metricsPayload.brokerBalanceSnapshot;
      const brokerBalanceSnapshot =
        brokerBalanceSnapshotRaw &&
        typeof brokerBalanceSnapshotRaw === "object" &&
        !Array.isArray(brokerBalanceSnapshotRaw) &&
        String((brokerBalanceSnapshotRaw as Record<string, unknown>).source || "") === "ibkr_account_summary"
          ? (brokerBalanceSnapshotRaw as NonNullable<AdminMetrics["brokerBalanceSnapshot"]>)
          : null;
      setAdminRows(rows);
      setAdminMetrics({
        ...(metricsPayload.metrics as AdminMetrics),
        brokerBalanceSnapshot
      });
      setAdminScope(scope);
      setAdminStatusFilter(status);
      setAdminIncludeArchived(includeArchived);
      const nextSelected = adminSelectedId && rows.some((row) => row.protection_id === adminSelectedId)
        ? adminSelectedId
        : rows[0]?.protection_id || null;
      setAdminSelectedId(nextSelected);
      if (nextSelected) {
        await refreshAdminSelection(nextSelected, token);
      }
      setAdminToken(token);
    } catch (err: any) {
      setAdminError(friendlyError(String(err?.message || "admin_load_failed")));
    } finally {
      setAdminBusy(false);
    }
  };

  const refreshAdminSelection = async (protectionId: string, token: string) => {
    setAdminBusy(true);
    setAdminError(null);
    setAdminViewingId(protectionId);
    try {
      const [ledgerRes, monitorRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/admin/protections/${protectionId}/ledger`, {
          headers: { "x-admin-token": token, "x-admin-actor": "web-admin" }
        }),
        fetch(`${API_BASE}/pilot/admin/protections/${protectionId}/monitor`, {
          headers: { "x-admin-token": token, "x-admin-actor": "web-admin" }
        })
      ]);
      const [ledgerParsed, monitorParsed] = await Promise.all([parseApiBody(ledgerRes), parseApiBody(monitorRes)]);
      const ledgerPayload = ledgerParsed.payload;
      const monitorPayload = monitorParsed.payload;
      if (!ledgerRes.ok || ledgerPayload?.status !== "ok") {
        const reason = String(ledgerPayload?.reason || "");
        if (reason === "unauthorized_admin" || ledgerRes.status === 401) {
          throw new Error("admin_unauthorized");
        }
        if (ledgerRes.status === 503) {
          throw new Error("admin_service_unavailable");
        }
        throw new Error(reason || `admin_ledger_failed:http_${ledgerRes.status}`);
      }
      setAdminDetailProtection((ledgerPayload?.protection as ProtectionRecord) || null);
      setAdminLedger(Array.isArray(ledgerPayload?.ledger) ? (ledgerPayload.ledger as AdminLedgerEntry[]) : []);
      setAdminMonitor(monitorPayload?.monitor ? (monitorPayload.monitor as MonitorPayload) : null);
      setAdminDetailUpdatedAt(new Date());
    } catch (err: any) {
      setAdminError(friendlyError(String(err?.message || "admin_refresh_failed")));
    } finally {
      setAdminBusy(false);
      setAdminViewingId(null);
    }
  };

  useEffect(() => {
    void refreshProtectionHistory({ clearExisting: true });
  }, [pilotUnlocked]);

  useEffect(() => {
    setMonitor(null);
    setMonitorUpdatedAt(null);
  }, [protection?.id]);

  useEffect(() => {
    if (!showProtectionModal || !protection?.id) return;
    void refreshMonitor(protection.id);
    const id = setInterval(() => {
      void refreshMonitor(protection.id);
    }, 10000);
    return () => clearInterval(id);
  }, [showProtectionModal, protection?.id, pilotUnlocked]);

  useEffect(() => {
    if (!showAdminModal) {
      setShowAdminDetailModal(false);
    }
  }, [showAdminModal]);

  useEffect(() => {
    if (!Number.isFinite(liquiditySignalAtMs) || liquiditySignalAtMs <= 0) return;
    const remainingMs = LIQUIDITY_STATUS_TTL_MS - (Date.now() - liquiditySignalAtMs);
    if (remainingMs <= 0) {
      setLiquiditySignalStatus("normal");
      return;
    }
    const id = setTimeout(() => setLiquiditySignalStatus("normal"), remainingMs);
    return () => clearTimeout(id);
  }, [liquiditySignalStatus, liquiditySignalAtMs]);

  useEffect(() => {
    if (!showQuoteSection) return;
    quoteSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showQuoteSection, quoteState, quote?.quote?.quoteId, error]);

  useEffect(() => {
    if (quoteState !== "ready" && quoteState !== "expired") return;
    const id = window.setTimeout(() => {
      actionsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(id);
  }, [quoteState, quote?.quote?.quoteId]);

  const requestQuote = async () => {
    if (!canQuote) return;
    setBusy(true);
    setError(null);
    setQuote(null);
    setQuoteState("fetching");
    setQuoteRequestTimeLeft(QUOTE_REQUEST_TIMEOUT_SECONDS);
    const requestStartedAt = Date.now();
    let finalError: any = null;
    try {
      for (let attempt = 1; attempt <= QUOTE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
        const remainingBudgetMs = QUOTE_REQUEST_TOTAL_TIMEOUT_MS - (Date.now() - requestStartedAt);
        if (remainingBudgetMs <= 0) {
          finalError = new Error("quote_request_deadline_exceeded");
          break;
        }
        const controller = new AbortController();
        const attemptTimeoutMs = Math.max(250, Math.min(QUOTE_REQUEST_TIMEOUT_MS, remainingBudgetMs));
        const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
        try {
          const res = await fetch(`${API_BASE}/pilot/protections/quote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              protectedNotional: protectedValue,
              foxifyExposureNotional: exposureValue,
              protectionType,
              instrumentId: `BTC-USD-${selectedTenorDays}D-${protectionType === "short" ? "C" : "P"}`,
              marketId: "BTC-USD",
              slPct: selectedTier.drawdownFloorPct * 100,
              tierName: selectedTier.name,
              drawdownFloorPct: selectedTier.drawdownFloorPct,
              tenorDays: selectedTenorDays
            })
          });
          const parsed = await parseApiBody(res);
          const payload = parsed.payload;
          if (!res.ok || payload?.status !== "ok") {
            const reason = String(payload?.reason || "");
            const detail = String(payload?.detail || "");
            if (reason === "price_unavailable") {
              throw new Error(`price_unavailable${detail ? `:${detail}` : ""}`);
            }
            if (reason === "quote_generation_timeout" || reason === "venue_quote_timeout") {
              throw new Error("venue_quote_timeout");
            }
            if (!payload && res.status === 503) {
              throw new Error("service_unavailable_503");
            }
            if (!payload && res.status >= 500) {
              throw new Error(`service_unavailable_${res.status}`);
            }
            const errMessage = [reason, payload?.message, detail].filter(Boolean).join(":") || "quote_failed";
            throw new Error(errMessage);
          }
          setQuote(payload as QuoteResult);
          recordLiquiditySignal("normal");
          setQuoteState("ready");
          return;
        } catch (err: any) {
          finalError = err;
          const classified = classifyLiquidityFromError(String(err?.message || "quote_failed"));
          if (classified === "thin") {
            recordLiquiditySignal("thin");
          }
          const retryable =
            err?.name === "AbortError" || isRetryableQuoteError(String(err?.message || "quote_failed"));
          if (attempt < QUOTE_REQUEST_MAX_ATTEMPTS && retryable) {
            const remainingAfterAttemptMs = QUOTE_REQUEST_TOTAL_TIMEOUT_MS - (Date.now() - requestStartedAt);
            if (remainingAfterAttemptMs <= QUOTE_RETRY_DELAY_MS + 200) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, QUOTE_RETRY_DELAY_MS));
            continue;
          }
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
      setQuoteState("idle");
      const err = finalError;
      recordLiquiditySignal(classifyLiquidityFromError(String(err?.message || "")));
      if (
        err?.name === "AbortError" ||
        String(err?.message || "").includes("quote_request_deadline_exceeded")
      ) {
        setError(
          `Quote timed out. Live venue response exceeded ${QUOTE_REQUEST_TIMEOUT_SECONDS}s. Please retry.`
        );
      } else {
        setError(friendlyError(String(err?.message || "Price temporarily unavailable, please retry.")));
      }
    } finally {
      setBusy(false);
    }
  };

  const activateProtection = async () => {
    if (!canActivate) {
      setError("Get a fresh quote before activation.");
      return;
    }
    setBusy(true);
    setError(null);
    let finalError: any = null;
    const maxAttempts = 2;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(`${API_BASE}/pilot/protections/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              protectedNotional: protectedValue,
              foxifyExposureNotional: exposureValue,
              protectionType,
              instrumentId: `BTC-USD-${selectedTenorDays}D-${protectionType === "short" ? "C" : "P"}`,
              marketId: "BTC-USD",
              slPct: selectedTier.drawdownFloorPct * 100,
              tierName: selectedTier.name,
              drawdownFloorPct: selectedTier.drawdownFloorPct,
              tenorDays: selectedTenorDays,
              renewWindowMinutes: selectedTier.renewWindowMinutes,
              autoRenew,
              quoteId: quote?.quote?.quoteId
            })
          });
          const payload = await res.json();
          if (!res.ok || payload?.status !== "ok") {
            const reason = String(payload?.reason || "");
            const message = String(payload?.message || "");
            throw new Error([reason, message].filter(Boolean).join(":") || "activation_failed");
          }
          setProtection(payload.protection as ProtectionRecord);
          setMonitor(null);
          setMonitorUpdatedAt(null);
          setLastUpdatedAt(new Date());
          setShowProtectionModal(true);
          setShowRenewModal(false);
          void refreshProtectionHistory({ silent: true });
          return;
        } catch (err: any) {
          finalError = err;
          const errMsg = String(err?.message || "activation_failed");
          const retryable = err?.name === "AbortError" || isRetryableActivationError(errMsg);
          if (attempt < maxAttempts && retryable) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      const err = finalError;
      if (err) {
        if (err?.name === "AbortError") {
          setError("Activation is taking longer than expected. Please retry.");
        } else {
          setError(friendlyError(String(err?.message || "activation_failed")));
        }
      }
      setBusy(false);
    }
  };

  const submitRenewDecision = async (decision: "renew" | "expire") => {
    if (!protection?.id) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/${protection.id}/renewal-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const payload = await res.json();
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.reason || "renewal_decision_failed");
      }
      if (payload?.protection) {
        setProtection(payload.protection as ProtectionRecord);
      }
      setShowRenewModal(false);
      void refreshProtectionHistory({ silent: true });
    } catch (err: any) {
      setError(friendlyError(String(err?.message || "Failed to process renewal decision.")));
    } finally {
      setBusy(false);
    }
  };

  const canContinuePastGate =
    !termsBusy &&
    termsStatus !== "checking" &&
    (termsStatus === "accepted" || termsChecked);

  const acceptTermsAndContinue = async () => {
    if (termsStatus === "accepted") {
      setPilotUnlocked(true);
      return;
    }
    if (!termsChecked) {
      setTermsError("Check the acknowledgement box to continue.");
      return;
    }
    setTermsBusy(true);
    setTermsError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/terms/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          termsVersion: PILOT_TERMS_VERSION,
          accepted: true
        })
      });
      const payload = (await res.json()) as {
        status?: "ok" | "error";
        acceptedAt?: string;
        reason?: string;
        message?: string;
      };
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.reason || payload?.message || "terms_accept_failed");
      }
      setTermsStatus("accepted");
      setPilotUnlocked(true);
      setTermsChecked(true);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(termsLocalStorageKey, "1");
        } catch {
          // best-effort cache only
        }
      }
    } catch (error: any) {
      setTermsError(friendlyError(String(error?.message || "terms_accept_failed")));
    } finally {
      setTermsBusy(false);
    }
  };

  const metadataProtectionType =
    protection?.metadata && typeof protection.metadata["protectionType"] === "string"
      ? ((protection.metadata["protectionType"] as string).toLowerCase() === "short" ? "short" : "long")
      : null;
  const effectiveProtectionType: ProtectionType = metadataProtectionType ?? quote?.protectionType ?? protectionType;
  const displayedDrawdownPct =
    Number(protection?.drawdownFloorPct ?? quote?.drawdownFloorPct ?? selectedTier.drawdownFloorPct);
  const displayedTriggerPrice =
    protection?.floorPrice ??
    quote?.triggerPrice ??
    quote?.floorPrice ??
    null;
  const metadataEntrySnapshotPrice =
    protection?.metadata && typeof protection.metadata["entrySnapshotPrice"] === "string"
      ? (protection.metadata["entrySnapshotPrice"] as string)
      : null;
  const liveReferenceNumber = Number(liveReference?.price ?? NaN);
  const liveReferenceAgeMs = Number(liveReference?.ageMs ?? NaN);
  const liveReferenceFreshnessMs = Number(liveReference?.freshnessMaxMs ?? NaN);
  const liveReferenceStale =
    Number.isFinite(liveReferenceAgeMs) &&
    Number.isFinite(liveReferenceFreshnessMs) &&
    liveReferenceFreshnessMs > 0 &&
    liveReferenceAgeMs > liveReferenceFreshnessMs;
  const referencePrice =
    Number(metadataEntrySnapshotPrice ?? quote?.entrySnapshot?.price ?? protection?.entryPrice ?? liveReference?.price ?? NaN);
  const triggerNumber = Number(displayedTriggerPrice ?? 0);
  const distanceToTriggerPct =
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(triggerNumber)
      ? effectiveProtectionType === "short"
        ? ((triggerNumber - referencePrice) / referencePrice) * 100
        : ((referencePrice - triggerNumber) / referencePrice) * 100
      : NaN;
  const indicativeOptionMark = Number(protection?.premium ?? quote?.quote?.premium ?? 0);
  const protectedNotionalForEstimation = Number(protection?.protectedNotional ?? protectedValue);
  const maxTriggerProtectionValue =
    Number.isFinite(protectedNotionalForEstimation) && Number.isFinite(displayedDrawdownPct)
      ? protectedNotionalForEstimation * displayedDrawdownPct
      : NaN;
  const renewalChip = protection?.expiryAt
    ? `Renewal window: ${new Date(
        Date.parse(protection.expiryAt) - (protection.renewWindowMinutes || 0) * 60 * 1000
      ).toLocaleString()}`
    : null;
  const triggerLabel = effectiveProtectionType === "short" ? "Protection Ceiling Price" : "Protection Floor Price";
  const drawdownLabel =
    effectiveProtectionType === "short" ? "Max Upside Move Protected" : "Max Drawdown Protected";
  const positionDirectionLabel =
    effectiveProtectionType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
  const quoteProtectionType: ProtectionType = quote?.protectionType ?? protectionType;
  const quoteDirectionLabel =
    quoteProtectionType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
  const quoteDetails =
    quote && quote.quote && typeof quote.quote.details === "object" && quote.quote.details
      ? (quote.quote.details as Record<string, unknown>)
      : null;
  const selectedTenorFromQuote = Number(quoteDetails?.selectedTenorDays ?? NaN);
  const selectedExpiryFromQuoteDetails = String(quoteDetails?.selectedExpiry ?? quoteDetails?.expiry ?? "").trim();
  const quoteDiagnostics =
    quote && quote.diagnostics && typeof quote.diagnostics === "object"
      ? (quote.diagnostics as Record<string, unknown>)
      : null;
  const venueSelection =
    quoteDiagnostics && typeof quoteDiagnostics.venueSelection === "object" && quoteDiagnostics.venueSelection
      ? (quoteDiagnostics.venueSelection as Record<string, unknown>)
      : null;
  const requestedTenorFromDiagnostics = Number(venueSelection?.requestedTenorDays ?? NaN);
  const selectedTenorFromDiagnostics = Number(
    venueSelection?.selectedTenorDaysActual ?? venueSelection?.selectedTenorDays ?? NaN
  );
  const selectedExpiryFromDiagnostics = String(venueSelection?.selectedExpiry || "").trim();
  const requestedVsMatchedTenorDriftDays =
    Number.isFinite(requestedTenorFromDiagnostics) && Number.isFinite(selectedTenorFromDiagnostics)
      ? Math.abs(selectedTenorFromDiagnostics - requestedTenorFromDiagnostics)
      : NaN;
  const targetTenorDaysForDisplay = Number.isFinite(requestedTenorFromDiagnostics)
    ? requestedTenorFromDiagnostics
    : selectedTenorDays;
  const matchedTenorDaysForDisplay = Number.isFinite(selectedTenorFromDiagnostics)
    ? selectedTenorFromDiagnostics
    : selectedTenorFromQuote;
  const targetHorizonDisplay = formatTargetHorizonLabel(targetTenorDaysForDisplay);
  const matchedHorizonDisplay = Number.isFinite(matchedTenorDaysForDisplay)
    ? formatMatchedHorizonLabel(matchedTenorDaysForDisplay)
    : "N/A";
  const selectedExpiryDisplay = formatExpiryDateLabel(selectedExpiryFromDiagnostics || selectedExpiryFromQuoteDetails);
  const matchedExpiryDisplay = selectedExpiryDisplay || matchedHorizonDisplay;
  const showTenorAdjustmentInfo =
    Number.isFinite(requestedVsMatchedTenorDriftDays) && requestedVsMatchedTenorDriftDays > 0.5;
  const quoteRequestProgressPct = Math.max(
    0,
    Math.min(
      100,
      ((QUOTE_REQUEST_TIMEOUT_SECONDS - quoteRequestTimeLeft) / Math.max(1, QUOTE_REQUEST_TIMEOUT_SECONDS)) * 100
    )
  );
  const quoteRequestUrgencyClass =
    quoteRequestTimeLeft <= 6 ? "is-danger" : quoteRequestTimeLeft <= 12 ? "is-warning" : "";
  const urlSearchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const internalAdminEnabled =
    typeof window !== "undefined" &&
    ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_INTERNAL_ADMIN_ENABLED ===
      "true" ||
      urlSearchParams?.get("internal_admin") === "1");
  const previewActivateEnabled = urlSearchParams?.get("preview_activate") === "1";
  const showPriceFeedHint = internalAdminEnabled && isPriceUnavailableError(error);
  const showQuoteUnavailableHint = quoteState !== "fetching" && isQuoteUnavailableError(error);
  const adminBrokerSnapshot = adminMetrics?.brokerBalanceSnapshot ?? null;
  const adminBrokerAvailableFunds = Number(adminBrokerSnapshot?.availableFundsUsd ?? NaN);
  const adminBrokerNetLiquidation = Number(adminBrokerSnapshot?.netLiquidationUsd ?? NaN);
  const adminBrokerExcessLiquidity = Number(adminBrokerSnapshot?.excessLiquidityUsd ?? NaN);
  const adminBrokerBuyingPower = Number(adminBrokerSnapshot?.buyingPowerUsd ?? NaN);
  const monitorHasLiveSnapshot = Boolean(
    monitor &&
      protection &&
      monitor.protectionId === protection.id &&
      Number.isFinite(Number(monitor.referencePrice))
  );
  const liveReferencePrice = monitorHasLiveSnapshot ? Number(monitor?.referencePrice ?? NaN) : NaN;
  const liveTriggerPrice = monitorHasLiveSnapshot ? monitor?.triggerPrice ?? null : null;
  const liveDistanceToTriggerPct = monitorHasLiveSnapshot ? Number(monitor?.distanceToTriggerPct ?? NaN) : NaN;
  const liveOptionMarkUsd = monitorHasLiveSnapshot ? Number(monitor?.optionMarkUsd ?? NaN) : NaN;
  const liveEstimatedTriggerValue = monitorHasLiveSnapshot ? Number(monitor?.estimatedTriggerValue ?? NaN) : NaN;
  const adminSelected = adminRows.find((row) => row.protection_id === adminSelectedId) || null;
  const adminClientPremiumTotal = Number(adminMetrics?.clientPremiumTotalUsdc ?? 0);
  const adminHedgePremiumTotal =
    Number(adminMetrics?.hedgePremiumTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.premium || 0), 0));
  const adminBookedMargin = Number(adminMetrics?.bookedMarginUsdc ?? adminClientPremiumTotal - adminHedgePremiumTotal);
  const adminBookedMarginPct = Number(adminMetrics?.bookedMarginPct ?? 0);
  const adminPremiumDueTotal = Number(adminMetrics?.premiumDueTotalUsdc ?? 0);
  const adminPremiumSettledTotal = Number(adminMetrics?.premiumSettledTotalUsdc ?? 0);
  const adminPendingPremiumReceivable = Number(adminMetrics?.pendingPremiumReceivableUsdc ?? 0);
  const adminTotalPayoutDue =
    Number(adminMetrics?.payoutDueTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.payout_due_amount || 0), 0));
  const adminTotalPayoutSettled =
    Number(
      adminMetrics?.payoutSettledTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.payout_settled_amount || 0), 0)
    );
  const adminOpenPayoutLiability = Number(adminMetrics?.openPayoutLiabilityUsdc ?? adminTotalPayoutDue - adminTotalPayoutSettled);
  const adminStartingReserve = Number(adminMetrics?.startingReserveUsdc ?? 0);
  const adminAvailableReserve = Number(adminMetrics?.availableReserveUsdc ?? 0);
  const adminReserveAfterOpenLiability = Number(adminMetrics?.reserveAfterOpenPayoutLiabilityUsdc ?? 0);
  const adminNetSettledCash = Number(adminMetrics?.netSettledCashUsdc ?? adminPremiumSettledTotal - adminTotalPayoutSettled);
  const adminActiveCount = Number(adminRows.filter((row) => row.status === "active").length);
  const adminMarkedRows = adminRows.filter((row) => row.status === "active" || row.status === "awaiting_expiry_price");
  const adminIndicativeHedgeMarkTotal = adminMarkedRows.reduce((sum, row) => {
    const monitorForRow = row.protection_id === adminSelectedId ? adminMonitor : null;
    const mark = Number(monitorForRow?.optionMarkUsd ?? NaN);
    return Number.isFinite(mark) ? sum + mark : sum;
  }, 0);
  const adminUnrealizedHedgePnlIndicative = adminIndicativeHedgeMarkTotal - adminHedgePremiumTotal;
  const adminIndicativeMarksCoverage = `${adminMarkedRows.filter((row) => row.protection_id === adminSelectedId).length}/${
    adminMarkedRows.length
  }`;
  const adminTimeLeftMs = adminSelected ? Date.parse(adminSelected.expiry_at) - Date.now() : NaN;
  const adminSelectedClientPremium = Number(adminDetailProtection?.premium ?? adminSelected?.premium ?? 0);
  const adminSelectedHedgeCost = Number(
    (adminDetailProtection?.metadata?.hedgePremiumUsd as string | undefined) ||
      (adminDetailProtection?.metadata?.rawHedgePremiumUsd as string | undefined) ||
      0
  );
  const adminSelectedTradeMargin = adminSelectedClientPremium - adminSelectedHedgeCost;
  const adminSelectedTradeMarginPct =
    adminSelectedClientPremium > 0 ? (adminSelectedTradeMargin / adminSelectedClientPremium) * 100 : NaN;
  const hasActiveInHistory = Boolean(protection && protectionsHistory.some((item) => item.id === protection.id));
  const activeProtectionForView = protection && hasActiveInHistory ? protection : null;
  const rawHistoryWithoutActive = activeProtectionForView
    ? protectionsHistory.filter((item) => item.id !== protection.id)
    : protectionsHistory;
  const totalFailedCount = rawHistoryWithoutActive.filter(
    (item) => item.status === "activation_failed" || item.status === "cancelled"
  ).length;
  const historyWithoutActive = showFailedProtections
    ? rawHistoryWithoutActive
    : rawHistoryWithoutActive.filter((item) => item.status !== "activation_failed" && item.status !== "cancelled");
  const protectionsTotalCount = (activeProtectionForView ? 1 : 0) + historyWithoutActive.length;
  const protectionsForPremium = activeProtectionForView
    ? [activeProtectionForView, ...historyWithoutActive]
    : protectionsHistory;
  const pilotPremiumOwedUsd = protectionsForPremium.reduce(
    (sum, item) => sum + Number(item.premium || 0),
    0
  );
  const dailyCapUsedUsd = Number(quote?.limits?.dailyUsedUsdc ?? 0);
  const dailyCapProjectedUsd = Number(quote?.limits?.projectedDailyUsdc ?? 0);
  const dailyCapMaxUsd = Number(quote?.limits?.maxDailyProtectedNotionalUsdc ?? 0);
  const showDailyCapSummary = Number.isFinite(dailyCapMaxUsd) && dailyCapMaxUsd > 0;
  const dailyCapPct =
    showDailyCapSummary && Number.isFinite(dailyCapProjectedUsd)
      ? Math.max(0, Math.min(100, (dailyCapProjectedUsd / dailyCapMaxUsd) * 100))
      : NaN;
  const monitorStatusLabel = monitorHasLiveSnapshot
    ? monitorBusy
      ? "Refreshing monitor..."
      : monitorUpdatedAt
        ? `Updated ${monitorUpdatedAt.toLocaleTimeString()}`
        : "Monitor ready"
    : monitorBusy
      ? "Loading monitor..."
      : "Awaiting first monitor update...";
  const statusPillClass = (status: string): string => {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "active") return "pill";
    if (normalized === "awaiting_renew_decision" || normalized === "awaiting_expiry_price") return "pill pill-warning";
    return "pill pill-danger";
  };

  if (!pilotUnlocked) {
    return (
      <div className="shell">
        <div className="card pilot-card pilot-gate-card">
          <div className="pilot-co-brand" aria-label="Foxify and Atticus logos">
            <div className="pilot-co-brand-logo-slot">
              {foxifyLogoFailed ? (
                <span className="pilot-co-brand-fallback">Foxify</span>
              ) : (
                <img
                  src={FOXIFY_LOGO_URL}
                  alt="Foxify logo"
                  className="pilot-co-brand-logo pilot-co-brand-logo--foxify"
                  onError={() => setFoxifyLogoFailed(true)}
                />
              )}
            </div>
            <span className="pilot-co-brand-separator">&lt;&gt;</span>
            <div className="pilot-co-brand-logo-slot">
              {atticusLogoFailed ? (
                <span className="pilot-co-brand-fallback">Atticus</span>
              ) : (
                <img
                  src={ATTICUS_LOGO_URL}
                  alt="Atticus logo"
                  className="pilot-co-brand-logo pilot-co-brand-logo--atticus"
                  onError={() => setAtticusLogoFailed(true)}
                />
              )}
            </div>
          </div>
          <h2 className="pilot-gate-title">Foxify Protection Pilot</h2>
          <div className="recommendation pilot-gate-copy">
            {termsStatus === "checking" && <div className="muted">Checking prior acceptance...</div>}
            <label className="pilot-gate-checkline">
              <input
                type="checkbox"
                checked={termsChecked}
                disabled={termsStatus === "accepted" || termsStatus === "checking" || termsBusy}
                onChange={(e) => setTermsChecked(e.target.checked)}
              />
              <span>
                I have read and accept{" "}
                <button
                  className="pilot-inline-terms-link"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTermsModalOpen(true);
                  }}
                >
                  Terms & Conditions
                </button>{" "}
                ({PILOT_TERMS_VERSION_DISPLAY})
              </span>
            </label>
            <button className="cta pilot-gate-cta" type="button" disabled={!canContinuePastGate} onClick={acceptTermsAndContinue}>
              {termsBusy ? "Saving..." : "Continue"}
            </button>
            {termsError && <div className="disclaimer danger">{termsError}</div>}
          </div>
        </div>

        {termsModalOpen && (
          <div className="modal" onClick={() => setTermsModalOpen(false)}>
            <div className="modal-card pilot-terms-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title">
                  <h3>Foxify Protection Pilot Terms & Conditions</h3>
                </div>
                <button className="icon-btn" type="button" onClick={() => setTermsModalOpen(false)}>
                  x
                </button>
              </div>
              <div className="subheader pilot-terms-version">({PILOT_TERMS_VERSION_DISPLAY})</div>
              <div className="modal-body pilot-terms-body">
                <p className="pilot-terms-intro">
                  By proceeding, you acknowledge and agree to the following pilot terms.
                </p>
                <ol className="pilot-terms-list">
                  <li>Internal pilot only for manual perpetual position protection, limited to Foxify executives.</li>
                  <li>These terms apply to all Foxify executives who execute protections during this pilot.</li>
                  <li>Maximum protection notional is 50,000 USDC per protection request.</li>
                  <li>
                    Daily protected notional limit is 50,000 USDC for pilot operations and resets at 00:00 UTC each calendar day.
                  </li>
                  <li>
                    Protection tenor is requested per quote, and matched expiry may differ based on live venue liquidity
                    and policy controls. Auto-renew may be enabled and remains subject to these terms.
                  </li>
                  <li>
                    The pilot campaign runs for a maximum of 30 days from the official UTC start date configured by
                    Atticus Operations.
                  </li>
                  <li>
                    Premiums owed by Foxify are payable Net 10 after the pilot closes, unless superseded by a signed
                    written amendment.
                  </li>
                  <li>
                    Option payout proceeds are remitted to Foxify T+3 business days after venue settlement is confirmed
                    and reconciled.
                  </li>
                  <li>
                    Pilot records, including quote/activation/monitor/expiry outcomes and terms acceptance, are
                    retained for audit and reconciliation.
                  </li>
                  <li>
                    Legal owner and final signatory for this pilot record: Michael William.
                  </li>
                  <li>
                    Support and escalation: {PILOT_SUPPORT_EMAIL} · Telegram {PILOT_SUPPORT_TELEGRAM}
                  </li>
                </ol>
              </div>
              <div className="modal-actions pilot-terms-actions">
                <button className="btn btn-secondary" type="button" onClick={() => setTermsModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="card pilot-card">
        <div className="title pilot-title">
          <div className="brand pilot-header-brand-simple">
            {foxifyLogoFailed ? (
              <span className="pilot-co-brand-fallback">Foxify</span>
            ) : (
              <img
                src={FOXIFY_LOGO_URL}
                alt="Foxify logo"
                className="pilot-header-logo"
                onError={() => setFoxifyLogoFailed(true)}
              />
            )}
            <span>Protection Pilot</span>
          </div>
          {internalAdminEnabled && (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setShowAdminModal(true)}
            >
              Internal Admin
            </button>
          )}
        </div>

        <div className="section section-compact">
          <div className="quote-market-banner quote-market-banner-micro">
            <span className="quote-market-banner-title">CME BTC Options</span>
            <span className="muted">Market Hours 9:30am-5pm EST</span>
            <span className="muted">Liquidity is thinner after market hours</span>
          </div>
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>Pilot Summary</h4>
            <button
              className="btn btn-secondary collapse-toggle"
              type="button"
              aria-expanded={showPilotSummary}
              onClick={() => setShowPilotSummary((prev) => !prev)}
            >
              <span className={`collapse-chevron ${showPilotSummary ? "open" : ""}`}>▶</span>
              {showPilotSummary ? "Hide" : "Show"}
            </button>
          </div>
          <div className={`collapsible-panel ${showPilotSummary ? "is-open" : ""}`}>
            <div className="collapsible-inner">
              <div className="quote-card quote-card-ready">
                <div className="muted">
                  Premium due at pilot close: <strong>${formatUsd(pilotPremiumOwedUsd)}</strong>
                </div>
                {showDailyCapSummary && (
                  <div className="muted">
                    Daily protected notional (UTC): used ${formatUsd(dailyCapUsedUsd)} → projected{" "}
                    <strong>${formatUsd(dailyCapProjectedUsd)}</strong> / ${formatUsd(dailyCapMaxUsd)}
                    {Number.isFinite(dailyCapPct) ? ` (${dailyCapPct.toFixed(1)}%)` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="section">
          <h4>Protection Request</h4>
          <div className={`pilot-reference-strip ${liveReferenceStale ? "pilot-reference-strip-stale" : ""}`}>
            <div className="pilot-reference-head">
              <span className="pilot-reference-title">BTC Reference Price</span>
              <button
                className="btn btn-secondary pilot-reference-refresh"
                type="button"
                disabled={liveReferenceBusy}
                onClick={() => {
                  setLiveReferenceBusy(true);
                  void (async () => {
                    try {
                      const res = await fetch(`${API_BASE}/pilot/reference-price?marketId=BTC-USD`);
                      const payload = (await res.json()) as ReferencePricePayload;
                      if (!res.ok || payload.status !== "ok" || !payload.reference) {
                        throw new Error(payload.reason || payload.message || "price_unavailable");
                      }
                      setLiveReference(payload.reference);
                      setLiveReferenceError(null);
                    } catch (error: any) {
                      setLiveReferenceError(friendlyError(String(error?.message || "price_unavailable")));
                    } finally {
                      setLiveReferenceBusy(false);
                    }
                  })();
                }}
              >
                {liveReferenceBusy ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="pilot-reference-value">
              {Number.isFinite(liveReferenceNumber) ? `$${formatUsd(liveReferenceNumber)}` : "—"}
            </div>
            <div className="pilot-reference-meta muted">
              {liveReference
                ? `Venue ${liveReference.venue || "Reference Feed"} · Last update ${new Date(
                    liveReference.timestamp
                  ).toLocaleString()}${liveReferenceStale ? " · delayed" : ""}`
                : liveReferenceBusy
                  ? "Loading latest reference..."
                  : "Reference price unavailable"}
            </div>
            {liveReferenceError && <div className="disclaimer danger">{liveReferenceError}</div>}
          </div>
          <div className="recommendation pilot-form">
            <div className="pilot-form-row">
              <span className="pilot-label">Tier</span>
              <div className="pilot-field">
                <select
                  className="input pilot-input pilot-select"
                  value={tierName}
                  onChange={(e) => setTierName(e.target.value)}
                  disabled={busy || quoteLocked}
                >
                  {tiers.map((tier) => (
                    <option key={tier.name} value={tier.name}>
                      {tier.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Position Direction</span>
              <div className="pilot-field">
                <select
                  className="input pilot-input pilot-select"
                  value={protectionType}
                  onChange={(e) => setProtectionType(e.target.value as ProtectionType)}
                  disabled={busy || quoteLocked}
                >
                  <option value="long">Long (Put Hedge)</option>
                  <option value="short">Short (Call Hedge)</option>
                </select>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Position Size (USD)</span>
              <div className="pilot-field">
                <input
                  className="input pilot-input"
                  inputMode="decimal"
                  placeholder="e.g. 50,000"
                  value={exposureNotional}
                  disabled={busy || quoteLocked}
                  onChange={(e) => setExposureNotional(formatCurrencyInput(e.target.value))}
                  onBlur={(e) => {
                    const parsedExposure = parseCurrencyNumber(e.currentTarget.value || "0");
                    if (!Number.isFinite(parsedExposure) || parsedExposure <= 0) return;
                    const nextExposure = Math.max(parsedExposure, minProtectionAmountUsd);
                    if (nextExposure !== parsedExposure) {
                      setExposureNotional(formatCurrencyInput(String(nextExposure)));
                    }
                    if (Number.isFinite(protectedValue) && protectedValue > nextExposure) {
                      setProtectedNotional(formatCurrencyInput(String(nextExposure)));
                    }
                  }}
                />
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Protection Amount (USD)</span>
              <div className="pilot-field">
                <input
                  className="input pilot-input"
                  inputMode="decimal"
                  placeholder="e.g. 25,000"
                  value={protectedNotional}
                  disabled={busy || quoteLocked}
                  onChange={(e) => setProtectedNotional(formatCurrencyInput(e.target.value))}
                  onBlur={(e) => {
                    const parsedProtected = parseCurrencyNumber(e.currentTarget.value || "0");
                    if (!Number.isFinite(parsedProtected) || parsedProtected <= 0) return;
                    let nextProtected = Math.max(parsedProtected, minProtectionAmountUsd);
                    nextProtected = Math.min(nextProtected, maxProtectionAmountUsd);
                    if (Number.isFinite(exposureValue) && exposureValue >= minProtectionAmountUsd) {
                      nextProtected = Math.min(nextProtected, exposureValue);
                    }
                    if (nextProtected !== parsedProtected) {
                      setProtectedNotional(formatCurrencyInput(String(nextProtected)));
                    }
                  }}
                />
                <div className="muted pilot-protection-min-helper">
                  Min ${formatUsdNoDecimals(minProtectionAmountUsd)}
                </div>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">{drawdownLabel}</span>
              <div className="pilot-field pilot-value">
                <strong>{formatPct(selectedTier.drawdownFloorPct)}</strong>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">{triggerLabel}</span>
              <div className="pilot-field pilot-value">
                <strong>{displayedTriggerPrice ? `$${formatUsd(displayedTriggerPrice)}` : "Set from live quote"}</strong>
              </div>
            </div>

            <div className="pilot-form-row pilot-form-row-tenor">
              <span className="pilot-label">Protection Length</span>
              <div className="pilot-field pilot-tenor-field">
                <div
                  className="pilot-tenor-chips pilot-tenor-chips-static"
                  role="group"
                  aria-label="Protection Length"
                >
                  {staticTenorOptions.map((tenorDay) => {
                    const selected = selectedTenorDays === tenorDay;
                    const recommended = tenorDay === PILOT_DEFAULT_TENOR_DAYS;
                    return (
                      <button
                        key={tenorDay}
                        type="button"
                        className={`pilot-tenor-chip ${selected ? "active" : ""} ${
                          recommended ? "pilot-tenor-chip-recommended" : ""
                        }`}
                        aria-pressed={selected}
                        disabled={busy || quoteLocked}
                        onClick={() => setSelectedTenorDays(tenorDay)}
                      >
                        {tenorDay}-Day
                      </button>
                    );
                  })}
                </div>
                <div className="muted pilot-tenor-helper">
                  Target length, nearest liquid expiry if unavailable
                </div>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Auto Renew</span>
              <div className="pilot-field">
                <label className="pilot-checkbox">
                  <input
                    type="checkbox"
                    checked={autoRenew}
                    disabled={busy || quoteLocked}
                    onChange={(e) => setAutoRenew(e.target.checked)}
                  />
                  <span>{autoRenew ? "Enabled" : "Disabled"}</span>
                </label>
              </div>
            </div>

            {!canQuote && (
              <div className="disclaimer danger">
                Protection amount must be between ${formatUsdNoDecimals(minProtectionAmountUsd)} and $
                {formatUsdNoDecimals(maxProtectionAmountUsd)} and cannot exceed position size
              </div>
            )}
          </div>
        </div>

        {showQuoteSection && (
          <div className="section" ref={quoteSectionRef}>
            <div className="section-title-row">
              <h4>Quote</h4>
            </div>
            <div className="quote-status-row">
              <div className="quote-status-right">
                {quoteState === "fetching" && <span className="pill">Finding best quote</span>}
                {quoteState === "ready" && quoteTimeLeft > 0 && (
                  <span className="pill pill-warning">Expires in {formatCountdown(quoteTimeLeft)}</span>
                )}
                {quoteState === "expired" && <span className="pill pill-warning">Quote expired</span>}
              </div>
            </div>
            <div className={`quote-card quote-card-${quoteState}`}>
              {quoteState === "idle" && <div className="muted">Find quote to fetch live premium and lock window</div>}
              {quoteState === "fetching" && (
                <div className="quote-fetching">
                  <div className="quote-fetching-title" aria-live="polite">
                    Finding best quote
                  </div>
                  <div className="quote-fetching-meta muted">Checking live contracts and executable prices</div>
                  <div className="quote-fetching-countdown">
                    <span className={`quote-fetching-seconds ${quoteRequestUrgencyClass}`}>
                      {formatCountdown(quoteRequestTimeLeft)}
                    </span>
                    <span className="muted">remaining</span>
                  </div>
                  <div className="quote-fetching-progress" aria-hidden="true">
                    <span style={{ width: `${quoteRequestProgressPct.toFixed(1)}%` }} />
                  </div>
                </div>
              )}
              {(quoteState === "ready" || quoteState === "expired") && quote && (
                <>
                  <div className="quote-primary">
                    Premium <strong>${formatUsd(quote.quote.premium)}</strong>
                  </div>
                  {Number.isFinite(quotePremiumRatioPct) && (
                    <div className="muted">Premium ratio {quotePremiumRatioPct.toFixed(2)}% of protection</div>
                  )}
                  <div className="muted">Venue {formatVenueLabel(quote.quote.venue)}</div>
                  <div className="quote-horizon-row">
                    <div>
                      <span className="muted">Target Horizon:</span> <strong>{targetHorizonDisplay}</strong>
                    </div>
                    <div>
                      <span className="muted">Matched Expiry:</span> <strong>{matchedExpiryDisplay}</strong>
                    </div>
                  </div>
                  <div className="muted">
                    {quoteDirectionLabel} · Tier {quote.tierName}
                  </div>
                  <div className="muted">
                    Move threshold {formatPct(quote.drawdownFloorPct)} ·{" "}
                    {quote.triggerLabel === "ceiling_price" ? "Ceiling" : "Floor"} $
                    {formatUsd(quote.triggerPrice ?? quote.floorPrice)}
                  </div>
                  <div className="muted">
                    Reference {formatUsd(quote.entrySnapshot.price)} ({quote.entrySnapshot.source}) at{" "}
                    {new Date(quote.entrySnapshot.timestamp).toLocaleString()}
                  </div>
                  {showTenorAdjustmentInfo && (
                    <div className="quote-warning">
                      <div className="pill pill-warning">Nearest liquid expiry used</div>
                    </div>
                  )}
                </>
              )}
            </div>
            {showQuoteUnavailableHint && (
              <div className="quote-unavailable-note">
                <div className="quote-unavailable-title">No liquidity or options available right now, try again</div>
              </div>
            )}
            {error && !showQuoteUnavailableHint && <div className="disclaimer danger">{error}</div>}
            {quoteLocked && (
              <div className="muted">Quote locked core request fields are read-only until refresh or expiry</div>
            )}
            {quoteCapWarning && (
              <div className="disclaimer danger">
                Daily protection limit reached for pilot operations quote shown for reference confirmation blocked until next UTC day
              </div>
            )}
            {showPriceFeedHint && (
              <div className="disclaimer">
                Quick check API must run with PILOT_API_ENABLED=true PRICE_SINGLE_SOURCE=true and valid PRICE_REFERENCE_URL
                <button
                  className="btn btn-secondary pilot-retry-btn"
                  type="button"
                  disabled={busy || !canQuote}
                  onClick={requestQuote}
                >
                  Retry quote
                </button>
              </div>
            )}
          </div>
        )}

        <div className="section pilot-actions-under-request" ref={actionsSectionRef}>
          <div className="pilot-actions">
            <button className="btn btn-secondary pilot-action-btn" disabled={busy || !canQuote} onClick={requestQuote}>
              {quoteState === "fetching" ? "Finding..." : "Find Quote"}
            </button>
            <button
              className="cta pilot-action-btn"
              disabled={busy || !canActivate}
              onClick={() => {
                setActivationPreviewNotice(null);
                setActivateModalMode("live");
                setShowActivateConfirmModal(true);
              }}
            >
              {busy && quoteState !== "fetching" ? "Confirming..." : "Confirm Protection"}
            </button>
          </div>
          {previewActivateEnabled && (
            <div className="disclaimer">
              <button
                className="btn btn-secondary pilot-preview-btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setActivationPreviewNotice(null);
                  setActivateModalMode("preview");
                  setShowActivateConfirmModal(true);
                }}
              >
                Preview activation modal
              </button>
            </div>
          )}
          {activationPreviewNotice && <div className="disclaimer">{activationPreviewNotice}</div>}
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>
              Protections <span className="muted">({protectionsTotalCount})</span>
            </h4>
            {historyBusy && <span className="pill">Loading…</span>}
            <div className="section-actions">
              <button
                className="btn btn-secondary pilot-inline-btn"
                disabled={busy || historyBusy}
                onClick={() => void refreshProtectionHistory()}
              >
                {historyBusy ? "Refreshing..." : "Refresh"}
              </button>
              <button
                className="btn btn-secondary pilot-inline-btn collapse-toggle"
                type="button"
                onClick={() => setShowHistorySection((prev) => !prev)}
                aria-expanded={showHistorySection}
              >
                <span className={`collapse-chevron ${showHistorySection ? "open" : ""}`} aria-hidden="true">
                  {">"}
                </span>
                {showHistorySection ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {!showHistorySection && protectionsTotalCount > 0 && pilotUnlocked && (
            <div className="muted section-collapsed-note">Protections hidden.</div>
          )}
          <div className={`collapsible-panel ${showHistorySection && pilotUnlocked ? "is-open" : "is-closed"}`}>
            <div className="collapsible-inner">
              {historyBusy ? (
                <div className="muted section-collapsed-note">
                  <span className="spinner" />
                  Loading protections...
                </div>
              ) : !protection && historyWithoutActive.length === 0 ? (
                <div className="muted">No protected positions yet.</div>
              ) : (
                <div className="positions">
                  {protection && (
                    <div className="position-row position-row-active">
                      <div className="position-main">
                        <div className="position-main-title">
                          <strong>{positionDirectionLabel}</strong>
                          <span className="pill">active</span>
                          <span className="pill pill-warning">Current</span>
                        </div>
                        <div className="muted">ID {protection.id}</div>
                        <div className="muted">
                          {triggerLabel.replace("Protection ", "")}{" "}
                          {displayedTriggerPrice ? `$${formatUsd(displayedTriggerPrice)}` : "—"} · Premium{" "}
                          {protection.premium ? `$${formatUsd(protection.premium)}` : "—"} · Expires{" "}
                          {new Date(protection.expiryAt).toLocaleString()}
                        </div>
                        {renewalChip && <div className="muted">{renewalChip}</div>}
                      </div>
                      <div className="position-actions">
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => {
                            setMonitor(null);
                            setShowProtectionModal(true);
                            void refreshMonitor(protection.id);
                          }}
                        >
                          Open Monitor
                        </button>
                      </div>
                    </div>
                  )}

                  {(historyWithoutActive.length > 0 || totalFailedCount > 0) && (
                    <div className="section-title-row">
                      <div className="muted section-subtitle">Recent Protections</div>
                      {totalFailedCount > 0 && (
                        <button
                          className="link-btn muted"
                          type="button"
                          onClick={() => setShowFailedProtections((prev) => !prev)}
                        >
                          {showFailedProtections
                            ? "Hide failed/cancelled"
                            : `Show failed/cancelled (${totalFailedCount})`}
                        </button>
                      )}
                    </div>
                  )}
                  {historyWithoutActive.map((item) => {
                    const itemType =
                      item.metadata && String(item.metadata.protectionType || "").toLowerCase() === "short"
                        ? "short"
                        : "long";
                    const itemDirection =
                      itemType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
                    const itemTriggerLabel =
                      itemType === "short" ? "Ceiling Price" : "Floor Price";
                    return (
                      <div className="position-row" key={item.id}>
                        <div className="position-main">
                          <div className="position-main-title">
                            <strong>{itemDirection}</strong>
                            <span className={statusPillClass(item.status)}>{item.status}</span>
                          </div>
                          <div className="muted">
                            ID {item.id}
                          </div>
                          <div className="muted">
                            {itemTriggerLabel} {item.floorPrice ? `$${formatUsd(item.floorPrice)}` : "—"} · Premium{" "}
                            {item.premium ? `$${formatUsd(item.premium)}` : "—"} · Expires{" "}
                            {new Date(item.expiryAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="position-actions">
                          <button
                            className="btn"
                            disabled={busy}
                            onClick={() => {
                              setProtection(item);
                              setMonitor(null);
                              setShowProtectionModal(true);
                              void refreshMonitor(item.id);
                            }}
                          >
                            Open Monitor
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showProtectionModal && protection && (
        <div className="modal" onClick={() => setShowProtectionModal(false)}>
          <div className="modal-card pilot-monitor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Protection Monitor</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowProtectionModal(false)}>
                x
              </button>
            </div>
            <div className="muted pilot-monitor-subtitle">
              Protection {protection.id} · Updates every 10s
              {monitorUpdatedAt ? ` · Last update ${monitorUpdatedAt.toLocaleTimeString()}` : ""}
            </div>
            <div className="muted pilot-monitor-status">{monitorStatusLabel}</div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={monitorBusy}
                onClick={() => void refreshMonitor(protection.id)}
              >
                {monitorBusy ? "Refreshing..." : "Refresh Monitor"}
              </button>
            </div>
            <div className="pilot-monitor-grid">
              <div className="pilot-monitor-card">
                <div className="label">Current BTC Price</div>
                <div className="value">
                  {Number.isFinite(liveReferencePrice) ? `$${formatUsd(liveReferencePrice)}` : "Loading live snapshot..."}
                </div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Entry BTC Price</div>
                <div className="value">${formatUsd(protection.entryPrice)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">{triggerLabel}</div>
                <div className="value">{liveTriggerPrice ? `$${formatUsd(liveTriggerPrice)}` : "—"}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Distance to Trigger</div>
                <div className={`value ${liveDistanceToTriggerPct < 3 ? "danger" : ""}`}>
                  {Number.isFinite(liveDistanceToTriggerPct) ? `${liveDistanceToTriggerPct.toFixed(2)}%` : "—"}
                </div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Current Hedge Value</div>
                <div className="value">
                  {Number.isFinite(liveOptionMarkUsd) ? `$${formatUsd(liveOptionMarkUsd)}` : "Loading live snapshot..."}
                </div>
                <div className="muted">Estimated current value of the hedge leg. Not realized P&L.</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Estimated Value at Trigger</div>
                <div className="value">
                  {Number.isFinite(liveEstimatedTriggerValue) ? `$${formatUsd(liveEstimatedTriggerValue)}` : "—"}
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowProtectionModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdminModal && internalAdminEnabled && (
        <div className="modal" onClick={() => setShowAdminModal(false)}>
          <div className="modal-card modal-wide pilot-admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Atticus Internal Admin</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowAdminModal(false)}>
                x
              </button>
            </div>

            {!adminToken && (
              <div className="modal-body">
                <div className="muted">Internal-only access. Enter Atticus admin token to unlock data.</div>
                <div className="pilot-form-row">
                  <span className="pilot-label">Admin Token</span>
                  <div className="pilot-field">
                    <input
                      className="input pilot-input pilot-input-text"
                      type="password"
                      value={adminTokenInput}
                      onChange={(e) => setAdminTokenInput(e.target.value)}
                      placeholder="x-admin-token"
                    />
                  </div>
                </div>
                <div className="modal-actions">
                  <button
                    className="cta"
                    disabled={!adminTokenInput.trim() || adminBusy}
                    onClick={() => void loadAdminRows(adminTokenInput.trim())}
                  >
                    {adminBusy ? "Unlocking..." : "Unlock Admin"}
                  </button>
                </div>
              </div>
            )}

            {adminToken && (
              <div className="modal-body">
                <div className="pilot-admin-grid">
                  <div className="pilot-monitor-card">
                    <div className="label">Active Protections</div>
                    <div className="value">{adminActiveCount}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Indicative Option Value (Open)</div>
                    <div className="value">
                      {Number.isFinite(adminIndicativeHedgeMarkTotal)
                        ? `$${formatUsd(adminIndicativeHedgeMarkTotal)}`
                        : "—"}
                    </div>
                    <div className="muted">Coverage: {adminIndicativeMarksCoverage} marked rows</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Unrealized Hedge P&L (Indicative)</div>
                    <div className={`value ${adminUnrealizedHedgePnlIndicative < 0 ? "danger" : ""}`}>
                      {Number.isFinite(adminUnrealizedHedgePnlIndicative)
                        ? `$${formatUsd(adminUnrealizedHedgePnlIndicative)}`
                        : "—"}
                    </div>
                    <div className="muted">Indicative mark value minus hedge premium cost.</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Starting Reserve</div>
                    <div className="value">${formatUsd(adminStartingReserve)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Available Reserve</div>
                    <div className="value">${formatUsd(adminAvailableReserve)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Reserve After Open Liability</div>
                    <div className="value">${formatUsd(adminReserveAfterOpenLiability)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">IBKR Available Funds (Live)</div>
                    <div className="value">{Number.isFinite(adminBrokerAvailableFunds) ? `$${formatUsd(adminBrokerAvailableFunds)}` : "—"}</div>
                    <div className="muted">{adminBrokerSnapshot ? `As of ${new Date(adminBrokerSnapshot.asOf).toLocaleString()}` : "Read-only broker snapshot unavailable."}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">IBKR Net Liquidation (Live)</div>
                    <div className="value">{Number.isFinite(adminBrokerNetLiquidation) ? `$${formatUsd(adminBrokerNetLiquidation)}` : "—"}</div>
                    <div className="muted">
                      {adminBrokerSnapshot ? `Acct ${adminBrokerSnapshot.accountId || "N/A"} · ${adminBrokerSnapshot.currency}` : "Read-only broker snapshot."}
                    </div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">IBKR Excess Liquidity (Live)</div>
                    <div className="value">{Number.isFinite(adminBrokerExcessLiquidity) ? `$${formatUsd(adminBrokerExcessLiquidity)}` : "—"}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">IBKR Buying Power (Live)</div>
                    <div className="value">{Number.isFinite(adminBrokerBuyingPower) ? `$${formatUsd(adminBrokerBuyingPower)}` : "—"}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Hedge Premium (Venue Cost)</div>
                    <div className="value">${formatUsd(adminHedgePremiumTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Client Premium (Charged)</div>
                    <div className="value">${formatUsd(adminClientPremiumTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Platform Margin (Booked)</div>
                    <div className="value">${formatUsd(adminBookedMargin)}</div>
                    <div className="muted">{Number.isFinite(adminBookedMarginPct) ? `${adminBookedMarginPct.toFixed(2)}%` : "—"}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Premium Due (Atticus Receivable)</div>
                    <div className="value">${formatUsd(adminPremiumDueTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Premium Settled (Received)</div>
                    <div className="value">${formatUsd(adminPremiumSettledTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Pending Premium Receivable</div>
                    <div className="value">${formatUsd(adminPendingPremiumReceivable)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Payout Liability</div>
                    <div className="value">${formatUsd(adminTotalPayoutDue)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Payout Settled</div>
                    <div className="value">${formatUsd(adminTotalPayoutSettled)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Open Payout Liability</div>
                    <div className="value">${formatUsd(adminOpenPayoutLiability)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Net Settled Cash (Premium - Payout Settled)</div>
                    <div className="value">${formatUsd(adminNetSettledCash)}</div>
                  </div>
                </div>
                <div className="muted">
                  Hedge cost and client premium are shown separately for margin visibility. Settled metrics move only when
                  settlement events are posted.
                </div>

                <div className="modal-actions">
                  <button className="btn" disabled={adminBusy} onClick={() => void loadAdminRows(adminToken)}>
                    {adminBusy ? "Refreshing..." : "Refresh Admin Data"}
                  </button>
                </div>
                <div className="pilot-admin-filters">
                  <label className="muted">
                    Scope
                    <select
                      className="input pilot-input pilot-input-text"
                      value={adminScope}
                      onChange={(e) => void loadAdminRows(adminToken, { scope: e.target.value as AdminScope })}
                    >
                      <option value="active">active</option>
                      <option value="open">open</option>
                      <option value="all">all</option>
                    </select>
                  </label>
                  <label className="muted">
                    Status
                    <select
                      className="input pilot-input pilot-input-text"
                      value={adminStatusFilter}
                      onChange={(e) =>
                        void loadAdminRows(adminToken, { status: e.target.value as AdminStatusFilter })
                      }
                    >
                      <option value="all">all</option>
                      <option value="pending_activation">pending_activation</option>
                      <option value="activation_failed">activation_failed</option>
                      <option value="active">active</option>
                      <option value="reconcile_pending">reconcile_pending</option>
                      <option value="awaiting_renew_decision">awaiting_renew_decision</option>
                      <option value="awaiting_expiry_price">awaiting_expiry_price</option>
                      <option value="expired_itm">expired_itm</option>
                      <option value="expired_otm">expired_otm</option>
                      <option value="cancelled">cancelled</option>
                    </select>
                  </label>
                  <label className="muted pilot-inline-check">
                    <input
                      type="checkbox"
                      checked={adminIncludeArchived}
                      onChange={(e) => void loadAdminRows(adminToken, { includeArchived: e.target.checked })}
                    />
                    Include archived
                  </label>
                  <button
                    className="btn btn-secondary"
                    disabled={adminBusy}
                    onClick={async () => {
                      if (!protection?.id) return;
                      try {
                        setAdminBusy(true);
                        const res = await fetch(`${API_BASE}/pilot/admin/protections/archive-except-current`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            "x-admin-token": adminToken
                          },
                          body: JSON.stringify({
                            keepProtectionId: protection.id,
                            reason: "pre_ship_cleanup_keep_current_active"
                          })
                        });
                        const payload = await res.json();
                        if (!res.ok || payload?.status !== "ok") {
                          throw new Error(payload?.reason || "archive_failed");
                        }
                        await loadAdminRows(adminToken);
                      } catch (err: any) {
                        setAdminError(friendlyError(String(err?.message || "archive_failed")));
                      } finally {
                        setAdminBusy(false);
                      }
                    }}
                  >
                    Archive all except current UI active
                  </button>
                </div>

                <div className="pilot-admin-table-scroll">
                  <div className="pilot-admin-table">
                  <div className="pilot-admin-head">
                    <span>Protection ID</span>
                    <span>Status</span>
                    <span>Premium</span>
                    <span>Expiry</span>
                    <span>Venue</span>
                    <span>Action</span>
                  </div>
                  {adminRows.slice(0, 20).map((row) => (
                    <div
                      className={`pilot-admin-row ${adminSelectedId === row.protection_id ? "pilot-admin-row-selected" : ""}`}
                      key={row.protection_id}
                    >
                      <span>{row.protection_id}</span>
                      <span>{row.status}</span>
                      <span>{row.premium ? `$${formatUsd(row.premium)}` : "—"}</span>
                      <span>{new Date(row.expiry_at).toLocaleString()}</span>
                      <span>{row.venue || "—"}</span>
                      <span>
                        <button
                          className="btn btn-secondary"
                          disabled={adminViewingId === row.protection_id}
                          onClick={() => {
                            setAdminSelectedId(row.protection_id);
                            setShowAdminDetailModal(true);
                            if (adminToken) {
                              void refreshAdminSelection(row.protection_id, adminToken);
                            }
                          }}
                        >
                          {adminViewingId === row.protection_id ? "Loading..." : "View details"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
                </div>

              </div>
            )}

            {adminError && <div className="disclaimer danger">{adminError}</div>}
          </div>
        </div>
      )}

      {showAdminDetailModal && adminSelected && (
        <div className="modal" onClick={() => setShowAdminDetailModal(false)}>
          <div className="modal-card pilot-admin-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Protection Detail</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowAdminDetailModal(false)}>
                x
              </button>
            </div>
            <div className="muted">ID: {adminSelected.protection_id}</div>
            {adminDetailUpdatedAt && <div className="muted">Updated {adminDetailUpdatedAt.toLocaleTimeString()}</div>}
            <div className="muted">
              Status: {adminSelected.status} · Time Left:{" "}
              {Number.isFinite(adminTimeLeftMs) && adminTimeLeftMs > 0
                ? formatCountdown(Math.floor(adminTimeLeftMs / 1000))
                : "expired"}
            </div>
            <div className="muted">
              {adminSelected.entry_price ? `Entry $${formatUsd(adminSelected.entry_price)}` : "Entry —"} ·{" "}
              {adminSelected.floor_price ? `Trigger $${formatUsd(adminSelected.floor_price)}` : "Trigger —"} ·{" "}
              {adminSelected.instrument_id || "No instrument"}
            </div>
            <div className="muted">
              MTM Option Mark:{" "}
              {adminMonitor && Number.isFinite(Number(adminMonitor.optionMarkUsd))
                ? `$${formatUsd(adminMonitor.optionMarkUsd)}`
                : "—"}
            </div>
            <div className="muted">
              Hedge Cost (Venue):{" "}
              {Number.isFinite(adminSelectedHedgeCost) && adminSelectedHedgeCost > 0
                ? `$${formatUsd(adminSelectedHedgeCost)}`
                : "—"}
            </div>
            <div className="muted">
              Client Premium:{" "}
              {Number.isFinite(adminSelectedClientPremium) && adminSelectedClientPremium > 0
                ? `$${formatUsd(adminSelectedClientPremium)}`
                : "—"}
            </div>
            <div className="muted">
              Trade Margin:{" "}
              {Number.isFinite(adminSelectedTradeMargin)
                ? `$${formatUsd(adminSelectedTradeMargin)}${Number.isFinite(adminSelectedTradeMarginPct) ? ` (${adminSelectedTradeMarginPct.toFixed(2)}%)` : ""}`
                : "—"}
            </div>
            <div className="muted">
              Reference:{" "}
              {adminMonitor && Number.isFinite(Number(adminMonitor.referencePrice))
                ? `$${formatUsd(adminMonitor.referencePrice)}`
                : "—"}
            </div>
            <div className="pilot-admin-ledger">
              <strong>Ledger Entries</strong>
              {adminLedger.length === 0 ? (
                <div className="muted">No ledger entries found.</div>
              ) : (
                adminLedger.map((entry) => (
                  <div className="muted" key={entry.id}>
                    {entry.entryType} · {entry.amount} {entry.currency} · {new Date(entry.createdAt).toLocaleString()}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowAdminDetailModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenewModal && (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-title">
                <h3>Renewal Required</h3>
              </div>
            </div>
            <div className="modal-body">
              <p>
                The renewal window has started and auto-renew is off. Choose how to proceed.
              </p>
              <div className="modal-actions">
                <button className="btn" disabled={busy} onClick={() => submitRenewDecision("expire")}>
                  Let protection expire
                </button>
                <button className="cta" disabled={busy} onClick={() => submitRenewDecision("renew")}>
                  Renew protection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showActivateConfirmModal && (
        <div className="modal" onClick={() => (busy ? undefined : setShowActivateConfirmModal(false))}>
          <div className="modal-card pilot-activate-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Confirm Protection Activation</h3>
              </div>
              <button
                className="icon-btn"
                type="button"
                disabled={busy}
                onClick={() => setShowActivateConfirmModal(false)}
              >
                x
              </button>
            </div>
            {activateModalMode === "preview" ? (
              <div className="disclaimer">
                Preview mode only. No live activation request will be sent.
              </div>
            ) : (
              <div className="muted">
                Confirm this quote to activate protection with the matched expiry and premium below.
              </div>
            )}
            <div className="pilot-activate-summary">
              <div className="pilot-monitor-card">
                <div className="label">Direction</div>
                <div className="value">{quoteDirectionLabel}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Protection Amount</div>
                <div className="value">${formatUsd(protectedValue)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Quoted Premium</div>
                <div className="value">${formatUsd(quote?.quote?.premium ?? 0)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Requested vs Matched</div>
                <div className="value">
                  {targetHorizonDisplay} → {matchedExpiryDisplay}
                </div>
              </div>
            </div>
            <div className="modal-actions pilot-activate-actions">
              <button
                className="btn pilot-activate-action-btn"
                type="button"
                disabled={busy}
                onClick={() => setShowActivateConfirmModal(false)}
              >
                Cancel
              </button>
              <button
                className="pilot-activate-action-btn pilot-activate-action-btn-primary"
                type="button"
                disabled={busy || (activateModalMode === "live" && !canActivate)}
                onClick={async () => {
                  if (activateModalMode === "preview") {
                    setShowActivateConfirmModal(false);
                    setActivationPreviewNotice("Preview complete. No live activation request was sent.");
                    return;
                  }
                  setShowActivateConfirmModal(false);
                  await activateProtection();
                }}
              >
                {activateModalMode === "preview"
                  ? "Run Preview"
                  : busy
                    ? "Confirming..."
                    : "Activate Protection"}
              </button>
            </div>
          </div>
        </div>
      )}
      <a
        className="pilot-help-fab"
        href={`https://t.me/${PILOT_SUPPORT_TELEGRAM.replace(/^@/, "")}?text=${encodeURIComponent(
          "Hi Michael, I need help with Foxify pilot testing."
        )}`}
        target="_blank"
        rel="noreferrer"
      >
        Telegram Help
      </a>
    </div>
  );
}

