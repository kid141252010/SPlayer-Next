/**
 * 计算单词的逐字扫动进度比例
 * @param word - 单词时间区间
 * @param lineStartTime - 所属行的起始时间（ms）
 * @param currentMs - 当前播放毫秒
 * @returns 扫动进度比例（0~1）
 */
export const getWordSweepProgress = (
  word: { startTime: number; endTime: number },
  lineStartTime: number,
  currentMs: number,
): number => {
  const wordDuration = Math.abs(word.endTime - word.startTime) || 1;
  const preRoll = Math.min(80, wordDuration * 0.3);
  const adjustedStart = Math.max(lineStartTime, word.startTime - preRoll);
  const adjustedDuration = Math.max(1, word.endTime - adjustedStart);
  return Math.max(0, Math.min(1, (currentMs - adjustedStart) / adjustedDuration));
};
