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
  mexc_key: string | null;
  mexc_secret: string | null;
  telegram_token: string | null;
}

// ── MEXC API helpers ────────────────────────────────────────────────

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

const MEXC_BASE = "https://api.mexc.com";

async function mexcRequest(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
  params: Record<string, string> = {}
) {
  const timestamp = Date.now().toString();
  params["timestamp"] = timestamp;
  params["recvWindow"] = "5000";

  const queryString = new URLSearchParams(params).toString();
  const signature = await hmacSHA256(apiSecret, queryString);

  const url = `${MEXC_BASE}${path}?${queryString}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-MEXC-APIKEY": apiKey,
    },
  });
  return res.json();
}

async function setLeverage(apiKey: string, apiSecret: string, symbol: string, leverage: number) {
  // MEXC futures leverage - using spot for now (MEXC spot doesn't have leverage)
  // For futures, endpoint would be different
  console.log(`Leverage set to ${leverage}x for ${symbol} (spot mode)`);
}

async function placeOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: "BUY" | "SELL",
  qty: string
) {
  return mexcRequest(apiKey, apiSecret, "POST", "/api/v3/order", {
    symbol,
    side,
    type: "MARKET",
    quantity: qty,
  });
}

async function getOpenOrders(apiKey: string, apiSecret: string, symbol: string) {
  return mexcRequest(apiKey, apiSecret, "GET", "/api/v3/openOrders", {
    symbol,
  });
}

async function getAccountInfo(apiKey: string, apiSecret: string) {
  return mexcRequest(apiKey, apiSecret, "GET", "/api/v3/account", {});
}

// ── RSI calculation ─────────────────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

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

// ── Fetch BTCUSDT price data from MEXC ──────────────────────────────

async function fetchOHLCV(): Promise<{ closes: number[]; currentPrice: number }> {
  const url = `${MEXC_BASE}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=50`;
  const res = await fetch(url);
  const json = await res.json();

  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(`Kline fetch failed: ${JSON.stringify(json).slice(0, 200)}`);
  }

  // MEXC klines: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
  const closes = json.map((k: any[]) => parseFloat(k[4]));
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

    const { closes, currentPrice } = await fetchOHLCV();
    const rsi = calculateRSI(closes);
    const rsiRounded = Math.round(rsi * 10) / 10;

    console.log(`RSI: ${rsiRounded} | Price: $${currentPrice}`);

    const results: Array<{ userId: string; action: string; detail?: string }> = [];

    for (const profile of profiles as Profile[]) {
      const { user_id, max_risk_pct, leverage, telegram_id } = profile;

      const { data: keys } = await supabaseAdmin
        .from("api_keys")
        .select("mexc_key, mexc_secret, telegram_token")
        .eq("user_id", user_id)
        .maybeSingle();

      if (!keys?.mexc_key || !keys?.mexc_secret) {
        results.push({ userId: user_id, action: "skipped", detail: "No MEXC API keys" });
        continue;
      }

      const apiKey = keys.mexc_key;
      const apiSecret = keys.mexc_secret;

      // Check existing open orders
      const openOrders = await getOpenOrders(apiKey, apiSecret, "BTCUSDT");
      const hasPosition = Array.isArray(openOrders) && openOrders.length > 0;

      let signal: "buy" | "sell" | "hold" = "hold";
      let action = "hold";
      let reasoning = `RSI=${rsiRounded}, Price=$${currentPrice}. `;

      if (rsi < 30 && !hasPosition) {
        signal = "buy";
        reasoning += "RSI oversold (<30), no open orders. Placing buy.";

        const qty = "0.00001"; // Small BTC amount for MEXC spot
        const orderRes = await placeOrder(apiKey, apiSecret, "BTCUSDT", "BUY", qty);

        if (orderRes.orderId) {
          action = "buy_executed";

          await supabaseAdmin.from("trades").insert({
            user_id,
            symbol: "BTCUSDT",
            side: "buy",
            size: parseFloat(qty),
            entry_price: currentPrice,
            tp: currentPrice * 1.003,
            sl: currentPrice * 0.9985,
            leverage,
            status: "open",
          });

          if (keys.telegram_token && telegram_id) {
            const tp = (currentPrice * 1.003).toFixed(2);
            const sl = (currentPrice * 0.9985).toFixed(2);
            await sendTelegramAlert(
              keys.telegram_token,
              telegram_id,
              `🟢 *ScalpPro BUY*\n📊 RSI: ${rsiRounded}\n💰 Entry: $${currentPrice}\n🎯 TP: $${tp}\n🛑 SL: $${sl}`
            );
          }
        } else {
          action = "buy_failed";
          reasoning += ` Order error: ${orderRes.msg || JSON.stringify(orderRes)}`;
        }
      } else if (rsi > 70 && hasPosition) {
        signal = "sell";
        reasoning += "RSI overbought (>70), closing position.";

        const qty = "0.00001";
        const orderRes = await placeOrder(apiKey, apiSecret, "BTCUSDT", "SELL", qty);

        if (orderRes.orderId) {
          action = "sell_executed";

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
              `🔴 *ScalpPro SELL*\n📊 RSI: ${rsiRounded}\n💰 Exit: $${currentPrice}`
            );
          }
        } else {
          action = "sell_failed";
          reasoning += ` Order error: ${orderRes.msg || JSON.stringify(orderRes)}`;
        }
      } else {
        reasoning += hasPosition
          ? "Position open, RSI neutral. Holding."
          : "No position, RSI neutral. Waiting.";
      }

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
