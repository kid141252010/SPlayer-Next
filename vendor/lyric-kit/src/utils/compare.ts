/**
 * 歌词比较：判断候选歌词与基准歌词是否为同一版本，并估算时间偏移
 * 误拒只会保留基准歌词，误判会显示错误歌词，因此阈值偏严
 */

import { stripLyricMetadata } from "../clean/stripper";
import type { LyricLine, StripOptions } from "../types";
import { getLineText } from "./text";

/** 基准的有效词元少于该值时不足以判断 */
const MIN_BASELINE_TOKENS = 10;
/** 对齐矩阵上限，每格占 1 字节 */
const MAX_ALIGN_CELLS = 16_000_000;
/** 基准内容被候选覆盖的最低比例，官方歌词常混入制作信息和重复段，不能定得太高 */
const MIN_BASELINE_COVERAGE = 0.6;
/** 候选内容来自基准的最低比例，基准可能只有部分段落，因此比基准侧宽松 */
const MIN_CANDIDATE_COVERAGE = 0.4;
/** 计算偏移所需的最少行首对齐点 */
const MIN_ANCHORS = 3;
/** 时间差离散度上限，超过视为不同版本，同版本的行首时间也常有 2 秒左右的抖动 */
const MAX_OFFSET_SPREAD_MS = 3000;
/** 达到该偏移才需要平移，更小的差异视为时间轴误差 */
const MIN_SHIFT_MS = 1000;
/** 可平移时的离散度上限，时间差逐渐变化的版本无法靠整体平移对齐 */
const MAX_SHIFT_SPREAD_MS = 1000;

const ALIGN_DIAGONAL = 0;
const ALIGN_UP = 1;
const ALIGN_LEFT = 2;

/** 语气词，两侧使用同一规则移除 */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  "啊",
  "嗯",
  "哦",
  "噢",
  "喔",
  "呀",
  "哎",
  "唉",
  "呃",
  "哈",
  "啦",
  "呵",
  "嘿",
  "ah",
  "hey",
  "hmm",
  "huh",
  "la",
  "mm",
  "na",
  "oh",
  "ooh",
  "uh",
  "um",
  "whoa",
  "woo",
  "wow",
  "yeah",
  "yo",
]);

