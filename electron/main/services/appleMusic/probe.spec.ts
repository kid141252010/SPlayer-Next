import { describe, expect, it } from "vitest";
import { shouldShortCircuitProbe } from "./probe";

describe("Apple Music 代理探针", () => {
  it("Track Key 未就绪时，不能把第一个分片后的正常请求短路为零填充", () => {
    expect(shouldShortCircuitProbe(1_001, 999, 9_000, 4_096, false)).toBe(false);
  });

  it("只对最后一个分片附近的小型尾部探针短路", () => {
    expect(shouldShortCircuitProbe(9_100, 999, 9_000, 4_096, false)).toBe(true);
    expect(shouldShortCircuitProbe(9_100, 999, 9_000, 65_537, false)).toBe(false);
  });
});
