/**
 * lyric-kit
 * A lightweight, zero-dependency toolkit for parsing, serializing, and processing lyrics
 */

// 清洗与归一化
export { extractLyricAuthors } from "./clean/author";
export {
  defaultAuthors,
  defaultKeywords,
  defaultKeywords as excludeKeywords,
  defaultRegexes,
  defaultRegexes as excludeRegexes,
} from "./clean/excludeRules";
export { normalizeKangxi } from "./clean/kangxi";
export { applyLyricLanguages } from "./clean/language";
export { normalizeLyricLines } from "./clean/normalize";
export { stripLyricMetadata } from "./clean/stripper";

// 解析器
export {
  alignRomanization,
  detectFormat,
  pairTranslation,
  parseASS,
  parseKRC,
  parseLRC,
  parseLyric,
  parseLyS,
  parseQRC,
  parseSRT,
  parseTTML,
  parseYRC,
} from "./parse";

// 序列化器
export { serializeLyric, toEnhancedLRC, toLRC, toSRT, toTTML } from "./serialize";

// 类型定义
export type {
  DOMParserConstructor,
  DOMParserLike,
  LyricFormat,
  LyricInput,
  LyricLanguage,
  LyricLine,
  LyricMetadata,
  LyricResult,
  LyricSpan,
  LyricWord,
  ParseOptions,
  SerializeLyricFormat,
  SerializeOptions,
  StripOptions,
  TTMLAgent,
  TTMLPlatformId,
} from "./types";

// 播放同步与行处理
export { detectBackgroundLine, splitTrailingBackground } from "./utils/bg";
export type { CompareLyricsOptions, LyricComparison } from "./utils/compare";
export { compareLyrics, hasWordTiming } from "./utils/compare";
export type { KanaUnit } from "./utils/kana";
export { applyKanaToLines, parseKanaUnits } from "./utils/kana";
export { applyTimestampOffset } from "./utils/meta";
export { getWordSweepProgress } from "./utils/sweep";
export {
  clampLastLineEnd,
  createActiveLyricFinder,
  findActiveLyricIndices,
  findLyricIndex,
  pickAdvanceOnEndIndex,
  pickLatestStartedIndex,
  pickPrimaryIndex,
} from "./utils/sync";
// 时间与播放算法
export {
  ANGLE_TIME_RE,
  BRACKET_TIME_RE,
  formatLrcTime,
  formatSrtTime,
  formatTtmlTime,
  MAX_TIME,
  parseBracketTag,
  parseTime,
  parseTTMLTime,
} from "./utils/timestamp";
export { transformLyricText } from "./utils/transform";
