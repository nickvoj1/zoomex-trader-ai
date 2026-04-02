import { createClient } from "@supabase/supabase-js";
import { booleanArg, numberArg, parseArgs, stringArg, writeJson } from "./shared";

const BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const CPI_SERIES_ID = "CUSR0000SA0";
const CORE_CPI_SERIES_ID = "CUSR0000SA0L1E";
const UNEMPLOYMENT_SERIES_ID = "LNS14000000";

interface BlsSeriesPoint {
  year: string;
  period: string;
  value: string;
}

interface BlsSeries {
  seriesID: string;
  data: BlsSeriesPoint[];
}

interface MacroContextSnapshot {
  timestamp: number;
  source: string;
  macroCpiYoY: number | null;
  macroCpiMoM: number | null;
  macroCoreCpiYoY: number | null;
  macroCoreCpiMoM: number | null;
  macroUnemploymentRate: number | null;
  macroUnemploymentChange: number | null;
  macroInflationTrend: number | null;
  macroRiskBias: number | null;
  releaseLabel: string;
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function maybeCreateSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

function toMonthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function parseMonthKey(key: string) {
  const [year, month] = key.split("-").map(Number);
  return { year, month };
}

function previousMonthKey(key: string, monthsBack = 1) {
  const { year, month } = parseMonthKey(key);
  const date = new Date(Date.UTC(year, month - 1 - monthsBack, 1));
  return toMonthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

function computePctChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  return round(((current - previous) / previous) * 100, 6);
}

function estimateReleaseTimestamp(year: number, month: number, releaseDay = 15) {
  const releaseMonth = month === 12 ? 1 : month + 1;
  const releaseYear = month === 12 ? year + 1 : year;
  return Date.UTC(releaseYear, releaseMonth - 1, releaseDay, 13, 30, 0);
}

function buildRiskBias(
  cpiMom: number | null,
  coreMom: number | null,
  cpiYoY: number | null,
  coreYoY: number | null,
  prevCpiYoY: number | null,
  prevCoreYoY: number | null,
  unemploymentRate: number | null,
  unemploymentChange: number | null,
) {
  const yoyDelta = cpiYoY !== null && prevCpiYoY !== null ? cpiYoY - prevCpiYoY : 0;
  const coreYoyDelta = coreYoY !== null && prevCoreYoY !== null ? coreYoY - prevCoreYoY : 0;
  const inflationPressure = (
    (cpiMom ?? 0) * 0.35 +
    (coreMom ?? 0) * 0.35 +
    yoyDelta * 0.15 +
    coreYoyDelta * 0.15
  );
  const laborSoftening = (unemploymentChange ?? 0) * 0.8 + ((unemploymentRate ?? 0) - 4.2) * 0.1;
  const raw = -inflationPressure + laborSoftening;
  return round(clamp(raw, -3, 3), 6);
}

async function fetchSeries(startYear: number, endYear: number) {
  const response = await fetch(BLS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      seriesid: [CPI_SERIES_ID, CORE_CPI_SERIES_ID, UNEMPLOYMENT_SERIES_ID],
      startyear: String(startYear),
      endyear: String(endYear),
      calculations: false,
      annualaverage: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`BLS CPI request failed ${response.status}: ${body.slice(0, 240)}`);
  }

  const payload = await response.json() as {
    Results?: {
      series?: BlsSeries[];
    };
  };
  return payload.Results?.series ?? [];
}

function seriesToMonthlyMap(series: BlsSeries | undefined) {
  const values = new Map<string, number>();
  for (const point of series?.data ?? []) {
    const monthMatch = point.period.match(/^M(\d{2})$/);
    if (!monthMatch) continue;
    const year = Number(point.year);
    const month = Number(monthMatch[1]);
    const value = Number(point.value);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(value)) {
      continue;
    }
    values.set(toMonthKey(year, month), value);
  }
  return values;
}

