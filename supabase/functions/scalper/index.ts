import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MEXC_FUTURES_LIVE = "https://contract.mexc.com";
const MEXC_FUTURES_DEMO = "https://contract.testnet.mexc.com";

// ── HMAC-SHA256 ─────────────────────────────────────────────────────

async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── MEXC Futures API helpers ────────────────────────────────────────

async function mexcFuturesGet(baseUrl: string, path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  return res.json();
}

async function mexcFuturesPrivate(
  baseUrl: string, apiKey: string, apiSecret: string,
  method: string, path: string,
  params: Record<string, string> = {}
) {
  const timestamp = Date.now().toString();
  params["timestamp"] = timestamp;
  const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const signature = await hmacSHA256(apiSecret, paramStr);

  const url = `${baseUrl}${path}`;
  const body = paramStr + "&signature=" + signature;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "ApiKey": apiKey,
    },
    body,
  });
  return res.json();
}

async function getAccountAssets(baseUrl: string, apiKey: string, apiSecret: string) {
  return mexcFuturesPrivate(baseUrl, apiKey, apiSecret, "GET", "/api/v1/private/account/assets");
}

async function getOpenPositions(baseUrl: string, apiKey: string, apiSecret: string, symbol: string) {
  return mexcFuturesPrivate(baseUrl, apiKey, apiSecret, "GET", "/api/v1/private/position/open_positions", { symbol });
}

async function submitOrder(
  baseUrl: string, apiKey: string, apiSecret: string,
  params: {
    symbol: string; price: string; vol: string;
    side: string; type: string; openType: string;
    leverage: string;
    stopLossPrice?: string; takeProfitPrice?: string;
  }
) {
  const orderParams: Record<string, string> = { ...params };
  return mexcFuturesPrivate(baseUrl, apiKey, apiSecret, "POST", "/api/v1/private/order/submit", orderParams);
}

