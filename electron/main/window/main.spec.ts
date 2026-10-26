import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { flushPromises } from "@vue/test-utils";

// 每个用例需要重新加载 main 的模块级窗口状态；静态导入无法隔离启动和重新启动边界。

const mocks = vi.hoisted(() => ({
  main: null as any,
  order: [] as string[],
  settings: {} as Record<string, unknown>,
  nativeState: undefined as
    | { bounds: { width: number; height: number; x: number; y: number }; maximized: boolean }
    | undefined,
  storeSet: vi.fn(),
  storeFlush: vi.fn(),
  createWindow: vi.fn(),
}));

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("./create", () => ({ createWindow: mocks.createWindow }));
vi.mock("@main/utils/logger", () => ({ coreLog: { error: vi.fn() } }));
vi.mock("@main/utils/powerBlocker", () => ({
  setMainWindowVisible: vi.fn(),
  setPlayerExpanded: vi.fn(),
}));
vi.mock("@main/services/thumbar", () => ({ initThumbar: vi.fn() }));
vi.mock("@main/services/thumbnail", () => ({ enableTaskbarThumbnail: vi.fn() }));
vi.mock("@main/services/tray", () => ({ initTray: vi.fn() }));
vi.mock("@main/store", () => ({
  store: {
    get: (key: string) => mocks.settings[key],
    set: mocks.storeSet,
    flushImmediate: mocks.storeFlush,
  },
}));
vi.mock("@main/utils/protocol", () => ({
  MAIN_PARTITION: "persist:main",
  handleCacheProtocolOnPartition: vi.fn(),
}));
vi.mock("@main/utils/lifecycle", () => ({ isAppQuitting: () => false }));
vi.mock("@main/utils/broadcast", () => ({ broadcast: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  mocks.order = [];
  mocks.settings = { "system.onboardingCompleted": true, "system.agreedAgreementVersion": 100 };
  mocks.nativeState = undefined;
  mocks.storeSet.mockReset();
  mocks.storeSet.mockImplementation((key: string, value: unknown) => {
    mocks.settings[key] = value;
  });
  mocks.storeFlush.mockReset();
  mocks.createWindow.mockReset();
  mocks.createWindow.mockImplementation((options) => {
    const persistence = !!options.name && !!options.windowStatePersistence;
    const bounds =
      persistence && mocks.nativeState
        ? { ...mocks.nativeState.bounds }
        : { width: options.width, height: options.height, x: options.x ?? 0, y: options.y ?? 0 };
    let maximized = persistence && mocks.nativeState ? mocks.nativeState.maximized : false;
    let visible = false;
    let destroyed = false;
    const win = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomFactor: () => 1,
      }),
      loadFile: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => destroyed,
      isMinimized: () => false,
      isVisible: () => visible,
      isMaximized: () => maximized,
      getNormalBounds: () => ({ ...bounds }),
      setBounds: (value: Partial<typeof bounds>) => Object.assign(bounds, value),
      show: vi.fn(() => {
        visible = true;
        mocks.order.push("main-show");
        win.emit("show");
      }),
      maximize: vi.fn(() => {
        maximized = true;
        win.emit("maximize");
      }),
      unmaximize: () => {
        maximized = false;
        win.emit("unmaximize");
      },
      destroy: () => {
        if (persistence) mocks.nativeState = { bounds: { ...bounds }, maximized };
        destroyed = true;
        visible = false;
        win.emit("closed");
      },
      focus: vi.fn(),
    });
    mocks.main = win;
    return win;
  });
});

