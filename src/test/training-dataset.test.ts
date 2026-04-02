import { describe, expect, it } from "vitest";
import { aggregateAggTradeCsvLines } from "../../scripts/quant/training-dataset";

describe("aggregateAggTradeCsvLines", () => {
  it("aggregates Binance aggTrades into minute-level trade-flow snapshots", () => {
    const snapshots = aggregateAggTradeCsvLines([
      "agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker",
      "1,100,2,1,1,1711699200000,false",
      "2,101,1,2,2,1711699210000,true",
      "3,102,1,3,3,1711699265000,false",
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      timestamp: 1711699200000,
      source: "binance-aggtrades",
    });
    expect(snapshots[0]?.microstructure?.takerImbalance).toBeGreaterThan(0);
    expect(snapshots[0]?.microstructure?.tradeCount1m).toBe(2);
    expect(snapshots[0]?.microstructure?.tradeNotionalUsd1m).toBe(301);
    expect(snapshots[0]?.microstructure?.aggressiveBuyNotionalUsd1m).toBe(200);
    expect(snapshots[0]?.microstructure?.aggressiveSellNotionalUsd1m).toBe(101);
    expect(snapshots[0]?.microstructure?.aggressiveFlowImbalance1m).toBeCloseTo(0.328904, 6);
    expect(snapshots[0]?.rawPayload?.tradeCount).toBe(2);
    expect(snapshots[1]?.timestamp).toBe(1711699260000);
  });

  it("supports headerless aggTrade rows", () => {
    const snapshots = aggregateAggTradeCsvLines([
      "1,100,1,1,1,1711699200000,false",
      "2,100,1,2,2,1711699205000,true",
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.microstructure?.takerImbalance).toBe(0);
    expect(snapshots[0]?.microstructure?.tradeCount1m).toBe(2);
    expect(snapshots[0]?.microstructure?.aggressiveFlowImbalance1m).toBe(0);
    expect(snapshots[0]?.rawPayload?.totalNotionalUsd).toBe(200);
  });
});
