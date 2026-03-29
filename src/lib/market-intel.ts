import {
  buildMarketMicrostructure,
  MarketMicrostructure,
  OrderBookLevel,
  summarizeOrderBook,
} from "./strategy-core.ts";

const MEXC_CONTRACT_BASE_URL = "https://contract.mexc.com";
const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";

export interface VenueMarketSnapshot {
  venue: "mexc" | "binance";
  symbol: string;
  fetchedAt: number;
  latencyMs: number;
  midPrice: number | null;
  markPrice: number | null;
  openInterestUsd: number | null;
  openInterestChangePct: number | null;
  fundingRatePct8h: number | null;
  longShortRatio: number | null;
  takerImbalance: number | null;
  liquidationBias: number | null;
  liquidationIntensity: number | null;
  orderBook: ReturnType<typeof summarizeOrderBook>;
  raw: Record<string, unknown>;
}

export interface CrossVenueSnapshot {
  symbol: string;
  fetchedAt: number;
  primary: VenueMarketSnapshot | null;
  secondary: VenueMarketSnapshot | null;
  microstructure: MarketMicrostructure | null;
}

export interface ArchivedOrderBookSnapshot {
  venue: "mexc" | "binance";
  symbol: string;
  fetchedAt: number;
  depthLimit: number;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  imbalance: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  exchangeTimestamp: number | null;
  latencyMs: number;
  rawPayload: Record<string, unknown>;
}

export interface ArchivedTradeTick {
  venue: "mexc" | "binance";
  symbol: string;
  fetchedAt: number;
  exchangeTradeId: string;
  exchangeTimestamp: number | null;
  price: number;
  size: number;
  side: "buy" | "sell" | null;
  notionalUsd: number;
  rawPayload: Record<string, unknown>;
}

function round(value: number, precision = 4) {
  return Number(value.toFixed(precision));
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: Array<number | null | undefined>) {
  const filtered = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function parseOrderBookLevels(payload: unknown) {
  if (!Array.isArray(payload)) {
    return [] as OrderBookLevel[];
  }

  return payload
    .map((level) => {
      if (!Array.isArray(level)) return null;
      const price = safeNumber(level[0]);
      const size = safeNumber(level[1]);
      if (price === null || size === null || price <= 0 || size <= 0) {
        return null;
      }
      return { price, size };
    })
    .filter((level): level is OrderBookLevel => level !== null);
}

async function fetchJson<T>(url: string) {
  const startedAt = Date.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }
  const data = await response.json() as T;
  return {
    data,
    latencyMs: Date.now() - startedAt,
  };
}

function parseMexcTicker(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return {
      bid1: null,
      ask1: null,
      fairPrice: null,
      lastPrice: null,
      holdVol: null,
      fundingRate: null,
      timestamp: null,
    };
  }
  const data = (payload as { data?: Record<string, unknown> }).data ?? {};
  return {
    bid1: safeNumber(data.bid1),
    ask1: safeNumber(data.ask1),
    fairPrice: safeNumber(data.fairPrice),
    lastPrice: safeNumber(data.lastPrice),
    holdVol: safeNumber(data.holdVol),
    fundingRate: safeNumber(data.fundingRate),
    timestamp: safeNumber(data.timestamp),
  };
}

function computeOpenInterestChange(values: Array<number | null>) {
  const filtered = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (filtered.length < 2) return null;
  const previous = filtered[filtered.length - 2];
  const latest = filtered[filtered.length - 1];
  if (previous === 0) return null;
  return ((latest - previous) / previous) * 100;
}

function ratioToImbalance(ratio: number | null) {
  if (ratio === null || ratio <= 0) return null;
  return (ratio - 1) / (ratio + 1);
}

