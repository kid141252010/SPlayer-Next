import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { detectBackgroundLine, splitTrailingBackground } from "../utils/bg";
import { applyKanaToLines } from "../utils/kana";
import { applyLrcMetaTag, applyTimestampOffset, META_TAG_RE } from "../utils/meta";
import { parseTime } from "../utils/timestamp";
import { pushCleanWord } from "../utils/word";

/** 行头时间戳：[mm:ss] / [mm:ss.xxx] / [mm:ss:xxx] */
const TIME_HEADER_RE = /^\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/;

/** 行头毫秒数：[起始ms, 时长ms] */
const MS_HEADER_RE = /^\[(\d+),(\d+)\]/;

/** 行内逐字：<offset,dur>字 或 <offset,dur,0>字 */
const WORD_RE = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;

/** 跨环境 Base64 UTF-8 解码 */
const decodeBase64Utf8 = (str: string): string => {
  try {
    const raw = globalThis.atob(str);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
};

/**
 * 解析酷狗音乐 KRC 歌词（解密后的纯文本）
 * @param text - 解密后的 KRC 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseKRC = (text: string, options: ParseOptions = {}): LyricResult => {
  const {
    detectBackground = true,
    extractMetadata = false,
    cleanKangxi = false,
    applyOffset = false,
  } = options;
  const metadata: LyricMetadata = extractMetadata ? { timingMode: "Word" } : {};
  const lines: LyricLine[] = [];
  let krcTranslations: string[] = [];
  let krcRomanizations: string[] = [];
  const mainLines: LyricLine[] = [];
  let kanaTag = "";

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const metaMatch = META_TAG_RE.exec(trimmed);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();
      if (key === "kana") {
        kanaTag = trimmed;
      }
      if (key === "language") {
        const isBase64 = val.startsWith("ey") || val.startsWith("{");
        if (isBase64) {
          try {
            const jsonStr = val.startsWith("{") ? val : decodeBase64Utf8(val);
            const data = JSON.parse(jsonStr) as {
              content?: Array<{
                type: number;
                lyricContent?: Array<string[] | string>;
              }>;
            };
            if (Array.isArray(data.content)) {
              for (const item of data.content) {
                if (item.type === 1 && Array.isArray(item.lyricContent)) {
                  krcTranslations = item.lyricContent.map((row) =>
                    Array.isArray(row) ? row.join("") : String(row),
                  );
                } else if (item.type === 0 && Array.isArray(item.lyricContent)) {
                  krcRomanizations = item.lyricContent.map((row) =>
                    Array.isArray(row) ? row.join("") : String(row),
                  );
                }
              }
            }
          } catch {
            // 忽略非法数据
          }
        } else if (extractMetadata) {
          metadata.language = val;
        }
      } else if (extractMetadata || (applyOffset && key === "offset")) {
        applyLrcMetaTag(metadata, metaMatch[1], metaMatch[2]);
      }
      continue;
    }

    let lineStart = 0;
    let lineDur = 0;
    let headerLen = 0;

    const timeHeader = TIME_HEADER_RE.exec(trimmed);
    if (timeHeader) {
      lineStart = parseTime(timeHeader[1], timeHeader[2], timeHeader[3], false);
      headerLen = timeHeader[0].length;
    } else {
      const msHeader = MS_HEADER_RE.exec(trimmed);
      if (msHeader) {
        lineStart = parseInt(msHeader[1], 10);
        lineDur = parseInt(msHeader[2], 10);
        headerLen = msHeader[0].length;
      } else {
        continue;
      }
    }

    const rest = trimmed.slice(headerLen);

    WORD_RE.lastIndex = 0;
    const words: LyricWord[] = [];
    let match: RegExpExecArray | null;
    let lastEnd = lineStart;
    while ((match = WORD_RE.exec(rest)) !== null) {
      const rawWord = match[3];
      if (!rawWord) continue;
      const offset = parseInt(match[1], 10);
      const dur = parseInt(match[2], 10);
      const start = lineStart + offset;
      const end = start + dur;

      pushCleanWord(words, rawWord, start, end);
      lastEnd = Math.max(lastEnd, end);
    }

    if (words.length === 0) continue;

    const calculatedEnd = lineDur > 0 ? lineStart + lineDur : lastEnd;
    const line: LyricLine = {
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: lineStart,
      endTime: calculatedEnd,
      isBG: detectBackgroundLine(words, detectBackground),
      isDuet: false,
    };
    mainLines.push(line);
    lines.push(line);
    if (!line.isBG) {
      const bg = splitTrailingBackground(line, detectBackground);
      if (bg) lines.push(bg);
    }
  }

  if (krcTranslations.length > 0 || krcRomanizations.length > 0) {
    for (let idx = 0; idx < mainLines.length; idx++) {
      if (isMeaningfulTranslation(krcTranslations[idx] ?? "")) {
        mainLines[idx].translatedLyric = krcTranslations[idx];
      }
      if (krcRomanizations[idx]) mainLines[idx].romanLyric = krcRomanizations[idx];
    }
  }

  if (kanaTag) {
    applyKanaToLines(lines, kanaTag);
  }

  if (cleanKangxi) {
    for (const line of lines) {
      for (const word of line.words) {
        word.word = normalizeKangxi(word.word);
      }
    }
  }

  if (applyOffset && metadata.offset) {
    applyTimestampOffset(lines, metadata.offset);
  }

  return {
    lines,
    metadata: extractMetadata ? metadata : {},
  };
};
