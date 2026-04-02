import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { booleanArg, numberArg, parseArgs, stringArg, writeJson } from "./shared";

const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const DEFAULT_QUERY = '(bitcoin OR btc OR "digital asset")';
const REQUEST_DELAY_MS = 5_500;
const execFileAsync = promisify(execFile);

interface GdeltTimelinePoint {
  date: string;
  value: number;
  norm?: number;
}

interface GdeltTimelineSeries {
  series: string;
  data: GdeltTimelinePoint[];
}

interface GdeltResponse {
  query_details?: {
    title?: string;
    date_resolution?: string;
  };
  timeline?: GdeltTimelineSeries[];
}

interface HistoricalNewsContextSnapshot {
  timestamp: number;
  source: string;
  newsEventCount: number;
  newsSentiment: number;
  newsImpact: number;
  newsPositiveCount: number;
  newsNegativeCount: number;
  newsBtcRelevance: number;
  newsShockScore: number;
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeCreateSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

function parseGdeltDate(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

function toGdeltDatetime(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

async function fetchTimeline(
  query: string,
  mode: "TimelineVolRaw" | "TimelineTone",
  startTimestamp: number,
  endTimestamp: number,
) {
  const url = new URL(GDELT_API_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", mode);
  url.searchParams.set("format", "json");
  url.searchParams.set("STARTDATETIME", toGdeltDatetime(startTimestamp));
  url.searchParams.set("ENDDATETIME", toGdeltDatetime(endTimestamp));

  const { stdout } = await execFileAsync("curl", [
    "-A",
    "Mozilla/5.0",
    "-sS",
    "--fail",
    "--max-time",
    "30",
    "--retry",
    "2",
    "--retry-delay",
    "5",
    url.toString(),
  ]);
  const body = stdout;
  if (body.startsWith("Please limit requests")) {
    throw new Error(body.trim());
  }

  return JSON.parse(body) as GdeltResponse;
}

async function persistSnapshots(symbol: string, snapshots: HistoricalNewsContextSnapshot[]) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase || snapshots.length === 0) {
    return false;
  }

  const rows = snapshots.map((snapshot) => ({
    venue: "gdelt",
    symbol,
    snapshot_type: "news_context",
    created_at: new Date(snapshot.timestamp).toISOString(),
    raw_payload: {
      context: {
        newsEventCount: snapshot.newsEventCount,
        newsSentiment: snapshot.newsSentiment,
        newsImpact: snapshot.newsImpact,
        newsPositiveCount: snapshot.newsPositiveCount,
        newsNegativeCount: snapshot.newsNegativeCount,
        newsBtcRelevance: snapshot.newsBtcRelevance,
        newsShockScore: snapshot.newsShockScore,
        source: snapshot.source,
      },
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
  const query = stringArg(args, "query", DEFAULT_QUERY)!;
  const output = stringArg(args, "output", `research/datasets/${symbol}-gdelt-news-context.json`)!;
  const persist = booleanArg(args, "persist", true);
  const startAt = Date.parse(stringArg(args, "start", "2024-01-01T00:00:00Z")!);
  const endAt = Date.parse(stringArg(args, "end", new Date().toISOString())!);
  const chunkDays = Math.max(7, numberArg(args, "chunk-days", 30));

  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) {
    throw new Error("Invalid --start/--end range");
  }

  const volumeByTimestamp = new Map<number, { value: number; norm: number }>();
  const toneByTimestamp = new Map<number, number>();
  let requestCount = 0;

  for (let chunkStart = startAt; chunkStart < endAt; chunkStart += chunkDays * 24 * 60 * 60_000) {
    const chunkEnd = Math.min(endAt, chunkStart + chunkDays * 24 * 60 * 60_000);

    const volumeResponse = await fetchTimeline(query, "TimelineVolRaw", chunkStart, chunkEnd);
    requestCount += 1;
    const volumeSeries = volumeResponse.timeline?.find((entry) => entry.series === "Article Count")?.data ?? [];
    for (const point of volumeSeries) {
      const timestamp = parseGdeltDate(point.date);
      if (timestamp === null) continue;
      volumeByTimestamp.set(timestamp, {
        value: Number(point.value ?? 0),
        norm: Number(point.norm ?? 0),
      });
    }

    await sleep(REQUEST_DELAY_MS);

    const toneResponse = await fetchTimeline(query, "TimelineTone", chunkStart, chunkEnd);
    requestCount += 1;
    const toneSeries = toneResponse.timeline?.find((entry) => entry.series === "Average Tone")?.data ?? [];
    for (const point of toneSeries) {
      const timestamp = parseGdeltDate(point.date);
      if (timestamp === null) continue;
      toneByTimestamp.set(timestamp, Number(point.value ?? 0));
    }

    if (chunkEnd < endAt) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const timestamps = [...new Set([...volumeByTimestamp.keys(), ...toneByTimestamp.keys()])].sort((left, right) => left - right);
  const maxCount = Math.max(...timestamps.map((timestamp) => volumeByTimestamp.get(timestamp)?.value ?? 0), 1);
  const snapshots: HistoricalNewsContextSnapshot[] = timestamps.map((timestamp) => {
    const volume = volumeByTimestamp.get(timestamp);
    const count = volume?.value ?? 0;
    const norm = volume?.norm ?? 0;
    const tone = toneByTimestamp.get(timestamp) ?? 0;
    const sentiment = clamp(tone / 10, -1, 1);
    const impact = clamp((count / maxCount) * 0.65 + Math.min(norm / 100, 1) * 0.35, 0, 1);
    const positiveShare = sentiment > 0 ? sentiment : 0;
    const negativeShare = sentiment < 0 ? Math.abs(sentiment) : 0;

    return {
      timestamp,
      source: "gdelt-timeline",
      newsEventCount: count,
      newsSentiment: round(sentiment),
      newsImpact: round(impact),
      newsPositiveCount: Math.round(count * positiveShare),
      newsNegativeCount: Math.round(count * negativeShare),
      newsBtcRelevance: 1,
      newsShockScore: round(clamp(impact * (0.4 + Math.abs(sentiment) * 0.6), 0, 1)),
    };
  });

  if (persist) {
    await persistSnapshots(symbol, snapshots).catch((error) => {
      console.error("Supabase persist failed:", error instanceof Error ? error.message : error);
    });
  }

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    provider: "gdelt",
    symbol,
    query,
    chunkDays,
    requestCount,
    count: snapshots.length,
    snapshots,
  });

  console.log(JSON.stringify({
    output,
    symbol,
    query,
    chunkDays,
    requestCount,
    persisted: persist,
    count: snapshots.length,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
