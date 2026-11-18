import type { LyricWord } from "../types";

/**
 * 添加单词到歌词单词数组中（原生保留单词文本及首尾空格）
 * @param words - 目标单词数组
 * @param rawWord - 原始文本
 * @param startTime - 单词起始时间（毫秒）
 * @param endTime - 单词结束时间（毫秒）
 * @returns 是否成功添加了有效词
 */
export const pushCleanWord = (
  words: LyricWord[],
  rawWord: string,
  startTime: number,
  endTime: number,
): boolean => {
  if (!rawWord) return false;

  words.push({
    word: rawWord,
    startTime,
    endTime,
  });
  return true;
};
