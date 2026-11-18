import type { LyricWord } from "../types";

/** 词边界判定与快速匹配容差（毫秒） */
const BOUNDARY_TOLERANCE_MS = 5;

/**
 * 将逐字罗马音/拼音音节高效对齐并挂载至主歌词单词列表（原地修改）
 *
 * 算法特性：
 * 1. 采用双指针单向滑动扫描，时间复杂度为严格的 O(M + N)；
 * 2. 具备提前剪枝与快速通道；
 * 3. 完美支持单汉字对应多音节场景（例如日文“界”对齐合并 "ka" + "i" 为 "kai"）；
 * 4. 当罗马音仅为整行单一文本而主词已细分时自动安全跳过，避免将整句错误挂载至首词。
 *
 * @param mainWords - 主歌词单词数组
 * @param romanWords - 逐字罗马音音节数组
 * @returns 无返回值（原地修改 mainWords 中每个单词的 romanWord 属性）
 */
export const alignRomanization = (mainWords: LyricWord[], romanWords: LyricWord[]): void => {
  if (mainWords.length === 0 || romanWords.length === 0) return;
  if (mainWords.length > 1 && romanWords.length === 1) return;

  let romanSearchStartIndex = 0;

  for (let mainIndex = 0; mainIndex < mainWords.length; mainIndex++) {
    const main = mainWords[mainIndex];
    const mainStartTime = main.startTime;
    const mainEndTime = main.endTime;
    const syllables: string[] = [];

    let romanIndex = romanSearchStartIndex;
    let bestFallbackIndex = -1;
    let maxOverlapDuration = 0;

    while (romanIndex < romanWords.length) {
      const sub = romanWords[romanIndex];

      // 若当前罗马音音节在主词之前完全结束，推进起始搜索指针
      if (sub.endTime <= mainStartTime - BOUNDARY_TOLERANCE_MS) {
        romanSearchStartIndex = romanIndex + 1;
        romanIndex++;
        continue;
      }

      // 若已收集到属于当前词的音节，且后续音节开始时间已临近或超出主词结束时间，立即终止当前词搜索
      if (syllables.length > 0 && sub.startTime >= mainEndTime - BOUNDARY_TOLERANCE_MS) {
        break;
      }

      // 若当前音节开始时间已达到主词结束时间，终止当前词搜索
      if (sub.startTime >= mainEndTime) {
        break;
      }

      const overlapStart = Math.max(mainStartTime, sub.startTime);
      const overlapEnd = Math.min(mainEndTime, sub.endTime);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const subDuration = Math.max(1, sub.endTime - sub.startTime);

      if (overlap > maxOverlapDuration) {
        maxOverlapDuration = overlap;
        bestFallbackIndex = romanIndex;
      }

      // 若该音节大部分落在主词区间，或时间戳与主词起止高度吻合
      if (
        overlap / subDuration >= 0.4 ||
        Math.abs(sub.startTime - mainStartTime) <= BOUNDARY_TOLERANCE_MS ||
        (sub.startTime >= mainStartTime - BOUNDARY_TOLERANCE_MS &&
          sub.endTime <= mainEndTime + BOUNDARY_TOLERANCE_MS)
      ) {
        const text = sub.word.trim();
        if (text) {
          syllables.push(text);
        }
        romanSearchStartIndex = romanIndex + 1;
      }

      romanIndex++;
    }

    if (syllables.length > 0) {
      main.romanWord = syllables.join("");
    } else if (bestFallbackIndex !== -1 && maxOverlapDuration > 0) {
      const text = romanWords[bestFallbackIndex].word.trim();
      if (text) {
        main.romanWord = text;
        romanSearchStartIndex = bestFallbackIndex + 1;
      }
    }
  }
};
