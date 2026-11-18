import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { detectBackgroundLine, splitTrailingBackground } from "../utils/bg";
import { applyLrcMetaTag, applyTimestampOffset, META_TAG_RE } from "../utils/meta";
import { LAST_LINE_FALLBACK_MS } from "../utils/sync";
import { getLineText } from "../utils/text";
import { ANGLE_TIME_RE, BRACKET_TIME_RE, parseTime } from "../utils/timestamp";
import { pushCleanWord } from "../utils/word";
import { isLineTimed, markLineTimed } from "./timing";

/** 检测尖括号逐字标签 */
const HAS_ANGLE_TAGS = /<\d+:\d+/;

/**
 * 提取行首连续的方括号时间戳
 * @param line - 原始行文本
 * @returns 时间戳数组和文本起始位置
 */
const extractHeaderTimes = (line: string): { times: number[]; textStart: number } => {
  BRACKET_TIME_RE.lastIndex = 0;
  const times: number[] = [];
  let textStart = 0;
  let match: RegExpExecArray | null;
  while ((match = BRACKET_TIME_RE.exec(line)) !== null) {
    if (match.index !== textStart) break;
    times.push(parseTime(match[1], match[2], match[3]));
    textStart = BRACKET_TIME_RE.lastIndex;
  }
  return { times, textStart };
};

/**
 * 尝试解析尖括号逐字时间戳与歌词单词（LRC A2 / 增强 LRC）
 * @param content - 包含尖括号时间戳的歌词内容
 * @returns 单词数组，非尖括号逐字格式时返回 null
 */
const parseAngleWordTags = (content: string): LyricWord[] | null => {
  if (!HAS_ANGLE_TAGS.test(content)) return null;
  ANGLE_TIME_RE.lastIndex = 0;
  const words: LyricWord[] = [];
  let match: RegExpExecArray | null;
  while ((match = ANGLE_TIME_RE.exec(content)) !== null) {
    const startTime = parseTime(match[1], match[2], match[3] ?? "0");
    const wordText = match[4];
    if (!wordText) {
      const lastWord = words[words.length - 1];
      if (lastWord && startTime >= lastWord.startTime) lastWord.endTime = startTime;
      continue;
    }
    pushCleanWord(words, wordText, startTime, 0);
  }
  if (words.length === 0) return null;
  for (let wordIndex = 0; wordIndex < words.length - 1; wordIndex++) {
    if (words[wordIndex].endTime <= words[wordIndex].startTime) {
      words[wordIndex].endTime = words[wordIndex + 1].startTime;
    }
  }
  return words;
};

/**
 * 尝试解析行内方括号逐字时间戳与歌词单词（标准 ESLyric 逐字）
 * @param lineContent - 包含方括号逐字标签的文本内容
 * @param initialStartTime - 行首起始时间戳
 * @returns 单词数组，非逐字行时返回 null
 */
const parseBracketWordTags = (
  lineContent: string,
  initialStartTime: number,
): LyricWord[] | null => {
  BRACKET_TIME_RE.lastIndex = 0;
  const words: LyricWord[] = [];
  let prevTime = initialStartTime;
  let prevTextStart = 0;
  let tagCount = 0;
  let match: RegExpExecArray | null;

  while ((match = BRACKET_TIME_RE.exec(lineContent)) !== null) {
    const time = parseTime(match[1], match[2], match[3]);
    tagCount++;
    const rawWord = lineContent.slice(prevTextStart, match.index);
    pushCleanWord(words, rawWord, prevTime, time);
    prevTime = time;
    prevTextStart = BRACKET_TIME_RE.lastIndex;
  }

  if (tagCount === 0 || words.length === 0) return null;

  if (prevTextStart < lineContent.length) {
    const rawWord = lineContent.slice(prevTextStart);
    pushCleanWord(words, rawWord, prevTime, 0);
  }

  return words;
};

