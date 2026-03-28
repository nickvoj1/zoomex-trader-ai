import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Profile {
  user_id: string;
  auto_trade: boolean;
  max_risk_pct: number;
  leverage: number;
  telegram_id: string | null;
}

interface ApiKeys {
  user_id: string;
  zoomex_key: string | null;
  zoomex_secret: string | null;
  telegram_token: string | null;
}

// ── Zoomex API helpers ──────────────────────────────────────────────

async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function zoomexRequest(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
  params: Record<string, unknown> = {}
) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const baseUrl = "https://openapi.zoomex.com";

  let queryString = "";
  let body = "";

  if (method === "GET") {
    queryString = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
  } else {
    body = JSON.stringify(params);
  }

  const preSign = `${timestamp}${apiKey}${recvWindow}${queryString || body}`;
  const signature = await hmacSHA256(apiSecret, preSign);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-SIGN": signature,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
  };

  const url = queryString ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
  return res.json();
}

async function setLeverage(apiKey: string, apiSecret: string, symbol: string, leverage: number) {
  return zoomexRequest(apiKey, apiSecret, "POST", "/cloud/trade/v3/position/set-leverage", {
    category: "linear",
    symbol,
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });
}

async function placeOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "Buy" | "Sell",
  qty: string,
  tpPrice: string,
  slPrice: string
) {
  return zoomexRequest(apiKey, apiSecret, "POST", "/cloud/trade/v3/order/create", {
    category: "linear",
    symbol,
    side,
    orderType: "Market",
    qty,
    timeInForce: "GTC",
    takeProfit: tpPrice,
    stopLoss: slPrice,
    positionIdx: 0, // one-way mode
  });
}

async function getOpenPositions(apiKey: string, apiSecret: string, symbol: string) {
  return zoomexRequest(apiKey, apiSecret, "GET", "/cloud/trade/v3/position/list", {
    category: "linear",
    symbol,
  });
}

// ── RSI calculation ─────────────────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── Fetch BTCUSDT price data ────────────────────────────────────────

async function fetchOHLCV(): Promise<{ closes: number[]; currentPrice: number }> {
  // Use Zoomex public kline endpoint (no auth needed) for 1m candles
  const url =
    "https://api.zoomex.com/cloud/trade/v3/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit=50";
  const res = await fetch(url);
  const json = await res.json();

  if (json.retCode !== 0 || !json.result?.list?.length) {
    throw new Error(`Kline fetch failed: ${json.retMsg || "unknown"}`);
  }

  // Zoomex klines: [startTime, open, high, low, close, volume, turnover] newest first
  const klines = json.result.list as string[][];
  const closes = klines.map((k) => parseFloat(k[4])).reverse(); // oldest → newest
  const currentPrice = closes[closes.length - 1];

  return { closes, currentPrice };
}

// ── Telegram alert ──────────────────────────────────────────────────

async function sendTelegramAlert(token: string, chatId: string, message: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("Telegram alert failed:", e);
  }
}

