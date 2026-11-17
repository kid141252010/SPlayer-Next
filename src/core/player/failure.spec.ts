import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerState, Track } from "@shared/types/player";
import { ErrorCode } from "@shared/types/errors";

const mocks = vi.hoisted(() => {
  const tracks: Track[] = ["first", "second", "third"].map((id) => ({
    id,
    title: id,
    source: "local",
    path: `C:/music/${id}.flac`,
    artists: [],
    duration: 10000,
  }));
  const queue = { value: tracks };
  const media = {
    track: null as Track | null,
    setTrack(track: Track) {
      this.track = track;
    },
    setPlaybackContext: vi.fn(),
    enrichTrack: vi.fn(),
    setLyric: vi.fn(),
    updateLyricIndex: vi.fn(),
  };
  const status = {
    jocActive: false,
    state: "playing" as PlayerState,
    playIndex: 0,
    fmMode: false,
    repeatMode: "list",
    shuffleMode: "off",
    trackLoading: false,
    transitioning: false,
    position: 0,
    duration: 10000,
    volume: 1,
    speed: 1,
    lyricOffsetMs: 0,
    abLoop: { enable: false },
    currentSource: null as string | null,
    get isPlaying() {
      return this.state === "playing";
    },
    get currentTrack() {
      return queue.value[this.playIndex] ?? null;
    },
  };
  return {
    tracks,
    queue,
    media,
    status,
    skipKeywordsSongs: false,
    skipTrackKeywords: [] as string[],
    resolve: vi.fn(),
    load: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    currentTime: 0,
    writeTags: vi.fn(),
    applyTrackUpdates: vi.fn(),
    stopAfterEnd: false,
    fmStart: vi.fn(),
    fmNext: vi.fn(),
    transition: vi.fn(),
    toast: vi.fn(),
    alert: vi.fn(),
  };
});

