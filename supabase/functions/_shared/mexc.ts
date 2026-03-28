export const MEXC_CONTRACT_BASE_URL = "https://contract.mexc.com";
export const MEXC_SPOT_BASE_URL = "https://api.mexc.com";
export const MEXC_REST_BASE_URL = MEXC_CONTRACT_BASE_URL;
export const MEXC_WS_URL = "wss://contract.mexc.com/edge";

export interface MexcApiResponse<T = unknown> {
  success?: boolean;
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
}

export interface MexcAsset {
  currency: string;
  availableBalance?: number | string;
  frozenBalance?: number | string;
  positionMargin?: number | string;
  cashBalance?: number | string;
  equity?: number | string;
  unrealized?: number | string;
  bonus?: number | string;
}

export interface MexcPosition {
  positionId?: number | string;
  positionType?: number;
  holdVol?: number | string;
  openType?: number;
}

export interface MexcSpotTickerPrice {
  symbol: string;
  price: number | string;
}

export interface MexcSpotMarket {
  symbol: string;
  status?: string | number;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
}

export interface MexcPortfolioValuedAsset {
  currency: string;
  equity: number;
  available: number;
  locked: number;
  unrealized: number;
  bonus: number;
  usdtPrice: number | null;
  usdtValue: number | null;
  conversionPath: string[] | null;
  priced: boolean;
}

export interface MexcPortfolioSummary {
  currency: "USDT";
  totalUsdt: number;
  availableUsdt: number;
  lockedUsdt: number;
  unrealizedUsdt: number;
  bonusUsdt: number;
  assetCount: number;
  pricedAssetCount: number;
  unpricedAssetCount: number;
  unpricedCurrencies: string[];
  valuationSource: string;
}

export interface MexcPortfolioValuation {
  summary: MexcPortfolioSummary;
  assets: MexcPortfolioValuedAsset[];
}

interface ConversionEdge {
  to: string;
  rate: number;
}

