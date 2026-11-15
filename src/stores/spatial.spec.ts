import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSpatialStore } from "./spatial";

describe("非持久化声场状态", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("关闭并重新打开、重复读取 store 不重置姿态和混音", () => {
    const store = useSpatialStore();
    store.open = true;
    store.update({ yaw: 1.2, x: 2, solo: [3], focus: 0.5 });
    store.open = false;
    store.open = true;
    expect(useSpatialStore().controls).toMatchObject({ yaw: 1.2, x: 2, solo: [3], focus: 0.5 });
    expect(store.controls.gains![3]).toBe(1);
    expect(store.controls.gains![2]).toBe(0);
    expect(store.revision).toBe(1);
  });
  it("新 Pinia 会话不恢复上次的控制状态", () => {
    useSpatialStore().update({ yaw: 2 });
    setActivePinia(createPinia());
    expect(useSpatialStore().controls.yaw).toBe(0);
    expect(useSpatialStore().open).toBe(false);
  });
});
