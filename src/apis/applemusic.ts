/**
 * Apple Music API 渲染端
 *
 * 用 Proxy 代理所有接口到主进程：`applemusic.search(...)` 等于
 * `window.api.apis.call("applemusic", "search", ...)`。
 *
 * 调用约定：成功 → 返回 data；失败 → 抛 Error。
 */

import type { ApiCallResponse } from "@shared/types/apis";

/**
 * 调用 Apple Music API，返回业务数据
 * @param name 接口名（search / song / album / artist / playlist）
 * @param params 接口参数
 */
export const appleMusicCall = async <T = unknown>(
  name: string,
  params?: Record<string, unknown>,
): Promise<T> => {
  const res: ApiCallResponse = await window.api.apis.call("applemusic", name, params);
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
};

type AppleMusicProxy = Record<
  string,
  <T = unknown>(params?: Record<string, unknown>) => Promise<T>
>;

/** 任意方法调用：`applemusic.search(...)` / `applemusic.song(...)` 等 */
export const applemusic: AppleMusicProxy = new Proxy({} as AppleMusicProxy, {
  get:
    (_t, name: string) =>
    <T = unknown>(params?: Record<string, unknown>) =>
      appleMusicCall<T>(name, params),
});