// ── Main handler ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get all users with auto_trade enabled
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, auto_trade, max_risk_pct, leverage, telegram_id")
      .eq("auto_trade", true);

    if (profileErr) throw profileErr;
    if (!profiles?.length) {
      return new Response(JSON.stringify({ message: "No auto-trade users" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch market data once for all users
    const { closes, currentPrice } = await fetchOHLCV();
    const rsi = calculateRSI(closes);
    const rsiRounded = Math.round(rsi * 10) / 10;

    console.log(`RSI: ${rsiRounded} | Price: $${currentPrice}`);

    const results: Array<{ userId: string; action: string; detail?: string }> = [];

    for (const profile of profiles as Profile[]) {
      const { user_id, max_risk_pct, leverage, telegram_id } = profile;

      // Get API keys
      const { data: keys } = await supabaseAdmin
        .from("api_keys")
        .select("zoomex_key, zoomex_secret, telegram_token")
        .eq("user_id", user_id)
        .maybeSingle();

      if (!keys?.zoomex_key || !keys?.zoomex_secret) {
        results.push({ userId: user_id, action: "skipped", detail: "No API keys" });
        continue;
      }

      const apiKey = keys.zoomex_key;
      const apiSecret = keys.zoomex_secret;

      // Check existing positions
      const posRes = await getOpenPositions(apiKey, apiSecret, "BTCUSDT");
      const positions = posRes?.result?.list || [];
      const hasPosition = positions.some(
        (p: Record<string, string>) => parseFloat(p.size || "0") > 0
      );

      let signal: "buy" | "sell" | "hold" = "hold";
      let action = "hold";
      let reasoning = `RSI=${rsiRounded}, Price=$${currentPrice}. `;

      // ── RSI Strategy ──
      if (rsi < 30 && !hasPosition) {
        signal = "buy";
        reasoning += "RSI oversold (<30), no open position. Opening long.";

        // Calculate position size: risk_pct of a notional $10k account
        const qty = "0.001"; // Fixed small size for safety
        const tp = (currentPrice * 1.003).toFixed(2); // +0.3%
        const sl = (currentPrice * 0.9985).toFixed(2); // -0.15%

        // Set leverage
        await setLeverage(apiKey, apiSecret, "BTCUSDT", leverage);

        // Place market buy
        const orderRes = await placeOrder(apiKey, apiSecret, "BTCUSDT", "Buy", qty, tp, sl);

        if (orderRes.retCode === 0) {
          action = "buy_executed";

          // Log trade to DB
          await supabaseAdmin.from("trades").insert({
            user_id,
            symbol: "BTCUSDT",
            side: "buy",
            size: parseFloat(qty),
            entry_price: currentPrice,
            tp: parseFloat(tp),
            sl: parseFloat(sl),
            leverage,
            status: "open",
          });

          // Telegram alert
          if (keys.telegram_token && telegram_id) {
            await sendTelegramAlert(
              keys.telegram_token,
              telegram_id,
              `🟢 *ScalpPro BUY*\n📊 RSI: ${rsiRounded}\n💰 Entry: $${currentPrice}\n🎯 TP: $${tp}\n🛑 SL: $${sl}\n⚡ Leverage: ${leverage}x`
            );
          }
        } else {
          action = "buy_failed";
          reasoning += ` Order error: ${orderRes.retMsg}`;
        }
      } else if (rsi > 70 && hasPosition) {
        signal = "sell";
        reasoning += "RSI overbought (>70), closing long position.";

        // Close by placing a sell of same size
        const pos = positions.find(
          (p: Record<string, string>) => parseFloat(p.size || "0") > 0
        );
        const posSize = pos?.size || "0.001";

        const orderRes = await placeOrder(
          apiKey,
          apiSecret,
          "BTCUSDT",
          "Sell",
          posSize,
          "0",
          "0"
        );

        if (orderRes.retCode === 0) {
          action = "sell_executed";

          // Update trade in DB
          await supabaseAdmin
            .from("trades")
            .update({
              status: "closed",
              exit_price: currentPrice,
              closed_at: new Date().toISOString(),
            })
            .eq("user_id", user_id)
            .eq("status", "open")
            .eq("symbol", "BTCUSDT");

          if (keys.telegram_token && telegram_id) {
            await sendTelegramAlert(
              keys.telegram_token,
              telegram_id,
              `🔴 *ScalpPro SELL*\n📊 RSI: ${rsiRounded}\n💰 Exit: $${currentPrice}\n📦 Size: ${posSize} BTC`
            );
          }
        } else {
          action = "sell_failed";
          reasoning += ` Order error: ${orderRes.retMsg}`;
        }
      } else {
        reasoning += hasPosition
          ? "Position open, RSI neutral. Holding."
          : "No position, RSI neutral. Waiting.";
      }

      // Log signal to DB
      await supabaseAdmin.from("signals").insert({
        user_id,
        symbol: "BTCUSDT",
        rsi: rsiRounded,
        price: currentPrice,
        signal,
        ai_reasoning: reasoning,
      });

      results.push({ userId: user_id, action, detail: reasoning });
    }

    return new Response(JSON.stringify({ rsi: rsiRounded, price: currentPrice, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Scalper error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
