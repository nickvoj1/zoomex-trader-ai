export interface ForwardValidationTrade {
  id: string;
  created_at: string;
  closed_at: string | null;
  pnl: number | null;
  setup_type?: string | null;
  trade_metadata: Record<string, unknown> | null;
}

export interface ForwardValidationTca {
  trade_id: string;
  estimated_fees_usd: number | null;
  entry_slippage_bps: number | null;
  exit_slippage_bps: number | null;
  gross_edge_usd: number | null;
  net_edge_usd: number | null;
  holding_minutes: number | null;
  metadata: Record<string, unknown> | null;
}

export interface ForwardValidationMergedTrade {
  id: string;
  createdAt: string;
  closedAt: string;
  pnlUsd: number;
  feesUsd: number;
  grossEdgeUsd: number;
  netEdgeUsd: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  holdingMinutes: number;
  executionMode: string;
  modelAssisted: boolean;
  setupType: string | null;
  regime: string | null;
}

export interface ForwardValidationGate {
  minTrades: number;
  minWinRatePct: number;
  minExpectancyUsd: number;
  minProfitFactor: number;
  maxAvgEntrySlippageBps: number;
  maxAvgExitSlippageBps: number;
  maxDrawdownPct: number;
  minModelAssistedTrades: number;
}

export interface ForwardValidationReport {
  executionMode: string;
  windowStart: string;
  windowEnd: string;
  tradeCount: number;
  modelAssistedTradeCount: number;
  winRate: number;
  expectancyUsd: number;
  profitFactor: number;
  totalNetPnlUsd: number;
  totalFeesUsd: number;
  avgNetEdgeUsd: number;
  avgEntrySlippageBps: number;
  avgExitSlippageBps: number;
  avgHoldingMinutes: number;
  maxDrawdownPct: number;
  gatePassed: boolean;
  gateReason: string;
  details: {
    grossProfitUsd: number;
    grossLossUsd: number;
    modelAssistedWinRate: number;
    setupCounts: Record<string, number>;
    regimeCounts: Record<string, number>;
    tradeIds: string[];
  };
}

