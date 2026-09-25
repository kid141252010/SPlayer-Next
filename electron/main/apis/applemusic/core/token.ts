/**
 * Apple Music Web Developer Token 管理器
 * 无感自动从 Apple Music 网页端抓取并提取公用 Developer Token，
 * 并内置长期有效的 Token 种子进行兜底，无需用户手动输入任何密钥。
 */

import { net } from "electron";
import { coreLog } from "@main/utils/logger";
import { APPLE_MUSIC_WEB_ORIGIN } from "./config";

/** 内置保底 Token 种子（经官方前端提取并验证有效） */
const FALLBACK_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzg5Njg4NzA5LCJleHAiOjE3OTU3MzY3MDksInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.y0gd6YWyrUrZx-YZNZS0xVHkDHGr-kGZ9RrsWRfApGc2-_NNC968VsD36hRU33s5BBs4KdB7LIZTmYqPra097Q";

/** 缓存有效期：默认 24 小时 */
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedToken {
  token: string;
  fetchedAt: number;
}

let cached: CachedToken | null = null;
let inflightFetch: Promise<string> | null = null;

/**
 * 从 Apple Music 官网提取最新的前端 Developer Token
 */
const fetchWebDeveloperToken = async (): Promise<string> => {
  try {
    const htmlResp = await net.fetch(APPLE_MUSIC_WEB_ORIGIN, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!htmlResp.ok) {
      throw new Error(`Failed to load Apple Music web HTML: ${htmlResp.status}`);
    }
    const html = await htmlResp.text();

    // 匹配 index bundle js
    const scriptMatches = [...html.matchAll(/src="(\/assets\/index[^"]+\.js)"/g)].map((m) => m[1]);
    for (const scriptPath of scriptMatches) {
      const scriptUrl = `${APPLE_MUSIC_WEB_ORIGIN}${scriptPath}`;
      const jsResp = await net.fetch(scriptUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      if (!jsResp.ok) continue;
      const jsContent = await jsResp.text();

      // 提取符合 Apple Music JWT 格式的 Token（长字符串）
      const tokenMatches = [
        ...jsContent.matchAll(
          /["'](eyJ0eXAiOiJKV1Qi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']/g,
        ),
      ].map((m) => m[1]);

      if (tokenMatches.length > 0 && tokenMatches[0]) {
        coreLog.info("[applemusic] Successfully extracted Developer Token from web asset");
        return tokenMatches[0];
      }
    }
  } catch (err) {
    coreLog.warn("[applemusic] Failed to extract Developer Token from web:", err);
  }

  // 失败时回退到保底 Token
  return FALLBACK_TOKEN;
};

/**
 * 获取可用的 Apple Music Developer Token
 * @param forceRefresh - 是否强制重新抓取
 * @returns Developer Token 字符串
 */
export const getDeveloperToken = async (forceRefresh: boolean = false): Promise<string> => {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  if (inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = fetchWebDeveloperToken()
    .then((token) => {
      cached = { token, fetchedAt: Date.now() };
      return token;
    })
    .finally(() => {
      inflightFetch = null;
    });

  return inflightFetch;
};

/**
 * 作废当前 Token 缓存（通常在收到 401 响应时触发）
 */
export const invalidateDeveloperToken = (): void => {
  cached = null;
};
