export const MEXC_REST_BASE_URL = "https://api.mexc.com";
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
}

export interface MexcPosition {
  positionId?: number | string;
  positionType?: number;
  holdVol?: number | string;
  openType?: number;
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
