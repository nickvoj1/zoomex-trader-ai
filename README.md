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
- Forward-validation reporting and live model gating based on real paper/live trade results
- Dedicated order-book and trade-tick archive collection for deeper microstructure research
- Always-on ops deployment support with Docker Compose, heartbeats, alerts, and kill-switch controls
- Automatic unified training-dataset preparation from downloaded Binance monthly archive files

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
- `scalper` now only loads approved signal models that pass validation gates and overfit checks

## Quant extensions

The repository now has four concrete layers that were missing from the original project:

- `src/lib/market-intel.ts`: pulls order-book, funding-rate, open-interest, long/short, and cross-venue basis context.
- `src/lib/quant-research.ts`: shared parameter search, walk-forward validation, and logistic model training code.
- `scripts/quant/*.ts`: runnable research and execution workflows.
- `supabase/migrations/20260328173000_add_quant_research_and_execution.sql`: persistent storage for market snapshots, research runs, model artifacts, reconciliations, execution events, and trade TCA.
- `supabase/migrations/20260329113000_add_forward_validation_and_depth_archive.sql`: persistent storage for order-book snapshots, trade ticks, and forward-validation reports.
- `supabase/migrations/20260329142000_add_ops_monitoring_and_controls.sql`: persistent storage for ops controls, daemon heartbeats, and alerts.

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

All research scripts use OHLCV CSV input with headers like `timestamp,open,high,low,close,volume`.
The loader now sorts, de-duplicates, repairs inconsistent OHLC bounds, detects gaps, fills small missing intervals with synthetic flat candles, and emits a data-quality summary that is stored with research runs.

Backfill historical futures candles from Binance:

```bash
npm run research:backfill -- --symbol BTCUSDT --interval 1m --start 2025-01-01 --end 2025-03-01
```

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

The trained artifacts now include dataset diagnostics, regime-segment validation metrics, and an approval decision that the live bot uses before loading them.

If you already have historical market snapshots in JSON, you can feed them into training too:

```bash
npm run research:train -- --input /absolute/path/to/btcusdt-1m.csv --side both --snapshots-file /absolute/path/to/market-snapshots.json
```

Run the full research cycle in one shot:

```bash
npm run research:cycle -- --input /absolute/path/to/btcusdt-1m.csv
```

Build a unified training CSV automatically from downloaded Binance monthly archives:

```bash
npm run research:prepare -- --klines-dir /absolute/path/to/binance-vision/klines/BTCUSDT
```

Run scheduled retraining from collected data:

```bash
npm run research:schedule -- --input /absolute/path/to/btcusdt-1m.csv --every-minutes 240
```

Run scheduled retraining with automatic dataset preparation from the archive folder:

```bash
npm run research:schedule -- --auto-prepare true --klines-dir /absolute/path/to/binance-vision/klines/BTCUSDT --snapshots-jsonl /absolute/path/to/market-snapshots-BTCUSDT.jsonl --every-minutes 240
```

Fetch cross-venue market snapshots:

```bash
npm run research:market-data -- --iterations 10 --interval-ms 60000
```

Archive deeper order-book and trade-tick samples:

```bash
npm run ops:archive -- --iterations 240 --interval-ms 15000
```

Generate forward-validation reports from real closed trades plus TCA:

```bash
npm run ops:forward-validate -- --user-id YOUR_USER_ID --lookback-days 14
```

Compare the latest research cycle against forward-paper/live results:

```bash
npm run research:compare -- --user-id YOUR_USER_ID --lookback-days 14
```

Run the execution daemon:

```bash
npm run ops:daemon -- --user-id YOUR_USER_ID
```

The daemon expects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. If `BOT_USER_ID` is also set, it will reconcile that account, call the `scalper` function on a loop, persist market snapshots, archive order-book and recent trade-tick samples, compute trade TCA, and write forward-validation reports that the live bot uses as an additional safety gate.

If the daemon is running, the `scalper` function will also reuse the freshest stored liquidation metrics from `market_snapshots` so direct bot runs benefit from that crowding context.

The training scripts now also pull historical `market_snapshots` from Supabase automatically when available, so the model can learn from more than candles alone.

For live auto-trading, approved offline models are no longer enough on their own. The live path now also requires a recent forward-validation report to pass its gate; otherwise the strategy falls back to rule-based analysis and suppresses auto-entry until more evidence has been collected.

The live path also checks the ops control plane before allowing new live entries. A stale daemon heartbeat, a temporary ops pause, or a kill switch in `ops_controls` will block new live entries while still allowing close logic.

## Always-On Server

The repo now includes:

- `Dockerfile.ops`
- `docker-compose.ops.yml`
- `.env.ops.example`

Use those to keep two services running continuously on a server:

- `ops-daemon`: collects market data, archives depth/ticks, reconciles positions, updates heartbeats, writes alerts, and calls `scalper`
- `ops-research`: prepares the latest unified dataset, retrains on schedule, and compares research against forward-live results

Example:

```bash
cp .env.ops.example .env.ops
docker compose -f docker-compose.ops.yml up -d --build
```

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
- Added dataset backfill, cleaning, gap handling, and data-quality reporting for research inputs
- Added regime-aware model diagnostics, approval gates, and scheduled retraining support
- Added persistent order-book/tick archive capture and forward-validation reports with live auto-entry gating
- Added server-ready ops packaging, kill-switch controls, daemon heartbeats/alerts, automatic archive-to-training dataset prep, and live-vs-research comparison reporting