describe("主窗口启动交接", () => {
  it("创建时设置缩放，导航重置后等首次绘制完成再校正", async () => {
    mocks.settings["system.uiZoom"] = 125;
    const service = await import("./main");
    service.createMainWindow();
    expect(mocks.main.loadFile).toHaveBeenCalledWith(expect.any(String), { hash: "/" });
    expect(mocks.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ webPreferences: expect.objectContaining({ zoomFactor: 1.25 }) }),
    );
    mocks.main.webContents.emit("did-finish-load");
    expect(mocks.main.webContents.setZoomFactor).not.toHaveBeenCalled();
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    expect(mocks.main.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it("加载层就绪通知先到时等待窗口首次绘制", async () => {
    const service = await import("./main");
    service.createMainWindow();
    const shown = service.showReadyMainWindow();
    await flushPromises();
    expect(mocks.main.show).not.toHaveBeenCalled();
    mocks.main.emit("ready-to-show");
    await shown;
    expect(mocks.order).toEqual(["main-show"]);
  });

  it("窗口首次绘制不会代替加载层的就绪通知", async () => {
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await flushPromises();
    service.focusMainWindow();
    expect(mocks.main.show).not.toHaveBeenCalled();
    await service.showReadyMainWindow();
    expect(mocks.order).toEqual(["main-show"]);
  });

  it("首次升级保留旧最大化及还原几何，显示成功后只消费主窗口记录", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    const lyric = { width: 800, height: 200, x: 40, y: 30, visible: true };
    mocks.settings["windowStates.main"] = legacy;
    mocks.settings["windowStates.desktopLyric"] = lyric;
    const service = await import("./main");
    service.createMainWindow();
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    const shown = service.showReadyMainWindow();
    await flushPromises();
    expect(mocks.main.isMaximized()).toBe(false);
    mocks.main.emit("ready-to-show");
    await shown;
    expect(mocks.main.isVisible()).toBe(true);
    expect(service.isMainWindowMaximized()).toBe(true);
    expect(mocks.main.getNormalBounds()).toEqual({ width: 1600, height: 900, x: 120, y: 80 });
    expect(mocks.settings["windowStates.main"]).toBeUndefined();
    expect(mocks.settings["windowStates.desktopLyric"]).toBe(lyric);
    expect(mocks.storeSet).toHaveBeenCalledOnce();
    expect(mocks.storeFlush).toHaveBeenCalledOnce();

    mocks.main.unmaximize();
    await service.showReadyMainWindow();
    service.focusMainWindow();
    expect(service.isMainWindowMaximized()).toBe(false);
    expect(mocks.storeSet).toHaveBeenCalledOnce();
  });

  it("迁移后重新启动采用原生普通窗口状态，不重放旧最大化或旧几何", async () => {
    mocks.settings["windowStates.main"] = {
      width: 1600,
      height: 900,
      x: 120,
      y: 80,
      maximized: true,
    };
    let service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    mocks.main.unmaximize();
    const nativeBounds = { width: 1100, height: 700, x: 200, y: 150 };
    mocks.main.setBounds(nativeBounds);
    mocks.main.destroy();

    // store 的 deepMerge 会为已消费的 main 补回默认值，不能使它覆盖原生状态。
    mocks.settings["windowStates.main"] = {
      width: 1280,
      height: 800,
      x: null,
      y: null,
      maximized: false,
    };
    vi.resetModules();
    service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    expect(mocks.main.isVisible()).toBe(true);
    expect(service.isMainWindowMaximized()).toBe(false);
    expect(mocks.main.getNormalBounds()).toEqual(nativeBounds);
  });

  it("旧普通窗口保持普通状态并在显示后消费旧记录", async () => {
    mocks.settings["windowStates.main"] = {
      width: 1400,
      height: 850,
      x: 90,
      y: 60,
      maximized: false,
    };
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    expect(service.isMainWindowMaximized()).toBe(false);
    expect(mocks.main.getNormalBounds()).toEqual({ width: 1400, height: 850, x: 90, y: 60 });
    expect(mocks.settings["windowStates.main"]).toBeUndefined();
  });

  it("关闭记忆时不应用旧记录或原生状态，也不消费其他窗口记录", async () => {
    mocks.settings["system.rememberWindowState"] = false;
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    mocks.nativeState = { bounds: { width: 1500, height: 950, x: 70, y: 50 }, maximized: true };
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    expect(mocks.main.isVisible()).toBe(true);
    expect(service.isMainWindowMaximized()).toBe(false);
    expect(mocks.main.getNormalBounds()).toEqual({ width: 1280, height: 800, x: 0, y: 0 });
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });

  it("异步最大化完成前不消费旧记录", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.maximize.mockImplementationOnce(() => {});
    mocks.main.emit("ready-to-show");
    await service.showReadyMainWindow();
    expect(mocks.main.isVisible()).toBe(true);
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    mocks.main.maximize();
    expect(service.isMainWindowMaximized()).toBe(true);
    expect(mocks.settings["windowStates.main"]).toBeUndefined();
    expect(mocks.storeSet).toHaveBeenCalledOnce();
  });

  it("show 未能显示时保留旧记录，重试显示后才消费", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.show.mockImplementationOnce(() => {});
    mocks.main.emit("ready-to-show");
    await expect(service.showReadyMainWindow()).rejects.toThrow("主窗口未显示");
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    expect(mocks.storeSet).not.toHaveBeenCalled();
    await service.showReadyMainWindow();
    expect(service.isMainWindowMaximized()).toBe(true);
    expect(mocks.settings["windowStates.main"]).toBeUndefined();
  });

  it("show 抛错后保留旧记录并允许再次交接", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.show.mockImplementationOnce(() => {
      throw new Error("show failed");
    });
    mocks.main.emit("ready-to-show");
    await expect(service.showReadyMainWindow()).rejects.toThrow("show failed");
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    expect(mocks.storeSet).not.toHaveBeenCalled();
    await service.showReadyMainWindow();
    expect(service.isMainWindowMaximized()).toBe(true);
    expect(mocks.settings["windowStates.main"]).toBeUndefined();
  });

  it("show 期间窗口销毁不会消费旧记录", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.show.mockImplementationOnce(() => mocks.main.destroy());
    mocks.main.emit("ready-to-show");
    await expect(service.showReadyMainWindow()).rejects.toThrow("主窗口已关闭");
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });

  it("重复就绪通知只交接一次，交接后允许托盘重新显示窗口", async () => {
    const service = await import("./main");
    service.createMainWindow();
    mocks.main.emit("ready-to-show");
    await Promise.all([service.showReadyMainWindow(), service.showReadyMainWindow()]);
    expect(mocks.order).toEqual(["main-show"]);
    service.focusMainWindow();
    expect(mocks.main.show).toHaveBeenCalledTimes(2);
    expect(mocks.main.focus).toHaveBeenCalledOnce();
  });

  it("等待首次绘制期间窗口销毁时不会显示窗口", async () => {
    const legacy = { width: 1600, height: 900, x: 120, y: 80, maximized: true };
    mocks.settings["windowStates.main"] = legacy;
    const service = await import("./main");
    service.createMainWindow();
    const shown = service.showReadyMainWindow();
    mocks.main.isDestroyed = () => true;
    mocks.main.emit("ready-to-show");
    await expect(shown).rejects.toThrow("主窗口已关闭");
    expect(mocks.main.show).not.toHaveBeenCalled();
    expect(mocks.settings["windowStates.main"]).toBe(legacy);
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });
});