/**
 * 解析单行 LRC 内容负载，处理多时间戳并识别逐字或逐行歌词
 * @param line - 待解析的 LRC 单行文本
 * @param detectBackground - 是否自动识别背景人声
 * @returns 解析出的歌词行列表
 */
const parseLrcPayload = (line: string, detectBackground: boolean): LyricLine[] => {
  const { times, textStart } = extractHeaderTimes(line);
  if (times.length === 0) return [];
  const content = line.slice(textStart);
  if (!content.trim()) {
    const lines: LyricLine[] = [];
    for (const time of times) {
      lines.push(
        markLineTimed({
          words: [{ startTime: time, endTime: 0, word: "" }],
          translatedLyric: "",
          romanLyric: "",
          startTime: time,
          endTime: 0,
          isBG: false,
          isDuet: false,
        }),
      );
    }
    return lines;
  }

  const angleWords = parseAngleWordTags(content);
  if (angleWords) {
    const lines: LyricLine[] = [];
    const baseTime = times[0];
    for (const time of times) {
      const delta = time - baseTime;
      const words =
        delta === 0
          ? angleWords
          : angleWords.map((word) => ({
              ...word,
              startTime: Math.max(0, word.startTime + delta),
              endTime: Math.max(0, word.endTime + delta),
            }));
      lines.push({
        words,
        translatedLyric: "",
        romanLyric: "",
        startTime: words[0].startTime,
        endTime: words[words.length - 1].endTime,
        isBG: detectBackgroundLine(words, detectBackground),
        isDuet: false,
      });
    }
    return lines;
  }

  const bracketWords = parseBracketWordTags(content, times[0]);
  if (bracketWords) {
    const lines: LyricLine[] = [];
    const baseTime = times[0];
    for (const time of times) {
      const delta = time - baseTime;
      const words =
        delta === 0
          ? bracketWords
          : bracketWords.map((word) => ({
              ...word,
              startTime: Math.max(0, word.startTime + delta),
              endTime: Math.max(0, word.endTime + delta),
            }));
      lines.push({
        words,
        translatedLyric: "",
        romanLyric: "",
        startTime: words[0].startTime,
        endTime: words[words.length - 1].endTime,
        isBG: detectBackgroundLine(words, detectBackground),
        isDuet: false,
      });
    }
    return lines;
  }

  const lineWords = [{ startTime: 0, endTime: 0, word: content.trim() }];
  const isBG = detectBackgroundLine(lineWords, detectBackground);
  const lines: LyricLine[] = [];
  for (const time of times) {
    lines.push(
      markLineTimed({
        words: [{ startTime: time, endTime: 0, word: lineWords[0].word }],
        translatedLyric: "",
        romanLyric: "",
        startTime: time,
        endTime: 0,
        isBG,
        isDuet: false,
      }),
    );
  }
  return lines;
};

