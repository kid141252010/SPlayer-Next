import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createSceneLoop } from "./loop";
import type { IpcResponse } from "@shared/types/player";

describe("可见性与非重叠场景轮询", () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let id: number;
  beforeEach(() => {
    callbacks = new Map();
    id = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.set(++id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((handle: number) => callbacks.delete(handle)),
    );
    vi.spyOn(performance, "now").mockReturnValue(0);
  });
  afterEach(() => vi.unstubAllGlobals());
  /** 触发当前待绘制帧并等待微任务 */
  async function frame(time: number): Promise<void> {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(time));
    await flushPromises();
  }
  /** 建立隔离的场景循环和原生接口桩 */
  function fixture() {
    const api = {
      getJocScene: vi
        .fn<() => Promise<IpcResponse<Float32Array | null>>>()
        .mockResolvedValue({ success: true, data: null }),
      setJocControls: vi.fn().mockResolvedValue({ success: true }),
    };
    const tick = vi.fn(),
      error = vi.fn();
    const state = { revision: 0, readable: true };
    const loop = createSceneLoop({
      api,
      tick,
      error,
      revision: () => state.revision,
      readable: () => state.readable,
      controls: () => ({ yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, focus: 0, height: 1 }),
    });
    return { api, tick, error, state, loop };
  }
  it("约 30 Hz 绘制，未改变控件不重复发送，隐藏后无 RAF 或 IPC", async () => {
    const f = fixture();
    f.loop.start();
    f.loop.start();
    await frame(0);
    await frame(16);
    await frame(34);
    expect(f.tick).toHaveBeenCalledTimes(2);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(2);
    expect(f.api.setJocControls).toHaveBeenCalledTimes(1);
    f.loop.stop();
    expect(callbacks.size).toBe(0);
    await frame(70);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(2);
    f.loop.start();
    await frame(100);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(3);
    f.loop.stop();
  });
  it("慢响应不叠加，隐藏前的返回不能更新恢复后的画面", async () => {
    const f = fixture();
    let resolve!: (value: IpcResponse<Float32Array | null>) => void;
    f.api.getJocScene.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    f.loop.start();
    await frame(0);
    await frame(40);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(1);
    f.loop.stop();
    f.loop.start();
    resolve({ success: true, data: new Float32Array(64) });
    await flushPromises();
    await frame(80);
    expect(f.tick.mock.lastCall![1]).toBeNull();
    f.loop.stop();
  });
  it("不可读时不轮询，空场景正常，错误停止重试直到重新打开", async () => {
    const f = fixture();
    f.state.readable = false;
    f.loop.start();
    await frame(0);
    expect(f.api.getJocScene).not.toHaveBeenCalled();
    f.state.readable = true;
    await frame(40);
    expect(f.error).not.toHaveBeenCalled();
    f.api.getJocScene.mockRejectedValueOnce(new Error("native"));
    await frame(80);
    await frame(120);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(2);
    expect(f.error).toHaveBeenCalledTimes(1);
    f.loop.stop();
    f.loop.start();
    await frame(160);
    expect(f.api.getJocScene).toHaveBeenCalledTimes(3);
    f.loop.stop();
  });
  it("非成功响应、损坏数组和控件错误均有错误出口，换曲可恢复", async () => {
    const f = fixture();
    f.api.getJocScene.mockResolvedValueOnce({ success: false, error: "native" });
    f.loop.start();
    await frame(0);
    expect(f.error).toHaveBeenCalledTimes(1);
    f.loop.reset();
    f.api.getJocScene.mockResolvedValueOnce({ success: true, data: new Float32Array(2) });
    await frame(40);
    expect(f.error).toHaveBeenCalledTimes(2);
    f.state.revision++;
    f.api.setJocControls.mockResolvedValueOnce({ success: false, error: "controls" });
    await frame(80);
    await frame(120);
    expect(f.error).toHaveBeenCalledTimes(3);
    f.loop.stop();
  });
});