vi.mock("./fm", () => ({ start: mocks.fmStart, next: mocks.fmNext }));
vi.mock("./stats", () => ({ installPlayStats: vi.fn(), onTrackEnded: vi.fn() }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => mocks.status }));
vi.mock("@/stores/media", () => ({ useMediaStore: () => mocks.media }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    preset: {
      skipKeywordsSongs: mocks.skipKeywordsSongs,
      skipTrackKeywords: mocks.skipTrackKeywords,
    },
    player: { transitionMode: "crossfade", transitionPreference: "standard" },
  }),
}));
vi.mock("@/stores/streaming", () => ({ useStreamingStore: vi.fn() }));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: vi.fn() }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ record: vi.fn() }) }));
vi.mock("@/stores/library", () => ({
  useLibraryStore: () => ({ applyTrackUpdates: mocks.applyTrackUpdates }),
}));
vi.mock("@/stores/queue", () => ({
  queue: mocks.queue,
  queueLength: {
    get value() {
      return mocks.queue.value.length;
    },
  },
  updateQueueTracks: vi.fn(),
  setQueue: (tracks: readonly Track[]) => {
    mocks.queue.value = [...tracks];
  },
}));
vi.mock("@/services/audioSource", () => ({ resolveTrackSource: mocks.resolve }));
vi.mock("@/services/nextTrackPreloader", () => ({
  consumePreloadedTrack: () => null,
  peekPreparedTrack: () => null,
  invalidateNextTrackPreload: vi.fn(),
  scheduleNextTrackPreload: vi.fn(),
  beginPreparedTransition: () => ({
    preparedId: "next-slot",
    source: { source: mocks.tracks[1]!.path, provider: "local", fromCache: false },
  }),
  finishPreparedTransition: vi.fn(),
}));
vi.mock("@/services/playback", () => ({
  getCurrentTime: () => mocks.currentTime,
  setCurrentTime: vi.fn((position) => {
    mocks.currentTime = position;
    return position;
  }),
  setDuration: vi.fn(),
  setPlaying: vi.fn(),
  setSeeking: vi.fn(),
  setSpeed: vi.fn(),
  reset: vi.fn(() => {
    mocks.currentTime = 0;
  }),
}));
vi.mock("@/services/lyric/loader", () => ({ beginLoad: vi.fn(), loadForTrack: vi.fn() }));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/services/abLoop", () => ({ reset: vi.fn(), checkLoop: vi.fn() }));
vi.mock("@/services/autoClose", () => ({
  onTrackEnded: () => mocks.stopAfterEnd,
  shouldStopAfterCurrentTrack: () => false,
}));
vi.mock("@/services/cacheScheduler", () => ({ cancel: vi.fn(), schedule: vi.fn(), tick: vi.fn() }));
vi.mock("@/services/deviceVolume", () => ({ getDeviceVolume: vi.fn(), setDeviceVolume: vi.fn() }));
vi.mock("@/composables/useFavorite", () => ({ useFavorite: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ toast: { error: mocks.toast } }));
vi.mock("@/composables/useDialog", () => ({ dialog: { alert: mocks.alert } }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/i18n", () => ({
  default: { global: { t: (key: string) => key, te: () => true } },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.queue.value = [...mocks.tracks];
  mocks.stopAfterEnd = false;
  mocks.skipKeywordsSongs = false;
  mocks.skipTrackKeywords = [];
  mocks.currentTime = 0;
  mocks.media.track = null;
  Object.assign(mocks.status, {
    state: "playing",
    playIndex: 0,
    fmMode: false,
    repeatMode: "list",
    shuffleMode: "off",
    position: 0,
    trackLoading: false,
    currentSource: null,
    duration: 10000,
  });
  mocks.resolve.mockImplementation(async (track: Track) => ({
    source: track.path,
    provider: "local",
    fromCache: false,
  }));
  mocks.load.mockResolvedValue({
    success: true,
    data: { detail: {}, mediaInfo: { duration: 10000 } },
  });
  mocks.stop.mockResolvedValue({ success: true });
  mocks.seek.mockResolvedValue({ success: true });
  mocks.play.mockResolvedValue({ success: true });
  mocks.pause.mockResolvedValue({ success: true });
  mocks.alert.mockResolvedValue(undefined);
  mocks.writeTags.mockResolvedValue({ success: true, data: [] });
  Object.assign(window, {
    api: {
      player: {
        load: mocks.load,
        stop: mocks.stop,
        seek: mocks.seek,
        play: mocks.play,
        pause: mocks.pause,
        transitionPrepared: mocks.transition,
      },
      library: { writeTags: mocks.writeTags },
    },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/**
 * 模拟原生停止通知晚于 IPC 响应到达
 * @param state - 原生播放器状态
 */
const sendStatus = async (state: PlayerState): Promise<void> => {
  const { handleEvent } = await import("./events");
  await handleEvent({
    type: "status",
    data: { state, position: 0, duration: 0, volume: 1, speed: 1, isFinished: false },
  });
};

describe("单曲失败自动跳曲", () => {
  it("跟随 JOC 生效与关闭事件更新状态", async () => {
    const { handleEvent } = await import("./events");
    await handleEvent({ type: "jocStateChanged", data: { active: true } });
    expect(mocks.status.jocActive).toBe(true);
    await handleEvent({ type: "jocStateChanged", data: { active: false } });
    expect(mocks.status.jocActive).toBe(false);
  });
  it("自然单曲重播明确通知主进程开启新轮次，睡眠定时停止时不重播", async () => {
    mocks.media.track = mocks.tracks[0]!;
    mocks.status.repeatMode = "one";
    mocks.status.state = "stopped";
    /** 原生 seek 从曲尾重播时会先发送播放状态，再返回跳转结果 */
    mocks.seek.mockImplementation(async () => {
      mocks.status.state = "playing";
      return { success: true };
    });
    const { handleEvent } = await import("./events");
    await handleEvent({ type: "ended" });
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(0, true);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.stopAfterEnd = true;
    await handleEvent({ type: "ended" });
    expect(mocks.seek).toHaveBeenCalledOnce();
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it.each(["streaming://server/song", "C:/cache/song.flac"])(
    "流媒体单曲重播重新加载 %s，保留队列位置且不复用旧会话",
    async (source) => {
      const track: Track = {
        ...mocks.tracks[0]!,
        source: "streaming",
        serverId: "server",
        originalId: "song",
      };
      mocks.media.track = track;
      mocks.status.repeatMode = "one";
      mocks.status.state = "stopped";
      mocks.resolve.mockResolvedValue({ source, provider: "streaming", fromCache: false });
      const { handleEvent } = await import("./events");
      await handleEvent({ type: "ended" });
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        source,
        expect.objectContaining({ meta: track, autoPlay: false }),
      );
      expect(mocks.seek).not.toHaveBeenCalled();
      expect(mocks.play).toHaveBeenCalledOnce();
      expect(mocks.status.playIndex).toBe(0);
      expect(mocks.status.state).toBe("playing");
    },
  );

  it.each(["暂停", "停止", "切歌"])(
    "流媒体重播取址期间手动%s，迟到响应不恢复旧播放",
    async (action) => {
      mocks.media.track = {
        ...mocks.tracks[0]!,
        source: "streaming",
        serverId: "server",
        originalId: "song",
      };
      mocks.status.repeatMode = "one";
      mocks.status.state = "stopped";
      let finish!: (value: unknown) => void;
      mocks.resolve.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { handleEvent } = await import("./events");
      const player = await import("./index");
      const pending = handleEvent({ type: "ended" });
      if (action === "暂停") await player.pause();
      else if (action === "停止") await player.stop();
      else await player.nextTrack();
      mocks.load.mockClear();
      mocks.play.mockClear();
      finish({ source: "streaming://server/song", provider: "streaming", fromCache: false });
      await pending;
      expect(mocks.play).not.toHaveBeenCalled();
      expect(mocks.status.state).toBe(
        action === "暂停" ? "paused" : action === "停止" ? "stopped" : "playing",
      );
      expect(mocks.media.track?.id).toBe(action === "切歌" ? "second" : "first");
      if (action !== "暂停") expect(mocks.load).not.toHaveBeenCalled();
    },
  );

  it("流媒体重播加载失败不调用播放，重复结束通知不重复加载", async () => {
    mocks.media.track = {
      ...mocks.tracks[0]!,
      source: "streaming",
      serverId: "server",
      originalId: "song",
    };
    mocks.status.repeatMode = "one";
    let finish!: (value: unknown) => void;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { handleEvent } = await import("./events");
    const pending = handleEvent({ type: "ended" });
    await vi.advanceTimersByTimeAsync(0);
    await handleEvent({ type: "ended" });
    expect(mocks.load).toHaveBeenCalledOnce();
    finish({ success: false, error: ErrorCode.NETWORK_ERROR });
    await pending;
    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.status.state).toBe("idle");
  });
  it.each([ErrorCode.NETEASE_UNAVAILABLE, ErrorCode.NO_PLUGIN_AVAILABLE, ErrorCode.FILE_NOT_FOUND])(
    "%s 遇到迟到的停止通知仍自动播放下一首",
    async (error) => {
      mocks.resolve.mockImplementationOnce((_track, options) => {
        options.onError(error);
        return null;
      });
      const { nextTrack } = await import("./index");
      await nextTrack();
      await sendStatus("stopped");
      await sendStatus("idle");
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.media.track?.id).toBe("third");
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        mocks.tracks[2]!.path,
        expect.objectContaining({ autoPlay: true }),
      );
      expect(mocks.status.state).toBe("playing");
    },
  );

  it.each(["list", "one"])("%s 模式解码失败后跳过坏歌", async (repeatMode) => {
    mocks.status.repeatMode = repeatMode;
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack } = await import("./index");
    await nextTrack();
    await sendStatus("stopped");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.media.track?.id).toBe("third");
    expect(mocks.status.state).toBe("playing");
  });

  it("手动停止会取消待执行的自动跳曲", async () => {
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack, stop } = await import("./index");
    await nextTrack();
    await stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.status.state).toBe("stopped");
  });

  it("手动切歌后旧失败不再多跳一首", async () => {
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack } = await import("./index");
    await nextTrack();
    await nextTrack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.media.track?.id).toBe("third");
  });

  it("官方音源解码失败时先尝试插件，成功则继续当前歌曲", async () => {
    mocks.resolve.mockResolvedValueOnce({
      source: "https://official/song",
      provider: "official",
      fromCache: false,
    });
    mocks.resolve.mockResolvedValueOnce({
      source: "https://plugin/song",
      provider: "plugin",
      pluginId: "fallback",
      fromCache: false,
    });
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack } = await import("./index");
    await nextTrack();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.load).toHaveBeenLastCalledWith(
      "https://plugin/song",
      expect.objectContaining({ autoPlay: true }),
    );
    expect(mocks.media.track?.id).toBe("second");
    expect(mocks.status.state).toBe("playing");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("暂停态恢复失败后的自动跳曲保持暂停", async () => {
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack } = await import("./index");
    await nextTrack(false);
    await sendStatus("stopped");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.media.track?.id).toBe("third");
    expect(mocks.load).toHaveBeenLastCalledWith(
      mocks.tracks[2]!.path,
      expect.objectContaining({ autoPlay: false }),
    );
    expect(mocks.status.state).toBe("paused");
  });

  it.each(["idle", "stopped"] as const)("正常播放收到 %s 仍取消在途交叉过渡", async (state) => {
    let finish!: (result: unknown) => void;
    mocks.transition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { trySmartTransition } = await import("./index");
    const pending = trySmartTransition(8000);
    expect(mocks.transition).toHaveBeenCalledOnce();
    await sendStatus(state);
    finish({ success: true, data: { detail: {}, mediaInfo: { duration: 10000 } } });
    await pending;
    expect(mocks.status.state).toBe(state);
    expect(mocks.status.playIndex).toBe(0);
    expect(mocks.media.track).toBeNull();
  });

  it.each([ErrorCode.NETWORK_ERROR, ErrorCode.NETWORK_TIMEOUT, ErrorCode.DEVICE_NOT_FOUND])(
    "%s 不触发连续跳曲",
    async (error) => {
      mocks.load.mockResolvedValueOnce({ success: false, error });
      const { nextTrack } = await import("./index");
      await nextTrack();
      await sendStatus("stopped");
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.load).toHaveBeenCalledOnce();
      expect(mocks.media.track?.id).toBe("second");
    },
  );

  it("整队列失败后停止，避免无限回绕", async () => {
    mocks.load.mockResolvedValue({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { nextTrack } = await import("./index");
    await nextTrack();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.load).toHaveBeenCalledTimes(3);
    expect(mocks.status.state).toBe("stopped");
  });

  it.each([0, 1])("私人 FM 失败不受普通队列长度 %s 限制", async (length) => {
    mocks.queue.value = mocks.tracks.slice(0, length);
    mocks.fmStart.mockResolvedValue(mocks.tracks[0]);
    mocks.fmNext.mockResolvedValue(mocks.tracks[1]);
    mocks.load.mockResolvedValueOnce({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { playPersonalFm } = await import("./index");
    await playPersonalFm();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fmNext).toHaveBeenCalledOnce();
    expect(mocks.media.track?.id).toBe("second");
    expect(mocks.status.state).toBe("playing");
  });

  it("私人 FM 连续五首失败后停止", async () => {
    mocks.queue.value = [];
    mocks.fmStart.mockResolvedValue(mocks.tracks[0]);
    mocks.fmNext.mockResolvedValue(mocks.tracks[1]);
    mocks.load.mockResolvedValue({ success: false, error: ErrorCode.FILE_DECODE_ERROR });
    const { playPersonalFm } = await import("./index");
    await playPersonalFm();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.load).toHaveBeenCalledTimes(5);
    expect(mocks.toast).toHaveBeenLastCalledWith("errors.MAX_CONSECUTIVE_FAILURES");
    expect(mocks.status.state).toBe("stopped");
  });
});

