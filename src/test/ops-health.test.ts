import { describe, expect, it } from "vitest";
import { evaluateOpsHealth } from "../lib/ops-health";

describe("evaluateOpsHealth", () => {
  it("returns ok when all signals are fresh", () => {
    const result = evaluateOpsHealth({
      daemonHeartbeatAgeSeconds: 30,
      marketSnapshotAgeSeconds: 20,
      researchCycleAgeHours: 2,
      forwardValidationAgeHours: 1,
    });

    expect(result.status).toBe("ok");
    expect(result.alerts).toHaveLength(0);
  });

  it("raises a hard kill switch on a dead daemon heartbeat", () => {
    const result = evaluateOpsHealth({
      daemonHeartbeatAgeSeconds: 720,
      marketSnapshotAgeSeconds: 40,
      researchCycleAgeHours: 2,
      forwardValidationAgeHours: 1,
    });

    expect(result.status).toBe("critical");
    expect(result.alerts.some((alert) => alert.enableKillSwitch)).toBe(true);
    expect(result.alerts[0]?.alertType).toContain("heartbeat");
  });

  it("warns when research and forward validation are stale", () => {
    const result = evaluateOpsHealth({
      daemonHeartbeatAgeSeconds: 40,
      marketSnapshotAgeSeconds: 60,
      researchCycleAgeHours: 30,
      forwardValidationAgeHours: 28,
    });

    expect(result.status).toBe("warning");
    expect(result.alerts.map((alert) => alert.alertType)).toEqual(
      expect.arrayContaining(["research_cycle_degrading", "forward_validation_degrading"]),
    );
  });
});
