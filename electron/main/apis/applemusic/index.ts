/**
 * Apple Music 主进程服务
 * 统一入口：callAppleMusic(name, params)
 */

import { createHash } from "node:crypto";
import { modules, type AppleMusicModuleName } from "./modules";
import { coreLog } from "@main/utils/logger";

/** 2 分钟响应缓存 */
const DEFAULT_TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

const hashParams = (params: unknown): string =>
  createHash("md5")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 8);

const cacheGet = (key: string): unknown => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expireAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const cacheSet = (key: string, value: unknown, ttl: number = DEFAULT_TTL): void => {
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { value, expireAt: Date.now() + ttl });
};

/**
 * 调用 Apple Music 接口
 * @param name - 接口名称
 * @param params - 接口参数
 */
export const callAppleMusic = async <T = unknown>(
  name: string,
  params: Record<string, unknown> = {},
): Promise<T> => {
  const fn = modules[name as AppleMusicModuleName];
  if (!fn) {
    throw new Error(`[applemusic] unknown module: ${name}`);
  }

  const cacheKey = `${name}:${hashParams(params)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return cached as T;
  }

  try {
    const result = (await fn(params as never)) as T;
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    coreLog.warn(`[applemusic] call ${name} failed:`, err);
    throw err;
  }
};
