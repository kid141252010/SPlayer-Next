import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  warn: vi.fn(),
  config: { mode: "off", hrtf: "D2", gainDb: 0 },
}));
vi.mock("@main/utils/nativeLoader", () => ({
  loadNativeModule: () => ({
    initLogger: vi.fn(),
    setHttpProxy: vi.fn(),
    AudioPlayer: class {
      setJocMode = mocks.mode;
      setCoverCacheDir = vi.fn();
    },
  }),
}));
vi.mock("@main/utils/config", () => ({
  getCoverCacheDir: () => "covers",
  getJocHrtfPath: (hrtf: string) => `resources/joc/joc-hrtf-${hrtf}.jochrtf`,
  isDev: true,
}));
vi.mock("@main/store", () => ({ store: { get: () => mocks.config } }));
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
});
