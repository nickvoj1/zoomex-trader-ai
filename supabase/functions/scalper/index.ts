import { corsHeaders, createAdminClient, HttpError, jsonResponse, resolveCaller } from "../_shared/auth.ts";
import {
  getAccountAssets,
  getOpenPositions,
  MexcAsset,
  MexcPosition,
  mexcPublicGet,
  MEXC_WS_URL,
  submitOrder,
} from "../_shared/mexc.ts";
import {
  applyPrecisionFirstEventGuard,
  buildMarketMicrostructure,
  buildMarketState,
  calculatePositionSize,
  deriveAdvancedDecision,
  StrategyDecision,
  StrategySettings,
  StrategySetup,
  toStopAndTakeProfit,
  TradeAction,
} from "../_shared/strategy-core.ts";
import { fetchCrossVenueSnapshot } from "../_shared/market-intel.ts";
import {
  extractFeatureMap,
  HistoricalContextSnapshot,
  HistoricalMicrostructureSnapshot,
  LogisticModelArtifact,
  prepareHistoricalContext,
  prepareHistoricalMicrostructure,
  predictLogisticProbability,
} from "../_shared/quant-research.ts";

const LOOP_DURATION_MS = 50_000;
const PAPER_STARTING_BALANCE = 10_000;
const MIN_BALANCE_USDT = 10;
const ENTRY_COOLDOWN_MS = 60_000;
const SYMBOL = "BTC_USDT";
const DB_SYMBOL = "BTCUSDT";

interface ProfileRecord {
  user_id: string;
  auto_trade: boolean;
  max_risk_pct: number;
  leverage: number;
  telegram_id: string | null;
  demo_mode: boolean;
  min_confidence: number | null;
  daily_loss_limit_pct: number | null;
  max_consecutive_losses: number | null;
  allow_trend_trades: boolean | null;
  allow_mean_reversion_trades: boolean | null;
}

interface ApiKeysRecord {
  mexc_key: string | null;
  mexc_secret: string | null;
  openai_key: string | null;
  telegram_token: string | null;
}

interface TradeRecord {
  id: string;
  created_at: string;
  side: string;
  size: number;
  entry_price: number;
  tp: number | null;
  sl: number | null;
  leverage: number;
  pnl: number | null;
  status: "open" | "closed";
  closed_at: string | null;
  setup_type: string | null;
  entry_confidence: number | null;
  trade_metadata: Record<string, unknown> | null;
}

interface SignalInsert {
  user_id: string;
  symbol: string;
  rsi: number;
  price: number;
  signal: "buy" | "sell" | "hold";
  ai_reasoning: string;
  confidence: number;
  decision_source: string;
  signal_context: Record<string, unknown>;
}

interface LiquidationMetricsRow {
  created_at: string;
  liquidation_bias: number | null;
  liquidation_intensity: number | null;
}

interface MicrostructureHistoryRow extends LiquidationMetricsRow {
  raw_payload: Record<string, unknown> | null;
  spread_bps: number | null;
  imbalance: number | null;
  funding_rate_pct_8h: number | null;
  open_interest_usd: number | null;
  open_interest_change_pct: number | null;
  long_short_ratio: number | null;
  taker_imbalance: number | null;
  cross_venue_basis_bps: number | null;
}

interface ContextHistoryRow {
  created_at: string;
  snapshot_type: string | null;
  raw_payload: Record<string, unknown> | null;
}

interface ModelArtifactRow {
  id: string;
  created_at: string;
  user_id: string | null;
  side: string;
  artifact: LogisticModelArtifact | null;
}

interface ForwardValidationReportRow {
  created_at: string;
  execution_mode: string;
  trade_count: number;
  gate_passed: boolean;
  gate_reason: string | null;
}

interface ForwardValidationStatus {
  paper: ForwardValidationReportRow | null;
  live: ForwardValidationReportRow | null;
  allowsLiveEntries: boolean;
  sourceMode: "paper" | "live" | null;
  reason: string;
}

interface OpsControlRow {
  kill_switch: boolean;
  pause_new_entries: boolean;
  disable_live_entries_until: string | null;
  max_heartbeat_age_seconds: number;
  notes: string | null;
}

interface OpsHeartbeatRow {
  created_at: string;
  status: string;
}

interface OpsEntryGuard {
  allowsLiveEntries: boolean;
  reason: string;
  heartbeatAgeSeconds: number | null;
}

interface ArtifactEligibilityLike {
  approved?: boolean;
  score?: number;
  reasons?: string[];
}

const FORWARD_VALIDATION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_NEWS_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const LIVE_OVERLAY_FEATURE_KEYS = [
  "context_has_snapshot",
  "news_event_count_sum",
  "news_sentiment_mean",
  "news_btc_relevance_mean",
  "news_shock_score_mean",
  "news_shock_score_max",
  "news_minutes_since_latest",
  "macro_has_snapshot",
  "macro_risk_bias",
  "macro_hours_since_release",
  "macro_release_window_24h",
  "macro_release_window_72h",
  "micro_crowding_score",
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function numberFeature(features: StrategyDecision["features"], key: string, fallback = 0) {
  const value = features[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLiveOverlayFeatures(featureMap: Record<string, number>) {
  const features: Record<string, number> = {};

  LIVE_OVERLAY_FEATURE_KEYS.forEach((key) => {
    const value = featureMap[key];
    features[key] = Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
  });

  return features;
}

function buildExecutionProfile(settings: StrategySettings, decision: StrategyDecision) {
  const qualityScore = numberFeature(decision.features, "qualityScore", decision.confidence);
  const regimeQuality = numberFeature(decision.features, "regimeQuality", qualityScore);
  const executionQuality = numberFeature(decision.features, "executionQuality", qualityScore);
  const featureRiskMultiplier = numberFeature(decision.features, "riskMultiplier", clamp(qualityScore / 100, 0.35, 1));
  const featureLeverageMultiplier = numberFeature(
    decision.features,
    "leverageMultiplier",
    clamp(executionQuality / 100, 0.55, 1),
  );
  const activeProbability = decision.action === "long"
    ? numberFeature(decision.features, "modelLongProbability", 0)
    : decision.action === "short"
      ? numberFeature(decision.features, "modelShortProbability", 0)
      : 0;
  const modelEdge = Math.max(numberFeature(decision.features, "modelEdge", 0), 0);
  const riskMultiplier = clamp(featureRiskMultiplier * (0.92 + modelEdge * 0.9), 0.35, 1);
  const leverageMultiplier = clamp(
    featureLeverageMultiplier * (0.92 + modelEdge * 0.7 + Math.max(activeProbability - 0.5, 0) * 0.3),
    0.55,
    1,
  );
  const effectiveRiskPct = clamp(settings.riskPct * riskMultiplier, 0.1, settings.riskPct);
  const effectiveLeverage = Math.max(1, Math.round(settings.leverage * leverageMultiplier));
  const convictionScore = clamp(
    qualityScore * 0.45 + regimeQuality * 0.2 + executionQuality * 0.2 + decision.confidence * 0.15,
    0,
    100,
  );

  return {
    riskMultiplier: Number(riskMultiplier.toFixed(4)),
    leverageMultiplier: Number(leverageMultiplier.toFixed(4)),
    effectiveRiskPct: Number(effectiveRiskPct.toFixed(4)),
    effectiveLeverage,
    convictionScore: Number(convictionScore.toFixed(2)),
  };
}

function startOfDayIso() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.toISOString();
}

function toStrategySettings(profile: ProfileRecord): StrategySettings {
  const paperMode = profile.demo_mode;
  return {
    riskPct: clamp(Number(profile.max_risk_pct) || 0.5, 0.1, paperMode ? 2 : 1),
    leverage: Math.round(clamp(Number(profile.leverage) || 10, 1, paperMode ? 50 : 20)),
    minConfidence: clamp(Number(profile.min_confidence) || 78, 30, 95),
    dailyLossLimitPct: clamp(Number(profile.daily_loss_limit_pct) || 3, 0.5, 10),
    maxConsecutiveLosses: Math.round(clamp(Number(profile.max_consecutive_losses) || 3, 1, 8)),
    allowTrendTrades: profile.allow_trend_trades ?? true,
    allowMeanReversionTrades: profile.allow_mean_reversion_trades ?? true,
    feeBps: paperMode ? 2 : 4,
    slippageBps: paperMode ? 1 : 3,
    maxBarsInTrade: 90,
    partialTakeProfitRR: 1.2,
    allowSessionFilter: true,
    sessionStartHourUtc: 6,
    sessionEndHourUtc: 22,
  };
}

async function sendTelegramAlert(token: string, chatId: string, message: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (error) {
    console.error("Telegram alert failed:", error);
  }
}

async function fetchFuturesOHLCV() {
  const response = await mexcPublicGet<
    | Array<Record<string, unknown>>
    | { time?: unknown[]; open?: unknown[]; high?: unknown[]; low?: unknown[]; close?: unknown[]; vol?: unknown[]; volume?: unknown[] }
  >(`/api/v1/contract/kline/${SYMBOL}`, {
    interval: "Min1",
    limit: 900,
  });

  const payload = response.data;
  if (!payload) {
    throw new Error(`Kline request failed: ${JSON.stringify(response).slice(0, 300)}`);
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => ({
      timestamp: Number(item.time ?? item.t ?? 0) || undefined,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.vol ?? item.volume ?? 0),
    }));
  }

  if (Array.isArray(payload.close)) {
    return payload.close.map((close, index) => ({
      timestamp: Number(payload.time?.[index] ?? 0) || undefined,
      open: Number(payload.open?.[index]),
      high: Number(payload.high?.[index]),
      low: Number(payload.low?.[index]),
      close: Number(close),
      volume: Number(payload.vol?.[index] ?? payload.volume?.[index] ?? 0),
    }));
  }

  throw new Error("No candle data returned from MEXC");
}

