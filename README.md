# ScalpPro for MEXC Futures

ScalpPro is a Supabase-backed React app for paper trading and controlled live execution on MEXC futures. The current bot now includes:

- Rule-based signal generation from 1-minute market structure
- Cross-venue microstructure inputs from MEXC and Binance
- Optional OpenAI confirmation layered on top of the rule engine
- Manual long, short, and close actions from the dashboard
- Paper mode with tracked trades, TP/SL handling, and equity history
- Live mode with authenticated MEXC account checks and order submission
- Walk-forward optimization, parameter sweeps, and supervised signal-model training scripts
- Execution-cycle logging, reconciliation, market snapshots, and transaction-cost analysis tables

## Important limitations

- This repository does not guarantee profitability. Treat it as trading infrastructure, not a money printer.
- Paper mode is local simulation, not an exchange sandbox.
- Live mode depends on your MEXC account having futures API trading access and valid permissions.
- The backtest page is still a lightweight research UI. The heavier research jobs run through the CLI scripts below.

## Stack

- Vite + React + TypeScript
- Supabase Auth, Postgres, Realtime, Edge Functions
- MEXC contract REST and websocket APIs
- OpenAI chat completions for optional discretionary confirmation
- Cross-venue market data from MEXC contract APIs and Binance futures market-data APIs
- Latest trained signal models are now loaded by `scalper` when model artifacts exist

## Quant extensions

The repository now has four concrete layers that were missing from the original project:

- `src/lib/market-intel.ts`: pulls order-book, funding-rate, open-interest, long/short, and cross-venue basis context.
- `src/lib/quant-research.ts`: shared parameter search, walk-forward validation, and logistic model training code.
- `scripts/quant/*.ts`: runnable research and execution workflows.
- `supabase/migrations/20260328173000_add_quant_research_and_execution.sql`: persistent storage for market snapshots, research runs, model artifacts, reconciliations, execution events, and trade TCA.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Fill in the Supabase values in `.env`.

4. Apply the database migrations and deploy the edge functions:

```bash
supabase db push
supabase functions deploy scalper
supabase functions deploy test-mexc
```

5. Provide these edge-function secrets in Supabase:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

6. Start the app:

```bash
npm run dev
```

## Research workflows

All research scripts use one-minute OHLCV CSV input with headers like `timestamp,open,high,low,close,volume`.

Parameter sweep:

```bash
npm run research:sweep -- --input /absolute/path/to/btcusdt-1m.csv
```

Walk-forward optimization:

```bash
npm run research:walk-forward -- --input /absolute/path/to/btcusdt-1m.csv
```

Train logistic signal models:

```bash
npm run research:train -- --input /absolute/path/to/btcusdt-1m.csv --side both
```

Run the full research cycle in one shot:

```bash
npm run research:cycle -- --input /absolute/path/to/btcusdt-1m.csv
```

Fetch cross-venue market snapshots:

```bash
npm run research:market-data -- --iterations 10 --interval-ms 60000
```

Run the execution daemon:

```bash
npm run ops:daemon -- --user-id YOUR_USER_ID
```

The daemon expects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. If `BOT_USER_ID` is also set, it will reconcile that account, call the `scalper` function on a loop, persist market snapshots, and keep a Binance liquidation stream in memory for live crowding metrics.

If the daemon is running, the `scalper` function will also reuse the freshest stored liquidation metrics from `market_snapshots` so direct bot runs benefit from that crowding context.

## Manual usage

- Sign in
- Add your MEXC API keys in Settings
- Test the connection from Settings
- Keep Paper Mode enabled until you have validated the flow end to end
- Use Dashboard for manual long, short, or close requests

## Automation

The `scalper` function supports two modes:

- User mode: call it with a user JWT and an optional manual `side`
- Service mode: call it with a service-role token to process all `auto_trade = true` profiles

Example user call:

```bash
curl -X POST \
  -H "Authorization: Bearer USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"side":"long"}' \
  https://YOUR_PROJECT.supabase.co/functions/v1/scalper
```

## What changed from the original repo

- Fixed MEXC private-request signing and request formatting
- Stopped trusting caller-supplied `user_id` for user-triggered actions
- Added structured signal metadata for future model training
- Reworked position sizing to use stop distance instead of multiplying leverage twice
- Added connection testing and clearer paper/live UX
- Removed the committed `.env` file and added `.env.example`
- Added market snapshot, research, model artifact, reconciliation, execution event, and trade TCA storage
- Added parameter sweep, walk-forward, market-data ingest, model-training, and execution-daemon scripts
- Added a one-command research cycle runner for sweep + walk-forward + training
- Added cross-venue microstructure gating to the live strategy path
- Added live model-artifact confirmation/veto on top of the rule engine
