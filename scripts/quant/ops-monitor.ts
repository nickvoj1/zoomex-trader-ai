import { evaluateOpsHealth } from "../../src/lib/ops-health";
import { fetchLatestResearchRun } from "./supabase";
import { acquireProcessLock } from "./process-lock";
import {
  createOpsAlert,
  createOpsAlertWithinCooldown,
  createSupabaseAdminFromEnv,
  fetchLatestForwardValidationReports,
  fetchLatestHeartbeat,
  fetchOpsControl,
  recordOpsHeartbeat,
  upsertOpsControl,
} from "./live-ops";
import { booleanArg, numberArg, parseArgs, stringArg } from "./shared";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pauseUntilIso(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function ageSeconds(iso: string | null | undefined) {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return (Date.now() - timestamp) / 1000;
}

function ageHours(iso: string | null | undefined) {
  const seconds = ageSeconds(iso);
  return seconds === null ? null : seconds / 3600;
}

async function fetchLatestMarketSnapshotAgeSeconds(
  supabase: ReturnType<typeof createSupabaseAdminFromEnv>,
  symbol: string,
) {
  const { data, error } = await supabase
    .from("market_snapshots")
    .select("created_at")
    .in("symbol", [symbol, symbol === "BTCUSDT" ? "BTC_USDT" : symbol])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return ageSeconds(data?.created_at ?? null);
}

async function emitAlerts(
  supabase: ReturnType<typeof createSupabaseAdminFromEnv>,
  symbol: string,
  alerts: ReturnType<typeof evaluateOpsHealth>["alerts"],
  summary: Record<string, unknown>,
) {
  for (const alert of alerts) {
    await createOpsAlertWithinCooldown(supabase, {
      serviceName: "ops-monitor",
      symbol,
      severity: alert.severity,
      alertType: alert.alertType,
      message: alert.message,
      details: summary,
    }, 15 * 60_000).catch(() => null);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = stringArg(args, "symbol", process.env.OPS_SYMBOL ?? "BTCUSDT")!;
  const once = booleanArg(args, "once", false);
  const intervalMs = numberArg(args, "interval-ms", 60_000);
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null;
  const lock = await acquireProcessLock(`ops-monitor-${symbol}`);
  const supabase = createSupabaseAdminFromEnv();

  try {
    let keepRunning = true;
    while (keepRunning) {
      const startedAt = Date.now();
      try {
        const control = await fetchOpsControl(supabase, symbol).catch(() => null);
        const daemonHeartbeat = await fetchLatestHeartbeat(supabase, "ops-daemon", symbol).catch(() => null);
        const marketSnapshotAgeSeconds = await fetchLatestMarketSnapshotAgeSeconds(supabase, symbol).catch(() => null);
        const researchCycle = await fetchLatestResearchRun({
          userId,
          runType: "research_cycle",
          symbol,
        }).catch(() => null);
        const forwardReports = userId
          ? await fetchLatestForwardValidationReports(supabase, userId, symbol, 8).catch(() => [])
          : [];
        const latestForwardReport = forwardReports[0] ?? null;

        const health = evaluateOpsHealth({
          daemonHeartbeatAgeSeconds: ageSeconds(daemonHeartbeat?.created_at ?? null),
          marketSnapshotAgeSeconds,
          researchCycleAgeHours: ageHours(researchCycle?.created_at ?? null),
          forwardValidationAgeHours: ageHours(latestForwardReport?.created_at ?? null),
        }, {
          maxDaemonHeartbeatAgeSeconds: control?.max_heartbeat_age_seconds ?? 180,
          maxMarketSnapshotAgeSeconds: control?.max_market_snapshot_age_seconds ?? 180,
          maxResearchCycleAgeHours: numberArg(args, "max-research-cycle-age-hours", 24),
          maxForwardValidationAgeHours: numberArg(args, "max-forward-validation-age-hours", 24),
          killSwitchHeartbeatMultiplier: numberArg(args, "kill-switch-heartbeat-multiplier", 3),
        });

        if (health.alerts.length > 0) {
          await emitAlerts(supabase, symbol, health.alerts, {
            daemonHeartbeat: daemonHeartbeat ?? null,
            marketSnapshotAgeSeconds,
            researchCycleCreatedAt: researchCycle?.created_at ?? null,
            latestForwardValidationCreatedAt: latestForwardReport?.created_at ?? null,
          });

          const pauseMinutes = Math.max(...health.alerts.map((alert) => alert.pauseMinutes), 0);
          const enableKillSwitch = health.alerts.some((alert) => alert.enableKillSwitch);
          await upsertOpsControl(supabase, symbol, {
            ...(pauseMinutes > 0 ? { disable_live_entries_until: pauseUntilIso(pauseMinutes) } : {}),
            ...(enableKillSwitch ? { kill_switch: true } : {}),
            notes: `ops-monitor ${health.status} at ${new Date().toISOString()}: ${health.alerts.map((alert) => alert.alertType).join(", ")}`,
          }).catch(() => null);
        }

        await recordOpsHeartbeat(supabase, {
          serviceName: "ops-monitor",
          symbol,
          status: health.status === "ok" ? "ok" : health.status === "warning" ? "degraded" : "error",
          details: {
            ...health.summary,
            alerts: health.alerts,
            cycleLatencyMs: Date.now() - startedAt,
          },
        }).catch(() => null);

        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          status: health.status,
          alerts: health.alerts,
          summary: health.summary,
        }, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("ops-monitor cycle failed:", message);
        await createOpsAlert(supabase, {
          serviceName: "ops-monitor",
          symbol,
          severity: "critical",
          alertType: "monitor_failure",
          message,
          details: {
            startedAt: new Date(startedAt).toISOString(),
          },
        }).catch(() => null);
        await recordOpsHeartbeat(supabase, {
          serviceName: "ops-monitor",
          symbol,
          status: "error",
          details: {
            message,
          },
        }).catch(() => null);
        await upsertOpsControl(supabase, symbol, {
          disable_live_entries_until: pauseUntilIso(30),
          notes: `ops-monitor failure at ${new Date().toISOString()}: ${message}`,
        }).catch(() => null);
        if (once) {
          throw error;
        }
      }

      if (once) {
        keepRunning = false;
        continue;
      }
      await sleep(intervalMs);
    }
  } finally {
    await lock.release();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