function round(value: number, precision = 4) {
  return Number(value.toFixed(precision));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isModelAssisted(tradeMetadata: Record<string, unknown> | null) {
  const features = tradeMetadata && typeof tradeMetadata.features === "object" && tradeMetadata.features !== null
    ? tradeMetadata.features as Record<string, unknown>
    : null;
  const execution = tradeMetadata && typeof tradeMetadata.execution === "object" && tradeMetadata.execution !== null
    ? tradeMetadata.execution as Record<string, unknown>
    : null;
  return Boolean(
    (features &&
      (
        typeof features.modelLongProbability === "number" ||
        typeof features.modelShortProbability === "number" ||
        typeof features.modelEdge === "number"
      )) ||
    (execution &&
      (
        typeof execution.longModelId === "string" ||
        typeof execution.shortModelId === "string"
      )),
  );
}

export function mergeTradesWithTca(
  trades: ForwardValidationTrade[],
  tcaRows: ForwardValidationTca[],
) {
  const tcaByTradeId = new Map(tcaRows.map((row) => [row.trade_id, row]));

  return trades
    .filter((trade) => trade.closed_at)
    .map<ForwardValidationMergedTrade>((trade) => {
      const metadata = trade.trade_metadata ?? {};
      const execution = typeof metadata.execution === "object" && metadata.execution !== null
        ? metadata.execution as Record<string, unknown>
        : {};
      const tca = tcaByTradeId.get(trade.id);

      return {
        id: trade.id,
        createdAt: trade.created_at,
        closedAt: trade.closed_at ?? trade.created_at,
        pnlUsd: toNumber(trade.pnl),
        feesUsd: toNumber(tca?.estimated_fees_usd),
        grossEdgeUsd: toNumber(tca?.gross_edge_usd),
        netEdgeUsd: tca?.net_edge_usd !== null && tca?.net_edge_usd !== undefined
          ? toNumber(tca.net_edge_usd)
          : toNumber(trade.pnl),
        entrySlippageBps: toNumber(tca?.entry_slippage_bps),
        exitSlippageBps: toNumber(tca?.exit_slippage_bps),
        holdingMinutes: toNumber(tca?.holding_minutes),
        executionMode: typeof execution.mode === "string" ? execution.mode : "unknown",
        modelAssisted: isModelAssisted(metadata),
        setupType:
          trade.setup_type ??
          (typeof metadata.setupType === "string"
            ? metadata.setupType
            : typeof metadata.setup_type === "string"
              ? metadata.setup_type
              : null),
        regime: typeof metadata.regime === "string" ? metadata.regime : null,
      };
    })
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}

export function defaultForwardValidationGate(executionMode: string): ForwardValidationGate {
  if (executionMode === "live") {
    return {
      minTrades: 12,
      minWinRatePct: 42,
      minExpectancyUsd: 0,
      minProfitFactor: 1.02,
      maxAvgEntrySlippageBps: 10,
      maxAvgExitSlippageBps: 10,
      maxDrawdownPct: 12,
      minModelAssistedTrades: 4,
    };
  }

  return {
    minTrades: 24,
    minWinRatePct: 44,
    minExpectancyUsd: 0,
    minProfitFactor: 1.05,
    maxAvgEntrySlippageBps: 8,
    maxAvgExitSlippageBps: 8,
    maxDrawdownPct: 10,
    minModelAssistedTrades: 6,
  };
}

export function computeForwardValidationReport(
  mergedTrades: ForwardValidationMergedTrade[],
  executionMode: string,
  gate = defaultForwardValidationGate(executionMode),
  startingBalanceUsd = 10_000,
): ForwardValidationReport {
  const filtered = mergedTrades.filter((trade) => trade.executionMode === executionMode);
  const tradeCount = filtered.length;
  const modelAssistedTrades = filtered.filter((trade) => trade.modelAssisted);
  const wins = filtered.filter((trade) => trade.netEdgeUsd > 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + trade.netEdgeUsd, 0);
  const grossLossUsd = Math.abs(filtered.filter((trade) => trade.netEdgeUsd < 0).reduce((sum, trade) => sum + trade.netEdgeUsd, 0));
  const totalNetPnlUsd = filtered.reduce((sum, trade) => sum + trade.netEdgeUsd, 0);
  const totalFeesUsd = filtered.reduce((sum, trade) => sum + trade.feesUsd, 0);
  const expectancyUsd = tradeCount === 0 ? 0 : totalNetPnlUsd / tradeCount;
  const profitFactor = grossLossUsd === 0 ? (grossProfitUsd > 0 ? grossProfitUsd : 0) : grossProfitUsd / grossLossUsd;
  const winRate = tradeCount === 0 ? 0 : (wins.length / tradeCount) * 100;

  let balance = startingBalanceUsd;
  let peakBalance = startingBalanceUsd;
  let maxDrawdownPct = 0;
  for (const trade of filtered) {
    balance += trade.netEdgeUsd;
    peakBalance = Math.max(peakBalance, balance);
    const drawdownPct = peakBalance === 0 ? 0 : ((peakBalance - balance) / peakBalance) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  const gateFailures: string[] = [];
  if (tradeCount < gate.minTrades) gateFailures.push(`trade_count ${tradeCount} < ${gate.minTrades}`);
  if (winRate < gate.minWinRatePct) gateFailures.push(`win_rate ${winRate.toFixed(2)} < ${gate.minWinRatePct}`);
  if (expectancyUsd < gate.minExpectancyUsd) gateFailures.push(`expectancy ${expectancyUsd.toFixed(2)} < ${gate.minExpectancyUsd}`);
  if (profitFactor < gate.minProfitFactor) gateFailures.push(`profit_factor ${profitFactor.toFixed(2)} < ${gate.minProfitFactor}`);
  const avgEntrySlippageBps = average(filtered.map((trade) => trade.entrySlippageBps));
  const avgExitSlippageBps = average(filtered.map((trade) => trade.exitSlippageBps));
  if (avgEntrySlippageBps > gate.maxAvgEntrySlippageBps) {
    gateFailures.push(`entry_slippage ${avgEntrySlippageBps.toFixed(2)} > ${gate.maxAvgEntrySlippageBps}`);
  }
  if (avgExitSlippageBps > gate.maxAvgExitSlippageBps) {
    gateFailures.push(`exit_slippage ${avgExitSlippageBps.toFixed(2)} > ${gate.maxAvgExitSlippageBps}`);
  }
  if (maxDrawdownPct > gate.maxDrawdownPct) {
    gateFailures.push(`drawdown ${maxDrawdownPct.toFixed(2)} > ${gate.maxDrawdownPct}`);
  }
  if (modelAssistedTrades.length < gate.minModelAssistedTrades) {
    gateFailures.push(`model_assisted_trades ${modelAssistedTrades.length} < ${gate.minModelAssistedTrades}`);
  }

  return {
    executionMode,
    windowStart: filtered[0]?.createdAt ?? new Date().toISOString(),
    windowEnd: filtered[filtered.length - 1]?.closedAt ?? new Date().toISOString(),
    tradeCount,
    modelAssistedTradeCount: modelAssistedTrades.length,
    winRate: round(winRate, 4),
    expectancyUsd: round(expectancyUsd, 4),
    profitFactor: round(profitFactor, 4),
    totalNetPnlUsd: round(totalNetPnlUsd, 4),
    totalFeesUsd: round(totalFeesUsd, 4),
    avgNetEdgeUsd: round(average(filtered.map((trade) => trade.netEdgeUsd)), 4),
    avgEntrySlippageBps: round(avgEntrySlippageBps, 4),
    avgExitSlippageBps: round(avgExitSlippageBps, 4),
    avgHoldingMinutes: round(average(filtered.map((trade) => trade.holdingMinutes)), 4),
    maxDrawdownPct: round(maxDrawdownPct, 4),
    gatePassed: gateFailures.length === 0,
    gateReason: gateFailures.length === 0 ? "passed" : gateFailures.join("; "),
    details: {
      grossProfitUsd: round(grossProfitUsd, 4),
      grossLossUsd: round(grossLossUsd, 4),
      modelAssistedWinRate: modelAssistedTrades.length === 0
        ? 0
        : round(
          (modelAssistedTrades.filter((trade) => trade.netEdgeUsd > 0).length / modelAssistedTrades.length) * 100,
          4,
        ),
      setupCounts: countBy(filtered.map((trade) => trade.setupType ?? "unknown")),
      regimeCounts: countBy(filtered.map((trade) => trade.regime ?? "unknown")),
      tradeIds: filtered.map((trade) => trade.id),
    },
  };
}