/** 中日韩文字按单字切分，其余文字按词切分，避免拉丁字母级比较造成相似度虚高 */
const CJK_CHAR = "\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}";
const TOKEN_RE = new RegExp(`${CJK_CHAR}|(?:(?!${CJK_CHAR})[\\p{L}\\p{M}\\p{N}])+`, "gu");
const APOSTROPHE_RE = /['’`]/g;

/** 歌词比较结果 */
export interface LyricComparison {
  /** same 同版本，shifted 同版本但需平移，different 不同版本，unknown 无法判断 */
  verdict: "same" | "shifted" | "different" | "unknown";
  /** 基准有多少内容被候选覆盖 */
  baselineCoverage: number;
  /** 候选有多少内容来自基准 */
  candidateCoverage: number;
  /** 候选相对基准的时间差中位数，正值表示候选偏晚 */
  offsetMs: number;
  /** 时间差离散度（第 80 与第 20 百分位之差），官方歌词的少数错位行不计入 */
  offsetSpreadMs: number;
}

/**
 * 把主歌词切分为词元，排除背景人声、翻译和元数据
 * @param lines - 歌词行列表
 * @param options - 比较选项
 * @returns 有效行、词元及每个词元所属的行下标
 */
const tokenizeLines = (lines: readonly LyricLine[], options: CompareLyricsOptions) => {
  const contentLines = stripLyricMetadata(
    lines.filter((line) => !line.isBG),
    { matchMetadata: options.matchMetadata },
  );
  const tokens: string[] = [];
  const tokenLines: number[] = [];
  contentLines.forEach((line, lineIndex) => {
    const text = getLineText(line).normalize("NFKC").toLowerCase().replace(APOSTROPHE_RE, "");
    for (const [token] of text.matchAll(TOKEN_RE)) {
      if (FILLER_TOKENS.has(token)) continue;
      tokens.push(token);
      tokenLines.push(lineIndex);
    }
  });
  return { contentLines, tokens, tokenLines };
};

/**
 * 用最长公共子序列对齐两组词元
 * @param baseline - 基准词元
 * @param candidate - 候选词元
 * @returns 对齐的词元下标对，顺序从后往前
 */
const alignTokens = (baseline: readonly string[], candidate: readonly string[]) => {
  const directions = new Uint8Array(baseline.length * candidate.length);
  let previous = new Uint16Array(candidate.length + 1);
  let current = new Uint16Array(candidate.length + 1);
  for (let row = 1; row <= baseline.length; row++) {
    const rowOffset = (row - 1) * candidate.length;
    for (let column = 1; column <= candidate.length; column++) {
      const cell = rowOffset + column - 1;
      if (baseline[row - 1] === candidate[column - 1]) {
        current[column] = previous[column - 1] + 1;
        directions[cell] = ALIGN_DIAGONAL;
      } else if (previous[column] >= current[column - 1]) {
        current[column] = previous[column];
        directions[cell] = ALIGN_UP;
      } else {
        current[column] = current[column - 1];
        directions[cell] = ALIGN_LEFT;
      }
    }
    [previous, current] = [current, previous];
  }

  const pairs: [number, number][] = [];
  let row = baseline.length;
  let column = candidate.length;
  while (row > 0 && column > 0) {
    const direction = directions[(row - 1) * candidate.length + column - 1];
    if (direction === ALIGN_DIAGONAL) {
      row--;
      column--;
      pairs.push([row, column]);
    } else if (direction === ALIGN_UP) {
      row--;
    } else {
      column--;
    }
  }
  return pairs;
};

/** compareLyrics 的选项 */
export type CompareLyricsOptions = Pick<StripOptions, "matchMetadata">;

/**
 * 比较候选歌词与基准歌词
 * 只比较主歌词正文；简繁转换等异步处理需由调用方在比较前完成
 * @param baseline - 基准歌词行
 * @param candidate - 候选歌词行
 * @param options - 比较选项，matchMetadata 用于排除歌名歌手行
 * @returns 判定结果、双向覆盖率和时间偏移
 */
export const compareLyrics = (
  baseline: readonly LyricLine[],
  candidate: readonly LyricLine[],
  options: CompareLyricsOptions = {},
): LyricComparison => {
  const base = tokenizeLines(baseline, options);
  const other = tokenizeLines(candidate, options);
  if (
    base.tokens.length < MIN_BASELINE_TOKENS ||
    base.tokens.length * other.tokens.length > MAX_ALIGN_CELLS
  ) {
    return {
      verdict: "unknown",
      baselineCoverage: 0,
      candidateCoverage: 0,
      offsetMs: 0,
      offsetSpreadMs: 0,
    };
  }

  const pairs = alignTokens(base.tokens, other.tokens);
  const baselineCoverage = pairs.length / base.tokens.length;
  const candidateCoverage = other.tokens.length > 0 ? pairs.length / other.tokens.length : 0;

  // 只取两侧都是行首的对齐点，重复副歌和不同断行不会混入偏移计算
  const offsets: number[] = [];
  for (const [baseIndex, otherIndex] of pairs) {
    const baseLine = base.tokenLines[baseIndex];
    const otherLine = other.tokenLines[otherIndex];
    if (baseLine === base.tokenLines[baseIndex - 1]) continue;
    if (otherLine === other.tokenLines[otherIndex - 1]) continue;
    offsets.push(other.contentLines[otherLine].startTime - base.contentLines[baseLine].startTime);
  }
  offsets.sort((left, right) => left - right);
  const lastOffset = offsets.length - 1;
  const offsetMs = offsets[Math.floor(offsets.length / 2)] ?? 0;
  const offsetSpreadMs =
    lastOffset < 0
      ? 0
      : offsets[Math.floor(lastOffset * 0.8)] - offsets[Math.floor(lastOffset * 0.2)];

  let verdict: LyricComparison["verdict"];
  if (baselineCoverage < MIN_BASELINE_COVERAGE || candidateCoverage < MIN_CANDIDATE_COVERAGE) {
    verdict = "different";
  } else if (offsets.length < MIN_ANCHORS) {
    verdict = "unknown";
  } else if (offsetSpreadMs > MAX_OFFSET_SPREAD_MS) {
    verdict = "different";
  } else if (Math.abs(offsetMs) < MIN_SHIFT_MS) {
    verdict = "same";
  } else {
    verdict = offsetSpreadMs <= MAX_SHIFT_SPREAD_MS ? "shifted" : "different";
  }
  return { verdict, baselineCoverage, candidateCoverage, offsetMs, offsetSpreadMs };
};

/**
 * 判断歌词是否有真实的逐字时间，只有单个片段或片段共用时间的行不算
 * @param lines - 歌词行列表
 * @returns 是否存在逐字时间
 */
export const hasWordTiming = (lines: readonly LyricLine[]): boolean =>
  lines.some((line) => {
    const timedWords = line.words.filter((word) => word.endTime > word.startTime);
    return timedWords.some((word) => word.startTime !== timedWords[0].startTime);
  });