async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanParams(params: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function buildQueryString(params: Record<string, unknown>) {
  return Object.entries(cleanParams(params))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/\+/g, "%20")}`)
    .join("&");
}

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function round(value: number, decimals = 8) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

function addEdge(graph: Map<string, ConversionEdge[]>, from: string, to: string, rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const existing = graph.get(from) ?? [];
  existing.push({ to, rate });
  graph.set(from, existing);
}

function buildSpotConversionGraph(
  markets: MexcSpotMarket[],
  tickers: MexcSpotTickerPrice[],
) {
  const priceBySymbol = new Map(
    tickers
      .map((ticker) => [ticker.symbol, toNumber(ticker.price)] as const)
      .filter(([, price]) => Number.isFinite(price) && price > 0),
  );
  const graph = new Map<string, ConversionEdge[]>();

  markets.forEach((market) => {
    const price = priceBySymbol.get(market.symbol);
    if (!price) return;
    if (market.isSpotTradingAllowed === false) return;
    if (market.permissions && !market.permissions.includes("SPOT")) return;
    if (market.status !== undefined && !["1", "ENABLED", "enabled"].includes(String(market.status))) return;

    addEdge(graph, market.baseAsset, market.quoteAsset, price);
    addEdge(graph, market.quoteAsset, market.baseAsset, 1 / price);
  });

  return graph;
}

function findConversionPath(
  graph: Map<string, ConversionEdge[]>,
  from: string,
  target = "USDT",
  maxHops = 4,
) {
  if (from === target) {
    return { rate: 1, path: [from] };
  }

  const queue: Array<{ asset: string; rate: number; path: string[] }> = [{ asset: from, rate: 1, path: [from] }];
  const visited = new Map<string, number>([[from, 0]]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const hopCount = current.path.length - 1;
    if (hopCount >= maxHops) continue;

    for (const edge of graph.get(current.asset) ?? []) {
      const nextHopCount = hopCount + 1;
      const previousHopCount = visited.get(edge.to);
      if (previousHopCount !== undefined && previousHopCount <= nextHopCount) continue;

      const next = {
        asset: edge.to,
        rate: current.rate * edge.rate,
        path: [...current.path, edge.to],
      };

      if (edge.to === target) {
        return next;
      }

      visited.set(edge.to, nextHopCount);
      queue.push(next);
    }
  }

  return null;
}

function getAssetEquity(asset: MexcAsset) {
  const explicitEquity = asset.equity;
  if (explicitEquity !== undefined && explicitEquity !== null && explicitEquity !== "") {
    return toNumber(explicitEquity);
  }

  return toNumber(asset.availableBalance) +
    toNumber(asset.frozenBalance) +
    toNumber(asset.positionMargin) +
    toNumber(asset.unrealized) +
    toNumber(asset.bonus);
}

export async function getSpotTickerPrices() {
  const res = await fetch(`${MEXC_SPOT_BASE_URL}/api/v3/ticker/price`);
  return (await res.json()) as MexcSpotTickerPrice[];
}

export async function getSpotExchangeInfo() {
  const res = await fetch(`${MEXC_SPOT_BASE_URL}/api/v3/exchangeInfo`);
  return (await res.json()) as { symbols?: MexcSpotMarket[] };
}

export async function valueMexcPortfolio(assets: MexcAsset[]): Promise<MexcPortfolioValuation> {
  const nonEmptyAssets = assets.filter((asset) =>
    getAssetEquity(asset) !== 0 ||
    toNumber(asset.availableBalance) !== 0 ||
    toNumber(asset.frozenBalance) !== 0 ||
    toNumber(asset.positionMargin) !== 0 ||
    toNumber(asset.unrealized) !== 0 ||
    toNumber(asset.bonus) !== 0
  );

  const requiresSpotPricing = nonEmptyAssets.some((asset) => asset.currency !== "USDT");
  const graph = new Map<string, ConversionEdge[]>();

  if (requiresSpotPricing) {
    const [tickerPrices, exchangeInfo] = await Promise.all([getSpotTickerPrices(), getSpotExchangeInfo()]);
    const spotGraph = buildSpotConversionGraph(exchangeInfo.symbols ?? [], tickerPrices);
    spotGraph.forEach((edges, asset) => graph.set(asset, edges));
  }

  const stableFallbacks = new Set(["USDC", "FDUSD", "TUSD", "USDE", "USDP", "USD1"]);
  const valuedAssets = nonEmptyAssets.map<MexcPortfolioValuedAsset>((asset) => {
    const currency = asset.currency;
    const available = toNumber(asset.availableBalance);
    const locked = toNumber(asset.frozenBalance) + toNumber(asset.positionMargin);
    const unrealized = toNumber(asset.unrealized);
    const bonus = toNumber(asset.bonus);
    const equity = getAssetEquity(asset);

    const conversion = currency === "USDT"
      ? { rate: 1, path: ["USDT"] }
      : findConversionPath(graph, currency) ??
        (stableFallbacks.has(currency) ? { rate: 1, path: [currency, "USDT"] } : null);

    return {
      currency,
      equity: round(equity, 8),
      available: round(available, 8),
      locked: round(locked, 8),
      unrealized: round(unrealized, 8),
      bonus: round(bonus, 8),
      usdtPrice: conversion ? round(conversion.rate, 8) : null,
      usdtValue: conversion ? round(equity * conversion.rate, 2) : null,
      conversionPath: conversion?.path ?? null,
      priced: Boolean(conversion),
    };
  }).sort((left, right) => (right.usdtValue ?? -Infinity) - (left.usdtValue ?? -Infinity));

  const pricedAssets = valuedAssets.filter((asset) => asset.priced);
  const unpricedAssets = valuedAssets.filter((asset) => !asset.priced);

  const summary: MexcPortfolioSummary = {
    currency: "USDT",
    totalUsdt: round(pricedAssets.reduce((sum, asset) => sum + (asset.usdtValue ?? 0), 0), 2),
    availableUsdt: round(
      pricedAssets.reduce((sum, asset) => sum + (asset.usdtPrice !== null ? asset.available * asset.usdtPrice : 0), 0),
      2,
    ),
    lockedUsdt: round(
      pricedAssets.reduce((sum, asset) => sum + (asset.usdtPrice !== null ? asset.locked * asset.usdtPrice : 0), 0),
      2,
    ),
    unrealizedUsdt: round(
      pricedAssets.reduce((sum, asset) => sum + (asset.usdtPrice !== null ? asset.unrealized * asset.usdtPrice : 0), 0),
      2,
    ),
    bonusUsdt: round(
      pricedAssets.reduce((sum, asset) => sum + (asset.usdtPrice !== null ? asset.bonus * asset.usdtPrice : 0), 0),
      2,
    ),
    assetCount: valuedAssets.length,
    pricedAssetCount: pricedAssets.length,
    unpricedAssetCount: unpricedAssets.length,
    unpricedCurrencies: unpricedAssets.map((asset) => asset.currency),
    valuationSource: "MEXC spot ticker graph",
  };

  return { summary, assets: valuedAssets };
}

export async function mexcPublicGet<T>(path: string, params: Record<string, unknown> = {}) {
  const query = buildQueryString(params);
  const url = `${MEXC_REST_BASE_URL}${path}${query ? `?${query}` : ""}`;
  const res = await fetch(url);
  return (await res.json()) as MexcApiResponse<T>;
}

export async function mexcPrivateRequest<T>(
  apiKey: string,
  apiSecret: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
) {
  const requestTime = Date.now().toString();
  const normalizedParams = cleanParams(params);
  const requestParam = method === "POST"
    ? JSON.stringify(normalizedParams)
    : buildQueryString(normalizedParams);
  const signaturePayload = `${apiKey}${requestTime}${requestParam}`;
  const signature = await hmacSHA256(apiSecret, signaturePayload);
  const url = `${MEXC_REST_BASE_URL}${path}${method === "POST" || !requestParam ? "" : `?${requestParam}`}`;

  const res = await fetch(url, {
    method,
    headers: {
      ApiKey: apiKey,
      "Request-Time": requestTime,
      Signature: signature,
      "Recv-Window": "5000",
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: requestParam } : {}),
  });

  return (await res.json()) as MexcApiResponse<T>;
}

export function getAccountAssets(apiKey: string, apiSecret: string) {
  return mexcPrivateRequest<MexcAsset[]>(apiKey, apiSecret, "GET", "/api/v1/private/account/assets");
}

export function getOpenPositions(apiKey: string, apiSecret: string, symbol: string) {
  return mexcPrivateRequest<MexcPosition[]>(
    apiKey,
    apiSecret,
    "GET",
    "/api/v1/private/position/open_positions",
    { symbol },
  );
}

export function submitOrder(
  apiKey: string,
  apiSecret: string,
  params: Record<string, unknown>,
) {
  return mexcPrivateRequest<number | string>(apiKey, apiSecret, "POST", "/api/v1/private/order/submit", params);
}
