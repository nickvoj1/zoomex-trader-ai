import { describe, expect, it } from "vitest";
import {
  computeForwardValidationReport,
  mergeTradesWithTca,
} from "../lib/forward-validation";

function makeTrades(count: number, mode: "paper" | "live", pnl = 15) {
  return Array.from({ length: count }, (_, index) => ({
    id: `trade-${mode}-${index}`,
    created_at: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
    closed_at: new Date(Date.UTC(2026, 2, 1, 0, index + 1)).toISOString(),
    pnl,
    setup_type: index % 2 === 0 ? "trend" : "mean_reversion",
    trade_metadata: {
      regime: index % 2 === 0 ? "trend_long" : "range",
      features: {
        modelLongProbability: 0.71,
        modelEdge: 0.14,
      },
      execution: {
        mode,
        longModelId: "model-long",
      },
    },
  }));
}

function makeTca(count: number, mode: "paper" | "live", netEdge = 12, slippageBps = 2) {
  return Array.from({ length: count }, (_, index) => ({
    trade_id: `trade-${mode}-${index}`,
    estimated_fees_usd: 3,
    entry_slippage_bps: slippageBps,
    exit_slippage_bps: slippageBps,
    gross_edge_usd: netEdge + 3,
    net_edge_usd: netEdge,
    holding_minutes: 8,
    metadata: {},
  }));
}

describe("forward validation reporting", () => {
  it("passes a healthy live sample", () => {
    const merged = mergeTradesWithTca(
      makeTrades(12, "live", 12),
      makeTca(12, "live", 12, 1.5),
    );
    const report = computeForwardValidationReport(merged, "live");

    expect(report.tradeCount).toBe(12);
    expect(report.modelAssistedTradeCount).toBe(12);
    expect(report.gatePassed).toBe(true);
    expect(report.profitFactor).toBeGreaterThan(1);
  });

  it("fails when slippage is too high", () => {
    const merged = mergeTradesWithTca(
      makeTrades(12, "live", 3),
      makeTca(12, "live", 3, 18),
    );
    const report = computeForwardValidationReport(merged, "live");

    expect(report.gatePassed).toBe(false);
    expect(report.gateReason).toContain("slippage");
  });
});