/**
 * 解析 LRC 歌词文本
 * @param text - LRC 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseLRC = (text: string, options: ParseOptions = {}): LyricResult => {
  const {
    detectBackground = true,
    extractMetadata = false,
    cleanKangxi = false,
    applyOffset = false,
    keepEmptyLines = false,
  } = options;
  const content = cleanKangxi ? normalizeKangxi(text) : text;

  const metadata: LyricMetadata = {};
  const lines: LyricLine[] = [];

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const metaMatch = META_TAG_RE.exec(trimmed);
    if (metaMatch) {
      const key = metaMatch[1];
      const val = metaMatch[2];

      if (extractMetadata || (applyOffset && key.toLowerCase() === "offset")) {
        applyLrcMetaTag(metadata, key, val);
      }

      if (key.toLowerCase() === "bg") {
        const bgPayload = parseLrcPayload(val, detectBackground);
        for (const item of bgPayload) {
          item.isBG = true;
          lines.push(item);
        }
      }
      continue;
    }

    if (trimmed.startsWith("{")) continue;

    const parsedLines = parseLrcPayload(trimmed, detectBackground);
    for (const item of parsedLines) {
      lines.push(item);
      if (!item.isBG) {
        const bg = splitTrailingBackground(item, detectBackground);
        if (bg) lines.push(isLineTimed(item) ? markLineTimed(bg) : bg);
      }
    }
  }

  lines.sort((lineA, lineB) => lineA.startTime - lineB.startTime);

  const merged: LyricLine[] = [];
  const translationConsumed = new Set<LyricLine>();
  for (const line of lines) {
    const currentText = getLineText(line);

    // 若当前行是空行标记，若同时间戳已存在正文行则丢弃该冗余空行，否则暂存作为时间截止标记
    if (!currentText) {
      let hasExistingMain = false;
      for (let searchIndex = merged.length - 1; searchIndex >= 0; searchIndex--) {
        const candidate = merged[searchIndex];
        if (candidate.startTime < line.startTime) break;
        if (candidate.startTime === line.startTime && candidate.isBG === line.isBG) {
          const candidateText = getLineText(candidate);
          if (candidateText !== "") {
            hasExistingMain = true;
            break;
          }
        }
      }
      if (!hasExistingMain) {
        merged.push(line);
      }
      continue;
    }

    let target: LyricLine | undefined;
    for (let searchIndex = merged.length - 1; searchIndex >= 0; searchIndex--) {
      const candidate = merged[searchIndex];
      if (candidate.startTime < line.startTime) break;
      if (candidate.startTime === line.startTime && candidate.isBG === line.isBG) {
        const candidateText = getLineText(candidate);
        if (candidateText) {
          // 候选行是有实际文本的正文行，可作为翻译或音译的合并目标
          target = candidate;
          break;
        } else {
          // 候选行是同时间戳的纯空行标记，当前非空正文行取代其占位
          merged.splice(searchIndex, 1);
        }
      }
    }

    if (target) {
      if (!translationConsumed.has(target)) {
        translationConsumed.add(target);
        if (isMeaningfulTranslation(currentText)) target.translatedLyric = currentText;
        continue;
      }
      if (!target.romanLyric) {
        target.romanLyric = currentText;
        continue;
      }
    }
    merged.push(line);
  }

  const lastLine = merged[merged.length - 1];
  let nextDistinctStartTime = lastLine
    ? Math.max(lastLine.startTime + LAST_LINE_FALLBACK_MS, lastLine.endTime)
    : 0;

  for (let lineIndex = merged.length - 1; lineIndex >= 0; lineIndex--) {
    const line = merged[lineIndex];
    if (line.endTime <= line.startTime) {
      line.endTime = nextDistinctStartTime;
    }
    const lastWord = line.words[line.words.length - 1];
    if (lastWord && lastWord.endTime <= lastWord.startTime) {
      lastWord.endTime = line.endTime;
    }
    if (line.words.length === 1 && line.words[0].endTime <= line.words[0].startTime) {
      line.words[0].endTime = line.endTime;
    }
    const prevLine = merged[lineIndex - 1];
    if (!prevLine || prevLine.startTime < line.startTime) {
      nextDistinctStartTime = line.startTime;
    }
  }

  // 过滤空行：在倒序计算 endTime 阶段，空行已作为时间截止标记界定了前一行的结束时间。
  // 若未显式开启 keepEmptyLines（默认 false），输出最终歌词行时彻底剔除纯空白文本行，保持歌词列表干净；
  // 若开启 keepEmptyLines（true），则完整保留该行（包含起止时间，起于间奏、止于下一行开头），交由播放器处理。
  const resultLines = keepEmptyLines ? merged : merged.filter((line) => getLineText(line) !== "");

  if (applyOffset && metadata.offset) {
    applyTimestampOffset(resultLines, metadata.offset);
  }

  if (extractMetadata) {
    const hasWordTiming = resultLines.some((line) => (line.words?.length ?? 0) > 1);
    metadata.timingMode = hasWordTiming ? "Word" : "Line";
  }

  return {
    lines: resultLines,
    metadata: extractMetadata ? metadata : {},
  };
};