async function getSessionRiskState(supabaseAdmin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data: closedTrades, error } = await supabaseAdmin
    .from("trades")
    .select("pnl, created_at, closed_at")
    .eq("user_id", userId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false });

  if (error) throw error;

  const realizedPnl = (closedTrades ?? []).reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
  const currentBalance = PAPER_STARTING_BALANCE + realizedPnl;
  const todayStart = startOfDayIso();
  const dailyRealizedPnl = (closedTrades ?? [])
    .filter((trade) => (trade.closed_at ?? trade.created_at) >= todayStart)
    .reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);

  // Only count consecutive losses within the current UTC day (session reset)
  const todayTrades = (closedTrades ?? []).filter(
    (trade) => (trade.closed_at ?? trade.created_at) >= todayStart,
  );
  let consecutiveLosses = 0;
  for (const trade of todayTrades) {
    if (Number(trade.pnl ?? 0) < 0) consecutiveLosses += 1;
    else break;
  }

  return {
    startingBalance: PAPER_STARTING_BALANCE,
    currentBalance,
    dailyRealizedPnl,
    consecutiveLosses,
  };
}

async function getOpenTradeRecord(supabaseAdmin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("symbol", DB_SYMBOL)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as TradeRecord | null;
}

async function isOnEntryCooldown(supabaseAdmin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.created_at) return false;
  return Date.now() - new Date(data.created_at).getTime() < ENTRY_COOLDOWN_MS;
}

async function getLatestLiquidationMetrics(supabaseAdmin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await supabaseAdmin
    .from("market_snapshots")
    .select("created_at, liquidation_bias, liquidation_intensity")
    .eq("venue", "composite")
    .eq("snapshot_type", "microstructure")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Failed to load liquidation metrics:", error);
    return null;
  }

  const row = (data ?? null) as LiquidationMetricsRow | null;
  if (!row?.created_at) {
    return null;
  }

  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > 10 * 60 * 1000) {
    return null;
  }

  return {
    bias: row.liquidation_bias,
    intensity: row.liquidation_intensity,
  };
}

function rowToHistoricalMicrostructure(row: MicrostructureHistoryRow): HistoricalMicrostructureSnapshot | null {
  const timestamp = Date.parse(row.created_at);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const rawPayload = row.raw_payload;
  const rawMicrostructure = rawPayload && typeof rawPayload === "object" && rawPayload.microstructure && typeof rawPayload.microstructure === "object"
    ? rawPayload.microstructure
    : null;

  return {
    timestamp,
    microstructure: (rawMicrostructure as ReturnType<typeof buildMarketMicrostructure>) ?? buildMarketMicrostructure({
      fundingRatePct8h: row.funding_rate_pct_8h,
      openInterestUsd: row.open_interest_usd,
      openInterestChangePct: row.open_interest_change_pct,
      longShortRatio: row.long_short_ratio,
      takerImbalance: row.taker_imbalance,
      liquidationBias: row.liquidation_bias,
      liquidationIntensity: row.liquidation_intensity,
      crossVenueBasisBps: row.cross_venue_basis_bps,
    }),
    source: "supabase",
  };
}

function extractContextPayload(row: ContextHistoryRow) {
  const rawPayload = row.raw_payload;
  if (rawPayload && typeof rawPayload === "object") {
    if (rawPayload.context && typeof rawPayload.context === "object") {
      return rawPayload.context as Record<string, unknown>;
    }
    return rawPayload;
  }
  return null;
}

function rowToHistoricalContext(row: ContextHistoryRow): HistoricalContextSnapshot | null {
  const timestamp = Date.parse(row.created_at);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const payload = extractContextPayload(row);
  if (!payload) {
    return null;
  }

  return {
    timestamp,
    newsEventCount: safeNumber(payload.news_event_count ?? payload.newsEventCount),
    newsSentiment: safeNumber(payload.news_sentiment ?? payload.newsSentiment),
    newsImpact: safeNumber(payload.news_impact ?? payload.newsImpact),
    newsPositiveCount: safeNumber(payload.news_positive_count ?? payload.newsPositiveCount),
    newsNegativeCount: safeNumber(payload.news_negative_count ?? payload.newsNegativeCount),
    newsBtcRelevance: safeNumber(payload.news_btc_relevance ?? payload.newsBtcRelevance),
    newsShockScore: safeNumber(payload.news_shock_score ?? payload.newsShockScore),
    macroCpiYoY: safeNumber(payload.macro_cpi_yoy ?? payload.macroCpiYoY),
    macroCpiMoM: safeNumber(payload.macro_cpi_mom ?? payload.macroCpiMoM),
    macroCoreCpiYoY: safeNumber(payload.macro_core_cpi_yoy ?? payload.macroCoreCpiYoY),
    macroCoreCpiMoM: safeNumber(payload.macro_core_cpi_mom ?? payload.macroCoreCpiMoM),
    macroUnemploymentRate: safeNumber(payload.macro_unemployment_rate ?? payload.macroUnemploymentRate),
    macroUnemploymentChange: safeNumber(payload.macro_unemployment_change ?? payload.macroUnemploymentChange),
    macroInflationTrend: safeNumber(payload.macro_inflation_trend ?? payload.macroInflationTrend),
    macroRiskBias: safeNumber(payload.macro_risk_bias ?? payload.macroRiskBias),
    source: typeof payload.source === "string" ? payload.source : row.snapshot_type ?? "supabase",
  };
}