export async function fetchMexcMarketSnapshot(symbol = "BTC_USDT") {
  const [depthResponse, tickerResponse, fundingResponse] = await Promise.all([
    fetchJson<{ data?: { bids?: unknown; asks?: unknown; timestamp?: number } }>(
      `${MEXC_CONTRACT_BASE_URL}/api/v1/contract/depth/${symbol}?limit=20`,
    ),
    fetchJson<Record<string, unknown>>(`${MEXC_CONTRACT_BASE_URL}/api/v1/contract/ticker?symbol=${symbol}`),
    fetchJson<{ data?: { fundingRate?: number; timestamp?: number } }>(
      `${MEXC_CONTRACT_BASE_URL}/api/v1/contract/funding_rate/${symbol}`,
    ),
  ]);

  const bids = parseOrderBookLevels(depthResponse.data.data?.bids);
  const asks = parseOrderBookLevels(depthResponse.data.data?.asks);
  const ticker = parseMexcTicker(tickerResponse.data);
  const orderBook = summarizeOrderBook("mexc", bids, asks, depthResponse.data.data?.timestamp);
  const midPrice = orderBook?.midPrice ?? mean([ticker.bid1, ticker.ask1, ticker.fairPrice, ticker.lastPrice]);

  return {
    venue: "mexc" as const,
    symbol,
    fetchedAt: Date.now(),
    latencyMs: depthResponse.latencyMs + tickerResponse.latencyMs + fundingResponse.latencyMs,
    midPrice,
    markPrice: ticker.fairPrice ?? ticker.lastPrice ?? midPrice,
    openInterestUsd: ticker.holdVol !== null && (ticker.fairPrice ?? ticker.lastPrice) !== null
      ? ticker.holdVol * ((ticker.fairPrice ?? ticker.lastPrice) as number)
      : null,
    openInterestChangePct: null,
    fundingRatePct8h: fundingResponse.data.data?.fundingRate !== undefined
      ? Number(fundingResponse.data.data.fundingRate) * 100
      : ticker.fundingRate !== null
        ? ticker.fundingRate * 100
        : null,
    longShortRatio: null,
    takerImbalance: null,
    liquidationBias: null,
    liquidationIntensity: null,
    orderBook,
    raw: {
      depth: depthResponse.data,
      ticker: tickerResponse.data,
      funding: fundingResponse.data,
    },
  } satisfies VenueMarketSnapshot;
}

export async function fetchMexcOrderBookSnapshot(symbol = "BTC_USDT", depthLimit = 20) {
  const depthResponse = await fetchJson<{ data?: { bids?: unknown; asks?: unknown; timestamp?: number } }>(
    `${MEXC_CONTRACT_BASE_URL}/api/v1/contract/depth/${symbol}?limit=${depthLimit}`,
  );

  const bids = parseOrderBookLevels(depthResponse.data.data?.bids);
  const asks = parseOrderBookLevels(depthResponse.data.data?.asks);
  const orderBook = summarizeOrderBook("mexc", bids, asks, depthResponse.data.data?.timestamp);

  return {
    venue: "mexc" as const,
    symbol,
    fetchedAt: Date.now(),
    depthLimit,
    bestBid: orderBook?.bestBid ?? null,
    bestAsk: orderBook?.bestAsk ?? null,
    spreadBps: orderBook?.spreadBps ?? null,
    imbalance: orderBook?.imbalance ?? null,
    bids,
    asks,
    exchangeTimestamp: safeNumber(depthResponse.data.data?.timestamp),
    latencyMs: depthResponse.latencyMs,
    rawPayload: depthResponse.data,
  } satisfies ArchivedOrderBookSnapshot;
}

export async function fetchMexcRecentTradeTicks(symbol = "BTC_USDT", limit = 100) {
  const response = await fetchJson<{ data?: unknown }>(
    `${MEXC_CONTRACT_BASE_URL}/api/v1/contract/deals/${symbol}?limit=${limit}`,
  );
  const rows = Array.isArray(response.data.data) ? response.data.data : [];
  const ticks: ArchivedTradeTick[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const price = safeNumber(record.p);
    const size = safeNumber(record.v);
    const exchangeTradeId = typeof record.i === "string" || typeof record.i === "number" ? String(record.i) : null;
    if (price === null || size === null || !exchangeTradeId) {
      continue;
    }
    const sideCode = safeNumber(record.T);
    ticks.push({
      venue: "mexc",
      symbol,
      fetchedAt: Date.now(),
      exchangeTradeId,
      exchangeTimestamp: safeNumber(record.t),
      price,
      size,
      side: sideCode === 1 ? "buy" : sideCode === 2 ? "sell" : null,
      notionalUsd: round(price * size, 8),
      rawPayload: record,
    });
  }

  return ticks;
}

