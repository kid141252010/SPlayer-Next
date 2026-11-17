import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSystemConfig } from "@shared/defaults/settings";
import type { SystemConfig } from "@shared/types/settings";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  phase: "idle",
  data: {} as SystemConfig,
  set: vi.fn(),
  clear: vi.fn(),
  replaceAll: vi.fn(),
  sync: vi.fn(),
  syncJoc: vi.fn(),
  broadcast: vi.fn(),
  stopServer: vi.fn(),
  stopMcp: vi.fn(),
  clearAllData: vi.fn(),
  output: vi.fn(),
  native: {
    normalization: true,
    equalizer: true,
    bands: [8],
    preamp: 8,
    exclusive: true,
    proxy: "http",
    device: "old-device" as string | null,
    volume: 0.35,
    fade: 900,
  },
  mediaEnabled: false,
  discordEnabled: true,
  proxy: "http",
  environmentProxy: "http",
  desktopLocked: true,
  dynamicNonOcclusive: true,
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock("@main/store", () => ({
  store: {
    get: (key: string) =>
      key
        .split(".")
        .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], mocks.data),
    set: mocks.set,
    clear: mocks.clear,
    replaceAll: mocks.replaceAll,
    get store() {
      return mocks.data;
    },
  },
}));
vi.mock("@main/services/updater", () => ({
  getUpdateState: () => ({ phase: mocks.phase }),
  syncUpdateChannel: mocks.sync,
}));
vi.mock("@main/utils/logger", () => ({
  systemLog: {},
  playerLog: { info: vi.fn(), warn: vi.fn() },
  nativeLogsDir: "isolated-native-logs",
}));
vi.mock("@main/utils/powerBlocker", () => ({ refreshPowerBlocker: vi.fn() }));
vi.mock("@main/utils/config", () => ({
  isWin: true,
  isDev: false,
  getCoverCacheDir: () => "isolated-covers",
  getJocHrtfPath: () => "isolated.hrtf",
}));
vi.mock("@main/utils/broadcast", () => ({ broadcast: mocks.broadcast }));
vi.mock("@main/services/media", () => ({
  enable: () => {
    mocks.mediaEnabled = true;
  },
  disable: () => {
    mocks.mediaEnabled = false;
  },
  reloadDiscordConfig: () => {
    mocks.discordEnabled = mocks.data.media.discord.enabled;
  },
}));
vi.mock("@main/services/lastfm", () => ({ reloadConfig: vi.fn() }));
// 仅替代 NAPI 边界，IPC 到真实 engine.ts 的配置消费链不能被测试替身跳过。
vi.mock("@main/utils/nativeLoader", () => ({
  loadNativeModule: () => ({
    initLogger: vi.fn(),
    setHttpProxy: (value: string) => {
      mocks.native.proxy = value;
    },
    AudioPlayer: class {
      setCoverCacheDir = vi.fn();
      stop = vi.fn();
      setOutputDevice = mocks.output;
      setVolume(value: number) {
        mocks.native.volume = value;
      }
      setFadeDuration(value: number) {
        mocks.native.fade = value;
      }
      setJocMode(value: unknown) {
        mocks.syncJoc(value);
        return Promise.resolve();
      }
      setNormalizationEnabled(value: boolean) {
        mocks.native.normalization = value;
      }
      setEqualizerEnabled(value: boolean) {
        mocks.native.equalizer = value;
      }
      setEqualizerBands(value: number[]) {
        mocks.native.bands = value;
      }
      setPreampGain(value: number) {
        mocks.native.preamp = value;
      }
      setExclusiveMode(value: boolean) {
        mocks.native.exclusive = value;
        return Promise.resolve();
      }
    },
  }),
}));
vi.mock("@main/utils/proxy", () => ({
  getNetworkProxyUrl: () => mocks.data.system.networkProxy.protocol,
  applyGlobalFetchProxy: vi.fn(async () => {}),
  applySessionsProxy: async () => {
    mocks.proxy = mocks.data.system.networkProxy.protocol;
  },
  syncProxyEnv: () => {
    mocks.environmentProxy = mocks.data.system.networkProxy.protocol;
  },
}));
vi.mock("@main/window", () => ({
  setTaskbarProgress: vi.fn(),
  applyMainWindowZoom: vi.fn(),
  applyDesktopLyricLock: (value: boolean) => {
    mocks.desktopLocked = value;
  },
  applyDesktopLyricAlwaysOnTop: vi.fn(),
  applyDynamicIslandAlwaysOnTop: vi.fn(),
  applyDynamicIslandSnapCentered: vi.fn(),
  applyDynamicIslandNotchFusion: vi.fn(),
  applyDynamicIslandNonOcclusive: (value: boolean) => {
    mocks.dynamicNonOcclusive = value;
  },
  applyTaskbarLyricLayout: vi.fn(),
}));
vi.mock("@main/server", () => ({ startServer: vi.fn(), stopServer: mocks.stopServer }));
vi.mock("@main/services/mcp/http", () => ({
  startMcpServer: vi.fn(),
  stopMcpServer: mocks.stopMcp,
}));
vi.mock("@main/services/orpheus", () => ({ setOrpheusProtocolRegistered: vi.fn() }));
vi.mock("@main/services/thumbnail", () => ({ setTaskbarThumbnailEnabled: vi.fn() }));
vi.mock("@main/services/dataReset", () => ({ requestAllDataReset: mocks.clearAllData }));

import { registerConfigIpc } from "./config";
import { getPlayer, resetPlayer } from "@main/services/engine";