describe("关键词过滤有界跳曲", () => {
  it.each([1, 3])("全部 %s 首歌曲被过滤时停止，不解析任何音源", async (length) => {
    mocks.skipKeywordsSongs = true;
    mocks.skipTrackKeywords = mocks.tracks.map((track) => track.title);
    const { playFrom } = await import("./index");

    await playFrom(mocks.tracks.slice(0, length), { startIndex: 0 });

    expect(mocks.status.state).toBe("stopped");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("errors.ALL_TRACKS_FILTERED");
  });

  it.each([true, false])("跳过过滤项后加载下一首可用歌曲，自动播放=%s", async (autoPlay) => {
    mocks.skipKeywordsSongs = true;
    mocks.skipTrackKeywords = ["second"];
    const { nextTrack } = await import("./index");

    await nextTrack(autoPlay);

    expect(mocks.media.track?.id).toBe("third");
    expect(mocks.status.playIndex).toBe(2);
    expect(mocks.status.state).toBe(autoPlay ? "playing" : "paused");
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      mocks.tracks[2]!.path,
      expect.objectContaining({ meta: mocks.tracks[2], autoPlay }),
    );
  });

  it("从队尾过滤项回绕到队首可用歌曲", async () => {
    mocks.skipKeywordsSongs = true;
    mocks.skipTrackKeywords = ["third"];
    const { playFrom } = await import("./index");

    await playFrom(mocks.tracks, { startIndex: 2 });

    expect(mocks.media.track?.id).toBe("first");
    expect(mocks.status.playIndex).toBe(0);
    expect(mocks.status.state).toBe("playing");
  });

  it("私人 FM 连续候选均被过滤时有界停止，不按普通队列长度递归", async () => {
    mocks.queue.value = [];
    mocks.skipKeywordsSongs = true;
    mocks.skipTrackKeywords = ["first", "second"];
    mocks.fmStart.mockResolvedValue(mocks.tracks[0]);
    mocks.fmNext.mockResolvedValue(mocks.tracks[1]);
    const { playPersonalFm } = await import("./index");

    await playPersonalFm();

    expect(mocks.status.state).toBe("stopped");
    expect(mocks.fmNext).toHaveBeenCalledTimes(4);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("errors.ALL_TRACKS_FILTERED");
  });

  it("等待下一首 FM 候选时手动停止，迟到的可用歌曲不恢复播放", async () => {
    mocks.skipKeywordsSongs = true;
    mocks.skipTrackKeywords = ["first"];
    mocks.fmStart.mockResolvedValue(mocks.tracks[0]);
    const { promise, resolve } = Promise.withResolvers<Track | null>();
    mocks.fmNext.mockReturnValueOnce(promise);
    const player = await import("./index");
    const loading = player.playPersonalFm();
    await vi.advanceTimersByTimeAsync(0);

    await player.stop();
    resolve(mocks.tracks[2]!);
    await loading;

    expect(mocks.status.state).toBe("stopped");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("Seek 取消后的进度收敛", () => {
  it("最新 Seek 被取消后恢复消费真实位置，不永久冻结在目标位置", async () => {
    mocks.seek.mockResolvedValueOnce({ success: false, error: ErrorCode.UNKNOWN });
    const player = await import("./index");
    await player.seek(10000);
    expect(player.isSeeking()).toBe(false);

    mocks.status.state = "paused";
    const { handleEvent } = await import("./events");
    await handleEvent({ type: "position", data: { position: 90000, duration: 120000 } });

    expect(mocks.status.position).toBe(90000);
  });

  it("旧 Seek 的取消响应不能解除较新 Seek 的位置保护", async () => {
    const first = Promise.withResolvers<unknown>();
    const latest = Promise.withResolvers<unknown>();
    mocks.seek.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const player = await import("./index");
    const earlierSeek = player.seek(90000);
    const latestSeek = player.seek(10000);

    first.resolve({ success: false, error: ErrorCode.UNKNOWN });
    await earlierSeek;
    expect(player.isSeeking()).toBe(true);
    expect(player.hasReachedSeekTarget(90000)).toBe(false);

    latest.resolve({ success: true });
    await latestSeek;
    expect(player.isSeeking()).toBe(true);
    expect(player.hasReachedSeekTarget(10000)).toBe(true);
    expect(player.isSeeking()).toBe(false);
  });

  it("IPC 拒绝时解除当前 Seek 冻结并向调用者保留原错误", async () => {
    mocks.seek.mockRejectedValueOnce(new Error("seek IPC unavailable"));
    const player = await import("./index");

    await expect(player.seek(10000)).rejects.toThrow("seek IPC unavailable");

    expect(player.isSeeking()).toBe(false);
    expect(player.hasReachedSeekTarget(90000)).toBe(true);
  });
});

describe("标签写入的播放操作归属", () => {
  it.each(["切歌", "停止", "暂停"])(
    "写入期间手动%s，成功和失败都不能抢回旧播放",
    async (action) => {
      const player = await import("./index");
      for (const success of [true, false]) {
        mocks.status.playIndex = 0;
        mocks.status.state = "playing";
        mocks.media.track = mocks.tracks[0]!;
        mocks.currentTime = 4200;
        const { promise, resolve } = Promise.withResolvers<unknown>();
        mocks.writeTags.mockReturnValueOnce(promise);
        const saving = player.saveTrackTags([{ path: mocks.tracks[0]!.path!, title: "edited" }]);
        await vi.advanceTimersByTimeAsync(0);

        if (action === "切歌") await player.nextTrack();
        else if (action === "停止") await player.stop();
        else await player.pause();
        mocks.load.mockClear();
        mocks.seek.mockClear();
        mocks.play.mockClear();
        resolve(
          success
            ? {
                success: true,
                data: [{ path: mocks.tracks[0]!.path, success: true, track: mocks.tracks[0] }],
              }
            : { success: false, error: ErrorCode.TAG_WRITE_FAILED },
        );
        await saving;

        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.seek).not.toHaveBeenCalled();
        expect(mocks.play).not.toHaveBeenCalled();
        expect(mocks.media.track?.id).toBe(action === "切歌" ? "second" : "first");
        expect(mocks.status.playIndex).toBe(action === "切歌" ? 1 : 0);
        expect(mocks.status.state).toBe(
          action === "切歌" ? "playing" : action === "停止" ? "stopped" : "paused",
        );
      }
    },
  );

  it.each([true, false])("没有新操作时按原进度和播放状态恢复，原播放=%s", async (wasPlaying) => {
    mocks.media.track = mocks.tracks[0]!;
    mocks.status.state = wasPlaying ? "playing" : "paused";
    mocks.currentTime = 4200;
    const updated = { ...mocks.tracks[0]!, title: "edited" };
    mocks.writeTags.mockResolvedValueOnce({
      success: true,
      data: [{ path: updated.path, success: true, track: updated }],
    });
    const player = await import("./index");

    await player.saveTrackTags([{ path: updated.path!, title: updated.title }]);

    expect(mocks.media.track?.title).toBe("edited");
    expect(mocks.status.position).toBe(4200);
    expect(mocks.status.state).toBe(wasPlaying ? "playing" : "paused");
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(4200);
    expect(mocks.play).toHaveBeenCalledTimes(wasPlaying ? 1 : 0);
  });

  it.each(["切歌", "停止", "暂停"])(
    "标签恢复 Seek 期间手动%s，不再自动恢复旧播放",
    async (action) => {
      mocks.media.track = mocks.tracks[0]!;
      mocks.currentTime = 4200;
      const { promise, resolve } = Promise.withResolvers<unknown>();
      mocks.seek.mockReturnValueOnce(promise);
      const player = await import("./index");
      const saving = player.saveTrackTags([{ path: mocks.tracks[0]!.path!, title: "edited" }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(4200);

      if (action === "切歌") await player.nextTrack();
      else if (action === "停止") await player.stop();
      else await player.pause();
      mocks.play.mockClear();
      resolve({ success: true });
      await saving;

      expect(mocks.play).not.toHaveBeenCalled();
      expect(mocks.media.track?.id).toBe(action === "切歌" ? "second" : "first");
      expect(mocks.status.state).toBe(
        action === "切歌" ? "playing" : action === "停止" ? "stopped" : "paused",
      );
      expect(mocks.status.position).toBe(action === "暂停" ? 4200 : 0);
    },
  );
});
