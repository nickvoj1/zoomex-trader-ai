import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCsvCandles, StrategySettings } from "../../src/lib/strategy-core";

export type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]) {
  const args: Args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }

  return args;
}

export function stringArg(args: Args, key: string, fallback?: string) {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function numberArg(args: Args, key: string, fallback: number) {
  const value = args[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function booleanArg(args: Args, key: string, fallback = false) {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

export function csvNumberArg(args: Args, key: string, fallback: number[]) {
  const raw = stringArg(args, key);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : fallback;
}

export function csvBooleanArg(args: Args, key: string, fallback: boolean[]) {
  const raw = stringArg(args, key);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => ["1", "true", "yes", "on"].includes(value));
  return values.length > 0 ? values : fallback;
}

export async function loadCandlesFromCsv(filePath: string) {
  const text = await readFile(filePath, "utf8");
  return parseCsvCandles(text);
}

export async function ensureParentDirectory(filePath: string) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

export function defaultStrategySettings(): StrategySettings {
  return {
    riskPct: 0.5,
    leverage: 10,
    minConfidence: 78,
    dailyLossLimitPct: 3,
    maxConsecutiveLosses: 3,
    allowTrendTrades: true,
    allowMeanReversionTrades: true,
    feeBps: 4,
    slippageBps: 3,
    maxBarsInTrade: 90,
    partialTakeProfitRR: 1.2,
    allowSessionFilter: true,
    sessionStartHourUtc: 6,
    sessionEndHourUtc: 22,
  };
}

export function timestampedFile(prefix: string, extension: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}.${extension}`;
}
