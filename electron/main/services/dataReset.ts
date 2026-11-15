import fs from "node:fs/promises";
import path from "node:path";
import { app, session } from "electron";
import { writeFile } from "atomically";
import { store } from "@main/store";
import { getAppCacheDir, getDownloadDir } from "@main/utils/config";
import { configDir, databaseDir, dataRoot, defaultCacheDir, pluginsDir } from "@main/utils/paths";

const markerPath = path.join(dataRoot, "reset-pending.json");
const cacheDirectories = ["covers", "artists", "backgrounds", "songs", "motion-covers"];
let pendingRequest: Promise<void> | undefined;

interface ResetMarker {
  cacheRoot: string;
  protectedPaths: string[];
}

const resolveDirectory = async (directory: string): Promise<string> => {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(directory);
    throw error;
  }
};

/** 缓存配置不能让清理操作跨入音乐库或下载成品所在的目录。 */
const getResetDirectories = async (marker: ResetMarker): Promise<string[]> => {
  const directories = [
    ...[...new Set([marker.cacheRoot, defaultCacheDir])].flatMap((root) =>
      cacheDirectories.map((directory) => path.join(root, directory)),
    ),
    path.join(defaultCacheDir, "automix"),
    configDir,
    databaseDir,
    path.join(pluginsDir, "data"),
  ];
  const protectedPaths = await Promise.all(marker.protectedPaths.map(resolveDirectory));
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  for (const directory of directories) {
    const resolved = await resolveDirectory(directory);
    for (const protectedPath of protectedPaths) {
      if (contains(resolved, protectedPath) || contains(protectedPath, resolved)) {
        throw new Error(`应用缓存与音乐库或下载目录重叠，无法安全清理：${directory}`);
      }
    }
  }
  return directories;
};

/**
 * 只安排退出，不在仍有登录、扫描、下载与 Pinia 写回任务的旧进程里删除数据。
 * relaunch 保证旧进程退出后才启动清理进程；应用退出资源由现有生命周期统一释放。
 */
export const requestAllDataReset = (): Promise<void> => {
  pendingRequest ??= (async () => {
    const marker: ResetMarker = {
      cacheRoot: path.resolve(getAppCacheDir()),
      protectedPaths: [getDownloadDir(), ...store.get("library.scanDirs")].map((directory) =>
        path.resolve(directory),
      ),
    };
    await getResetDirectories(marker);
    store.flushImmediate();
    await fs.mkdir(dataRoot, { recursive: true });
    await writeFile(markerPath, JSON.stringify(marker));
    app.relaunch();
    app.quit();
  })().catch((error) => {
    pendingRequest = undefined;
    throw error;
  });
  return pendingRequest;
};

/**
 * 必须在数据库、插件、窗口和后台业务启动前调用。
 * 返回 true 代表清理进程已安排退出，调用方不得继续初始化业务。
 * 任一步失败都保留标记并抛错，由启动边界明确报错、中止启动。
 */
export const completePendingDataReset = async (): Promise<boolean> => {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const marker = JSON.parse(raw) as ResetMarker;
  if (
    typeof marker.cacheRoot !== "string" ||
    !path.isAbsolute(marker.cacheRoot) ||
    !Array.isArray(marker.protectedPaths) ||
    marker.protectedPaths.some(
      (directory) => typeof directory !== "string" || !path.isAbsolute(directory),
    )
  ) {
    throw new Error("无效的应用数据清理标记");
  }

  // 仅删除应用定义的缓存子目录，不递归删除用户指定的缓存根或下载/音乐目录。
  for (const directory of await getResetDirectories(marker)) {
    await fs.rm(directory, { recursive: true, force: true });
  }

  // 无窗口、无 live store 的进程里清除全部 Web Storage、IndexedDB、Cookie 和网络缓存。
  const sessions = new Set([
    session.defaultSession,
    session.fromPartition("persist:main"),
    session.fromPartition("persist:netease-login"),
  ]);
  for (const current of sessions) {
    await current.clearStorageData();
    await current.clearCache();
    await current.clearAuthCache();
  }

  // 静态 import 的 store 可能已加载旧配置；取消其防抖写盘并立即写入默认值。
  store.clear();
  store.flushImmediate();
  await fs.rm(markerPath);
  // 不走 before-quit，避免这个进程里其他模块保留的旧内存再次落盘。
  // 最后再重启一次，全新进程才允许初始化业务和渲染窗口。
  try {
    app.relaunch();
    app.exit(0);
  } catch (error) {
    await writeFile(markerPath, raw);
    throw error;
  }
  return true;
};
