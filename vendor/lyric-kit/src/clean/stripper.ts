/**
 * 元数据行清理器
 * 用于清理歌词中开头和结尾的制作人、词曲作者、版权声明等元数据行
 */

import type { LyricLine, StripOptions } from "../types";
import { getLineText } from "../utils/text";
import { defaultKeywords, defaultRegexes } from "./excludeRules";

/**
 * 归一化关键词字符串（转小写并移除空格）
 * @param str - 原始字符串
 * @returns 归一化后的字符串
 */
const normalizeKw = (str: string): string =>
  str.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * 无冒号回退匹配时，关键词前缀后允许紧跟的分隔符（归一化后形态）
 * 用于 "作词-青石"、"编曲（林一）" 这类无冒号分隔格式
 */
const NO_COLON_SEPARATORS = new Set([
  ":",
  ",",
  ".",
  "!",
  "-",
  "_",
  "(",
  "[",
  "{",
  "【",
  "『",
  "「",
  "。",
  "·",
]);

/** 模块级预归一化的默认关键词集合 */
const NORMALIZED_DEFAULT_KEYWORDS: ReadonlySet<string> = new Set(defaultKeywords.map(normalizeKw));

/** 模块级预编译的默认严格正则列表 */
const COMPILED_DEFAULT_REGEXES: readonly RegExp[] = defaultRegexes
  .map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch {
      return null;
    }
  })
  .filter((re): re is RegExp => re !== null);

/**
 * 清除行两端的外层包装括号
 * @param text - 原始行文本
 * @returns 剥除括号后的文本
 */
const cleanTextForCheck = (text: string): string => {
  let processed = text.trim();
  const brackets: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["（", "）"],
    ["【", "】"],
    ["[", "]"],
    ["{", "}"],
    ["『", "』"],
    ["「", "」"],
  ];

  let changed = true;
  let loopCount = 0;
  while (changed && loopCount < 5) {
    changed = false;
    loopCount++;
    for (const [open, close] of brackets) {
      if (processed.startsWith(open)) {
        if (processed.endsWith(close)) {
          processed = processed.slice(open.length, processed.length - close.length).trim();
          changed = true;
          break;
        }
        const closeIdx = processed.indexOf(close);
        if (closeIdx > -1) {
          const contentAfter = processed.slice(closeIdx + close.length).trim();
          if (contentAfter.length > 0) {
            processed = contentAfter;
            changed = true;
            break;
          }
        }
      }
    }
  }
  return processed;
};

/**
 * 判定单行文本是否为制作人或版权元数据行
 * 判定机制：命中版权声明或纯音乐正则；包含冒号且冒号左侧职务 Key 匹配关键词库（支持单字职务、多字职务及复合双语）；无冒号时整行完全等于多字关键词，或以多字关键词开头并紧跟分隔符
 *
 * @param text - 待检查的行文本
 * @param keywordSet - 归一化关键词集合
 * @param regexes - 正则表达式列表
 * @returns 是否判定为元数据行
 */
