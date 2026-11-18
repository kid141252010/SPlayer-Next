import { shouldExcludeAuthor } from "../clean/author";
import type { LyricLine, LyricMetadata } from "../types";

/** 匹配标准 LRC 元数据标签（如 [ti:xxx]、[ar:xxx]、[offset:xxx]） */
export const META_TAG_RE = /^\[([a-zA-Z]+):(.*?)]$/;

/**
 * 解析并应用标准元数据标签到 LyricMetadata 对象中
 * @param metadata - 目标元数据对象
 * @param key - 标签键名（不区分大小写，如 ti, ar, al, by, offset 等）
 * @param val - 标签值
 */
export const applyLrcMetaTag = (metadata: LyricMetadata, key: string, val: string): void => {
  const lowerKey = key.toLowerCase();
  const trimmedVal = val.trim();
  if (!trimmedVal) return;

  if (lowerKey === "ti") {
    metadata.title = [trimmedVal];
  } else if (lowerKey === "ar") {
    metadata.artist = [trimmedVal];
  } else if (lowerKey === "al") {
    metadata.album = [trimmedVal];
  } else if (lowerKey === "by") {
    if (!shouldExcludeAuthor(trimmedVal)) metadata.authors = [trimmedVal];
  } else if (lowerKey === "offset") {
    const off = parseInt(trimmedVal, 10);
    if (!Number.isNaN(off)) metadata.offset = off;
  } else {
    (metadata.rawProperties ??= {})[lowerKey] = [trimmedVal];
  }
};

/**
 * 将 offset 偏移量毫秒数应用到所有歌词行及词时间戳中
 *
 * 符号约定说明：
 * 此处采用时间戳数值直接累加规则：newTime = Math.max(0, originalTime + offset)。
 * - 当 offset > 0 时，歌词时间戳数值增加（即歌词整体延后展示）；
 * - 当 offset < 0 时，歌词时间戳数值减小（即歌词整体提前展示）。
 * 若业务或播放器场景遵循部分 LRC 编辑器「[offset:+500] 表示歌词提前」的逆向约定，在传入前应对 offset 取反（-offset）。
 *
 * @param lines - 歌词行数组
 * @param offset - 偏移毫秒数（直接累加至时间戳的数值）
 */
export const applyTimestampOffset = (lines: LyricLine[], offset: number): void => {
  if (!offset) return;
  for (const line of lines) {
    line.startTime = Math.max(0, line.startTime + offset);
    line.endTime = Math.max(0, line.endTime + offset);
    for (const word of line.words) {
      word.startTime = Math.max(0, word.startTime + offset);
      word.endTime = Math.max(0, word.endTime + offset);
      if (word.ruby) {
        for (const rubyItem of word.ruby) {
          rubyItem.startTime = Math.max(0, rubyItem.startTime + offset);
          rubyItem.endTime = Math.max(0, rubyItem.endTime + offset);
        }
      }
    }
  }
};
