

# ScalpPro: MEXC Futures + OpenAI Analysis + Auto-Cron

## Overview

Rebuild the scalper edge function to trade MEXC USDT-M perpetual futures with leverage, use the user's OpenAI API key (already stored in `api_keys.openai_key`) for AI-powered trade analysis, and schedule automatic execution every minute.

**Risk warning**: Leverage trading can liquidate your entire balance. TP/SL and risk limits are built in, but losses are always possible.

---

## What Gets Built

### 1. Rewrite Scalper for MEXC Futures API
- Switch from spot (`api.mexc.com`) to futures (`contract.mexc.com`)
- Symbol format: `BTC_USDT` (underscore)
- Market orders via `POST /api/v1/private/order/submit` with native TP/SL
- Dynamic position sizing from account balance × `max_risk_pct` × leverage
- Isolated margin mode

### 2. OpenAI-Powered Signal Analysis
- Read the user's `openai_key` from the `api_keys` table (already stored)
- Send last 50 candles (1m), RSI, EMA(9/21), volume data to **GPT-4o** via `https://api.openai.com/v1/chat/completions`
- AI returns structured decision: `{ action, confidence, reasoning }`
- Only execute trades when confidence > 70%
- Store AI reasoning in the `signals` table

### 3. Multi-Indicator Strategy
- RSI (14-period), EMA crossover (9/21), volume spike detection
- All indicators fed to OpenAI for final decision

### 4. Auto-Cron (every 60 seconds)
- Enable `pg_cron` + `pg_net` extensions
- Create cron job invoking the scalper edge function every minute

### 5. Connect Dashboard to Real Data
- Replace mock data with actual DB queries (trades, signals, equity)
- Wire Quick Trade buttons to call scalper with manual side override

---

## Technical Steps

| # | Task | Details |
|---|------|---------|
| 1 | Rewrite `supabase/functions/scalper/index.ts` | MEXC futures API, OpenAI analysis (using user's key from DB), multi-indicator strategy, dynamic sizing |
| 2 | Update `supabase/functions/test-mexc/index.ts` | Verify futures API connectivity |
| 3 | DB migration | Enable `pg_cron` + `pg_net`, create 1-min cron schedule |
| 4 | Update `src/pages/Dashboard.tsx` | Real trades/signals from DB instead of mock data |
| 5 | Update `src/components/dashboard/QuickTrade.tsx` | Call scalper edge function with manual side override |

---

## Risk Management
- Max risk per trade from user's `max_risk_pct` setting (default 0.5%)
- Native TP/SL on every MEXC order
- No new position if one already exists
- AI confidence gate (>70%)
- Isolated margin per position

