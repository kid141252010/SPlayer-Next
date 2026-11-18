import { normalizeKangxi } from "../clean/kangxi";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { detectBackgroundLine, splitTrailingBackground } from "../utils/bg";
import { applyLrcMetaTag, applyTimestampOffset, META_TAG_RE } from "../utils/meta";
import { pushCleanWord } from "../utils/word";

/** 行头：[起始毫秒, 时长毫秒] */
const LINE_HEADER_RE = /^\[(\d+),(\d+)\]/;

/** 字级时间戳标记：(起始毫秒, 时长毫秒, 0) */
const TIMING_TAG_RE = /\((\d+),(\d+),\d+\)/g;

/**
 * 解析单行 YRC 的逐字时间戳与单词序列
 * @param rest - 行头时间戳之后的行文本内容
 * @returns 逐字单词数组
 */
const parseYrcWords = (rest: string): LyricWord[] => {
  TIMING_TAG_RE.lastIndex = 0;
  const matches: { start: number; dur: number; index: number; length: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = TIMING_TAG_RE.exec(rest)) !== null) {
    matches.push({
      start: parseInt(match[1], 10),
      dur: parseInt(match[2], 10),
      index: match.index,
      length: match[0].length,
    });
  }

  if (matches.length === 0) return [];

  const words: LyricWord[] = [];
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
    const curr = matches[matchIndex];
    const textStart = curr.index + curr.length;
    const textEnd = matchIndex + 1 < matches.length ? matches[matchIndex + 1].index : rest.length;
    const rawWord = rest.slice(textStart, textEnd);

    pushCleanWord(words, rawWord, curr.start, curr.start + curr.dur);
  }

  return words;
};

/**
 * 解析网易云音乐 YRC 逐字歌词
 * @param text - YRC 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseYRC = (text: string, options: ParseOptions = {}): LyricResult => {
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

    const jsonStr = trimmed.replace(/^\[\d+,\d+\]/, "");
    if (jsonStr.startsWith('{"t":') || jsonStr.startsWith('{"c":')) {
      if (extractMetadata) {
        try {
          const parsed = JSON.parse(jsonStr) as {
            c?: Array<{ tx?: string }>;
          };
          const contentList = parsed.c;
          if (Array.isArray(contentList)) {
            for (let idx = 0; idx < contentList.length; idx++) {
              const rawTx = contentList[idx]?.tx?.trim();
              if (!rawTx) continue;

              const halfColonIdx = rawTx.indexOf(":");
              const fullColonIdx = rawTx.indexOf("：");
              const splitIdx =
                halfColonIdx === -1
                  ? fullColonIdx
                  : fullColonIdx === -1
                    ? halfColonIdx
                    : Math.min(halfColonIdx, fullColonIdx);

              let role = "";
              let value = "";

              if (splitIdx > -1) {
                role = rawTx.slice(0, splitIdx).trim();
                value = rawTx.slice(splitIdx + 1).trim();
                if (!value && idx + 1 < contentList.length) {
                  value = (contentList[idx + 1]?.tx || "").trim();
                  idx++;
                }
              }

              if (role && value) {
                if (/^(作词|作曲|编曲|词|曲|Lyricist|Composer|Arranger)/i.test(role)) {
                  if (!metadata.songwriters?.includes(value)) {
                    (metadata.songwriters ??= []).push(value);
                  }
                } else if (/^(歌手|演唱|原唱|Artist|Vocals)/i.test(role)) {
                  if (!metadata.artist?.includes(value)) {
                    (metadata.artist ??= []).push(value);
                  }
                } else if (/^(制作人|监制|出品|统筹|Producer|Publisher)/i.test(role)) {
                  if (!metadata.authors?.includes(value)) {
                    (metadata.authors ??= []).push(value);
                  }
                } else {
                  (metadata.rawProperties ??= {})[role] = [value];
                }
              }
            }
          }
        } catch {
          // 忽略非法 JSON
        }
      }
      continue;
    }

    const metaMatch = META_TAG_RE.exec(trimmed);
    if (metaMatch) {
      if (extractMetadata || (applyOffset && metaMatch[1].toLowerCase() === "offset")) {
        applyLrcMetaTag(metadata, metaMatch[1], metaMatch[2]);
      }
      continue;
    }

    const header = LINE_HEADER_RE.exec(trimmed);
    if (!header) continue;

    const lineStart = parseInt(header[1], 10);
    const lineDur = parseInt(header[2], 10);
    const rest = trimmed.slice(header[0].length);

    const words = parseYrcWords(rest);
    if (words.length === 0) continue;

    const line: LyricLine = {
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: lineStart,
      endTime: lineStart + lineDur,
      isBG: detectBackgroundLine(words, detectBackground),
      isDuet: false,
    };
    lines.push(line);
    if (!line.isBG) {
      const bg = splitTrailingBackground(line, detectBackground);
      if (bg) lines.push(bg);
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
