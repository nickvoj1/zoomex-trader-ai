import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MEXC_FUTURES = "https://contract.mexc.com";
const MEXC_WS = "wss://contract.mexc.com/edge";
const LOOP_DURATION_MS = 50_000; // run for 50 seconds, cron restarts every 60s

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
  const fullParams = paramStr + "&signature=" + signature;

  const isGet = method.toUpperCase() === "GET";
  const url = isGet ? `${baseUrl}${path}?${fullParams}` : `${baseUrl}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "ApiKey": apiKey,
      "Request-Time": timestamp,
      "Signature": signature,
    },
    ...(isGet ? {} : { body: fullParams }),
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

  const d = data?.data;
  if (!d) throw new Error(`Kline fetch failed: ${JSON.stringify(data).slice(0, 300)}`);

  let candles: Array<{ open: number; high: number; low: number; close: number; vol: number }>;

  if (Array.isArray(d)) {
    candles = d.map((k: any) => ({
      open: Number(k.open), high: Number(k.high),
      low: Number(k.low), close: Number(k.close), vol: Number(k.vol),
    }));
  } else if (d.close && Array.isArray(d.close)) {
    const len = d.close.length;
    candles = [];
    for (let i = 0; i < len; i++) {
      candles.push({
        open: Number(d.open[i]), high: Number(d.high[i]),
        low: Number(d.low[i]), close: Number(d.close[i]),
        vol: Number(d.vol?.[i] || d.volume?.[i] || 0),
      });
    }
  } else {
    throw new Error(`Unexpected kline format: ${JSON.stringify(d).slice(0, 300)}`);
  }

  if (candles.length === 0) throw new Error("No kline data returned");

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.vol);
  const currentPrice = closes[closes.length - 1];

  return { closes, volumes, currentPrice, candles };
}

// ── OpenAI Analysis ─────────────────────────────────────────────────

async function analyzeWithOpenAI(
  openaiKey: string,
  candles: Array<{ open: number; high: number; low: number; close: number; vol: number }>,
  rsi: number, ema9: number, ema21: number,
  volumeSpike: boolean, hasPosition: boolean, positionSide: string | null
): Promise<{ action: string; confidence: number; reasoning: string }> {
  const last10 = candles.slice(-10);
  const prompt = `You are an expert crypto futures scalper. Analyze BTC_USDT 1-minute data and give a trading decision.

Current indicators:
- RSI(14): ${rsi.toFixed(1)}
- EMA(9): ${ema9.toFixed(2)}, EMA(21): ${ema21.toFixed(2)}
- EMA crossover: ${ema9 > ema21 ? "BULLISH (9 > 21)" : "BEARISH (9 < 21)"}
- Volume spike: ${volumeSpike ? "YES (2x+ average)" : "NO"}
- Current price: $${last10[last10.length - 1].close}
- Has open position: ${hasPosition ? "YES (" + positionSide + ")" : "NO"}

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

// ── WebSocket real-time price listener ──────────────────────────────

function connectMexcWS(): Promise<{ ws: WebSocket; prices: { latest: number; ticks: number[] }; close: () => void }> {
  return new Promise((resolve, reject) => {
    const prices = { latest: 0, ticks: [] as number[] };
    const ws = new WebSocket(MEXC_WS);
    let resolved = false;

    ws.onopen = () => {
      // Subscribe to BTC_USDT deal (trade) stream for real-time ticks
      ws.send(JSON.stringify({
        method: "sub.deal",
        param: { symbol: "BTC_USDT" },
      }));
      // Also subscribe to ticker for last price
      ws.send(JSON.stringify({
        method: "sub.ticker",
        param: { symbol: "BTC_USDT" },
      }));
      if (!resolved) {
        resolved = true;
        resolve({ ws, prices, close: () => ws.close() });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Deal (trade) messages
        if (msg.channel === "push.deal" && msg.data) {
          const dealPrice = Number(msg.data.p || msg.data.price);
          if (dealPrice > 0) {
            prices.latest = dealPrice;
            prices.ticks.push(dealPrice);
          }
        }
        // Ticker messages
        if (msg.channel === "push.ticker" && msg.data) {
          const tickerPrice = Number(msg.data.lastPrice || msg.data.fairPrice);
          if (tickerPrice > 0) {
            prices.latest = tickerPrice;
          }
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    };

    // Timeout in case WS never connects
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("WebSocket connection timeout"));
      }
    }, 5000);
  });
}

// ── Execute trade logic (shared between demo/live) ──────────────────

