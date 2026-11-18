import type { LyricLine } from "../types";

export const LAST_LINE_FALLBACK_MS = 8000;

/**
 * 根据播放时间查找当前歌词行索引
 * @param lines - 已按 startTime 排序的歌词行数组
 * @param time - 当前播放时间（毫秒）
 * @param prevIndex - 上一次的索引，用于快速查找优化
 * @returns 匹配的行索引，无匹配返回 -1
 */
export const findLyricIndex = (lines: LyricLine[], time: number, prevIndex = -1): number => {
  if (lines.length === 0) return -1;

  // 快速路径：当前索引仍然有效
  if (prevIndex >= 0 && prevIndex < lines.length) {
    const current = lines[prevIndex];
    if (time >= current.startTime && time < current.endTime) return prevIndex;
    // 检查下一行（正常播放最常见的情况）
    const next = lines[prevIndex + 1];
    if (next && time >= next.startTime && time < next.endTime) return prevIndex + 1;
  }

  // 二分查找：找最后一个 startTime <= time 的行
  const result = pickLatestStartedIndex(lines, time);

  // 在该行时间范围内，或处于该行 endTime 与下一行 startTime 之间的间隙，都停留在该行
  if (result >= 0) {
    if (time < lines[result].endTime) return result;
    const next = lines[result + 1];
    if (!next || time < next.startTime) return result;
  }

  // 跳过背景歌词行，往前找最近的主歌词行
  for (let searchIndex = result; searchIndex >= 0; searchIndex--) {
    if (!lines[searchIndex].isBG) return searchIndex;
  }

  return -1;
};

/**
 * 查找当前时间下所有激活的歌词行索引
 * @param lines - 已按 startTime 排序的歌词行数组
 * @param time - 当前播放时间（毫秒）
 * @returns 所有当前处于激活时间范围内的行索引列表
 */
export const findActiveLyricIndices = (lines: LyricLine[], time: number): number[] => {
  const result: number[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (time >= line.startTime && time < line.endTime) result.push(lineIndex);
    else if (line.startTime > time) break;
  }
  return result;
};

/**
 * 为按 startTime 排序的歌词创建可重复查询的时间快照
 * 适用于每帧查询，构建 O(n)，查询先二分裁剪已结束/未开始的区间，再检查候选重叠行
 * 原数组或时间戳改变后须重新创建，不会缓存或修改调用方的对象
 * @param lines - 已按 startTime 排序的歌词行数组
 * @returns 根据播放毫秒数查询激活行索引的函数
 */
export const createActiveLyricFinder = (
  lines: readonly LyricLine[],
): ((time: number) => number[]) => {
  const starts = Float64Array.from(lines, (line) => line.startTime);
  const ends = Float64Array.from(lines, (line) => line.endTime);
  const maxEnds = new Float64Array(lines.length);
  let maxEnd = -Infinity;
  for (let index = 0; index < lines.length; index++) {
    if (ends[index] > maxEnd) maxEnd = ends[index];
    maxEnds[index] = maxEnd;
  }

  const upperBound = (values: Float64Array, time: number): number => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid] <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  return (time: number): number[] => {
    const result: number[] = [];
    if (Number.isNaN(time)) return result;
    const limit = upperBound(starts, time);
    for (let index = upperBound(maxEnds, time); index < limit; index++) {
      if (time < ends[index]) result.push(index);
    }
    return result;
  };
};

/**
 * 选出最新已开始的行索引
 * @param lines - 歌词行数组
 * @param time - 当前播放毫秒数
 * @returns 匹配的行索引，无匹配返回 -1
 */
export const pickLatestStartedIndex = (lines: LyricLine[], time: number): number => {
  if (lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let result = -1;
  while (low <= high) {
    const midIndex = (low + high) >>> 1;
    if (lines[midIndex].startTime <= time) {
      result = midIndex;
      low = midIndex + 1;
    } else {
      high = midIndex - 1;
    }
  }
  return result;
};

/**
 * 选出适合滚动的行索引（行结束前不切走，结束后立即切下一行）
 * @param lines - 歌词行数组
 * @param time - 当前播放毫秒数
 * @returns 匹配的行索引，无匹配返回 -1
 */
export const pickAdvanceOnEndIndex = (lines: LyricLine[], time: number): number => {
  const activeIndex = pickLatestStartedIndex(lines, time);
  if (activeIndex === -1) return -1;

  const current = lines[activeIndex];
  if (time >= current.endTime && activeIndex + 1 < lines.length) {
    return activeIndex + 1;
  }
  return activeIndex;
};

/**
 * 主歌词行索引选择（保留未唱完的重叠行、行结束提前滚动）
 * 适合桌面歌词等双行展示场景，主行之后的一行作为副行与其同时播放
 * @param lines - 歌词行数组
 * @param time - 当前播放毫秒数
 * @returns 匹配的行索引，首行开始前或无匹配返回 -1
 */
export const pickPrimaryIndex = (lines: LyricLine[], time: number): number => {
  const activeIndex = pickLatestStartedIndex(lines, time);
  if (activeIndex === -1) return -1;

  // 若当前命中行是背景人声，优先寻找同时间段的主歌词行
  if (lines[activeIndex].isBG) {
    for (let searchIndex = activeIndex - 1; searchIndex >= 0; searchIndex--) {
      if (
        !lines[searchIndex].isBG &&
        time >= lines[searchIndex].startTime &&
        time < lines[searchIndex].endTime
      ) {
        return searchIndex;
      }
    }
  }

  // 上一主歌词行未唱完时保留为主行，让重叠的新行同时显示
  let previousIndex = activeIndex - 1;
  while (previousIndex >= 0 && lines[previousIndex].isBG) previousIndex--;
  if (previousIndex >= 0 && time < lines[previousIndex].endTime) return previousIndex;

  // 跨行空隙期：当前行唱完（time >= current.endTime）且存在下一行时，推进展示下一行
  const current = lines[activeIndex];
  if (time >= current.endTime && activeIndex + 1 < lines.length) {
    return activeIndex + 1;
  }

  return activeIndex;
};

/**
 * 校验并限制最后一行歌词的结束时间
 * @param lines - 歌词行列表
 * @param trackDurationMs - 音轨总时长毫秒数
 * @returns 限制后的歌词行列表
 */
export const clampLastLineEnd = (lines: LyricLine[], trackDurationMs?: number): LyricLine[] => {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1];
  const reasonable =
    typeof trackDurationMs === "number" && trackDurationMs > last.startTime
      ? trackDurationMs
      : last.startTime + LAST_LINE_FALLBACK_MS;
  if (last.endTime <= reasonable) return lines;
  const clamped: LyricLine = {
    ...last,
    endTime: reasonable,
    words: last.words.map((word, wordIndex, wordArray) =>
      wordIndex === wordArray.length - 1 && word.endTime > reasonable
        ? { ...word, endTime: reasonable }
        : word,
    ),
  };
  return [...lines.slice(0, -1), clamped];
};
