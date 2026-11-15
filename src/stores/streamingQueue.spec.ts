import { createPinia, disposePinia, getActivePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackContext, Track } from "@shared/types/player";
import type { StreamingServerConfig, StreamingServerInput } from "@shared/types/streaming";

const state = vi.hoisted(() => ({
  media: {
    track: null as Track | null,
    context: undefined as PlaybackContext | undefined,
  },
  audio: null as Track | null,
  load: vi.fn(),
  stop: vi.fn(),
  updateServer: vi.fn(),
  removeServer: vi.fn(),
}));

vi.mock("localforage", () => ({
  default: { createInstance: () => ({ setItem: vi.fn(async () => undefined) }) },
}));
vi.mock("@/stores/media", () => ({
  useMediaStore: () => ({
    get track() {
      return state.media.track;
    },
    setTrack: (track: Track) => {
      state.media.track = track;
    },
    setPlaybackContext: (context?: PlaybackContext) => {
      state.media.context = context;
    },
    enrichTrack: vi.fn(),
  }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ preset: { skipKeywordsSongs: false } }),
}));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: vi.fn() }));
vi.mock("@/stores/library", () => ({ useLibraryStore: vi.fn() }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ record: vi.fn() }) }));
vi.mock("@/core/player/events", () => ({ handleEvent: vi.fn() }));
vi.mock("@/core/player/fm", () => ({}));
vi.mock("@/core/player/stats", () => ({ installPlayStats: vi.fn(), onTrackEnded: vi.fn() }));
vi.mock("@/services/playback", () => ({
  reset: vi.fn(),
  setCurrentTime: vi.fn(),
  setDuration: vi.fn(),
  setPlaying: vi.fn(),
  setSeeking: vi.fn(),
}));
vi.mock("@/services/lyric/loader", () => ({ beginLoad: vi.fn(), loadForTrack: vi.fn() }));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/services/abLoop", () => ({ reset: vi.fn() }));
vi.mock("@/services/autoClose", () => ({}));
vi.mock("@/services/cacheScheduler", () => ({ cancel: vi.fn(), schedule: vi.fn() }));
vi.mock("@/services/deviceVolume", () => ({ getDeviceVolume: vi.fn(), setDeviceVolume: vi.fn() }));
vi.mock("@/services/audioSource", () => ({
  resolveTrackSource: async (track: Track) => ({ source: track.id, fromCache: false }),
}));
vi.mock("@/services/nextTrackPreloader", () => ({
  consumePreloadedTrack: () => null,
  disposeNextTrackPreload: vi.fn(),
  invalidateNextTrackPreload: vi.fn(),
  installNextTrackPreloadWatchers: vi.fn(),
  beginPreparedTransition: vi.fn(),
  peekPreparedTrack: vi.fn(),
  finishPreparedTransition: vi.fn(),
  scheduleNextTrackPreload: vi.fn(),
}));
vi.mock("@/composables/useFavorite", () => ({ useFavorite: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/utils/errors", () => ({ handleError: vi.fn(), isSkippableError: () => false }));
vi.mock("@/utils/preset/skipKeywords", () => ({ shouldSkipKeywordTrack: () => false }));
vi.mock("@/i18n", () => ({ default: { global: { t: (value: string) => value } } }));

import * as queue from "./queue";
import { useStatusStore } from "./status";
import { useStreamingStore } from "./streaming";

const local = (id: string): Track => ({
  id,
  source: "local",
  title: id,
  artists: [],
  duration: 1_000,
});
const remote = (id: string, serverId = "server"): Track => ({
  ...local(id),
  source: "streaming",
  serverId,
  originalId: id,
});
const server: StreamingServerConfig = {
  id: "server",
  name: "服务器",
  type: "navidrome",
  url: "https://server",
  username: "user",
  hasPassword: true,
  mediaRevision: 1,
};
const input: StreamingServerInput = {
  name: server.name,
  type: server.type,
  url: server.url,
  username: server.username,
  password: "",
};
const start = (tracks: Track[], index: number): void => {
  queue.setQueue(tracks);
  const status = useStatusStore();
  status.playIndex = index;
  status.state = "playing";
  status.position = 500;
  state.media.track = tracks[index];
  state.audio = tracks[index];
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  queue.clearQueue();
  state.media.track = null;
  state.media.context = undefined;
  state.audio = null;
  state.stop.mockReset().mockImplementation(async () => {
    state.audio = null;
    return { success: true };
  });
  state.load.mockReset().mockImplementation(async (_source: string, options: { meta: Track }) => {
    state.audio = options.meta;
    return { success: true, data: { detail: {}, mediaInfo: { duration: 1_000 } } };
  });
  state.removeServer.mockReset().mockResolvedValue(undefined);
  state.updateServer.mockReset().mockResolvedValue(server);
  Object.assign(window, {
    api: {
      player: { load: state.load, stop: state.stop },
      streaming: { removeServer: state.removeServer, updateServer: state.updateServer },
    },
  });
  useStreamingStore().servers = [server, { ...server, id: "other" }];
});

afterEach(() => disposePinia(getActivePinia()!));

describe("服务器管理消费真实播放队列", () => {
  it.each([
    { name: "之前", tracks: [remote("a"), local("b"), local("c")], index: 1, expected: 0 },
    { name: "之后", tracks: [local("b"), remote("a"), local("c")], index: 0, expected: 0 },
  ])("删除当前歌$name的服务器曲目保持播放身份且不中断音频", async ({ tracks, index, expected }) => {
    start(tracks, index);
    const current = tracks[index];

    await useStreamingStore().removeServer("server");

    const status = useStatusStore();
    expect(queue.queue.value).toEqual([local("b"), local("c")]);
    expect(status.playIndex).toBe(expected);
    expect(status.currentTrack).toBe(current);
    expect(state.media.track).toBe(current);
    expect(state.audio).toBe(current);
    expect(status.state).toBe("playing");
    expect(status.position).toBe(500);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
  });

  it("先清除所有失效候选再切离当前歌，仅加载一次保留曲目及上下文", async () => {
    const keep = remote("keep", "other");
    start([remote("before"), remote("current"), remote("after"), keep], 1);
    const context: PlaybackContext = {
      provider: "qqmusic",
      originId: "list",
      originType: "playlist",
    };
    queue.queueEntries.value[3].context = context;

    await useStreamingStore().removeServer("server");

    expect(queue.queue.value).toEqual([keep]);
    expect(useStatusStore().playIndex).toBe(0);
    expect(useStatusStore().currentTrack).toBe(keep);
    expect(state.media.track).toBe(keep);
    expect(state.media.context).toEqual(context);
    expect(state.audio).toBe(keep);
    expect(state.load).toHaveBeenCalledOnce();
  });

  it("删除末位当前歌时回绕到第一首保留曲目", async () => {
    const first = local("first");
    start([first, local("second"), remote("last")], 2);

    await useStreamingStore().removeServer("server");

    expect(queue.queue.value).toEqual([first, local("second")]);
    expect(useStatusStore().playIndex).toBe(0);
    expect(useStatusStore().currentTrack).toBe(first);
    expect(state.audio).toBe(first);
  });

  it("相同裸 ID 不跨来源或服务器删除，并同步随机播放原顺序", async () => {
    const keepLocal = local("shared");
    const keepOther = remote("shared", "other");
    const removed = remote("shared");
    start([removed, keepOther, keepLocal], 1);
    queue.originalQueue.value = [{ track: keepLocal }, { track: keepOther }, { track: removed }];

    await useStreamingStore().removeServer("server");

    expect(queue.queue.value).toEqual([keepOther, keepLocal]);
    expect(useStatusStore().playIndex).toBe(0);
    expect(useStatusStore().currentTrack).toBe(keepOther);
    expect(state.audio).toBe(keepOther);
    expect(queue.originalQueue.value?.map(({ track }) => track)).toEqual([keepLocal, keepOther]);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it("真实洗牌后删除服务器，取消随机仍恢复保留项的原顺序与当前身份", async () => {
    const first = local("first");
    const current = local("current");
    start([first, remote("removed"), current, remote("removed-too")], 2);
    queue.shuffleQueue(2);
    useStatusStore().playIndex = 0;

    await useStreamingStore().removeServer("server");

    expect(queue.queue.value).toEqual([current, first]);
    expect(queue.originalQueue.value?.map(({ track }) => track)).toEqual([first, current]);
    expect(useStatusStore().currentTrack).toBe(current);
    useStatusStore().playIndex = queue.unshuffleQueue(current.id);
    expect(queue.queue.value).toEqual([first, current]);
    expect(useStatusStore().playIndex).toBe(1);
    expect(useStatusStore().currentTrack).toBe(current);
    expect(state.audio).toBe(current);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it("删除所有服务器曲目后队列与随机备份均为空且音频停止", async () => {
    const tracks = [remote("first"), remote("last")];
    start(tracks, 1);
    queue.originalQueue.value = tracks.map((track) => ({ track }));

    await useStreamingStore().removeServer("server");

    expect(queue.queue.value).toEqual([]);
    expect(queue.originalQueue.value).toEqual([]);
    expect(useStatusStore().playIndex).toBe(-1);
    expect(useStatusStore().currentTrack).toBeNull();
    expect(useStatusStore().state).toBe("stopped");
    expect(state.audio).toBeNull();
    expect(state.load).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://new-server" },
    { type: "subsonic" as const },
    { username: "new-user" },
    { password: "new-password" },
  ])("更新服务器身份后同样修正真实播放索引：%j", async (change) => {
    const current = local("keep");
    start([remote("old-account"), current], 1);
    state.updateServer.mockResolvedValue({ ...server, ...change, mediaRevision: 2 });

    await useStreamingStore().updateServer("server", { ...input, ...change });

    expect(queue.queue.value).toEqual([current]);
    expect(useStatusStore().playIndex).toBe(0);
    expect(useStatusStore().currentTrack).toBe(current);
    expect(state.audio).toBe(current);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it("只更新服务器名称不会清理现有曲目或重载当前音频", async () => {
    const current = remote("keep");
    start([current], 0);
    state.updateServer.mockResolvedValue({ ...server, name: "新名称" });

    await useStreamingStore().updateServer("server", { ...input, name: "新名称" });

    expect(queue.queue.value).toEqual([current]);
    expect(useStatusStore().currentTrack).toBe(current);
    expect(state.audio).toBe(current);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it.each(["remove", "update"] as const)(
    "%s 在替代歌曲实际完成加载前不报告完成",
    async (operation) => {
      const current = remote("old");
      const next = local("next");
      start([current, next], 0);
      const loading = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      state.load.mockImplementationOnce(async (_source: string, options: { meta: Track }) => {
        entered.resolve();
        await loading.promise;
        state.audio = options.meta;
        return { success: true, data: { detail: {}, mediaInfo: { duration: 1_000 } } };
      });
      state.updateServer.mockResolvedValue({
        ...server,
        url: "https://new-server",
        mediaRevision: 2,
      });
      const store = useStreamingStore();
      let completed = false;
      const change = (
        operation === "remove"
          ? store.removeServer("server")
          : store.updateServer("server", { ...input, url: "https://new-server" })
      ).then(() => {
        completed = true;
      });
      await entered.promise;

      expect(completed).toBe(false);
      expect(queue.queue.value).toEqual([next]);
      expect(useStatusStore().currentTrack).toBe(next);
      expect(state.audio).toBeNull();
      loading.resolve();
      await change;
      expect(completed).toBe(true);
      expect(state.audio).toBe(next);
    },
  );
});
