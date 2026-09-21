import type { LyricLine } from "@shared/types/lyrics";

/**
 * 获取 XML 属性值，支持前缀命名空间（如 itunes:lyricOffset 或 lyricOffset）
 * @param el - DOM 元素
 * @param name - 属性本地名称
 * @returns 属性值或 null
 */
const getAttr = (el: Element, name: string): string | null => {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === name || attr.name.endsWith(`:${name}`)) {
      return attr.value;
    }
  }
  return null;
};

/**
 * 解析时间偏移秒数（支持纯浮点数、带 s / ms 后缀）
 * @param raw - 原始时间属性文本
 * @returns 秒数浮点值，无效时返回 NaN
 */
const parseOffsetSeconds = (raw: string): number => {
  const trimmed = raw.trim();
  if (trimmed.endsWith("ms")) {
    return parseFloat(trimmed.slice(0, -2)) / 1000;
  }
  if (trimmed.endsWith("s")) {
    return parseFloat(trimmed.slice(0, -1));
  }
  return parseFloat(trimmed);
};

/**
 * 收集 iTunes 杜比全景声（空间音频）歌词时间轴偏移元数据（毫秒）
 * 匹配 iTunesMetadata 内的 <audio lyricOffset="..." role="spatial"/>
 * @param doc - XML 文档
 * @returns 偏移毫秒数，未指定或无效时返回 0
 */
export const collectSpatialLyricOffset = (doc: Document): number => {
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (el.localName === "audio") {
      const role = (getAttr(el, "role") ?? "").trim().toLowerCase();
      if (role === "spatial" || role.includes("spatial")) {
        const offsetAttr = getAttr(el, "lyricOffset");
        if (offsetAttr) {
          const secs = parseOffsetSeconds(offsetAttr);
          if (!Number.isNaN(secs)) {
            return Math.round(secs * 1000);
          }
        }
      }
    }
  }
  return 0;
};

/**
 * 从 TTML 文本中提取杜比全景声（空间音频）歌词时间轴偏移毫秒数
 * @param text - TTML XML 文本
 * @returns 偏移毫秒数，未提取到或解析失败时返回 0
 */
export const extractTTMLSpatialOffset = (text: string): number => {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return 0;
    return collectSpatialLyricOffset(doc);
  } catch {
    return 0;
  }
};

/**
 * 对歌词行及行内逐字应用杜比全景声时间轴偏移
 * @param lines - 歌词行数组
 * @param offsetMs - 偏移毫秒数
 */
export const applySpatialLyricOffset = (lines: LyricLine[], offsetMs: number): void => {
  if (!offsetMs) return;
  for (const line of lines) {
    line.startTime = Math.max(0, line.startTime + offsetMs);
    line.endTime = Math.max(0, line.endTime + offsetMs);
    if (line.words) {
      for (const word of line.words) {
        word.startTime = Math.max(0, word.startTime + offsetMs);
        word.endTime = Math.max(0, word.endTime + offsetMs);
      }
    }
  }
};