async function getRecentMicrostructureHistory(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  windowMinutes = 90,
) {
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("market_snapshots")
    .select(
      "created_at, raw_payload, spread_bps, imbalance, funding_rate_pct_8h, open_interest_usd, open_interest_change_pct, long_short_ratio, taker_imbalance, liquidation_bias, liquidation_intensity, cross_venue_basis_bps",
    )
    .eq("venue", "composite")
    .eq("snapshot_type", "microstructure")
    .in("symbol", [DB_SYMBOL, SYMBOL])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(180);

  if (error) {
    console.error("Failed to load microstructure history:", error);
    return [];
  }

  return prepareHistoricalMicrostructure(
    ((data ?? []) as MicrostructureHistoryRow[])
      .map((row) => rowToHistoricalMicrostructure(row))
      .filter((row): row is HistoricalMicrostructureSnapshot => row !== null),
  );
}

async function getRecentContextHistory(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  options: { newsWindowHours?: number; macroWindowDays?: number } = {},
) {
  const newsWindowHours = options.newsWindowHours ?? 48;
  const macroWindowDays = options.macroWindowDays ?? 120;
  const sinceNewsIso = new Date(Date.now() - newsWindowHours * 60 * 60_000).toISOString();
  const sinceMacroIso = new Date(Date.now() - macroWindowDays * 24 * 60 * 60_000).toISOString();

  const [newsResult, macroResult] = await Promise.all([
    supabaseAdmin
      .from("market_snapshots")
      .select("created_at, snapshot_type, raw_payload")
      .eq("snapshot_type", "news_context")
      .in("symbol", [DB_SYMBOL, SYMBOL])
      .gte("created_at", sinceNewsIso)
      .order("created_at", { ascending: true })
      .limit(500),
    supabaseAdmin
      .from("market_snapshots")
      .select("created_at, snapshot_type, raw_payload")
      .eq("snapshot_type", "macro_context")
      .in("symbol", [DB_SYMBOL, SYMBOL])
      .gte("created_at", sinceMacroIso)
      .order("created_at", { ascending: true })
      .limit(48),
  ]);

  if (newsResult.error) {
    console.error("Failed to load news context history:", newsResult.error);
  }
  if (macroResult.error) {
    console.error("Failed to load macro context history:", macroResult.error);
  }

  return prepareHistoricalContext(
    ([...(newsResult.data ?? []), ...(macroResult.data ?? [])] as ContextHistoryRow[])
      .map((row) => rowToHistoricalContext(row))
      .filter((row): row is HistoricalContextSnapshot => row !== null),
  );
}

function legacyModelApproval(artifact: LogisticModelArtifact) {
  return artifact.metrics.validation.precision >= 0.5 &&
    artifact.metrics.test.precision >= 0.5 &&
    artifact.metrics.validation.brier <= 0.24 &&
    artifact.metrics.test.brier <= 0.24 &&
    artifact.metrics.train.f1 - artifact.metrics.validation.f1 <= 0.2;
}

function modelApprovalStatus(artifact: LogisticModelArtifact | null) {
  if (!artifact) {
    return { approved: false, score: -Infinity };
  }

  const eligibility = (artifact as LogisticModelArtifact & { eligibility?: ArtifactEligibilityLike }).eligibility;
  if (eligibility) {
    return {
      approved: eligibility.approved === true,
      score: Number.isFinite(eligibility.score) ? Number(eligibility.score) : -Infinity,
    };
  }

  const score =
    artifact.metrics.validation.precision * 25 +
    artifact.metrics.test.precision * 30 +
    artifact.metrics.validation.f1 * 15 +
    artifact.metrics.test.f1 * 15 -
    artifact.metrics.validation.brier * 10 -
    artifact.metrics.test.brier * 10;
  return {
    approved: legacyModelApproval(artifact),
    score,
  };
}

async function loadLatestSignalModels(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("model_artifacts")
    .select("id, created_at, user_id, side, artifact")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load model artifacts:", error);
    return { longModel: null, shortModel: null };
  }

  const rows = ((data ?? []) as ModelArtifactRow[])
    .filter((row) => row.user_id === userId || row.user_id === null);
  const pickEligible = (side: "long" | "short") => rows
    .filter((row) => row.side === side && row.artifact)
    .map((row) => ({
      row,
      approval: modelApprovalStatus(row.artifact),
      createdAtMs: Date.parse(row.created_at),
    }))
    .sort((left, right) => {
      if (left.approval.approved !== right.approval.approved) {
        return left.approval.approved ? -1 : 1;
      }
      if (left.approval.score !== right.approval.score) {
        return right.approval.score - left.approval.score;
      }
      return right.createdAtMs - left.createdAtMs;
    })[0]?.row ?? null;
  const longRow = pickEligible("long");
  const shortRow = pickEligible("short");

  return {
    longModel: longRow?.artifact && modelApprovalStatus(longRow.artifact).approved ? longRow.artifact : null,
    shortModel: shortRow?.artifact && modelApprovalStatus(shortRow.artifact).approved ? shortRow.artifact : null,
    longModelId: longRow?.id ?? null,
    shortModelId: shortRow?.id ?? null,
  };
}

async function loadForwardValidationStatus(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<ForwardValidationStatus> {
  const fallback: ForwardValidationStatus = {
    paper: null,
    live: null,
    allowsLiveEntries: false,
    sourceMode: null,
    reason: "no recent forward validation report",
  };

  const { data, error } = await supabaseAdmin
    .from("forward_validation_reports")
    .select("created_at, execution_mode, trade_count, gate_passed, gate_reason")
    .eq("user_id", userId)
    .eq("symbol", DB_SYMBOL)
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) {
    console.error("Failed to load forward validation status:", error);
    return {
      ...fallback,
      reason: "forward validation lookup failed",
    };
  }

  const rows = ((data ?? []) as ForwardValidationReportRow[]).filter((row) => {
    const createdAtMs = Date.parse(row.created_at);
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= FORWARD_VALIDATION_MAX_AGE_MS;
  });
  const live = rows.find((row) => row.execution_mode === "live") ?? null;
  const paper = rows.find((row) => row.execution_mode === "paper") ?? null;

  if (live) {
    return {
      paper,
      live,
      allowsLiveEntries: live.gate_passed === true,
      sourceMode: "live",
      reason: live.gate_passed
        ? `live forward validation passed on ${live.trade_count} trades`
        : live.gate_reason ?? "latest live forward validation failed",
    };
  }

  if (paper) {
    return {
      paper,
      live,
      allowsLiveEntries: paper.gate_passed === true,
      sourceMode: "paper",
      reason: paper.gate_passed
        ? `paper forward validation passed on ${paper.trade_count} trades`
        : paper.gate_reason ?? "latest paper forward validation failed",
    };
  }

  return fallback;
}