async function executeTrade(
  supabaseAdmin: any, userId: string, action: string,
  currentPrice: number, riskPct: number, lev: number,
  demoMode: boolean, baseUrl: string,
  keys: any, telegramId: string | null,
  reasoning: string, rsi: number, ema9: number, ema21: number,
) {
  const isLong = action === "long";
  const tpPct = 0.003;
  const slPct = 0.0015;
  const tp = isLong ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
  const sl = isLong ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);

  if (demoMode) {
    const demoBalance = 10000;
    const riskAmount = demoBalance * (riskPct / 100);
    const contractValue = 0.0001 * currentPrice;
    const contracts = Math.max(1, Math.floor((riskAmount * lev) / contractValue));

    await supabaseAdmin.from("trades").insert({
      user_id: userId, symbol: "BTCUSDT",
      side: isLong ? "buy" : "sell",
      size: contracts * 0.0001,
      entry_price: currentPrice, tp, sl,
      leverage: lev, status: "open",
    });

    console.log(`User ${userId}: DEMO ${action} @ $${currentPrice} — ${contracts} contracts`);

    if (keys.telegram_token && telegramId) {
      await sendTelegramAlert(keys.telegram_token, telegramId,
        `📝 DEMO ${isLong ? "🟢 LONG" : "🔴 SHORT"} *ScalpPro*\n💰 Entry: $${currentPrice}\n🎯 TP: $${tp.toFixed(2)}\n🛑 SL: $${sl.toFixed(2)}\n📐 ${contracts} contracts @ ${lev}x\n🤖 AI: ${reasoning}`);
    }
    return `demo_${action}_executed`;
  } else {
    const assets = await getAccountAssets(baseUrl, keys.mexc_key, keys.mexc_secret);
    const usdtBalance = assets?.data?.find?.((a: any) => a.currency === "USDT");
    const availableBalance = Number(usdtBalance?.availableBalance || 0);
    if (availableBalance < 1) return "insufficient_balance";

    const riskAmount = availableBalance * (riskPct / 100);
    const contractValue = 0.0001 * currentPrice;
    const contracts = Math.max(1, Math.floor((riskAmount * lev) / contractValue));
    const side = isLong ? "1" : "3";

    const orderRes = await submitOrder(baseUrl, keys.mexc_key, keys.mexc_secret, {
      symbol: "BTC_USDT", price: currentPrice.toString(),
      vol: contracts.toString(), side, type: "5", openType: "1",
      leverage: lev.toString(),
      takeProfitPrice: tp.toFixed(2), stopLossPrice: sl.toFixed(2),
    });

    if (orderRes?.data) {
      await supabaseAdmin.from("trades").insert({
        user_id: userId, symbol: "BTCUSDT",
        side: isLong ? "buy" : "sell",
        size: contracts * 0.0001,
        entry_price: currentPrice, tp, sl,
        leverage: lev, status: "open",
      });

      if (keys.telegram_token && telegramId) {
        await sendTelegramAlert(keys.telegram_token, telegramId,
          `${isLong ? "🟢 LONG" : "🔴 SHORT"} *ScalpPro*\n📊 RSI: ${rsi.toFixed(1)}\n💰 Entry: $${currentPrice}\n🎯 TP: $${tp.toFixed(2)}\n🛑 SL: $${sl.toFixed(2)}\n📐 ${contracts} contracts @ ${lev}x`);
      }
      return `${action}_executed`;
    }
    return `${action}_failed`;
  }
}

// ── Check TP/SL hit for demo trades ─────────────────────────────────

async function checkDemoTPSL(supabaseAdmin: any, userId: string, currentPrice: number, keys: any, telegramId: string | null) {
  const { data: openTrades } = await supabaseAdmin
    .from("trades").select("*")
    .eq("user_id", userId).eq("status", "open").eq("symbol", "BTCUSDT");

  if (!openTrades?.length) return null;

  for (const trade of openTrades) {
    const entryPrice = Number(trade.entry_price);
    const tpPrice = Number(trade.tp);
    const slPrice = Number(trade.sl);
    const isLong = trade.side === "buy";
    const hitTp = isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice;
    const hitSl = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;

    if (hitTp || hitSl) {
      const exitPrice = hitTp ? tpPrice : slPrice;
      const size = Number(trade.size);
      const tradeLev = Number(trade.leverage);
      const priceDiff = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const pnl = (priceDiff / entryPrice) * size * exitPrice * tradeLev;

      await supabaseAdmin.from("trades")
        .update({ status: "closed", exit_price: exitPrice, pnl: Math.round(pnl * 100) / 100, closed_at: new Date().toISOString() })
        .eq("id", trade.id);

      console.log(`User ${userId}: DEMO auto-${hitTp ? "TP" : "SL"} @ $${currentPrice} — PnL: $${pnl.toFixed(2)}`);

      if (keys.telegram_token && telegramId) {
        await sendTelegramAlert(keys.telegram_token, telegramId,
          `📝 DEMO ${hitTp ? "🎯 TP HIT" : "🛑 SL HIT"} *ScalpPro*\n💰 Exit: $${exitPrice.toFixed(2)}\n${pnl >= 0 ? "✅" : "❌"} PnL: $${pnl.toFixed(2)}`);
      }
      return { hit: hitTp ? "tp" : "sl", pnl };
    }
  }
  return null;
}

