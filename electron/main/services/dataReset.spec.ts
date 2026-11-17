// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  scanDirs: [] as string[],
  quit: vi.fn(),
  exit: vi.fn(),
  relaunch: vi.fn(),
  clear: vi.fn(),
  flush: vi.fn(),
  sessions: new Map<
    string,
    {
      values: Map<string, string>;
      clearStorageData: Mock<() => Promise<void>>;
      clearCache: Mock<() => Promise<void>>;
      clearAuthCache: Mock<() => Promise<void>>;
    }
  >(),
}));
vi.mock("electron", () => ({
  app: { quit: state.quit, exit: state.exit, relaunch: state.relaunch },
  session: {
    get defaultSession() {
      return state.sessions.get("default");
    },
    fromPartition: (name: string) => state.sessions.get(name),
  },
}));
vi.mock("@main/store", () => ({
  store: {
    clear: state.clear,
    flushImmediate: state.flush,
    get: () => state.scanDirs,
  },
}));
vi.mock("@main/utils/config", () => ({
  getAppCacheDir: () => path.join(state.root, "custom-cache"),
  getDownloadDir: () => path.join(state.root, "music", "downloads"),
}));
vi.mock("@main/utils/paths", () => ({
  get dataRoot() {
    return path.join(state.root, "application");
  },
  get configDir() {
    return path.join(state.root, "application", "config");
  },
  get databaseDir() {
    return path.join(state.root, "application", "database");
  },
  get defaultCacheDir() {
    return path.join(state.root, "application", "cache");
  },
  get pluginsDir() {
    return path.join(state.root, "application", "plugins");
  },
}));

beforeEach(async () => {
  vi.resetModules();
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "splayer-data-reset-"));
  state.scanDirs = [path.join(state.root, "music", "library")];
  // 服务持有模块级标记路径与请求单航班，必须在每个隔离目录就绪后重新加载模块。
  state.sessions.clear();
  for (const name of ["default", "persist:main", "persist:netease-login"]) {
    const values = new Map([
      ["cookie", "private-session"],
      ["localStorage", "old-settings"],
      ["IndexedDB:playlists", "saved-playlist"],
      ["IndexedDB:queue", "saved-queue"],
    ]);
    state.sessions.set(name, {
      values,
      clearStorageData: vi.fn(async () => values.clear()),
      clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
    });
  }
});
afterEach(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});