async function loadOpsEntryGuard(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
): Promise<OpsEntryGuard> {
  const fallback: OpsEntryGuard = {
    allowsLiveEntries: false,
    reason: "ops control state unavailable",
    heartbeatAgeSeconds: null,
  };

  const { data: controlData, error: controlError } = await supabaseAdmin
    .from("ops_controls")
    .select("kill_switch, pause_new_entries, disable_live_entries_until, max_heartbeat_age_seconds, notes")
    .eq("scope", "global")
    .eq("symbol", DB_SYMBOL)
    .maybeSingle();
  if (controlError) {
    console.error("Failed to load ops control:", controlError);
    return fallback;
  }

  const control = (controlData ?? null) as OpsControlRow | null;
  if (control?.kill_switch) {
    return {
      allowsLiveEntries: false,
      reason: control.notes ?? "global kill switch enabled",
      heartbeatAgeSeconds: null,
    };
  }

  const disabledUntil = control?.disable_live_entries_until ? Date.parse(control.disable_live_entries_until) : null;
  if (disabledUntil && Number.isFinite(disabledUntil) && disabledUntil > Date.now()) {
    return {
      allowsLiveEntries: false,
      reason: control?.notes ?? `live entries paused until ${control?.disable_live_entries_until}`,
      heartbeatAgeSeconds: null,
    };
  }

  if (control?.pause_new_entries) {
    return {
      allowsLiveEntries: false,
      reason: control.notes ?? "new live entries paused by ops control",
      heartbeatAgeSeconds: null,
    };
  }

  const { data: heartbeatData, error: heartbeatError } = await supabaseAdmin
    .from("ops_heartbeats")
    .select("created_at, status")
    .eq("service_name", "ops-daemon")
    .eq("symbol", DB_SYMBOL)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (heartbeatError) {
    console.error("Failed to load ops heartbeat:", heartbeatError);
    return fallback;
  }

  const heartbeat = (heartbeatData ?? null) as OpsHeartbeatRow | null;
  if (!heartbeat?.created_at) {
    return {
      allowsLiveEntries: false,
      reason: "ops-daemon heartbeat missing",
      heartbeatAgeSeconds: null,
    };
  }

  const heartbeatAgeSeconds = (Date.now() - Date.parse(heartbeat.created_at)) / 1000;
  const maxHeartbeatAgeSeconds = control?.max_heartbeat_age_seconds ?? 180;
  if (!Number.isFinite(heartbeatAgeSeconds) || heartbeatAgeSeconds > maxHeartbeatAgeSeconds) {
    return {
      allowsLiveEntries: false,
      reason: `ops-daemon heartbeat stale (${Math.round(heartbeatAgeSeconds)}s old)`,
      heartbeatAgeSeconds: Number.isFinite(heartbeatAgeSeconds) ? Math.round(heartbeatAgeSeconds) : null,
    };
  }

  if (heartbeat.status !== "ok" && heartbeat.status !== "degraded") {
    return {
      allowsLiveEntries: false,
      reason: `ops-daemon heartbeat status ${heartbeat.status}`,
      heartbeatAgeSeconds: Math.round(heartbeatAgeSeconds),
    };
  }

  return {
    allowsLiveEntries: true,
    reason: "ops control checks passed",
    heartbeatAgeSeconds: Math.round(heartbeatAgeSeconds),
  };
}

function applyModelOverlay(
  candles: Awaited<ReturnType<typeof fetchFuturesOHLCV>>,
  settings: StrategySettings,
  decision: StrategyDecision,
  models: { longModel: LogisticModelArtifact | null; shortModel: LogisticModelArtifact | null },
  microstructureOptions: {
    liveMicrostructure?: Parameters<typeof buildMarketState>[3];
    microstructureHistory?: HistoricalMicrostructureSnapshot[];
    contextHistory?: HistoricalContextSnapshot[];
    newsLookbackMs?: number;
  } = {},
) {
  const { featureMap } = extractFeatureMap(candles, candles.length - 1, settings, {
    liveMicrostructure: microstructureOptions.liveMicrostructure ?? null,
    microstructureHistory: microstructureOptions.microstructureHistory ?? [],
    contextHistory: microstructureOptions.contextHistory ?? [],
    newsLookbackMs: microstructureOptions.newsLookbackMs ?? DEFAULT_MODEL_NEWS_LOOKBACK_MS,
  });
  const longProbability = models.longModel ? predictLogisticProbability(models.longModel, featureMap) : null;
  const shortProbability = models.shortModel ? predictLogisticProbability(models.shortModel, featureMap) : null;
  const sharedFeatures = {
    ...decision.features,
    ...extractLiveOverlayFeatures(featureMap),
    modelLongProbability: longProbability === null ? null : Number(longProbability.toFixed(6)),
    modelShortProbability: shortProbability === null ? null : Number(shortProbability.toFixed(6)),
    modelLongThreshold: models.longModel ? Number(models.longModel.threshold.toFixed(6)) : null,
    modelShortThreshold: models.shortModel ? Number(models.shortModel.threshold.toFixed(6)) : null,
  };

  if (!models.longModel && !models.shortModel) {
    return {
      ...decision,
      features: sharedFeatures,
    };
  }

  if (decision.action !== "long" && decision.action !== "short") {
    return {
      ...decision,
      features: sharedFeatures,
    };
  }

  const selectedModel = decision.action === "long" ? models.longModel : models.shortModel;
  const selectedProbability = decision.action === "long" ? longProbability : shortProbability;
  const oppositeProbability = decision.action === "long" ? shortProbability : longProbability;
  if (!selectedModel || selectedProbability === null) {
    return {
      ...decision,
      features: sharedFeatures,
    };
  }

  const threshold = selectedModel.threshold;
  const delta = selectedProbability - threshold;
  const modelEdge = selectedProbability - (oppositeProbability ?? 0.5);
  const confidenceAdjustment = clamp(delta * 110 + modelEdge * 60, -24, 18);
  const features = {
    ...sharedFeatures,
    modelThreshold: Number(threshold.toFixed(6)),
    modelEdge: Number(modelEdge.toFixed(6)),
    modelDelta: Number(delta.toFixed(6)),
  };

  if (delta < -0.08 || modelEdge < -0.03) {
    return {
      ...decision,
      action: "hold" as TradeAction,
      confidence: clamp(decision.confidence + confidenceAdjustment, 0, 99),
      reasoning:
        `${decision.reasoning} · model vetoed ${decision.action} ` +
        `(${(selectedProbability * 100).toFixed(1)}%, edge ${(modelEdge * 100).toFixed(1)}pts)`,
      features,
    };
  }

  if (delta < 0.01 && modelEdge < 0.04) {
    return {
      ...decision,
      action: "hold" as TradeAction,
      confidence: clamp(decision.confidence + confidenceAdjustment, 0, 99),
      reasoning: `${decision.reasoning} · model conviction is too weak`,
      features,
    };
  }

  return {
    ...decision,
    confidence: clamp(decision.confidence + confidenceAdjustment, 0, 99),
    reasoning:
      `${decision.reasoning} · model ${delta >= 0 ? "confirmed" : "tempered"} ${decision.action} ` +
      `(${(selectedProbability * 100).toFixed(1)}%, edge ${(modelEdge * 100).toFixed(1)}pts)`,
    features,
  };
}

