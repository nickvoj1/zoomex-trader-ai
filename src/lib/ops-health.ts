export interface OpsHealthThresholds {
  maxDaemonHeartbeatAgeSeconds: number;
  maxMarketSnapshotAgeSeconds: number;
  maxResearchCycleAgeHours: number;
  maxForwardValidationAgeHours: number;
  killSwitchHeartbeatMultiplier: number;
}

export interface OpsHealthInputs {
  daemonHeartbeatAgeSeconds: number | null;
  marketSnapshotAgeSeconds: number | null;
  researchCycleAgeHours: number | null;
  forwardValidationAgeHours: number | null;
}

export interface OpsHealthAlert {
  severity: "warning" | "critical";
  alertType: string;
  message: string;
  pauseMinutes: number;
  enableKillSwitch: boolean;
}

export interface OpsHealthEvaluation {
  status: "ok" | "warning" | "critical";
  alerts: OpsHealthAlert[];
  summary: {
    daemonHeartbeatAgeSeconds: number | null;
    marketSnapshotAgeSeconds: number | null;
    researchCycleAgeHours: number | null;
    forwardValidationAgeHours: number | null;
  };
}

function round(value: number, precision = 2) {
  return Number(value.toFixed(precision));
}

export function defaultOpsHealthThresholds(): OpsHealthThresholds {
  return {
    maxDaemonHeartbeatAgeSeconds: 180,
    maxMarketSnapshotAgeSeconds: 180,
    maxResearchCycleAgeHours: 24,
    maxForwardValidationAgeHours: 24,
    killSwitchHeartbeatMultiplier: 3,
  };
}

export function evaluateOpsHealth(
  inputs: OpsHealthInputs,
  thresholds: OpsHealthThresholds = defaultOpsHealthThresholds(),
): OpsHealthEvaluation {
  const alerts: OpsHealthAlert[] = [];

  const heartbeatKillSwitchAge = thresholds.maxDaemonHeartbeatAgeSeconds * thresholds.killSwitchHeartbeatMultiplier;
  if (inputs.daemonHeartbeatAgeSeconds === null) {
    alerts.push({
      severity: "critical",
      alertType: "daemon_heartbeat_missing",
      message: "ops-daemon heartbeat is missing",
      pauseMinutes: 60,
      enableKillSwitch: true,
    });
  } else if (inputs.daemonHeartbeatAgeSeconds > heartbeatKillSwitchAge) {
    alerts.push({
      severity: "critical",
      alertType: "daemon_heartbeat_dead",
      message:
        `ops-daemon heartbeat is ${Math.round(inputs.daemonHeartbeatAgeSeconds)}s old ` +
        `(kill switch threshold ${heartbeatKillSwitchAge}s)`,
      pauseMinutes: 120,
      enableKillSwitch: true,
    });
  } else if (inputs.daemonHeartbeatAgeSeconds > thresholds.maxDaemonHeartbeatAgeSeconds) {
    alerts.push({
      severity: "critical",
      alertType: "daemon_heartbeat_stale",
      message:
        `ops-daemon heartbeat is ${Math.round(inputs.daemonHeartbeatAgeSeconds)}s old ` +
        `(threshold ${thresholds.maxDaemonHeartbeatAgeSeconds}s)`,
      pauseMinutes: 30,
      enableKillSwitch: false,
    });
  }

  if (inputs.marketSnapshotAgeSeconds === null) {
    alerts.push({
      severity: "warning",
      alertType: "market_snapshot_missing",
      message: "market snapshot freshness cannot be verified",
      pauseMinutes: 15,
      enableKillSwitch: false,
    });
  } else if (inputs.marketSnapshotAgeSeconds > thresholds.maxMarketSnapshotAgeSeconds * 2) {
    alerts.push({
      severity: "critical",
      alertType: "market_snapshot_stale",
      message:
        `latest market snapshot is ${Math.round(inputs.marketSnapshotAgeSeconds)}s old ` +
        `(threshold ${thresholds.maxMarketSnapshotAgeSeconds}s)`,
      pauseMinutes: 30,
      enableKillSwitch: false,
    });
  } else if (inputs.marketSnapshotAgeSeconds > thresholds.maxMarketSnapshotAgeSeconds) {
    alerts.push({
      severity: "warning",
      alertType: "market_snapshot_degrading",
      message:
        `latest market snapshot is ${Math.round(inputs.marketSnapshotAgeSeconds)}s old ` +
        `(threshold ${thresholds.maxMarketSnapshotAgeSeconds}s)`,
      pauseMinutes: 15,
      enableKillSwitch: false,
    });
  }

  if (inputs.researchCycleAgeHours === null) {
    alerts.push({
      severity: "warning",
      alertType: "research_cycle_missing",
      message: "no research cycle has been recorded yet",
      pauseMinutes: 0,
      enableKillSwitch: false,
    });
  } else if (inputs.researchCycleAgeHours > thresholds.maxResearchCycleAgeHours * 2) {
    alerts.push({
      severity: "critical",
      alertType: "research_cycle_stale",
      message:
        `latest research cycle is ${round(inputs.researchCycleAgeHours)}h old ` +
        `(threshold ${thresholds.maxResearchCycleAgeHours}h)`,
      pauseMinutes: 30,
      enableKillSwitch: false,
    });
  } else if (inputs.researchCycleAgeHours > thresholds.maxResearchCycleAgeHours) {
    alerts.push({
      severity: "warning",
      alertType: "research_cycle_degrading",
      message:
        `latest research cycle is ${round(inputs.researchCycleAgeHours)}h old ` +
        `(threshold ${thresholds.maxResearchCycleAgeHours}h)`,
      pauseMinutes: 15,
      enableKillSwitch: false,
    });
  }

  if (inputs.forwardValidationAgeHours === null) {
    alerts.push({
      severity: "warning",
      alertType: "forward_validation_missing",
      message: "no forward validation report has been recorded yet",
      pauseMinutes: 15,
      enableKillSwitch: false,
    });
  } else if (inputs.forwardValidationAgeHours > thresholds.maxForwardValidationAgeHours * 2) {
    alerts.push({
      severity: "critical",
      alertType: "forward_validation_stale",
      message:
        `latest forward validation is ${round(inputs.forwardValidationAgeHours)}h old ` +
        `(threshold ${thresholds.maxForwardValidationAgeHours}h)`,
      pauseMinutes: 30,
      enableKillSwitch: false,
    });
  } else if (inputs.forwardValidationAgeHours > thresholds.maxForwardValidationAgeHours) {
    alerts.push({
      severity: "warning",
      alertType: "forward_validation_degrading",
      message:
        `latest forward validation is ${round(inputs.forwardValidationAgeHours)}h old ` +
        `(threshold ${thresholds.maxForwardValidationAgeHours}h)`,
      pauseMinutes: 15,
      enableKillSwitch: false,
    });
  }

  const status = alerts.some((alert) => alert.severity === "critical")
    ? "critical"
    : alerts.some((alert) => alert.severity === "warning")
      ? "warning"
      : "ok";

  return {
    status,
    alerts,
    summary: {
      daemonHeartbeatAgeSeconds: inputs.daemonHeartbeatAgeSeconds,
      marketSnapshotAgeSeconds: inputs.marketSnapshotAgeSeconds,
      researchCycleAgeHours: inputs.researchCycleAgeHours,
      forwardValidationAgeHours: inputs.forwardValidationAgeHours,
    },
  };
}
