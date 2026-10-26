import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsPlayerEvent } from "@splayer/audio-engine";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  reset: [] as Array<() => void>,
  transition: vi.fn(),
  load: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  metadata: vi.fn(),
  prepareTransition: vi.fn(),
  cancel: vi.fn(),
  streamingPrepare: vi.fn(),
  streamingStart: vi.fn(),
  streamingStop: vi.fn(),
  mediaEvent: (_event: { type: string; positionMs?: number }) => {},
  scrobbleRestart: vi.fn(),
  lastfmRestart: vi.fn(),
  nativeEvent: (_event: JsPlayerEvent) => {},
  generation: 0,
  invalidate: vi.fn(),
  cachedFiles: new Set<string>(),
  broadcast: vi.fn(),
  recreatePlayer: () => {},
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, callback),
    on: vi.fn(),
  },
  powerMonitor: { on: vi.fn() },
  app: { on: vi.fn() },
}));
vi.mock("@main/services/engine", () => {
  let player = {
    transitionToPrepared: mocks.transition,
    load: mocks.load,
    stop: mocks.stop,
    seek: mocks.seek,
    getDuration: () => 10,
    getPosition: () => 5,
    getSpeed: () => 1,
    getVolume: () => 1,
    getCoverRaw: () => null,
    getStatus: () => ({ state: "playing" }),
    getSourceGeneration: () => mocks.generation,
    onEvent: (callback: typeof mocks.nativeEvent) => {
      mocks.nativeEvent = callback;
    },
  };
  const created: Array<(instance: typeof player) => void> = [];
  mocks.recreatePlayer = () => {
    player = { ...player };
    created.forEach((callback) => callback(player));
  };
  return {
    getPlayer: () => player,
    onPlayerCreated: (callback: (instance: typeof player) => void) => {
      created.push(callback);
      callback(player);
    },
    onPlayerReset: (callback: () => void) => mocks.reset.push(callback),
    resetPlayer: () => mocks.reset.forEach((callback) => callback()),
  };
});
vi.mock("@main/services/playerControl", () => ({
  playerControl: { syncQueueIndex: vi.fn() },
}));
vi.mock("@main/services/playerPreload", () => ({
  prepareNextTrack: vi.fn(),
  cancelPreparedTrack: mocks.cancel,
  takeTransitionReady: vi.fn(),
  setCurrentTransitionRange: vi.fn(),
  getTransitionEndMs: (end: number) => end,
}));
vi.mock("@main/utils/logger", () => ({
  playerLog: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("@main/services/media", () => ({
  setMetadata: mocks.metadata,
  setPlayState: vi.fn(),
  setTimeline: vi.fn(),
  onEvent: (callback: typeof mocks.mediaEvent) => {
    mocks.mediaEvent = callback;
  },
}));
vi.mock("@main/services/nowPlaying", () => ({ prepareTransition: mocks.prepareTransition }));
vi.mock("@main/services/device", () => ({
  cancelPendingReinit: vi.fn(),
  startDeviceMonitoring: vi.fn(),
  stopDeviceMonitoring: vi.fn(),
}));
vi.mock("@main/utils/broadcast", () => ({ sendToMain: mocks.broadcast }));
vi.mock("@main/server/broadcast", () => ({ wsBroadcast: vi.fn() }));
vi.mock("@main/utils/encoding", () => ({}));
vi.mock("@main/utils/protocol", () => ({ toCacheUrl: () => undefined }));
vi.mock("@main/utils/config", () => ({ appName: "SPlayer", getSongCacheDir: () => "cache" }));
vi.mock("@main/utils/fetchBytes", () => ({}));
vi.mock("@main/utils/powerBlocker", () => ({ updatePowerBlocker: vi.fn() }));
vi.mock("@main/services/lastfm", () => ({
  onTrackLoaded: vi.fn(),
  onStopped: vi.fn(),
  onRepeatOneRestart: mocks.lastfmRestart,
}));
vi.mock("@main/services/neteaseScrobble", () => ({
  onTrackLoaded: vi.fn(),
  onStopped: vi.fn(),
  onRepeatOneRestart: mocks.scrobbleRestart,
  onState: vi.fn(),
}));
vi.mock("@main/services/streaming/playback", () => ({
  prepareStreamingPlayback: mocks.streamingPrepare,
  startStreamingPlayback: mocks.streamingStart,
  stopStreamingPlayback: mocks.streamingStop,
  onStreamingSeek: vi.fn(),
}));
vi.mock("@main/services/streaming/adapters/resolve", () => ({
  invalidateStreamingSession: vi.fn(),
}));
vi.mock("@main/services/songCache", () => ({ invalidate: mocks.invalidate }));
vi.mock("@main/services/thumbar", () => ({ getThumbar: () => null }));
vi.mock("@main/services/tray", () => ({ setTraySongName: vi.fn(), setTrayPlayState: vi.fn() }));
vi.mock("@main/services/thumbnail", () => ({ setTaskbarThumbnailCover: vi.fn() }));
vi.mock("@main/window", () => ({ getMainWindow: () => null, setTaskbarProgress: vi.fn() }));
vi.mock("@main/store", () => ({ store: { get: () => false } }));

const meta = { title: "Next", duration: 10, artist: "", album: "" };
const options = { meta: { id: "next", title: "Next", source: "local", artists: [] } };

/**
 * 调用注册后的 IPC 处理器，验证原生响应提交顺序
 * @param name - IPC 通道
 * @param args - 通道参数
 * @returns 处理器返回值
 */
const invoke = (name: string, ...args: unknown[]) => mocks.handlers.get(name)!(null, ...args);

describe("交接响应的主进程竞态保护", () => {
  it("单曲重播先开启两种统计轮次，普通跳转不重置轮次", async () => {
    expect(await invoke("player:seek", 0, true)).toEqual({ success: true });
    expect(mocks.scrobbleRestart).toHaveBeenCalledOnce();
    expect(mocks.lastfmRestart).toHaveBeenCalledOnce();
    expect(mocks.scrobbleRestart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.seek.mock.invocationCallOrder[0]!,
    );
    expect(await invoke("player:seek", 1000)).toEqual({ success: true });
    expect(mocks.scrobbleRestart).toHaveBeenCalledOnce();
    expect(mocks.lastfmRestart).toHaveBeenCalledOnce();
  });
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.reset.length = 0;
    mocks.generation = 0;
    mocks.cachedFiles.clear();
    mocks.invalidate.mockReset().mockImplementation(async (source: string) => {
      mocks.cachedFiles.delete(source);
    });
    mocks.stop.mockImplementation(() => {
      mocks.generation++;
    });
    mocks.seek.mockImplementation(async () => {
      mocks.generation++;
    });
    mocks.load.mockImplementation(async () => {
      mocks.generation++;
      return meta;
    });
    mocks.streamingPrepare.mockReset().mockResolvedValue(undefined);
    mocks.streamingStop.mockResolvedValue(undefined);
    // 每例必须重建模块内播放代次，静态导入无法隔离这些生命周期状态。
    const { registerPlayerIpc } = await import("./player");
    registerPlayerIpc();
  });

  it.each(["停止", "跳转", "重置", "加载新曲", "系统停止", "系统跳转"])(
    "%s 后不提交迟到的交接元数据",
    async (action) => {
      let finish!: (value: unknown) => void;
      mocks.transition.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = invoke(
        "player:transitionPrepared",
        "slot",
        "next.wav",
        5000,
        "standard",
        options,
      );
      if (action === "系统停止") mocks.mediaEvent({ type: "Stop" });
      if (action === "系统跳转") mocks.mediaEvent({ type: "Seek", positionMs: 1000 });
      if (action === "停止") await invoke("player:stop");
      if (action === "跳转") await invoke("player:seek", 1000);
      if (action === "重置") mocks.reset.forEach((callback) => callback());
      if (action === "加载新曲") await invoke("player:load", "chosen.wav", {});
      mocks.metadata.mockClear();
      finish(meta);
      expect(await pending).toEqual({ success: false });
      expect(mocks.metadata).not.toHaveBeenCalled();
      expect(mocks.prepareTransition).not.toHaveBeenCalled();
    },
  );

  it("停止后忽略旧交接错误，避免渲染端误触发下一曲", async () => {
    let reject!: (error: Error) => void;
    mocks.transition.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = invoke(
      "player:transitionPrepared",
      "slot",
      "next.wav",
      5000,
      "standard",
      options,
    );
    await invoke("player:stop");
    reject(new Error("旧交接超时"));
    expect(await pending).toEqual({ success: false });
  });

  it("仍有效的交接正常更新媒体元数据", async () => {
    mocks.transition.mockResolvedValueOnce(meta);
    expect(
      await invoke("player:transitionPrepared", "slot", "next.wav", 5000, "standard", options),
    ).toMatchObject({ success: true, data: { playback: { state: "playing" } } });
    expect(mocks.metadata).toHaveBeenCalledOnce();
    expect(mocks.prepareTransition).toHaveBeenCalledOnce();
  });

  it("流媒体加载由主进程解析地址，解码成功后才绑定播放会话", async () => {
    mocks.streamingPrepare.mockResolvedValueOnce({
      url: "https://server/audio",
      sessionId: "new-play",
    });
    const track = {
      id: "server:song",
      originalId: "song",
      serverId: "server",
      source: "streaming",
      title: "歌曲",
      artists: [],
      duration: 10000,
    };
    expect(await invoke("player:load", "streaming://server/song", { meta: track })).toMatchObject({
      success: true,
    });
    expect(mocks.load).toHaveBeenCalledWith("https://server/audio", true, undefined);
    expect(mocks.streamingStart).toHaveBeenCalledWith(
      track,
      { url: "https://server/audio", sessionId: "new-play" },
      10000,
      true,
    );
  });

  it("停止时作废尚未完成的流媒体地址解析，不能产生迟到播放会话", async () => {
    let finish!: (value: unknown) => void;
    mocks.streamingPrepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const track = {
      id: "server:song",
      originalId: "song",
      serverId: "server",
      source: "streaming",
      title: "歌曲",
      artists: [],
      duration: 10000,
    };
    const pending = invoke("player:load", "streaming://server/song", { meta: track });
    await invoke("player:stop");
    finish({ url: "https://server/audio", sessionId: "old-play" });
    expect(await pending).toMatchObject({ success: false });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.streamingStart).not.toHaveBeenCalled();
  });

  it.each([
    ["[DecodeFailed] invalid audio data", "FILE_DECODE_ERROR"],
    ["[SourceNotFound] HTTP 404", "FILE_NOT_FOUND"],
    ["[NetworkUnreachable] connection refused", "NETWORK_ERROR"],
    ["[Device] output unavailable", "DEVICE_NOT_FOUND"],
    ["[Cancelled] superseded", "LOAD_SUPERSEDED"],
    ["unclassified remote error", "NETWORK_ERROR"],
  ])("远程音源保留原生错误分类 %s", async (message, error) => {
    mocks.load.mockRejectedValueOnce(new Error(message));
    expect(await invoke("player:load", "https://music/song.flac", {})).toEqual({
      success: false,
      error,
    });
  });

  it("异步失败先清掉对应缓存再通知续播，重复事件不会再次失效", async () => {
    const source = "cache/broken.bin";
    mocks.cachedFiles.add(source);
    await invoke("player:load", source);
    const event: JsPlayerEvent = {
      type: "sourceError",
      source,
      sourceGeneration: mocks.generation,
    };
    const { promise: invalidated, resolve: finish } = Promise.withResolvers<void>();
    mocks.invalidate.mockImplementationOnce(async (failed: string) => {
      await invalidated;
      mocks.cachedFiles.delete(failed);
    });
    mocks.broadcast.mockClear();
    mocks.nativeEvent(event);
    mocks.nativeEvent(event);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(source);
    expect(mocks.broadcast).not.toHaveBeenCalledWith("player:event", { type: "sourceError" });
    finish();
    await vi.waitFor(() =>
      expect(mocks.broadcast).toHaveBeenCalledWith("player:event", { type: "sourceError" }),
    );
    expect(mocks.cachedFiles.has(source)).toBe(false);
  });

  it.each(["加载新曲", "同源重新加载", "停止", "跳转", "重置"])(
    "%s 后迟到的旧失败不能清缓存或触发新曲续播",
    async (action) => {
      const old = "cache/old.bin";
      const fresh = "cache/fresh.bin";
      mocks.cachedFiles.add(old);
      mocks.cachedFiles.add(fresh);
      await invoke("player:load", old);
      const oldEvent: JsPlayerEvent = {
        type: "sourceError",
        source: old,
        sourceGeneration: mocks.generation,
      };
      if (action === "加载新曲") await invoke("player:load", fresh);
      if (action === "同源重新加载") await invoke("player:load", old);
      if (action === "停止") await invoke("player:stop");
      if (action === "跳转") await invoke("player:seek", 2000);
      if (action === "重置") mocks.reset.forEach((callback) => callback());
      mocks.broadcast.mockClear();
      mocks.nativeEvent(oldEvent);
      await Promise.resolve();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.cachedFiles.has(old)).toBe(true);
      expect(mocks.cachedFiles.has(fresh)).toBe(true);
      expect(mocks.broadcast).not.toHaveBeenCalledWith("player:event", { type: "sourceError" });
    },
  );

  it("失效等待期间切歌，不把旧失败通知应用到新曲", async () => {
    await invoke("player:load", "cache/old.bin");
    const generation = mocks.generation;
    const { promise: invalidated, resolve: finish } = Promise.withResolvers<void>();
    mocks.invalidate.mockImplementationOnce(() => invalidated);
    mocks.nativeEvent({
      type: "sourceError",
      source: "cache/old.bin",
      sourceGeneration: generation,
    });
    await invoke("player:load", "cache/new.bin");
    mocks.broadcast.mockClear();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.broadcast).not.toHaveBeenCalledWith("player:event", { type: "sourceError" });
  });

  it("被新加载取代的同步解码异常不删除同源新缓存", async () => {
    const { promise: failed, reject } = Promise.withResolvers<typeof meta>();
    mocks.load.mockImplementationOnce(() => failed);
    const stale = invoke("player:load", "cache/same.bin");
    await invoke("player:load", "cache/same.bin");
    reject(new Error("[DecodeFailed] old failure"));
    expect(await stale).toMatchObject({ success: false, error: "LOAD_SUPERSEDED" });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("旧实例回调即使来源和代次都碰巧一致，也不能失效新实例缓存", async () => {
    const source = "cache/same.bin";
    mocks.cachedFiles.add(source);
    await invoke("player:load", source);
    const oldCallback = mocks.nativeEvent;
    mocks.recreatePlayer();
    await invoke("player:load", source);
    mocks.broadcast.mockClear();
    oldCallback({ type: "sourceError", source, sourceGeneration: mocks.generation });
    await Promise.resolve();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.cachedFiles.has(source)).toBe(true);
    expect(mocks.broadcast).not.toHaveBeenCalledWith("player:event", { type: "sourceError" });
  });

  it("跳转后当前代次的新失败仍会移除该曲缓存", async () => {
    const source = "cache/seek-failed.bin";
    mocks.cachedFiles.add(source);
    await invoke("player:load", source);
    await invoke("player:seek", 2000);
    mocks.nativeEvent({ type: "sourceError", source, sourceGeneration: mocks.generation });
    await vi.waitFor(() => expect(mocks.cachedFiles.has(source)).toBe(false));
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(source);
  });

  it.each(["IPC", "SMTC"])("%s 跳转返回前的当前失败等待提交后仍能失效坏缓存", async (entry) => {
    const source = "cache/pending-seek.bin";
    mocks.cachedFiles.add(source);
    await invoke("player:load", source);
    const oldGeneration = mocks.generation;
    const { promise, resolve } = Promise.withResolvers<void>();
    mocks.seek.mockImplementationOnce(() => {
      mocks.generation++;
      return promise;
    });
    let pending: unknown;
    if (entry === "IPC") {
      pending = invoke("player:seek", 2000);
    } else {
      mocks.mediaEvent({ type: "Seek", positionMs: 2000 });
      pending = promise;
    }
    mocks.nativeEvent({ type: "sourceError", source, sourceGeneration: oldGeneration });
    mocks.nativeEvent({ type: "sourceError", source, sourceGeneration: mocks.generation });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    resolve();
    await pending;
    await vi.waitFor(() => expect(mocks.cachedFiles.has(source)).toBe(false));
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("当前加载的同步解码失败仍会移除对应坏缓存", async () => {
    const source = "cache/invalid.bin";
    mocks.cachedFiles.add(source);
    mocks.load.mockRejectedValueOnce(new Error("[DecodeFailed] invalid data"));
    expect(await invoke("player:load", source)).toMatchObject({
      success: false,
      error: "FILE_DECODE_ERROR",
    });
    expect(mocks.cachedFiles.has(source)).toBe(false);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(source);
  });
});