const isMetadataLine = (
  text: string,
  keywordSet: ReadonlySet<string>,
  regexes: readonly RegExp[],
): boolean => {
  for (const regex of regexes) {
    if (regex.test(text)) return true;
  }

  const cleaned = cleanTextForCheck(text);
  const colonMatch = /[:：]/.exec(cleaned);

  if (colonMatch) {
    const rawKey = cleaned.slice(0, colonMatch.index).trim();
    if (!rawKey) return false;

    const key = normalizeKw(cleanTextForCheck(rawKey));
    if (!key) return false;

    if (keywordSet.has(key)) return true;

    for (const kw of keywordSet) {
      if (key.startsWith(kw)) {
        const nextChar = key[kw.length];
        if (
          nextChar === "/" ||
          nextChar === "&" ||
          nextChar === "、" ||
          nextChar === "+" ||
          (nextChar >= "a" && nextChar <= "z")
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const normalizedText = normalizeKw(cleaned);
  if (normalizedText.length >= 2 && keywordSet.has(normalizedText)) {
    return true;
  }

  // 无冒号回退：多字关键词前缀 + 紧随分隔符
  for (const kw of keywordSet) {
    if (kw.length < 2) continue;
    if (normalizedText.startsWith(kw)) {
      const nextChar = normalizedText[kw.length];
      if (nextChar && NO_COLON_SEPARATORS.has(nextChar)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * 剥离歌词中的元数据行（词/曲/编曲/制作/版权等）
 * @param lines - 原始歌词行列表
 * @param options - 清理选项（默认使用内置关键词与正则，并与用户传入合并去重）
 * @returns 剥离元数据后的歌词行列表
 */
export const stripLyricMetadata = (
  lines: readonly LyricLine[],
  options: StripOptions = {},
): LyricLine[] => {
  if (!lines || lines.length === 0) return [];

  const useDefaultRules = options.useDefaultRules ?? true;

  let keywordSet: ReadonlySet<string>;
  if (!useDefaultRules) {
    keywordSet = new Set((options.keywords ?? []).map(normalizeKw));
  } else if (!options.keywords || options.keywords.length === 0) {
    keywordSet = NORMALIZED_DEFAULT_KEYWORDS;
  } else {
    keywordSet = new Set([...NORMALIZED_DEFAULT_KEYWORDS, ...options.keywords.map(normalizeKw)]);
  }

  let regexes: readonly RegExp[];
  if (!useDefaultRules) {
    regexes = (options.regexPatterns ?? [])
      .map((pattern) => {
        try {
          return new RegExp(pattern, "i");
        } catch {
          return null;
        }
      })
      .filter((re): re is RegExp => re !== null);
  } else if (!options.regexPatterns || options.regexPatterns.length === 0) {
    regexes = COMPILED_DEFAULT_REGEXES;
  } else {
    const extraRegexes = (options.regexPatterns ?? [])
      .map((pattern) => {
        try {
          return new RegExp(pattern, "i");
        } catch {
          return null;
        }
      })
      .filter((re): re is RegExp => re !== null);
    regexes = [...COMPILED_DEFAULT_REGEXES, ...extraRegexes];
  }

  // 预提取所有行文本，避免后续多次遍历时重复 map / join / trim
  const lineTexts = lines.map(getLineText);
  const excludeIndices = new Set<number>();

  // 制作人与版权元数据全文精准判定
  for (let idx = 0; idx < lines.length; idx++) {
    const text = lineTexts[idx];
    if (!text) continue;
    if (isMetadataLine(text, keywordSet, regexes)) {
      excludeIndices.add(idx);
    }
  }

  // 歌曲名与歌手匹配：在清理元数据后的前 5 行有效内容内扫描，
  // 避免元数据行占用扫描窗口导致靠后的标题行漏判
  if (options.matchMetadata) {
    const { title, artists } = options.matchMetadata;
    if (title && artists && artists.length > 0) {
      const lowerTitle = title.toLowerCase();
      let scanned = 0;
      for (let idx = 0; idx < lines.length && scanned < 5; idx++) {
        if (excludeIndices.has(idx)) continue;
        const text = lineTexts[idx];
        if (!text) continue;
        scanned++;
        const lowerText = text.toLowerCase();
        if (lowerText.includes(lowerTitle)) {
          const hasAnyArtist = artists.some((artist) => lowerText.includes(artist.toLowerCase()));
          if (hasAnyArtist) {
            excludeIndices.add(idx);
          }
        }
      }
    }
  }

  // 关联背景行处理：若主行被剔除或背景行孤立无主，背景行联动剔除
  let currentMainIdx = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!lines[idx].isBG) {
      currentMainIdx = idx;
    } else if (currentMainIdx === -1 || excludeIndices.has(currentMainIdx)) {
      excludeIndices.add(idx);
    }
  }

  // 定位有效正文区间，排除正文开唱前与结束后的空白行与元数据
  let firstContentIdx = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (excludeIndices.has(idx)) continue;
    if (lineTexts[idx].length > 0) {
      firstContentIdx = idx;
      break;
    }
  }

  if (firstContentIdx === -1) {
    return [];
  }

  let lastContentIdx = -1;
  for (let idx = lines.length - 1; idx >= firstContentIdx; idx--) {
    if (excludeIndices.has(idx)) continue;
    if (lineTexts[idx].length > 0) {
      lastContentIdx = idx;
      break;
    }
  }

  for (let idx = 0; idx < firstContentIdx; idx++) {
    excludeIndices.add(idx);
  }

  for (let idx = lastContentIdx + 1; idx < lines.length; idx++) {
    excludeIndices.add(idx);
  }

  if (excludeIndices.size === 0) return lines as LyricLine[];

  return lines.filter((_, idx) => !excludeIndices.has(idx));
};
