import type { LyricLine } from "../types";

// 行级文本也会生成带起止时间的 word，单凭时间无法区分两种来源。
const lineTimed = new WeakSet<LyricLine>();

/**
 * 标记由行级时间戳生成的歌词行
 * @param line - 待标记的歌词行
 * @returns 原歌词行对象
 */
export const markLineTimed = (line: LyricLine): LyricLine => {
  lineTimed.add(line);
  return line;
};

/**
 * 检查歌词行是否已标记为行级计时
 * @param line - 待检查的歌词行
 * @returns 是否已标记为行级计时
 */
export const isLineTimed = (line: LyricLine): boolean => lineTimed.has(line);
