import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import type * as LyricResolve from "./resolve";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
import { loadForTrack } from "./loader";

const resolve = vi.hoisted(() => ({
  local: vi.fn(),
  online: vi.fn(),
  ttml: vi.fn(),
  plugin: vi.fn(),
}));
vi.mock("./preload", () => ({
  consumePreloadedLyric: vi.fn(async () => ({ hit: false })),
}));
vi.mock("./resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof LyricResolve>()),
  resolveLocalRepoLyric: resolve.local,
  resolveOnlineByPreference: resolve.online,
  resolveTTMLOverlay: resolve.ttml,
  resolvePluginLyric: resolve.plugin,
}));

const mockWindowApi = {
  player: { readLyricFile: vi.fn().mockResolvedValue({ success: false, data: null }) },
  desktopLyric: { onConfigChange: vi.fn(() => () => {}) },
  taskbarLyric: { onConfigChange: vi.fn(() => () => {}) },
  dynamicIsland: { onConfigChange: vi.fn(() => () => {}) },
  window: {
    onDesktopLyricVisibilityChange: vi.fn(() => () => {}),
    onDynamicIslandVisibilityChange: vi.fn(() => () => {}),
    onTaskbarLyricVisibilityChange: vi.fn(() => () => {}),
    isDesktopLyricOpen: vi.fn().mockResolvedValue(false),
    isDynamicIslandOpen: vi.fn().mockResolvedValue(false),
    isTaskbarLyricOpen: vi.fn().mockResolvedValue(false),
  },
  nowPlaying: { update: vi.fn(), updatePlaybackState: vi.fn(), updateLyricLine: vi.fn() },
  plugins: { matchLyric: vi.fn() },
};

beforeEach(() => {
  setActivePinia(createPinia());
  resolve.local.mockReset().mockResolvedValue(null);
  resolve.online.mockReset().mockResolvedValue(null);
  resolve.ttml.mockReset().mockResolvedValue(null);
  resolve.plugin.mockReset().mockResolvedValue(null);
  // @ts-expect-error 仅提供歌词刷新流程使用的 preload 接口
  window.api = mockWindowApi;
});

describe("本地 TTML 匹配规则刷新", () => {
  it.each([true, false])(
    "切换严格匹配后未命中，不再保留旧专辑 TTML（在线回退：%s）",
    async (hasOnline) => {
      const settings = useSettingsStore();
      const media = useMediaStore();
      const track: Track = {
        id: "local-album",
        source: "local",
        title: "他还是不懂",
        artists: [{ name: "S.H.E" }],
        album: { name: "奇幻旅程" },
        duration: 254000,
      };
      media.track = track;
      resolve.local.mockResolvedValue({
        source: { source: "external", format: "ttml" },
        input: {
          content: `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:01.00" end="00:03.00">旧专辑歌词</p></div></body></tt>`,
        },
      });
      await loadForTrack(null);
      expect(media.parsedLyric[0].words[0].word).toBe("旧专辑歌词");

      resolve.local.mockResolvedValue(null);
      resolve.online.mockResolvedValue(
        hasOnline
          ? {
              source: { source: "online", format: "lrc", platform: "netease" },
              input: { content: "[00:01.00]在线回退歌词" },
            }
          : null,
      );
      settings.system.localLyric.matchLevel = "strict";

      await vi.waitFor(() => {
        if (hasOnline) {
          expect(media.activeLyric?.format).toBe("lrc");
          expect(media.parsedLyric[0].words[0].word).toBe("在线回退歌词");
        } else {
          expect(media.activeLyric).toBeNull();
          expect(media.parsedLyric).toEqual([]);
        }
      });
    },
  );
});
