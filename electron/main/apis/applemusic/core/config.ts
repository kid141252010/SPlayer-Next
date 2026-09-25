/**
 * Apple Music API 核心配置
 */

import { store } from "@main/store";

export const APPLE_MUSIC_API_BASE = "https://api.music.apple.com/v1";
export const APPLE_MUSIC_WEB_ORIGIN = "https://music.apple.com";

/** 预设候选 storefront */
export const PRESET_STOREFRONTS = ["cn", "us", "tr", "jp", "kr"] as const;
export type PresetStorefront = (typeof PRESET_STOREFRONTS)[number];

/** 默认 storefront */
export const DEFAULT_STOREFRONT = "cn";

/**
 * 获取当前生效的 storefront（2位字母小写）
 * @returns 规范化的 storefront，若未配置或非法则返回 "cn"
 */
export const getAMStorefront = (): string => {
  try {
    const raw = store.get("system.amStorefront" as never) as string | undefined;
    if (typeof raw === "string") {
      const trimmed = raw.trim().toLowerCase();
      if (/^[a-z]{2}$/.test(trimmed)) {
        return trimmed;
      }
    }
  } catch {}
  return DEFAULT_STOREFRONT;
};