function parseBinanceDepth(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { bids: [], asks: [], timestamp: undefined };
  }
  const object = payload as { bids?: unknown; asks?: unknown; T?: number; E?: number };
  return {
    bids: parseOrderBookLevels(object.bids),
    asks: parseOrderBookLevels(object.asks),
    timestamp: object.T ?? object.E,
  };
}

function latestArrayValue(payload: unknown) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const latest = payload[payload.length - 1];
  return latest && typeof latest === "object" ? latest as Record<string, unknown> : null;
}

export async function fetchBinanceMarketSnapshot(symbol = "BTCUSDT") {
  const [depthResponse, premiumResponse, openInterestResponse, openInterestHistResponse, longShortResponse, takerResponse] =
    await Promise.all([
      fetchJson<Record<string, unknown>>(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchJson<Record<string, unknown>>(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`),
      fetchJson<Record<string, unknown>>(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/openInterest?symbol=${symbol}`),
      fetchJson<unknown>(`${BINANCE_FUTURES_BASE_URL}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=3`),
      fetchJson<unknown>(`${BINANCE_FUTURES_BASE_URL}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`),
      fetchJson<unknown>(`${BINANCE_FUTURES_BASE_URL}/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=3`),
    ]);

  const depth = parseBinanceDepth(depthResponse.data);
  const premium = premiumResponse.data;
  const openInterest = openInterestResponse.data;
  const histRows = Array.isArray(openInterestHistResponse.data) ? openInterestHistResponse.data : [];
  const oiChange = computeOpenInterestChange(
    histRows.map((row) => safeNumber((row as Record<string, unknown>).sumOpenInterestValue ?? (row as Record<string, unknown>).sumOpenInterest)),
  );
  const latestLongShort = latestArrayValue(longShortResponse.data);
  const latestTaker = latestArrayValue(takerResponse.data);
  const orderBook = summarizeOrderBook("binance", depth.bids, depth.asks, depth.timestamp);

  const markPrice = safeNumber(premium.markPrice);
  const indexPrice = safeNumber(premium.indexPrice);
  const lastFundingRate = safeNumber(premium.lastFundingRate);
  const openInterestAmount = safeNumber(openInterest.openInterest);
  const openInterestUsd = openInterestAmount !== null && markPrice !== null ? openInterestAmount * markPrice : null;
  const longShortRatio = safeNumber(latestLongShort?.longShortRatio);
  const buyVolume = safeNumber(latestTaker?.buySellRatio);
  const takerImbalance = ratioToImbalance(buyVolume);

  return {
    venue: "binance" as const,
    symbol,
    fetchedAt: Date.now(),
    latencyMs:
      depthResponse.latencyMs +
      premiumResponse.latencyMs +
      openInterestResponse.latencyMs +
      openInterestHistResponse.latencyMs +
      longShortResponse.latencyMs +
      takerResponse.latencyMs,
    midPrice: orderBook?.midPrice ?? mean([markPrice, indexPrice]),
    markPrice,
    openInterestUsd,
    openInterestChangePct: oiChange !== null ? round(oiChange, 4) : null,
    fundingRatePct8h: lastFundingRate !== null ? lastFundingRate * 100 : null,
    longShortRatio,
    takerImbalance: takerImbalance !== null ? round(takerImbalance, 4) : null,
    liquidationBias: null,
    liquidationIntensity: null,
    orderBook,
    raw: {
      depth: depthResponse.data,
      premium: premiumResponse.data,
      openInterest: openInterestResponse.data,
      openInterestHistory: openInterestHistResponse.data,
      longShortRatio: longShortResponse.data,
      takerLongShortRatio: takerResponse.data,
    },
  } satisfies VenueMarketSnapshot;
}

export async function fetchBinanceOrderBookSnapshot(symbol = "BTCUSDT", depthLimit = 20) {
  const depthResponse = await fetchJson<Record<string, unknown>>(
    `${BINANCE_FUTURES_BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=${depthLimit}`,
  );
  const depth = parseBinanceDepth(depthResponse.data);
  const orderBook = summarizeOrderBook("binance", depth.bids, depth.asks, depth.timestamp);

  return {
    venue: "binance" as const,
    symbol,
    fetchedAt: Date.now(),
    depthLimit,
    bestBid: orderBook?.bestBid ?? null,
    bestAsk: orderBook?.bestAsk ?? null,
    spreadBps: orderBook?.spreadBps ?? null,
    imbalance: orderBook?.imbalance ?? null,
    bids: depth.bids,
    asks: depth.asks,
    exchangeTimestamp: safeNumber(depth.timestamp),
    latencyMs: depthResponse.latencyMs,
    rawPayload: depthResponse.data,
  } satisfies ArchivedOrderBookSnapshot;
}

export async function fetchBinanceRecentTradeTicks(symbol = "BTCUSDT", limit = 100) {
  const response = await fetchJson<unknown[]>(
    `${BINANCE_FUTURES_BASE_URL}/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`,
  );
  const ticks: ArchivedTradeTick[] = [];

  for (const row of Array.isArray(response.data) ? response.data : []) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const price = safeNumber(record.p);
    const size = safeNumber(record.q);
    const exchangeTradeId = typeof record.a === "number" || typeof record.a === "string" ? String(record.a) : null;
    if (price === null || size === null || !exchangeTradeId) {
      continue;
    }
    ticks.push({
      venue: "binance",
      symbol,
      fetchedAt: Date.now(),
      exchangeTradeId,
      exchangeTimestamp: safeNumber(record.T),
      price,
      size,
      side: typeof record.m === "boolean" ? (record.m ? "sell" : "buy") : null,
      notionalUsd: round(price * size, 8),
      rawPayload: record,
    });
  }

  return ticks;
}