// ── Technical Indicators ────────────────────────────────────────────

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  ema[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function detectVolumeSpike(volumes: number[], threshold = 2.0): boolean {
  if (volumes.length < 21) return false;
  const recent = volumes.slice(-20, -1);
  const avgVol = recent.reduce((a, b) => a + b, 0) / recent.length;
  return volumes[volumes.length - 1] > avgVol * threshold;
}

// ── Fetch MEXC Futures klines ───────────────────────────────────────

async function fetchFuturesOHLCV(baseUrl: string): Promise<{
  closes: number[]; volumes: number[]; currentPrice: number;
  candles: Array<{ open: number; high: number; low: number; close: number; vol: number }>;
}> {
  const data = await mexcFuturesGet(baseUrl, "/api/v1/contract/kline/BTC_USDT", {
    interval: "Min1",
    limit: "50",
  });

  if (!data?.data || !Array.isArray(data.data)) {
    throw new Error(`Kline fetch failed: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const candles = data.data.map((k: any) => ({
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    vol: Number(k.vol),
  }));

  const closes = candles.map((c: any) => c.close);
  const volumes = candles.map((c: any) => c.vol);
  const currentPrice = closes[closes.length - 1];

  return { closes, volumes, currentPrice, candles };
}

// ── OpenAI Analysis ─────────────────────────────────────────────────

async function analyzeWithOpenAI(
  openaiKey: string,
  candles: Array<{ open: number; high: number; low: number; close: number; vol: number }>,
  rsi: number,
  ema9: number,
  ema21: number,
  volumeSpike: boolean,
  hasPosition: boolean,
  positionSide: string | null
): Promise<{ action: string; confidence: number; reasoning: string }> {
  const last10 = candles.slice(-10);
  const prompt = `You are an expert crypto futures scalper. Analyze BTC_USDT 1-minute data and give a trading decision.

Current indicators:
- RSI(14): ${rsi.toFixed(1)}
- EMA(9): ${ema9.toFixed(2)}, EMA(21): ${ema21.toFixed(2)}
- EMA crossover: ${ema9 > ema21 ? "BULLISH (9 > 21)" : "BEARISH (9 < 21)"}
- Volume spike: ${volumeSpike ? "YES (2x+ average)" : "NO"}
- Current price: $${last10[last10.length - 1].close}
- Has open position: ${hasPosition ? `YES (${positionSide})` : "NO"}

Last 10 candles (O/H/L/C/Vol):
${last10.map(c => `${c.open}/${c.high}/${c.low}/${c.close}/${c.vol}`).join("\n")}

Rules:
- If no position: recommend "long", "short", or "hold"
- If position open: recommend "close" or "hold"
- Confidence 0-100. Only trade above 70%.
- Be aggressive but smart. We're scalping for small quick profits.

Respond ONLY with valid JSON: {"action":"long|short|close|hold","confidence":0-100,"reasoning":"brief explanation"}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("OpenAI error:", errText);
    return { action: "hold", confidence: 0, reasoning: `OpenAI API error: ${res.status}` };
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "";

  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.error("Failed to parse OpenAI response:", content);
    return { action: "hold", confidence: 0, reasoning: `Parse error: ${content.slice(0, 100)}` };
  }
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
    // Check for manual override (from QuickTrade button)
    let manualSide: string | null = null;
    let manualUserId: string | null = null;
    try {
      const body = await req.json();
      manualSide = body.side || null;       // "long" or "short"
      manualUserId = body.user_id || null;
    } catch { /* cron calls with no body or minimal body */ }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get users with auto_trade enabled (or specific user for manual trade)
    let profilesQuery = supabaseAdmin
      .from("profiles")
      .select("user_id, auto_trade, max_risk_pct, leverage, telegram_id, demo_mode");

    if (manualUserId) {
      profilesQuery = profilesQuery.eq("user_id", manualUserId);
    } else {
      profilesQuery = profilesQuery.eq("auto_trade", true);
    }

    const { data: profiles, error: profileErr } = await profilesQuery;
    if (profileErr) throw profileErr;
    if (!profiles?.length) {
      return new Response(JSON.stringify({ message: "No active users" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch market data once
    const { closes, volumes, currentPrice, candles } = await fetchFuturesOHLCV();
    const rsi = calculateRSI(closes);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const volumeSpike = detectVolumeSpike(volumes);
    const currentEma9 = ema9[ema9.length - 1];
    const currentEma21 = ema21[ema21.length - 1];

    console.log(`RSI: ${rsi.toFixed(1)} | EMA9: ${currentEma9.toFixed(0)} | EMA21: ${currentEma21.toFixed(0)} | Price: $${currentPrice} | VolSpike: ${volumeSpike}`);

    const results: Array<{ userId: string; action: string; detail?: string }> = [];

    for (const profile of profiles) {
      const { user_id, max_risk_pct, leverage, telegram_id } = profile;

      const { data: keys } = await supabaseAdmin
        .from("api_keys")
        .select("mexc_key, mexc_secret, openai_key, telegram_token")
        .eq("user_id", user_id)
        .maybeSingle();

      if (!keys?.mexc_key || !keys?.mexc_secret) {
        results.push({ userId: user_id, action: "skipped", detail: "No MEXC API keys" });
        continue;
      }

      // Check open positions
      const posData = await getOpenPositions(keys.mexc_key, keys.mexc_secret, "BTC_USDT");
      const positions = posData?.data || [];
      const hasPosition = Array.isArray(positions) && positions.length > 0;
      const positionSide = hasPosition ? (positions[0].positionType === 1 ? "long" : "short") : null;

      let aiDecision = { action: "hold", confidence: 0, reasoning: "No OpenAI key" };

      if (manualSide) {
        // Manual trade override
        aiDecision = {
          action: manualSide,
          confidence: 100,
          reasoning: `Manual ${manualSide} trade triggered by user`,
        };
      } else if (keys.openai_key) {
        // AI analysis
        aiDecision = await analyzeWithOpenAI(
          keys.openai_key, candles, rsi, currentEma9, currentEma21,
          volumeSpike, hasPosition, positionSide
        );
      } else {
        // Fallback: pure technical
        if (!hasPosition) {
          if (rsi < 30 && currentEma9 > currentEma21) {
            aiDecision = { action: "long", confidence: 75, reasoning: `RSI oversold (${rsi.toFixed(1)}), EMA bullish crossover` };
          } else if (rsi > 70 && currentEma9 < currentEma21) {
            aiDecision = { action: "short", confidence: 75, reasoning: `RSI overbought (${rsi.toFixed(1)}), EMA bearish crossover` };
          }
        } else {
          if ((positionSide === "long" && rsi > 70) || (positionSide === "short" && rsi < 30)) {
            aiDecision = { action: "close", confidence: 80, reasoning: `RSI reversal signal, closing ${positionSide}` };
          }
        }
      }

      console.log(`User ${user_id}: AI decision = ${aiDecision.action} (${aiDecision.confidence}%)`);

      // Store signal
      const signalType = aiDecision.action === "long" ? "buy" : aiDecision.action === "short" ? "sell" : "hold";
      await supabaseAdmin.from("signals").insert({
        user_id,
        symbol: "BTCUSDT",
        rsi: Math.round(rsi * 10) / 10,
        price: currentPrice,
        signal: signalType,
        ai_reasoning: `[${aiDecision.confidence}%] ${aiDecision.reasoning}`,
      });

      // Execute trade if confidence > 70%
      if (aiDecision.confidence < 70) {
        results.push({ userId: user_id, action: "hold", detail: `Low confidence: ${aiDecision.confidence}%` });
        continue;
      }

      const riskPct = Number(max_risk_pct) || 0.5;
      const lev = Number(leverage) || 10;

      if (aiDecision.action === "long" || aiDecision.action === "short") {
        if (hasPosition) {
          results.push({ userId: user_id, action: "hold", detail: "Position already open" });
          continue;
        }

        // Get account balance for dynamic sizing
        const assets = await getAccountAssets(keys.mexc_key, keys.mexc_secret);
        const usdtBalance = assets?.data?.find?.((a: any) => a.currency === "USDT");
        const availableBalance = Number(usdtBalance?.availableBalance || 0);

        if (availableBalance < 1) {
          results.push({ userId: user_id, action: "skipped", detail: `Insufficient balance: $${availableBalance}` });
          continue;
        }

        // Position sizing: (balance * risk%) / price * leverage
        // Each contract = 0.0001 BTC
        const riskAmount = availableBalance * (riskPct / 100);
        const contractValue = 0.0001 * currentPrice;
        const contracts = Math.max(1, Math.floor((riskAmount * lev) / contractValue));

        // TP/SL
        const tpPct = 0.003; // 0.3%
        const slPct = 0.0015; // 0.15%
        const isLong = aiDecision.action === "long";
        const tp = isLong ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
        const sl = isLong ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);

        // side: 1=open long, 3=open short
        const side = isLong ? "1" : "3";

        const orderRes = await submitOrder(keys.mexc_key, keys.mexc_secret, {
          symbol: "BTC_USDT",
          price: currentPrice.toString(),
          vol: contracts.toString(),
          side,
          type: "5", // market
          openType: "1", // isolated
          leverage: lev.toString(),
          takeProfitPrice: tp.toFixed(2),
          stopLossPrice: sl.toFixed(2),
        });

        if (orderRes?.data) {
          await supabaseAdmin.from("trades").insert({
            user_id,
            symbol: "BTCUSDT",
            side: isLong ? "buy" : "sell",
            size: contracts * 0.0001,
            entry_price: currentPrice,
            tp,
            sl,
            leverage: lev,
            status: "open",
          });

          if (keys.telegram_token && telegram_id) {
            await sendTelegramAlert(
              keys.telegram_token, telegram_id,
              `${isLong ? "🟢 LONG" : "🔴 SHORT"} *ScalpPro*\n📊 RSI: ${rsi.toFixed(1)} | EMA: ${currentEma9 > currentEma21 ? "Bull" : "Bear"}\n💰 Entry: $${currentPrice}\n🎯 TP: $${tp.toFixed(2)}\n🛑 SL: $${sl.toFixed(2)}\n📐 ${contracts} contracts @ ${lev}x\n🤖 AI: ${aiDecision.reasoning}`
            );
          }

          results.push({ userId: user_id, action: `${aiDecision.action}_executed`, detail: `${contracts} contracts @ $${currentPrice}` });
        } else {
          results.push({ userId: user_id, action: `${aiDecision.action}_failed`, detail: JSON.stringify(orderRes).slice(0, 200) });
        }
      } else if (aiDecision.action === "close" && hasPosition) {
        // Close position: side 4=close long, 2=close short
        const closeSide = positionSide === "long" ? "4" : "2";
        const posVol = positions[0].holdVol?.toString() || "1";

        const orderRes = await submitOrder(keys.mexc_key, keys.mexc_secret, {
          symbol: "BTC_USDT",
          price: currentPrice.toString(),
          vol: posVol,
          side: closeSide,
          type: "5",
          openType: "1",
          leverage: lev.toString(),
        });

        if (orderRes?.data) {
          await supabaseAdmin
            .from("trades")
            .update({ status: "closed", exit_price: currentPrice, closed_at: new Date().toISOString() })
            .eq("user_id", user_id)
            .eq("status", "open")
            .eq("symbol", "BTCUSDT");

          if (keys.telegram_token && telegram_id) {
            await sendTelegramAlert(
              keys.telegram_token, telegram_id,
              `⬜ *CLOSE* ScalpPro\n💰 Exit: $${currentPrice}\n🤖 AI: ${aiDecision.reasoning}`
            );
          }

          results.push({ userId: user_id, action: "close_executed", detail: `Closed at $${currentPrice}` });
        } else {
          results.push({ userId: user_id, action: "close_failed", detail: JSON.stringify(orderRes).slice(0, 200) });
        }
      } else {
        results.push({ userId: user_id, action: "hold", detail: aiDecision.reasoning });
      }
    }

    return new Response(JSON.stringify({
      rsi: Math.round(rsi * 10) / 10,
      price: currentPrice,
      ema9: Math.round(currentEma9),
      ema21: Math.round(currentEma21),
      volumeSpike,
      results,
    }), {
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
