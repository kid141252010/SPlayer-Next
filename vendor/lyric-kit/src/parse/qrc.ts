import { normalizeKangxi } from "../clean/kangxi";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { detectBackgroundLine, splitTrailingBackground } from "../utils/bg";
import { applyKanaToLines } from "../utils/kana";
import { applyLrcMetaTag, applyTimestampOffset, META_TAG_RE } from "../utils/meta";
import { pushCleanWord } from "../utils/word";

/** 行头：[起始毫秒, 时长毫秒] */
const LINE_HEADER_RE = /^\[(\d+),(\d+)\]/;

/** 逐词匹配正则：词内容(起始毫秒,时长毫秒) */
const WORD_RE = /(.*?)\((\d+),(\d+)\)/g;

/**
 * 逐词解析单行 QRC 字级歌词与时间戳
 * @param rest - 行头时间戳之后的行文本内容
 * @returns 解析出的歌词单词列表
 */
const parseWords = (rest: string): LyricWord[] => {
  const words: LyricWord[] = [];
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WORD_RE.exec(rest)) !== null) {
    const rawWord = match[1];
    const start = parseInt(match[2], 10);
    const dur = parseInt(match[3], 10);

    if (!rawWord && dur === 0) continue;
    pushCleanWord(words, rawWord, start, start + dur);
  }

  return words;
};

/** XML 字符实体反转义 */
const decodeXmlEntities = (str: string): string =>
  str
    .replace(/&#(\d+);/g, (_matched, code) => {
      const codePoint = parseInt(code, 10);
      return Number.isNaN(codePoint) ? "" : String.fromCodePoint(codePoint);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_matched, code) => {
      const codePoint = parseInt(code, 16);
      return Number.isNaN(codePoint) ? "" : String.fromCodePoint(codePoint);
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * 从 XML 包裹结构中提取 QRC 纯文本歌词内容与元数据
 * @param text - 原始 QRC 文本（可能包含 XML 标签）
 * @returns 提取出的纯文本歌词与元数据对象
 */
const extractFromXml = (text: string): { content: string; xmlMeta?: LyricMetadata } => {
  if (!text.trimStart().startsWith("<")) return { content: text };

  let xmlMeta: LyricMetadata | undefined;
  const titleMatch = text.match(/(?:Title|musicName)="([^"]+)"/i);
  const singerMatch = text.match(/(?:Singer|Artist|artists)="([^"]+)"/i);
  const albumMatch = text.match(/(?:Album)="([^"]+)"/i);

  if (titleMatch || singerMatch || albumMatch) {
    xmlMeta = {};
    if (titleMatch) xmlMeta.title = [decodeXmlEntities(titleMatch[1])];
    if (singerMatch) xmlMeta.artist = [decodeXmlEntities(singerMatch[1])];
    if (albumMatch) xmlMeta.album = [decodeXmlEntities(albumMatch[1])];
  }

  const cdataMatch = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) return { content: cdataMatch[1], xmlMeta };
  const multiLineMatch = text.match(/LyricContent="([\s\S]*?)"\s*\/?>/);
  if (multiLineMatch) return { content: decodeXmlEntities(multiLineMatch[1]), xmlMeta };
  const attrMatch = text.match(/LyricContent="([^"]*)"/);
  if (attrMatch) return { content: decodeXmlEntities(attrMatch[1]), xmlMeta };
  return { content: text, xmlMeta };
};

/**
 * 解析 QQ 音乐 QRC 歌词（支持纯文本与 XML 包裹格式）
 * @param text - QRC 歌词内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseQRC = (text: string, options: ParseOptions = {}): LyricResult => {
  const {
    detectBackground = true,
    extractMetadata = false,
    cleanKangxi = false,
    applyOffset = false,
  } = options;
  const { content, xmlMeta } = extractFromXml(text);
  const metadata: LyricMetadata =
    extractMetadata && xmlMeta
      ? { ...xmlMeta, timingMode: "Word" }
      : extractMetadata
        ? { timingMode: "Word" }
        : {};
  const lines: LyricLine[] = [];
  let kanaTag = "";

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const metaMatch = META_TAG_RE.exec(trimmed);
    if (metaMatch) {
      if (metaMatch[1].toLowerCase() === "kana") {
        kanaTag = trimmed;
      }
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

    const words = parseWords(rest);

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
