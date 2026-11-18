import { normalizeKangxi } from "../clean/kangxi";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { detectBackgroundLine } from "../utils/bg";
import { applyLrcMetaTag, applyTimestampOffset, META_TAG_RE } from "../utils/meta";
import { pushCleanWord } from "../utils/word";

/** 匹配行头属性码 [0]~[9] */
const PROP_RE = /^\[(\d)\]/;

/** 匹配逐字时间戳：文字(起始ms,时长ms) */
const WORD_RE = /(.*?)\((\d+),(\d+)\)/g;

/**
 * 解析属性码为背景音与对唱状态
 * @param code - LyS 行头数字属性码（0~9）
 * @returns 包含 isBG 与 isDuet 的状态对象（isBG 为 undefined 时表示未明确指定）
 */
const parseProperty = (code: number): { isBG: boolean | undefined; isDuet: boolean } => {
  switch (code) {
    case 2:
      return { isBG: undefined, isDuet: true };
    case 5:
      return { isBG: false, isDuet: true };
    case 6:
    case 7:
      return { isBG: true, isDuet: false };
    case 8:
      return { isBG: true, isDuet: true };
    case 3:
    case 4:
      return { isBG: false, isDuet: false };
    default:
      return { isBG: undefined, isDuet: false };
  }
};

/**
 * 解析 LyS（Lyricify Syllable）歌词文本
 * @param text - LyS 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseLyS = (text: string, options: ParseOptions = {}): LyricResult => {
  const {
    detectBackground = true,
    extractMetadata = false,
    cleanKangxi = false,
    applyOffset = false,
  } = options;
  const content = cleanKangxi ? normalizeKangxi(text) : text;

  const metadata: LyricMetadata = extractMetadata ? { timingMode: "Word" } : {};
  const lines: LyricLine[] = [];

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const metaMatch = META_TAG_RE.exec(trimmed);
    if (metaMatch) {
      if (extractMetadata || (applyOffset && metaMatch[1].toLowerCase() === "offset")) {
        applyLrcMetaTag(metadata, metaMatch[1], metaMatch[2]);
      }
      continue;
    }

    const propMatch = PROP_RE.exec(trimmed);
    if (!propMatch) continue;

    const { isBG: declaredBg, isDuet } = parseProperty(parseInt(propMatch[1], 10));
    const rest = trimmed.slice(propMatch[0].length);

    WORD_RE.lastIndex = 0;
    const words: LyricWord[] = [];
    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(rest)) !== null) {
      const rawWord = match[1];
      const wordStart = parseInt(match[2], 10);
      const wordDur = parseInt(match[3], 10);

      pushCleanWord(words, rawWord, wordStart, wordStart + wordDur);
    }

    if (words.length === 0) continue;

    let isBG = declaredBg === true;
    if (declaredBg === undefined) {
      isBG = detectBackgroundLine(words, detectBackground);
    } else if (isBG && detectBackground) {
      detectBackgroundLine(words, true);
    }

    lines.push({
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: words[0].startTime,
      endTime: words[words.length - 1].endTime,
      isBG,
      isDuet,
    });
  }

  if (applyOffset && metadata.offset) {
    applyTimestampOffset(lines, metadata.offset);
  }

  return {
    lines,
    metadata: extractMetadata ? metadata : {},
  };
};
