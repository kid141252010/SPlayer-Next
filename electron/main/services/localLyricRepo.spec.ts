// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import { matchLocalTTML } from "./localLyricRepo";

const state = vi.hoisted(() => ({
  directory: "",
  level: "strict",
  cachedId: null as { platformId: string } | null,
}));
vi.mock("@main/store", () => ({
  store: {
    get: (key: string) => {
      if (key === "localLyric.repoDir") return state.directory;
      if (key === "localLyric.matchLevel") return state.level;
      return true;
    },
  },
}));
vi.mock("@main/utils/logger", () => ({ coreLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@main/database/lyricMatchCache", () => ({
  buildFingerprint: () => "track-fingerprint",
  getMatchedId: () => state.cachedId,
}));

const track: Track = {
  id: "551526530",
  source: "applemusic",
  title: "他还是不懂",
  artists: [{ name: "S.H.E" }],
  album: { name: "奇幻旅程" },
  duration: 254000,
  isrc: "TWD950406103",
};

const addLyric = async (
  filename: string,
  album: string | undefined,
  ids: Record<string, string> = {},
): Promise<string> => {
  const meta: Record<string, string> = {
    musicName: track.title,
    artists: "S.H.E",
    ...ids,
  };
  if (album !== undefined) meta.album = album;
  const tags = Object.entries(meta)
    .map(([key, value]) => `<amll:meta key="${key}" value="${value}"/>`)
    .join("");
  const content = `<tt><head><metadata>${tags}</metadata></head><body>${filename}</body></tt>`;
  await writeFile(join(state.directory, `${filename}.ttml`), content);
  return content;
};

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "splayer-lyric-match-"));
  state.level = "strict";
  state.cachedId = null;
});
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true });
});

describe("本地 TTML 严格匹配专辑版本", () => {
  it("相同 ISRC 的原专辑与精选集按当前专辑选择，不取扫描首项", async () => {
    await addLyric("a-forever", "Forever 新歌+精选", { isrc: track.isrc! });
    const expected = await addLyric("b-journey", "奇幻旅程", { isrc: track.isrc! });
    expect(await matchLocalTTML(track)).toBe(expected);
  });

  it("真实平台 ID 优先于其他发行版本共享的 ISRC", async () => {
    await addLyric("a-forever", "Forever 新歌+精选", { isrc: track.isrc! });
    const expected = await addLyric("b-journey", "奇幻旅程", { appleMusicId: track.id });
    expect(await matchLocalTTML({ ...track, album: undefined })).toBe(expected);
  });

  it("只有另一张专辑的同 ISRC 歌词时不覆盖当前歌曲", async () => {
    await addLyric("forever", "Forever 新歌+精选", { isrc: track.isrc! });
    expect(await matchLocalTTML(track)).toBeNull();
  });

  it("专辑名称仅互相包含时不能通过严格匹配", async () => {
    await addLyric("live", "奇幻旅程 Live");
    expect(await matchLocalTTML({ ...track, isrc: undefined })).toBeNull();
  });

  it("候选缺少有效专辑时不能按歌名冒充严格命中", async () => {
    await addLyric("unknown-album", undefined);
    expect(await matchLocalTTML({ ...track, isrc: undefined })).toBeNull();
  });

  it("当前歌曲缺少专辑且没有真实平台 ID 时不能确认发行版本", async () => {
    await addLyric("journey", "奇幻旅程", { isrc: track.isrc! });
    expect(await matchLocalTTML({ ...track, album: undefined })).toBeNull();
  });

  it("在线模糊搜索缓存不能绕过已经失败的严格专辑检查", async () => {
    await addLyric("forever", "Forever 新歌+精选", { ncmMusicId: "375347" });
    state.cachedId = { platformId: "375347" };
    expect(await matchLocalTTML({ ...track, isrc: undefined })).toBeNull();
  });

  it("同名多候选仍可按完整元信息命中，忽略空白与常用分隔符", async () => {
    await addLyric("a-forever", "Forever 新歌+精选");
    const expected = await addLyric("b-journey", "奇幻旅程");
    expect(
      await matchLocalTTML({
        ...track,
        isrc: undefined,
        album: { name: " 奇幻 旅程 " },
      }),
    ).toBe(expected);
  });

  it.each(["standard", "loose"])("%s 模式保留模糊平台 ID 缓存回查", async (level) => {
    state.level = level;
    const expected = await addLyric("cached", "精选集", { ncmMusicId: "375347" });
    state.cachedId = { platformId: "375347" };
    expect(await matchLocalTTML({ ...track, title: "不同语言标题", isrc: undefined })).toBe(
      expected,
    );
  });
});
