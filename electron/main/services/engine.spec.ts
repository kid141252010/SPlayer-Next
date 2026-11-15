import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSystemConfig } from "@shared/defaults/settings";
import type { SystemConfig } from "@shared/types/settings";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  warn: vi.fn(),
  config: { mode: "off", hrtf: "D2", gainDb: 0 },
  playback: {} as SystemConfig["player"],
  output: vi.fn(),
  exclusive: vi.fn(),
  volume: vi.fn(),
  fade: vi.fn(),
}));
vi.mock("@main/utils/nativeLoader", () => ({
  loadNativeModule: () => ({
    initLogger: vi.fn(),
    setHttpProxy: vi.fn(),
    AudioPlayer: class {
      setJocMode = mocks.mode;
      setCoverCacheDir = vi.fn();
      setOutputDevice = mocks.output;
      setExclusiveMode = mocks.exclusive;
      setVolume = mocks.volume;
      setFadeDuration = mocks.fade;
    },
  }),
}));
vi.mock("@main/utils/config", () => ({
  getCoverCacheDir: () => "covers",
  getJocHrtfPath: (hrtf: string) => `resources/joc/joc-hrtf-${hrtf}.jochrtf`,
  isDev: true,
  isWin: true,
}));
vi.mock("@main/store", () => ({
  store: { get: (key: string) => (key === "player" ? mocks.playback : mocks.config) },
}));
vi.mock("@main/utils/proxy", () => ({ getNetworkProxyUrl: () => null }));
vi.mock("@main/utils/logger", () => ({
  playerLog: { info: vi.fn(), warn: mocks.warn },
  nativeLogsDir: "logs",
}));

// 重建模块级原生实例状态，覆盖初始化与配置更新边界。
describe("对象渲染配置同步", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.mode.mockReset().mockResolvedValue(undefined);
    mocks.config = { mode: "off", hrtf: "D2", gainDb: 0 };
    mocks.playback = structuredClone(defaultSystemConfig.player);
    mocks.output.mockReset().mockResolvedValue(undefined);
    mocks.exclusive.mockReset().mockResolvedValue(undefined);
  });
  it("尚未创建播放器时不创建实例，初始化及修改时应用配置", async () => {
    const { getPlayer, syncJocSettings } = await import("./engine");
    syncJocSettings();
    expect(mocks.mode).not.toHaveBeenCalled();
    getPlayer();
    expect(mocks.mode).toHaveBeenLastCalledWith({ mode: "off", gainDb: 0, hrtfPath: undefined });
    mocks.config = { mode: "binaural", hrtf: "D2", gainDb: -3 };
    syncJocSettings();
    expect(mocks.mode).toHaveBeenLastCalledWith({
      mode: "binaural",
      gainDb: -3,
      hrtfPath: "resources/joc/joc-hrtf-D2.jochrtf",
    });
    mocks.config = { mode: "speaker", hrtf: "H20", gainDb: 6 };
    syncJocSettings();
    expect(mocks.mode).toHaveBeenLastCalledWith({
      mode: "speaker",
      gainDb: 6,
      hrtfPath: undefined,
    });
  });
  it("记录原生设置失败而不产生未处理拒绝", async () => {
    mocks.mode.mockRejectedValueOnce(new Error("HRTF 无效"));
    const { getPlayer } = await import("./engine");
    getPlayer();
    await Promise.resolve();
    expect(mocks.warn).toHaveBeenCalledWith("应用 JOC 对象渲染配置失败:", expect.any(Error));
  });

  it("尚未创建实例时整盘同步不会加载或创建播放器", async () => {
    const { syncPlaybackSettings } = await import("./engine");
    await syncPlaybackSettings();
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(mocks.output).not.toHaveBeenCalled();
    expect(mocks.volume).not.toHaveBeenCalled();
  });

  it("等待独占模式和设备恢复，再应用默认音量与渐变", async () => {
    const { getPlayer, syncPlaybackSettings } = await import("./engine");
    getPlayer();
    const exclusiveReady = Promise.withResolvers<void>();
    const outputReady = Promise.withResolvers<void>();
    mocks.exclusive.mockReturnValueOnce(exclusiveReady.promise);
    mocks.output.mockReturnValueOnce(outputReady.promise);
    const syncing = syncPlaybackSettings();
    expect(mocks.exclusive).toHaveBeenCalledWith(false);
    expect(mocks.output).not.toHaveBeenCalled();
    exclusiveReady.resolve();
    await Promise.resolve();
    expect(mocks.output).toHaveBeenCalledWith(undefined);
    expect(mocks.volume).not.toHaveBeenCalled();
    outputReady.resolve();
    await syncing;
    expect(mocks.volume).toHaveBeenCalledWith(1);
    expect(mocks.fade).toHaveBeenCalledWith(200);

    mocks.playback.outputDevice = "chosen-device";
    mocks.playback.volume = 0.35;
    mocks.playback.fadeEnabled = false;
    mocks.playback.audioOutputMode = "exclusive";
    await syncPlaybackSettings();
    expect(mocks.output).toHaveBeenLastCalledWith("chosen-device");
    expect(mocks.exclusive).toHaveBeenLastCalledWith(true);
    expect(mocks.volume).toHaveBeenLastCalledWith(0.35);
    expect(mocks.fade).toHaveBeenLastCalledWith(0);
  });

  it.each(["output", "exclusive"] as const)(
    "%s 失败直接拒绝整盘同步，不假报成功",
    async (method) => {
      const { getPlayer, syncPlaybackSettings } = await import("./engine");
      getPlayer();
      mocks[method].mockRejectedValueOnce(new Error("device unavailable"));
      await expect(syncPlaybackSettings()).rejects.toThrow("device unavailable");
      expect(mocks.volume).not.toHaveBeenCalled();
      expect(mocks.fade).not.toHaveBeenCalled();
    },
  );
});