describe("受控冷进程清除全部应用数据", () => {
  it("无标记时不清除任何会话，也不请求重启", async () => {
    const reset = await import("./dataReset");
    expect(await reset.completePendingDataReset()).toBe(false);
    expect(state.sessions.get("persist:main")!.values.size).toBe(4);
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it("等待旧进程退出后清凭据、真实测试数据库和文件缓存，保留音乐、下载和插件脚本", async () => {
    const files = [
      "application/config/settings.json",
      "application/config/streaming.json",
      "application/config/lastfm.json",
      "application/config/ai-models.json",
      "application/cache/covers/cover.jpg",
      "application/plugins/data/plugin.json",
      "custom-cache/covers/cover.jpg",
      "custom-cache/songs/cache.bin",
      "custom-cache/motion-covers/cover.mp4",
      "music/library/song.flac",
      "music/downloads/finished.mp3",
      "custom-cache/unrelated.txt",
      "application/plugins/scripts/plugin.js",
      "application/models/model.onnx",
    ];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(state.root, file)), { recursive: true });
      await fs.writeFile(path.join(state.root, file), file);
    }
    const dbPath = path.join(state.root, "application/database/library.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (cookie TEXT); INSERT INTO sessions VALUES ('private')");
    expect(db.prepare("SELECT cookie FROM sessions").get()).toEqual({ cookie: "private" });
    db.close();

    const reset = await import("./dataReset");
    await Promise.all([reset.requestAllDataReset(), reset.requestAllDataReset()]);
    expect(state.quit).toHaveBeenCalledOnce();
    expect(state.relaunch).toHaveBeenCalledOnce();
    // 旧进程的请求只安排退出，不能在 live store 仍会写回时先删数据。
    expect(await fs.readFile(dbPath)).not.toHaveLength(0);
    expect(state.sessions.get("persist:main")!.values.size).toBe(4);
    // 模拟旧异步任务在退出前落盘，下一清理进程必须仍能清除。
    await fs.writeFile(path.join(state.root, "custom-cache/songs/late.bin"), "late-write");
    await fs.writeFile(path.join(state.root, "application/config/lastfm.json"), "late-session");
    const cacheDone = Promise.withResolvers<void>();
    state.sessions.get("persist:main")!.clearCache.mockReturnValueOnce(cacheDone.promise);
    const cleaning = reset.completePendingDataReset();
    await vi.waitFor(() =>
      expect(state.sessions.get("persist:main")!.clearCache).toHaveBeenCalledOnce(),
    );
    expect(state.exit).not.toHaveBeenCalled();
    expect(state.relaunch).toHaveBeenCalledOnce();
    cacheDone.resolve();
    expect(await cleaning).toBe(true);

    for (const file of [
      "application/config/lastfm.json",
      "application/config/streaming.json",
      "application/config/ai-models.json",
      "application/database/library.db",
      "custom-cache/songs/late.bin",
      "custom-cache/covers/cover.jpg",
      "application/cache/covers/cover.jpg",
      "application/plugins/data/plugin.json",
      "application/reset-pending.json",
    ]) {
      await expect(fs.stat(path.join(state.root, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const file of [
      "music/library/song.flac",
      "music/downloads/finished.mp3",
      "custom-cache/unrelated.txt",
      "application/plugins/scripts/plugin.js",
      "application/models/model.onnx",
    ]) {
      expect(await fs.readFile(path.join(state.root, file), "utf8")).toBe(file);
    }
    for (const current of state.sessions.values()) {
      expect(current.values.size).toBe(0);
      expect(current.clearAuthCache).toHaveBeenCalledOnce();
    }
    expect(state.clear).toHaveBeenCalledOnce();
    expect(state.flush).toHaveBeenCalledTimes(2);
    expect(state.exit).toHaveBeenCalledWith(0);
    expect(state.quit).toHaveBeenCalledOnce();
    expect(state.relaunch).toHaveBeenCalledTimes(2);
  });

  it("清理失败保留标记，不启动最终会话，重试成功才移除标记", async () => {
    const reset = await import("./dataReset");
    await reset.requestAllDataReset();
    state.sessions
      .get("persist:main")!
      .clearStorageData.mockRejectedValueOnce(new Error("disk busy"));
    await expect(reset.completePendingDataReset()).rejects.toThrow("disk busy");
    const marker = path.join(state.root, "application/reset-pending.json");
    expect(JSON.parse(await fs.readFile(marker, "utf8")).cacheRoot).toBe(
      path.join(state.root, "custom-cache"),
    );
    expect(state.exit).not.toHaveBeenCalled();
    expect(state.relaunch).toHaveBeenCalledOnce();
    expect(await reset.completePendingDataReset()).toBe(true);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("无效标记中止清理并保留标记，不触碰现存会话", async () => {
    const marker = path.join(state.root, "application/reset-pending.json");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ cacheRoot: "relative-path", protectedPaths: [] }));
    const reset = await import("./dataReset");
    await expect(reset.completePendingDataReset()).rejects.toThrow("无效的应用数据清理标记");
    expect(await fs.readFile(marker, "utf8")).toContain("relative-path");
    expect(state.sessions.get("persist:main")!.values.size).toBe(4);
    expect(state.exit).not.toHaveBeenCalled();
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it("最终重启失败时恢复清理标记，不能伪造清理事务成功", async () => {
    const reset = await import("./dataReset");
    await reset.requestAllDataReset();
    state.relaunch.mockImplementationOnce(() => {
      throw new Error("relaunch failed");
    });
    await expect(reset.completePendingDataReset()).rejects.toThrow("relaunch failed");
    const marker = path.join(state.root, "application/reset-pending.json");
    expect(JSON.parse(await fs.readFile(marker, "utf8")).cacheRoot).toBe(
      path.join(state.root, "custom-cache"),
    );
    expect(state.exit).not.toHaveBeenCalled();
  });

  it("缓存与用户音乐或下载目录重叠时拒绝破坏性清理", async () => {
    state.scanDirs = [path.join(state.root, "custom-cache", "songs")];
    const music = path.join(state.scanDirs[0]!, "song.flac");
    await fs.mkdir(path.dirname(music), { recursive: true });
    await fs.writeFile(music, "music");
    const reset = await import("./dataReset");
    await expect(reset.requestAllDataReset()).rejects.toThrow("无法安全清理");
    expect(await fs.readFile(music, "utf8")).toBe("music");
    expect(state.quit).not.toHaveBeenCalled();
    expect(state.relaunch).not.toHaveBeenCalled();
  });
});