async function persistSnapshots(symbol: string, snapshots: MacroContextSnapshot[]) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase || snapshots.length === 0) {
    return false;
  }

  const rows = snapshots.map((snapshot) => ({
    venue: "macro",
    symbol,
    snapshot_type: "macro_context",
    created_at: new Date(snapshot.timestamp).toISOString(),
    raw_payload: {
      context: {
        macroCpiYoY: snapshot.macroCpiYoY,
        macroCpiMoM: snapshot.macroCpiMoM,
        macroCoreCpiYoY: snapshot.macroCoreCpiYoY,
        macroCoreCpiMoM: snapshot.macroCoreCpiMoM,
        macroUnemploymentRate: snapshot.macroUnemploymentRate,
        macroUnemploymentChange: snapshot.macroUnemploymentChange,
        macroInflationTrend: snapshot.macroInflationTrend,
        macroRiskBias: snapshot.macroRiskBias,
        source: snapshot.source,
      },
      releaseLabel: snapshot.releaseLabel,
    },
  }));

  const { error } = await supabase.from("market_snapshots").insert(rows as unknown);
  if (error) {
    throw error;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const output = stringArg(args, "output", `research/datasets/${symbol}-cpi-context.json`)!;
  const persist = booleanArg(args, "persist", true);
  const releaseDay = Math.max(8, Math.min(20, numberArg(args, "release-day", 15)));
  const startYear = numberArg(args, "start-year", 2019);
  const endYear = numberArg(args, "end-year", new Date().getUTCFullYear());

  const series = await fetchSeries(startYear, endYear);
  const cpiValues = seriesToMonthlyMap(series.find((entry) => entry.seriesID === CPI_SERIES_ID));
  const coreValues = seriesToMonthlyMap(series.find((entry) => entry.seriesID === CORE_CPI_SERIES_ID));
  const unemploymentValues = seriesToMonthlyMap(series.find((entry) => entry.seriesID === UNEMPLOYMENT_SERIES_ID));
  const monthKeys = [...new Set([...cpiValues.keys(), ...coreValues.keys(), ...unemploymentValues.keys()])].sort();

  const snapshots: MacroContextSnapshot[] = [];
  for (const monthKey of monthKeys) {
    const currentCpi = cpiValues.get(monthKey) ?? null;
    const currentCore = coreValues.get(monthKey) ?? null;
    const prevMonthKey = previousMonthKey(monthKey, 1);
    const prevYearKey = previousMonthKey(monthKey, 12);
    const prevYearPrevMonthKey = previousMonthKey(monthKey, 13);
    const cpiMom = computePctChange(currentCpi, cpiValues.get(prevMonthKey) ?? null);
    const coreMom = computePctChange(currentCore, coreValues.get(prevMonthKey) ?? null);
    const cpiYoY = computePctChange(currentCpi, cpiValues.get(prevYearKey) ?? null);
    const coreYoY = computePctChange(currentCore, coreValues.get(prevYearKey) ?? null);
    const prevCpiYoY = computePctChange(cpiValues.get(prevMonthKey) ?? null, cpiValues.get(prevYearPrevMonthKey) ?? null);
    const prevCoreYoY = computePctChange(coreValues.get(prevMonthKey) ?? null, coreValues.get(prevYearPrevMonthKey) ?? null);
    const unemploymentRate = unemploymentValues.get(monthKey) ?? null;
    const previousUnemploymentRate = unemploymentValues.get(prevMonthKey) ?? null;
    const unemploymentChange = unemploymentRate !== null && previousUnemploymentRate !== null
      ? round(unemploymentRate - previousUnemploymentRate, 6)
      : null;
    const inflationTrend = cpiYoY !== null && prevCpiYoY !== null
      ? round(cpiYoY - prevCpiYoY, 6)
      : coreYoY !== null && prevCoreYoY !== null
        ? round(coreYoY - prevCoreYoY, 6)
        : null;
    const macroRiskBias = buildRiskBias(
      cpiMom,
      coreMom,
      cpiYoY,
      coreYoY,
      prevCpiYoY,
      prevCoreYoY,
      unemploymentRate,
      unemploymentChange,
    );
    const { year, month } = parseMonthKey(monthKey);

    snapshots.push({
      timestamp: estimateReleaseTimestamp(year, month, releaseDay),
      source: "bls-cpi",
      macroCpiYoY: cpiYoY,
      macroCpiMoM: cpiMom,
      macroCoreCpiYoY: coreYoY,
      macroCoreCpiMoM: coreMom,
      macroUnemploymentRate: unemploymentRate,
      macroUnemploymentChange: unemploymentChange,
      macroInflationTrend: inflationTrend,
      macroRiskBias,
      releaseLabel: monthKey,
    });
  }

  if (persist) {
    await persistSnapshots(symbol, snapshots).catch((error) => {
      console.error("Supabase persist failed:", error instanceof Error ? error.message : error);
    });
  }

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    provider: "bls",
    symbol,
    releaseDay,
    seriesIds: {
      cpi: CPI_SERIES_ID,
      coreCpi: CORE_CPI_SERIES_ID,
      unemploymentRate: UNEMPLOYMENT_SERIES_ID,
    },
    count: snapshots.length,
    snapshots,
  });

  console.log(JSON.stringify({
    output,
    symbol,
    persisted: persist,
    count: snapshots.length,
    firstRelease: snapshots[0]?.releaseLabel ?? null,
    lastRelease: snapshots[snapshots.length - 1]?.releaseLabel ?? null,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