function deriveTrainingVolatilityBucket(marketState: ReturnType<typeof buildMarketState>) {
  const combined = marketState.timeframe1m.atrPct * 100 + marketState.timeframe15m.realizedVolPct * 0.35;
  if (combined < 0.35) return "compressed" as const;
  if (combined > 0.95) return "expanded" as const;
  return "normal" as const;
}

function applyCompressedLongRegimeGate(
  decision: StrategyDecision,
  marketState: ReturnType<typeof buildMarketState>,
) {
  const volatilityBucket = deriveTrainingVolatilityBucket(marketState);
  const features = {
    ...decision.features,
    liveVolatilityBucket: volatilityBucket,
    compressedLongGate: false,
  };

  if (
    decision.action !== "long" ||
    decision.regime !== "trend_long" ||
    volatilityBucket !== "compressed"
  ) {
    return {
      ...decision,
      features,
    };
  }

  return {
    ...decision,
    action: "hold" as TradeAction,
    confidence: clamp(decision.confidence - 18, 0, 99),
    reasoning: `${decision.reasoning} · compressed trend-long regime gated`,
    features: {
      ...features,
      compressedLongGate: true,
    },
  };
}

async function analyzeWithOpenAI(
  openaiKey: string,
  decision: StrategyDecision,
  marketState: ReturnType<typeof buildMarketState>,
) {
  const prompt = `You are reviewing a crypto futures scalping decision.

Return only JSON:
{"verdict":"confirm|veto|tighten_exit","confidence_adjustment":-15_to_15,"reasoning":"short sentence"}

Current decision:
${JSON.stringify(decision)}

Market state:
${JSON.stringify(marketState)}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 120,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    return { verdict: "confirm", confidence_adjustment: 0, reasoning: `OpenAI failed (${response.status})` };
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content?.replace(/```json\s*/g, "").replace(/```/g, "").trim() ?? "";

  try {
    const parsed = JSON.parse(content) as {
      verdict?: "confirm" | "veto" | "tighten_exit";
      confidence_adjustment?: number;
      reasoning?: string;
    };

    return {
      verdict: parsed.verdict ?? "confirm",
      confidence_adjustment: clamp(Number(parsed.confidence_adjustment ?? 0), -15, 15),
      reasoning: parsed.reasoning ?? "AI review applied",
    };
  } catch {
    return { verdict: "confirm", confidence_adjustment: 0, reasoning: "AI parse fallback" };
  }
}

async function applyAiOverlay(
  keys: ApiKeysRecord,
  decision: StrategyDecision,
  marketState: ReturnType<typeof buildMarketState>,
  manualSide: TradeAction | null,
) {
  if (!keys.openai_key || manualSide) {
    return decision;
  }

  const aiReview = await analyzeWithOpenAI(keys.openai_key, decision, marketState);
  if (decision.action === "close") {
    return {
      ...decision,
      confidence: clamp(decision.confidence + Math.max(aiReview.confidence_adjustment, -5), 0, 99),
      reasoning: `${decision.reasoning} · AI ${aiReview.verdict}: ${aiReview.reasoning}`,
    };
  }

  if (aiReview.verdict === "veto") {
    return {
      ...decision,
      action: "hold" as TradeAction,
      reasoning: `${decision.reasoning} · AI vetoed: ${aiReview.reasoning}`,
    };
  }

  if (aiReview.verdict === "tighten_exit" && (decision.action === "long" || decision.action === "short")) {
    return {
      ...decision,
      stopPct: decision.stopPct * 0.9,
      takeProfitPct: decision.takeProfitPct * 0.9,
      confidence: clamp(decision.confidence + aiReview.confidence_adjustment, 0, 99),
      reasoning: `${decision.reasoning} · AI requested tighter exits: ${aiReview.reasoning}`,
    };
  }

  return {
    ...decision,
    confidence: clamp(decision.confidence + aiReview.confidence_adjustment, 0, 99),
    reasoning: `${decision.reasoning} · AI confirmed: ${aiReview.reasoning}`,
  };
}

async function closePaperTrade(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  trade: TradeRecord,
  exitPrice: number,
  reason = "manual_close",
) {
  const isLong = trade.side === "buy";
  const pnl = Number(((isLong ? exitPrice - trade.entry_price : trade.entry_price - exitPrice) * trade.size).toFixed(2));
  const metadata = trade.trade_metadata ?? {};
  const execution = typeof metadata.execution === "object" && metadata.execution !== null
    ? metadata.execution as Record<string, unknown>
    : {};

  const { error } = await supabaseAdmin
    .from("trades")
    .update({
      status: "closed",
      exit_price: exitPrice,
      pnl,
      closed_at: new Date().toISOString(),
      trade_metadata: {
        ...metadata,
        execution: {
          ...execution,
          requestedExitPrice: exitPrice,
          actualExitPrice: exitPrice,
          exitReason: reason,
          closedAt: new Date().toISOString(),
        },
      },
    })
    .eq("id", trade.id);

  if (error) throw error;
  return pnl;
}

async function closePaperTrades(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
  currentPrice: number,
  keys: ApiKeysRecord,
  telegramId: string | null,
  reason: string,
) {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("symbol", DB_SYMBOL);

  if (error) throw error;
  const openTrades = (data ?? []) as TradeRecord[];
  if (openTrades.length === 0) {
    return "no_open_trade";
  }

  let totalPnl = 0;
  for (const trade of openTrades) {
    totalPnl += await closePaperTrade(supabaseAdmin, trade, currentPrice, reason);
  }

  if (keys.telegram_token && telegramId) {
    await sendTelegramAlert(
      keys.telegram_token,
      telegramId,
      `🧾 PAPER CLOSE *ScalpPro*\n💰 Exit: $${currentPrice.toFixed(2)}\n${totalPnl >= 0 ? "✅" : "❌"} PnL: $${totalPnl.toFixed(2)}\n🧠 ${reason}`,
    );
  }

  return `paper_close_$${totalPnl.toFixed(2)}`;
}

async function executeTrade(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
  action: "long" | "short",
  currentPrice: number,
  settings: StrategySettings,
  decision: StrategyDecision,
  paperMode: boolean,
  keys: ApiKeysRecord,
  telegramId: string | null,
  modelIds: { longModelId: string | null; shortModelId: string | null },
  forwardValidation: ForwardValidationStatus | null,
) {
  const { stopPrice, takeProfitPrice } = toStopAndTakeProfit(currentPrice, action, decision);
  const executionProfile = buildExecutionProfile(settings, decision);
  const tradeMetadata: Record<string, unknown> = {
    initialStopPrice: stopPrice,
    initialTakeProfitPrice: takeProfitPrice,
    initialRiskPerUnit: Math.abs(currentPrice - stopPrice),
    takeProfitPct: decision.takeProfitPct,
    stopPct: decision.stopPct,
    regime: decision.regime,
    reasoning: decision.reasoning,
    features: decision.features,
    executionProfile,
    execution: {
      venue: "mexc",
      mode: paperMode ? "paper" : "live",
      requestedEntryPrice: currentPrice,
      actualEntryPrice: currentPrice,
      createdAt: new Date().toISOString(),
      feesEstimate: 0,
      longModelId: modelIds.longModelId,
      shortModelId: modelIds.shortModelId,
    },
    forwardValidation: forwardValidation
      ? {
        allowsLiveEntries: forwardValidation.allowsLiveEntries,
        sourceMode: forwardValidation.sourceMode,
        reason: forwardValidation.reason,
      }
      : null,
  };

  if (paperMode) {
    const riskState = await getSessionRiskState(supabaseAdmin, userId);
    const sizing = calculatePositionSize(
      riskState.currentBalance,
      executionProfile.effectiveRiskPct,
      currentPrice,
      stopPrice,
      executionProfile.effectiveLeverage,
    );
    if (!sizing) return "paper_insufficient_balance";

    const { error } = await supabaseAdmin.from("trades").insert({
      user_id: userId,
      symbol: DB_SYMBOL,
      side: action === "long" ? "buy" : "sell",
      size: sizing.sizeBtc,
      entry_price: currentPrice,
      tp: takeProfitPrice,
      sl: stopPrice,
      leverage: executionProfile.effectiveLeverage,
      status: "open",
      setup_type: decision.setupType,
      entry_confidence: decision.confidence,
      trade_metadata: tradeMetadata,
    });

    if (error) throw error;

    if (keys.telegram_token && telegramId) {
      await sendTelegramAlert(
        keys.telegram_token,
        telegramId,
        `📝 PAPER ${action === "long" ? "🟢 LONG" : "🔴 SHORT"} *ScalpPro*\n💰 Entry: $${currentPrice.toFixed(2)}\n🎯 TP: $${takeProfitPrice.toFixed(2)}\n🛑 SL: $${stopPrice.toFixed(2)}\n📐 ${sizing.contracts} contracts (${sizing.sizeBtc.toFixed(4)} BTC) @ ${executionProfile.effectiveLeverage}x\n🎛 Risk ${executionProfile.effectiveRiskPct.toFixed(2)}% · Conviction ${executionProfile.convictionScore.toFixed(0)}\n🧠 ${decision.reasoning}`,
      );
    }

    return `paper_${action}_executed`;
  }

  if (!keys.mexc_key || !keys.mexc_secret) {
    return "missing_mexc_keys";
  }

  const assetResponse = await getAccountAssets(keys.mexc_key, keys.mexc_secret);
  const assets = (assetResponse.data ?? []) as MexcAsset[];
  const usdtBalance = Number(assets.find((asset) => asset.currency === "USDT")?.availableBalance ?? 0);
  if (usdtBalance < MIN_BALANCE_USDT) return "insufficient_balance";

  const sizing = calculatePositionSize(
    usdtBalance,
    executionProfile.effectiveRiskPct,
    currentPrice,
    stopPrice,
    executionProfile.effectiveLeverage,
  );
  if (!sizing) return "insufficient_balance";

  const orderResponse = await submitOrder(keys.mexc_key, keys.mexc_secret, {
    symbol: SYMBOL,
    price: currentPrice.toFixed(2),
    vol: sizing.contracts,
    leverage: executionProfile.effectiveLeverage,
    side: action === "long" ? 1 : 3,
    type: 5,
    openType: 1,
    stopLossPrice: stopPrice.toFixed(2),
    takeProfitPrice: takeProfitPrice.toFixed(2),
  });

  if (!(orderResponse.success === true || orderResponse.code === 0)) {
    return `live_order_failed:${orderResponse.msg ?? orderResponse.message ?? orderResponse.code ?? "unknown"}`;
  }

  tradeMetadata.execution = {
    ...(tradeMetadata.execution as Record<string, unknown>),
    orderId: orderResponse.data ?? null,
    orderResponse,
  };

  const { error } = await supabaseAdmin.from("trades").insert({
    user_id: userId,
    symbol: DB_SYMBOL,
    side: action === "long" ? "buy" : "sell",
    size: sizing.sizeBtc,
    entry_price: currentPrice,
    tp: takeProfitPrice,
    sl: stopPrice,
    leverage: executionProfile.effectiveLeverage,
    status: "open",
    setup_type: decision.setupType,
    entry_confidence: decision.confidence,
    trade_metadata: tradeMetadata,
  });

  if (error) throw error;

  if (keys.telegram_token && telegramId) {
    await sendTelegramAlert(
      keys.telegram_token,
      telegramId,
      `${action === "long" ? "🟢 LONG" : "🔴 SHORT"} *ScalpPro*\n💰 Entry: $${currentPrice.toFixed(2)}\n🎯 TP: $${takeProfitPrice.toFixed(2)}\n🛑 SL: $${stopPrice.toFixed(2)}\n📐 ${sizing.contracts} contracts (${sizing.sizeBtc.toFixed(4)} BTC) @ ${executionProfile.effectiveLeverage}x\n🎛 Risk ${executionProfile.effectiveRiskPct.toFixed(2)}% · Conviction ${executionProfile.convictionScore.toFixed(0)}\n🧠 ${decision.reasoning}`,
    );
  }

  return `${action}_executed`;
}

function connectMexcWS(): Promise<{ ws: WebSocket; prices: { latest: number }; close: () => void }> {
  return new Promise((resolve, reject) => {
    const prices = { latest: 0 };
    const ws = new WebSocket(MEXC_WS_URL);
    let settled = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "sub.deal", param: { symbol: SYMBOL } }));
      ws.send(JSON.stringify({ method: "sub.ticker", param: { symbol: SYMBOL } }));
      if (!settled) {
        settled = true;
        resolve({ ws, prices, close: () => ws.close() });
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          channel?: string;
          data?: { p?: string | number; price?: string | number; lastPrice?: string | number; fairPrice?: string | number };
        };

        if (message.channel === "push.deal" && message.data) {
          prices.latest = Number(message.data.p ?? message.data.price ?? 0);
        }
        if (message.channel === "push.ticker" && message.data) {
          prices.latest = Number(message.data.lastPrice ?? message.data.fairPrice ?? prices.latest);
        }
      } catch {
        // ignore malformed events
      }
    };

    ws.onerror = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket connection timeout"));
      }
    }, 5_000);
  });
}

async function checkPaperTPSL(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
  currentPrice: number,
  keys: ApiKeysRecord,
  telegramId: string | null,
) {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("symbol", DB_SYMBOL);

  if (error) throw error;
  const openTrades = (data ?? []) as TradeRecord[];
  if (openTrades.length === 0) return null;

  for (const trade of openTrades) {
    const isLong = trade.side === "buy";
    const metadata = trade.trade_metadata ?? {};
    const initialRiskPerUnit = Number(metadata.initialRiskPerUnit ?? Math.abs(trade.entry_price - Number(trade.sl ?? trade.entry_price)));
    let nextStop = Number(trade.sl ?? trade.entry_price);
    const favorableMove = isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice;

    if (favorableMove >= initialRiskPerUnit) {
      nextStop = isLong ? Math.max(nextStop, trade.entry_price) : Math.min(nextStop, trade.entry_price);
    }
    if (favorableMove >= initialRiskPerUnit * 1.5) {
      const trail = isLong ? trade.entry_price + initialRiskPerUnit * 0.5 : trade.entry_price - initialRiskPerUnit * 0.5;
      nextStop = isLong ? Math.max(nextStop, trail) : Math.min(nextStop, trail);
    }

    if (nextStop !== Number(trade.sl ?? trade.entry_price)) {
      const { error: stopUpdateError } = await supabaseAdmin
        .from("trades")
        .update({ sl: nextStop })
        .eq("id", trade.id);
      if (stopUpdateError) throw stopUpdateError;
      trade.sl = nextStop;
    }

    const tpPrice = Number(trade.tp ?? trade.entry_price);
    const slPrice = Number(trade.sl ?? trade.entry_price);
    const hitTakeProfit = isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice;
    const hitStopLoss = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;

    if (!hitTakeProfit && !hitStopLoss) {
      continue;
    }

    const exitPrice = hitTakeProfit ? tpPrice : slPrice;
    const pnl = await closePaperTrade(supabaseAdmin, trade, exitPrice, hitTakeProfit ? "tp_hit" : "sl_hit");

    if (keys.telegram_token && telegramId) {
      await sendTelegramAlert(
        keys.telegram_token,
        telegramId,
        `🧾 PAPER ${hitTakeProfit ? "🎯 TP HIT" : "🛑 SL HIT"} *ScalpPro*\n💰 Exit: $${exitPrice.toFixed(2)}\n${pnl >= 0 ? "✅" : "❌"} PnL: $${pnl.toFixed(2)}`,
      );
    }

    return { hit: hitTakeProfit ? "tp" : "sl", pnl };
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { isServiceRole, userId: callerUserId } = await resolveCaller(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
    const requestedAction = typeof body.side === "string" ? body.side : null;
    const requestedUserId = typeof body.user_id === "string" ? body.user_id : null;
    const allowedActions: TradeAction[] = ["long", "short", "close", "hold"];
    const manualSide = allowedActions.includes(requestedAction as TradeAction) ? (requestedAction as TradeAction) : null;

    if (!isServiceRole && requestedUserId && requestedUserId !== callerUserId) {
      throw new HttpError(403, "You can only operate on your own account");
    }
    if (isServiceRole && manualSide && !requestedUserId) {
      throw new HttpError(400, "user_id is required for service-role manual actions");
    }

    const supabaseAdmin = createAdminClient();
    let profilesQuery = supabaseAdmin
      .from("profiles")
      .select("user_id, auto_trade, max_risk_pct, leverage, telegram_id, demo_mode, min_confidence, daily_loss_limit_pct, max_consecutive_losses, allow_trend_trades, allow_mean_reversion_trades");

    if (isServiceRole) {
      profilesQuery = requestedUserId
        ? profilesQuery.eq("user_id", requestedUserId)
        : profilesQuery.eq("auto_trade", true);
    } else {
      profilesQuery = profilesQuery.eq("user_id", callerUserId);
    }

    const { data: profileRows, error: profileError } = await profilesQuery;
    if (profileError) throw profileError;
    const profiles = (profileRows ?? []) as ProfileRecord[];
    if (profiles.length === 0) {
      return jsonResponse({ message: "No eligible profiles found" });
    }

    const candles = await fetchFuturesOHLCV();
    const latestPrice = candles[candles.length - 1].close;
    const liquidationMetrics = await getLatestLiquidationMetrics(supabaseAdmin);
    const crossVenueSnapshot = await fetchCrossVenueSnapshot({
      liquidationMetrics: liquidationMetrics ?? undefined,
    });
    const recentMicrostructureHistory = await getRecentMicrostructureHistory(supabaseAdmin);
    const modelMicrostructureHistory = prepareHistoricalMicrostructure([
      ...recentMicrostructureHistory,
      ...(crossVenueSnapshot.microstructure
        ? [{
          timestamp: crossVenueSnapshot.fetchedAt,
          microstructure: crossVenueSnapshot.microstructure,
          source: "live",
        } satisfies HistoricalMicrostructureSnapshot]
        : []),
    ]);
    const results: Array<{ userId: string; action: string; detail: string }> = [];

    for (const profile of profiles) {
      const settings = toStrategySettings(profile);
      const userId = profile.user_id;
      const telegramId = profile.telegram_id;
      const paperMode = profile.demo_mode;

      const { data: keysRow, error: keyError } = await supabaseAdmin
        .from("api_keys")
        .select("mexc_key, mexc_secret, openai_key, telegram_token")
        .eq("user_id", userId)
        .maybeSingle();
      if (keyError) throw keyError;

      const keys = (keysRow ?? null) as ApiKeysRecord | null;
      if (!keys?.mexc_key || !keys?.mexc_secret) {
        results.push({ userId, action: "skipped", detail: "MEXC API keys are not configured" });
        continue;
      }
      const opsGuard = !paperMode
        ? await loadOpsEntryGuard(supabaseAdmin)
        : {
          allowsLiveEntries: true,
          reason: "paper mode bypasses ops live-entry guard",
          heartbeatAgeSeconds: null,
        };
      const forwardValidation = manualSide
        ? null
        : await loadForwardValidationStatus(supabaseAdmin, userId);
      const loadedModels = manualSide
        ? { longModel: null, shortModel: null, longModelId: null, shortModelId: null }
        : await loadLatestSignalModels(supabaseAdmin, userId);
      const models = !paperMode && !manualSide && (
        !(forwardValidation?.allowsLiveEntries ?? false) ||
        !opsGuard.allowsLiveEntries
      )
        ? { longModel: null, shortModel: null, longModelId: null, shortModelId: null }
        : loadedModels;

      const openTradeRecord = await getOpenTradeRecord(supabaseAdmin, userId);
      let hasPosition = false;
      let positionSide: "long" | "short" | null = openTradeRecord
        ? openTradeRecord.side === "buy" ? "long" : "short"
        : null;

      if (paperMode) {
        hasPosition = openTradeRecord !== null;
      } else {
        const livePositions = await getOpenPositions(keys.mexc_key, keys.mexc_secret, SYMBOL);
        const positions = (livePositions.data ?? []) as MexcPosition[];
        hasPosition = positions.length > 0;
        if (hasPosition && !positionSide) {
          positionSide = positions[0].positionType === 1 ? "long" : "short";
        }
      }

      const sessionRisk = await getSessionRiskState(supabaseAdmin, userId);
      const modelContextHistory = loadedModels.longModel || loadedModels.shortModel
        ? await getRecentContextHistory(supabaseAdmin)
        : [];
      let decision: StrategyDecision;

      if (manualSide) {
        decision = {
          action: manualSide,
          confidence: 100,
          reasoning: `Manual ${manualSide} request`,
          regime: "mixed",
          setupType: "manual",
          stopPct: 0.0015,
          takeProfitPct: 0.003,
          riskReward: 2,
          features: {},
        };
      } else {
        const marketState = buildMarketState(
          candles,
          positionSide,
          (openTradeRecord?.setup_type as StrategySetup | null) ?? null,
          crossVenueSnapshot.microstructure,
        );
        decision = deriveAdvancedDecision(marketState, settings, sessionRisk);
        decision = applyCompressedLongRegimeGate(decision, marketState);
        decision = applyModelOverlay(candles, settings, decision, models, {
          liveMicrostructure: crossVenueSnapshot.microstructure,
          microstructureHistory: modelMicrostructureHistory,
          contextHistory: modelContextHistory,
        });
        decision = await applyAiOverlay(keys, decision, marketState, manualSide);
        decision = applyPrecisionFirstEventGuard(decision, settings.minConfidence);
        if (!paperMode && !(forwardValidation?.allowsLiveEntries ?? false) && (decision.action === "long" || decision.action === "short")) {
          decision = {
            ...decision,
            action: "hold",
            reasoning: `${decision.reasoning} · live auto-entry locked until forward validation passes (${forwardValidation?.reason ?? "no recent report"})`,
          };
        }
        if (!paperMode && !opsGuard.allowsLiveEntries && (decision.action === "long" || decision.action === "short")) {
          decision = {
            ...decision,
            action: "hold",
            reasoning: `${decision.reasoning} · ops guard blocked live entry (${opsGuard.reason})`,
          };
        }
      }

      if (!paperMode && manualSide && manualSide !== "close" && !opsGuard.allowsLiveEntries) {
        decision = {
          ...decision,
          action: "hold",
          reasoning: `${decision.reasoning} · ops guard blocked manual live entry (${opsGuard.reason})`,
        };
      }

      const marketState = buildMarketState(
        candles,
        positionSide,
        (openTradeRecord?.setup_type as StrategySetup | null) ?? null,
        crossVenueSnapshot.microstructure,
      );
      const signalType = decision.action === "long" ? "buy" : decision.action === "short" ? "sell" : "hold";
      const signalPayload: SignalInsert = {
        user_id: userId,
        symbol: DB_SYMBOL,
        rsi: Number(marketState.timeframe1m.rsi.toFixed(1)),
        price: Number(latestPrice.toFixed(2)),
        signal: signalType,
        ai_reasoning: decision.reasoning,
        confidence: decision.confidence,
        decision_source: decision.setupType === "manual"
          ? "manual"
          : (models.longModel || models.shortModel) ? "advanced_rules_with_model" : "advanced_rules",
        signal_context: {
          regime: decision.regime,
          setupType: decision.setupType,
          timeframe1m: marketState.timeframe1m,
          timeframe5m: marketState.timeframe5m,
          timeframe15m: marketState.timeframe15m,
          marketMicrostructure: crossVenueSnapshot.microstructure,
          venues: {
            mexc: crossVenueSnapshot.primary,
            binance: crossVenueSnapshot.secondary,
          },
          liquidationMetrics,
          models: {
            longModelId: models.longModelId ?? null,
            shortModelId: models.shortModelId ?? null,
          },
          opsGuard,
          forwardValidation,
          features: decision.features,
          risk: sessionRisk,
        },
      };
      const { error: signalError } = await supabaseAdmin.from("signals").insert(signalPayload);
      if (signalError) throw signalError;

      if (!hasPosition && (decision.action === "long" || decision.action === "short")) {
        const cooldown = await isOnEntryCooldown(supabaseAdmin, userId);
        if (cooldown && !manualSide) {
          results.push({ userId, action: "hold", detail: "Entry cooldown is active" });
          continue;
        }

        const executionResult = await executeTrade(
          supabaseAdmin,
          userId,
          decision.action,
          latestPrice,
          settings,
          decision,
          paperMode,
          keys,
          telegramId,
          {
            longModelId: models.longModelId ?? null,
            shortModelId: models.shortModelId ?? null,
          },
          forwardValidation,
        );
        results.push({ userId, action: executionResult, detail: decision.reasoning });
        continue;
      }

      if (hasPosition && decision.action === "close") {
        if (paperMode) {
          const closeResult = await closePaperTrades(supabaseAdmin, userId, latestPrice, keys, telegramId, decision.reasoning);
          results.push({ userId, action: closeResult, detail: decision.reasoning });
          continue;
        }

        const livePositions = await getOpenPositions(keys.mexc_key, keys.mexc_secret, SYMBOL);
        const positions = (livePositions.data ?? []) as MexcPosition[];
        const activePosition = positions[0];
        if (!activePosition || !activePosition.holdVol) {
          results.push({ userId, action: "hold", detail: "No live position found to close" });
          continue;
        }

        const closeResponse = await submitOrder(keys.mexc_key, keys.mexc_secret, {
          symbol: SYMBOL,
          price: latestPrice.toFixed(2),
          vol: Number(activePosition.holdVol),
          leverage: settings.leverage,
          side: positionSide === "long" ? 4 : 2,
          type: 5,
          openType: activePosition.openType ?? 1,
          positionId: activePosition.positionId,
          reduceOnly: true,
        });

        if (!(closeResponse.success === true || closeResponse.code === 0)) {
          results.push({
            userId,
            action: "close_failed",
            detail: closeResponse.msg ?? closeResponse.message ?? String(closeResponse.code ?? "unknown"),
          });
          continue;
        }

        const { error: updateError } = await supabaseAdmin
          .from("trades")
          .update({
            status: "closed",
            exit_price: latestPrice,
            closed_at: new Date().toISOString(),
            trade_metadata: {
              ...(openTradeRecord?.trade_metadata ?? {}),
              execution: {
                ...((openTradeRecord?.trade_metadata?.execution as Record<string, unknown> | undefined) ?? {}),
                requestedExitPrice: latestPrice,
                actualExitPrice: latestPrice,
                exitReason: decision.reasoning,
                closeOrderResponse: closeResponse,
                closedAt: new Date().toISOString(),
              },
            },
          })
          .eq("user_id", userId)
          .eq("status", "open")
          .eq("symbol", DB_SYMBOL);
        if (updateError) throw updateError;

        results.push({ userId, action: "close_executed", detail: decision.reasoning });
        continue;
      }

      results.push({ userId, action: "hold", detail: decision.reasoning });

      if (paperMode && hasPosition) {
        try {
          const { ws, prices, close } = await connectMexcWS();
          const start = Date.now();
          let lastPrice = 0;

          const pingInterval = setInterval(() => {
            try {
              ws.send(JSON.stringify({ method: "ping" }));
            } catch {
              // ignore ping errors during shutdown
            }
          }, 15_000);

          await new Promise<void>((resolve) => {
            const checkInterval = setInterval(async () => {
              if (Date.now() - start >= LOOP_DURATION_MS) {
                clearInterval(checkInterval);
                clearInterval(pingInterval);
                close();
                resolve();
                return;
              }

              if (prices.latest <= 0 || prices.latest === lastPrice) {
                return;
              }

              lastPrice = prices.latest;
              const hit = await checkPaperTPSL(supabaseAdmin, userId, prices.latest, keys, telegramId);
              if (hit) {
                clearInterval(checkInterval);
                clearInterval(pingInterval);
                close();
                resolve();
              }
            }, 150);
          });
        } catch (error) {
          console.error(`Paper websocket monitor failed for ${userId}:`, error);
        }
      }
    }

    return jsonResponse({
      price: Number(latestPrice.toFixed(2)),
      results,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }

    console.error("Scalper error:", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