export function combineVenueSnapshots(
  symbol: string,
  primary: VenueMarketSnapshot | null,
  secondary: VenueMarketSnapshot | null,
  liquidationMetrics?: { bias?: number | null; intensity?: number | null },
) {
  const microstructure = buildMarketMicrostructure({
    primaryBook: primary?.orderBook ?? null,
    secondaryBook: secondary?.orderBook ?? null,
    fundingRatePct8h: mean([primary?.fundingRatePct8h, secondary?.fundingRatePct8h]),
    openInterestUsd: mean([primary?.openInterestUsd, secondary?.openInterestUsd]),
    openInterestChangePct: mean([primary?.openInterestChangePct, secondary?.openInterestChangePct]),
    longShortRatio: mean([primary?.longShortRatio, secondary?.longShortRatio]),
    takerImbalance: mean([primary?.takerImbalance, secondary?.takerImbalance]),
    liquidationBias: liquidationMetrics?.bias ?? mean([primary?.liquidationBias, secondary?.liquidationBias]),
    liquidationIntensity: liquidationMetrics?.intensity ?? mean([primary?.liquidationIntensity, secondary?.liquidationIntensity]),
    crossVenueBasisBps:
      primary?.midPrice && secondary?.midPrice
        ? round(((primary.midPrice - secondary.midPrice) / secondary.midPrice) * 10_000, 4)
        : null,
  });

  return {
    symbol,
    fetchedAt: Date.now(),
    primary,
    secondary,
    microstructure,
  } satisfies CrossVenueSnapshot;
}

export async function fetchCrossVenueSnapshot(options: {
  mexcSymbol?: string;
  binanceSymbol?: string;
  liquidationMetrics?: { bias?: number | null; intensity?: number | null };
} = {}) {
  const [mexc, binance] = await Promise.all([
    fetchMexcMarketSnapshot(options.mexcSymbol ?? "BTC_USDT").catch(() => null),
    fetchBinanceMarketSnapshot(options.binanceSymbol ?? "BTCUSDT").catch(() => null),
  ]);

  return combineVenueSnapshots(options.mexcSymbol ?? "BTC_USDT", mexc, binance, options.liquidationMetrics);
}
