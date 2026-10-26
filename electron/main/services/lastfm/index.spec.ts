import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LastfmCredentials } from "./credentials";
import type * as LastfmService from "./index";

const mocks = vi.hoisted(() => ({
  config: { enabled: true, nowPlaying: true, scrobble: true, loveSync: false },
  load: vi.fn(),
  updateNowPlaying: vi.fn(),
  scrobble: vi.fn(),
}));

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("@main/store", () => ({ store: { get: () => mocks.config } }));
vi.mock("@main/utils/logger", () => ({
  lastfmLog: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./credentials", () => ({ load: mocks.load, save: vi.fn(), clear: vi.fn() }));
vi.mock("./client", () => ({
  updateNowPlaying: mocks.updateNowPlaying,
  scrobble: mocks.scrobble,
}));

const savedSession: LastfmCredentials = { username: "listener", sessionKey: "session-key" };
const firstTrack = {
  title: "First track",
  artist: "First artist",
  album: "First album",
  durationMs: 100_000,
  autoPlay: true,
};

let service: typeof LastfmService;
let resolveCredentials: (value: LastfmCredentials | null) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  Object.assign(mocks.config, { enabled: true, nowPlaying: true, scrobble: true });
  mocks.load.mockReturnValue(
    new Promise<LastfmCredentials | null>((resolve) => {
      resolveCredentials = resolve;
    }),
  );
  mocks.updateNowPlaying.mockResolvedValue(undefined);
  mocks.scrobble.mockResolvedValue(undefined);
  // 冷启动边界：必须在 resetModules 后加载真实模块，清除上次的会话和 handlers。
  service = await import("./index");
});

afterEach(() => {
  service.onStopped();
  vi.useRealTimers();
});

const reachFirstThreshold = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(50_000);
  service.onPosition();
  service.onPosition();
  service.onState(false);
};

describe("Last.fm 凭证异步初始化期间的真实播放事件", () => {
  it.each([true, false])(
    "凭证就绪前的首曲恰好上报一次，后续曲正常（autoPlay=%s）",
    async (autoPlay) => {
      const initializing = service.init();
      service.onTrackLoaded({ ...firstTrack, autoPlay });
      service.onState(true);
      service.onState(true);
      await reachFirstThreshold();

      // 初始化仍未完成，但真实状态机已能累计播放并达到上报阈值。
      expect(service.getStatus().connected).toBe(false);
      expect(mocks.load).toHaveBeenCalledTimes(1);
      expect(mocks.updateNowPlaying).not.toHaveBeenCalled();
      expect(mocks.scrobble).not.toHaveBeenCalled();

      resolveCredentials(savedSession);
      await initializing;
      expect(mocks.updateNowPlaying).toHaveBeenCalledExactlyOnceWith(
        "session-key",
        "First track",
        "First artist",
        "First album",
        100,
      );
      expect(mocks.scrobble).toHaveBeenCalledExactlyOnceWith(
        "session-key",
        "First track",
        "First artist",
        1_700_000_000,
        "First album",
        100,
      );

      service.onState(true);
      service.onPosition();
      expect(mocks.updateNowPlaying).toHaveBeenCalledTimes(1);
      expect(mocks.scrobble).toHaveBeenCalledTimes(1);

      service.onTrackLoaded({ ...firstTrack, title: "Second track" });
      await reachFirstThreshold();
      expect(mocks.updateNowPlaying).toHaveBeenCalledTimes(2);
      expect(mocks.updateNowPlaying).toHaveBeenLastCalledWith(
        "session-key",
        "Second track",
        "First artist",
        "First album",
        100,
      );
      expect(mocks.scrobble).toHaveBeenCalledTimes(2);
      expect(mocks.scrobble).toHaveBeenLastCalledWith(
        "session-key",
        "Second track",
        "First artist",
        1_700_000_050,
        "First album",
        100,
      );
    },
  );

  it("未授权时不会发送初始化期间发生的报告", async () => {
    const initializing = service.init();
    service.onTrackLoaded(firstTrack);
    await reachFirstThreshold();

    resolveCredentials(null);
    await initializing;
    expect(service.getStatus().connected).toBe(false);
    expect(mocks.updateNowPlaying).not.toHaveBeenCalled();
    expect(mocks.scrobble).not.toHaveBeenCalled();
  });

  it.each([
    { setting: "enabled", nowPlayingCalls: 0, scrobbleCalls: 0 },
    { setting: "nowPlaying", nowPlayingCalls: 0, scrobbleCalls: 1 },
    { setting: "scrobble", nowPlayingCalls: 1, scrobbleCalls: 0 },
  ] as const)(
    "等待凭证期间关闭 $setting 后按实时配置决定是否发送",
    async ({ setting, nowPlayingCalls, scrobbleCalls }) => {
      const initializing = service.init();
      service.onTrackLoaded(firstTrack);
      await reachFirstThreshold();
      mocks.config[setting] = false;
      service.reloadConfig();

      resolveCredentials(savedSession);
      await initializing;
      expect(mocks.updateNowPlaying).toHaveBeenCalledTimes(nowPlayingCalls);
      expect(mocks.scrobble).toHaveBeenCalledTimes(scrobbleCalls);
    },
  );
});