// ── Main handler ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let manualSide: string | null = null;
    let manualUserId: string | null = null;
    try {
      const body = await req.json();
      manualSide = body.side || null;
      manualUserId = body.user_id || null;
    } catch { /* cron calls */ }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get users
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

    // 1. Fetch initial kline data for indicators + AI analysis
    const { closes, volumes, currentPrice: initialPrice, candles } = await fetchFuturesOHLCV(MEXC_FUTURES);
    const rsi = calculateRSI(closes);
    const ema9arr = calculateEMA(closes, 9);
    const ema21arr = calculateEMA(closes, 21);
    const volumeSpike = detectVolumeSpike(volumes);
    const ema9 = ema9arr[ema9arr.length - 1];
    const ema21 = ema21arr[ema21arr.length - 1];

    console.log(`RSI: ${rsi.toFixed(1)} | EMA9: ${ema9.toFixed(0)} | EMA21: ${ema21.toFixed(0)} | Price: $${initialPrice} | VolSpike: ${volumeSpike}`);

    const results: Array<{ userId: string; action: string; detail?: string }> = [];

    // 2. For each user, get AI decision once, then monitor ticks in real-time
    for (const profile of profiles) {
      const { user_id, max_risk_pct, leverage, telegram_id, demo_mode } = profile as any;
      const baseUrl = MEXC_FUTURES;
      console.log(`User ${user_id}: ${demo_mode ? "DEMO" : "LIVE"} mode`);

      const { data: keys } = await supabaseAdmin
        .from("api_keys")
        .select("mexc_key, mexc_secret, openai_key, telegram_token")
        .eq("user_id", user_id)
        .maybeSingle();

      if (!keys?.mexc_key || !keys?.mexc_secret) {
        results.push({ userId: user_id, action: "skipped", detail: "No MEXC API keys" });
        continue;
      }

      // Check current positions
      let hasPosition = false;
      let positionSide: string | null = null;

      if (demo_mode) {
        const { data: openTrades } = await supabaseAdmin
          .from("trades").select("*")
          .eq("user_id", user_id).eq("status", "open").eq("symbol", "BTCUSDT").limit(1);
        if (openTrades?.length) {
          hasPosition = true;
          positionSide = openTrades[0].side === "buy" ? "long" : "short";
        }
      } else {
        const posData = await getOpenPositions(baseUrl, keys.mexc_key, keys.mexc_secret, "BTC_USDT");
        const positions = posData?.data || [];
        hasPosition = Array.isArray(positions) && positions.length > 0;
        positionSide = hasPosition ? (positions[0].positionType === 1 ? "long" : "short") : null;
      }

      // Get AI decision (once per cycle)
      let aiDecision = { action: "hold", confidence: 0, reasoning: "No OpenAI key" };

      if (manualSide) {
        aiDecision = { action: manualSide, confidence: 100, reasoning: `Manual ${manualSide} trade` };
      } else if (keys.openai_key) {
        aiDecision = await analyzeWithOpenAI(
          keys.openai_key, candles, rsi, ema9, ema21,
          volumeSpike, hasPosition, positionSide
        );
      } else {
        if (!hasPosition) {
          if (rsi < 30 && ema9 > ema21) aiDecision = { action: "long", confidence: 75, reasoning: `RSI oversold (${rsi.toFixed(1)})` };
          else if (rsi > 70 && ema9 < ema21) aiDecision = { action: "short", confidence: 75, reasoning: `RSI overbought (${rsi.toFixed(1)})` };
        } else {
          if ((positionSide === "long" && rsi > 70) || (positionSide === "short" && rsi < 30))
            aiDecision = { action: "close", confidence: 80, reasoning: `RSI reversal` };
        }
      }

      console.log(`User ${user_id}: AI decision = ${aiDecision.action} (${aiDecision.confidence}%)`);

      // Store signal
      const signalType = aiDecision.action === "long" ? "buy" : aiDecision.action === "short" ? "sell" : "hold";
      await supabaseAdmin.from("signals").insert({
        user_id,
        symbol: "BTCUSDT",
        rsi: Math.round(rsi * 10) / 10,
        price: initialPrice,
        signal: signalType,
        ai_reasoning: `[${aiDecision.confidence}%] ${aiDecision.reasoning}`,
      });

      // Execute trade immediately if confidence > 70%
      const riskPct = Number(max_risk_pct) || 0.5;
      const lev = Number(leverage) || 10;

      if (aiDecision.confidence >= 70 && (aiDecision.action === "long" || aiDecision.action === "short") && !hasPosition) {
        const result = await executeTrade(
          supabaseAdmin, user_id, aiDecision.action, initialPrice,
          riskPct, lev, demo_mode, baseUrl, keys, telegram_id,
          aiDecision.reasoning, rsi, ema9, ema21
        );
        results.push({ userId: user_id, action: result, detail: `@ $${initialPrice}` });
        hasPosition = true; // now we have a position
      } else if (aiDecision.confidence >= 70 && aiDecision.action === "close" && hasPosition) {
        // Close via AI
        if (demo_mode) {
          const { data: openTrades } = await supabaseAdmin
            .from("trades").select("*")
            .eq("user_id", user_id).eq("status", "open").eq("symbol", "BTCUSDT").limit(1);
          if (openTrades?.length) {
            const t = openTrades[0];
            const entryPrice = Number(t.entry_price);
            const size = Number(t.size);
            const tradeLev = Number(t.leverage);
            const isLongPos = t.side === "buy";
            const priceDiff = isLongPos ? (initialPrice - entryPrice) : (entryPrice - initialPrice);
            const pnl = (priceDiff / entryPrice) * size * initialPrice * tradeLev;

            await supabaseAdmin.from("trades")
              .update({ status: "closed", exit_price: initialPrice, pnl: Math.round(pnl * 100) / 100, closed_at: new Date().toISOString() })
              .eq("id", t.id);
            console.log(`User ${user_id}: DEMO close @ $${initialPrice} — PnL: $${pnl.toFixed(2)}`);
            results.push({ userId: user_id, action: "demo_close", detail: `PnL: $${pnl.toFixed(2)}` });
            hasPosition = false;
          }
        } else {
          // Live close logic
          const posData = await getOpenPositions(baseUrl, keys.mexc_key, keys.mexc_secret, "BTC_USDT");
          const positions = posData?.data || [];
          if (positions.length > 0) {
            const closeSide = positionSide === "long" ? "4" : "2";
            const posVol = positions[0]?.holdVol?.toString() || "1";
            await submitOrder(baseUrl, keys.mexc_key, keys.mexc_secret, {
              symbol: "BTC_USDT", price: initialPrice.toString(),
              vol: posVol, side: closeSide, type: "5", openType: "1", leverage: lev.toString(),
            });
            await supabaseAdmin.from("trades")
              .update({ status: "closed", exit_price: initialPrice, closed_at: new Date().toISOString() })
              .eq("user_id", user_id).eq("status", "open").eq("symbol", "BTCUSDT");
            results.push({ userId: user_id, action: "close_executed", detail: `@ $${initialPrice}` });
            hasPosition = false;
          }
        }
      } else {
        results.push({ userId: user_id, action: "hold", detail: aiDecision.reasoning });
      }

      // 3. WebSocket real-time monitoring loop (TP/SL checks every tick)
      if (demo_mode && hasPosition) {
        console.log(`User ${user_id}: Starting WebSocket real-time TP/SL monitor for ~${LOOP_DURATION_MS / 1000}s`);
        try {
          const { ws, prices, close: closeWs } = await connectMexcWS();
          const startTime = Date.now();
          let tickCount = 0;
          let lastCheckPrice = 0;

          // Ping to keep alive
          const pingInterval = setInterval(() => {
            try { ws.send(JSON.stringify({ method: "ping" })); } catch { /* ignore */ }
          }, 15000);

          // Monitor loop
          await new Promise<void>((resolve) => {
            const checkInterval = setInterval(async () => {
              const elapsed = Date.now() - startTime;
              if (elapsed >= LOOP_DURATION_MS) {
                clearInterval(checkInterval);
                clearInterval(pingInterval);
                closeWs();
                resolve();
                return;
              }

              const price = prices.latest;
              if (price <= 0 || price === lastCheckPrice) return;
              lastCheckPrice = price;
              tickCount++;

              // Check TP/SL on every new price
              const hit = await checkDemoTPSL(supabaseAdmin, user_id, price, keys, telegram_id);
              if (hit) {
                console.log(`User ${user_id}: ${hit.hit.toUpperCase()} hit @ $${price} after ${tickCount} ticks (${elapsed}ms)`);
                clearInterval(checkInterval);
                clearInterval(pingInterval);
                closeWs();
                resolve();
              }
            }, 100); // check every 100ms
          });

          console.log(`User ${user_id}: WS loop done — ${tickCount} unique ticks in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        } catch (wsErr) {
          console.error(`User ${user_id}: WebSocket failed, falling back:`, wsErr);
        }
      }
    }

    return new Response(JSON.stringify({
      rsi: Math.round(rsi * 10) / 10,
      price: initialPrice,
      ema9: Math.round(ema9),
      ema21: Math.round(ema21),
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
