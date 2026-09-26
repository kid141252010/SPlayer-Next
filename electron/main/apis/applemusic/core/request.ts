/**
 * Apple Music API 请求封装
 */

import { net } from "electron";
import { coreLog } from "@main/utils/logger";
import { APPLE_MUSIC_API_BASE, APPLE_MUSIC_WEB_ORIGIN, getAMStorefront } from "./config";
import { getDeveloperToken, invalidateDeveloperToken } from "./token";

/** 单次请求硬超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 10_000;

export interface AMRequestOptions {
  /** 路径，以 /catalog 开头或相对路径 */
  path: string;
  /** 查询参数 */
  params?: Record<string, string | number | boolean | undefined>;
  /** 是否允许 401 重试（内部使用） */
  retryOnAuthFail?: boolean;
}

/**
 * 发起 Apple Music API 请求
 * @param options - 请求参数配置
 * @returns 响应 JSON 数据
 */
export const requestAppleMusic = async <T>(options: AMRequestOptions): Promise<T> => {
  const { path: reqPath, params = {}, retryOnAuthFail = true } = options;
  const token = await getDeveloperToken();

  // 构建完整 URL
  const normalizedPath = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const url = new URL(`${APPLE_MUSIC_API_BASE}${normalizedPath}`);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  try {
    const resp = await net.fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: APPLE_MUSIC_WEB_ORIGIN,
        Referer: `${APPLE_MUSIC_WEB_ORIGIN}/`,
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (resp.status === 401 && retryOnAuthFail) {
      coreLog.warn("[applemusic] 401 Unauthorized, refreshing developer token and retrying...");
      invalidateDeveloperToken();
      return requestAppleMusic<T>({ ...options, retryOnAuthFail: false });
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Apple Music API error: ${resp.status} ${resp.statusText} - ${errText}`);
    }

    return (await resp.json()) as T;
  } catch (err) {
    coreLog.warn(`[applemusic] request failed: ${url.pathname}`, err);
    throw err;
  }
};

/**
 * 发起基于当前 storefront 的 catalog API 请求
 * @param subPath - catalog 后的子路径，如 "/search" 或 "/songs/123"
 * @param params - 查询参数
 */
export const requestCatalog = async <T>(
  subPath: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const customStorefront = typeof params?.storefront === "string" ? params.storefront : undefined;
  const storefront = customStorefront || getAMStorefront();
  const restParams = params ? { ...params } : undefined;
  if (restParams && "storefront" in restParams) {
    delete restParams.storefront;
  }
  const normalizedSubPath = subPath.startsWith("/") ? subPath : `/${subPath}`;
  const reqPath = normalizedSubPath.startsWith("/catalog/")
    ? normalizedSubPath
    : `/catalog/${storefront}${normalizedSubPath}`;
  return requestAppleMusic<T>({
    path: reqPath,
    params: restParams,
  });
};