beforeEach(() => {
  mocks.phase = "idle";
  mocks.data = structuredClone(defaultSystemConfig);
  mocks.clear.mockImplementation(() => {
    mocks.data = structuredClone(defaultSystemConfig);
  });
  mocks.replaceAll.mockImplementation((data: SystemConfig) => {
    mocks.data = structuredClone(data);
  });
  mocks.stopServer.mockResolvedValue(undefined);
  mocks.stopMcp.mockResolvedValue(undefined);
  mocks.output.mockImplementation(async (device: string | undefined) => {
    mocks.native.device = device ?? null;
  });
  resetPlayer();
  getPlayer();
  mocks.syncJoc.mockClear();
  Object.assign(mocks.native, {
    normalization: true,
    equalizer: true,
    bands: [8],
    preamp: 8,
    exclusive: true,
    proxy: "http",
    device: "old-device",
    volume: 0.35,
    fade: 900,
  });
  mocks.mediaEnabled = false;
  mocks.discordEnabled = true;
  mocks.proxy = "http";
  mocks.environmentProxy = "http";
  mocks.desktopLocked = true;
  mocks.dynamicNonOcclusive = true;
  mocks.handlers.clear();
  registerConfigIpc();
});

describe("更新配置入口", () => {
  it.each([
    ["config:set", [null, "update.channel", "stable"], "set"],
    ["config:reset", [], "clear"],
    ["config:replaceAll", [null, structuredClone(defaultSystemConfig)], "replaceAll"],
  ] as const)("%s 写入后同步更新器，安装启动中拒绝改动", async (channel, args, method) => {
    const invoke = mocks.handlers.get(channel)!;
    await invoke(...args);
    expect(mocks[method]).toHaveBeenCalledOnce();
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks[method].mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0],
    );
    mocks.phase = "installing";
    expect(() => invoke(...args)).toThrow("安装启动中");
    expect(mocks[method]).toHaveBeenCalledOnce();
  });

  it("非法通道不能写入配置", () => {
    expect(() => mocks.handlers.get("config:set")!(null, "update.channel", "invalid")).toThrow(
      "无效的更新通道",
    );
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it.each([
    ["player.joc.mode", "binaural"],
    ["player.joc.hrtf", "H20"],
    ["player.joc.gainDb", -12],
    ["player.joc", { mode: "off", hrtf: "D2", gainDb: 0 }],
  ])("写入 %s 后同步对象渲染配置", async (key, value) => {
    await mocks.handlers.get("config:set")!(null, key, value);
    expect(mocks.set).toHaveBeenCalledWith(key, value);
    expect(mocks.syncJoc).toHaveBeenCalledOnce();
    expect(mocks.set.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncJoc.mock.invocationCallOrder[0],
    );
  });
});

describe("整盘配置实时同步", () => {
  it.each(["config:reset", "config:replaceAll"])(
    "%s 恢复已启用的 EQ、原生代理、媒体和窗口效果，不要求重启",
    async (channel) => {
      await mocks.handlers.get(channel)!(null, structuredClone(defaultSystemConfig));
      expect(mocks.native).toEqual({
        normalization: false,
        equalizer: false,
        bands: Array(10).fill(0),
        preamp: 0,
        exclusive: false,
        proxy: "off",
        device: null,
        volume: 1,
        fade: 200,
      });
      expect(mocks.mediaEnabled).toBe(true);
      expect(mocks.discordEnabled).toBe(false);
      expect(mocks.proxy).toBe("off");
      expect(mocks.environmentProxy).toBe("off");
      expect(mocks.desktopLocked).toBe(false);
      expect(mocks.dynamicNonOcclusive).toBe(false);
      expect(mocks.syncJoc).toHaveBeenCalledOnce();
      expect(mocks.broadcast.mock.calls).toEqual([
        ["desktopLyric:configChange", defaultSystemConfig.desktopLyric],
        ["dynamicIsland:configChange", defaultSystemConfig.dynamicIsland],
        ["taskbarLyric:configChange", defaultSystemConfig.taskbarLyric],
      ]);
      expect(mocks.stopServer).toHaveBeenCalledOnce();
      expect(mocks.stopMcp).toHaveBeenCalledOnce();
      expect(mocks.clearAllData).not.toHaveBeenCalled();
    },
  );

  it("等待外部服务关闭和 WebSocket 生命周期收尾后才完成重置", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stopServer.mockReturnValueOnce(stopped.promise);
    let finished = false;
    const resetting = (mocks.handlers.get("config:reset")!() as Promise<void>).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(mocks.stopServer).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(mocks.stopMcp).not.toHaveBeenCalled();
    stopped.resolve();
    await resetting;
    expect(finished).toBe(true);
    expect(mocks.stopMcp).toHaveBeenCalledOnce();
  });

  it("设备切换未完成时不提前返回，底层失败继续向调用方拒绝", async () => {
    const ready = Promise.withResolvers<void>();
    mocks.output.mockReturnValueOnce(ready.promise);
    let finished = false;
    const resetting = (mocks.handlers.get("config:reset")!() as Promise<void>).finally(() => {
      finished = true;
    });
    const rejected = expect(resetting).rejects.toThrow("device unavailable");
    await vi.waitFor(() => expect(mocks.output).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    ready.reject(new Error("device unavailable"));
    await rejected;
    expect(finished).toBe(true);
  });

  it("全部清理同样服从更新安装期保护", async () => {
    mocks.phase = "installing";
    expect(() => mocks.handlers.get("config:clearAllData")!()).toThrow("安装启动中");
    expect(mocks.clearAllData).not.toHaveBeenCalled();
    mocks.phase = "idle";
    await mocks.handlers.get("config:clearAllData")!();
    expect(mocks.clearAllData).toHaveBeenCalledOnce();
  });
});
