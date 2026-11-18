import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type { LyricLine, LyricMetadata, LyricResult, LyricWord, ParseOptions } from "../types";
import { markLineTimed } from "./timing";

/** 匹配 Dialogue 行时间戳、Style 与 Name（Speaker）字段 */
const DIALOGUE_RE =
  /^Dialogue:\s*\d+,(\d+:\d{2}:\d{2}(?:\.\d{1,3})?),(\d+:\d{2}:\d{2}(?:\.\d{1,3})?),([^,]*),([^,]*),/;

/** 匹配卡拉OK 标签 {\kf<n>} / {\k<n>} / {\K<n>} */
const KARAOKE_RE = /\{\\[kK]f?(\d+)\}([^{]*)/g;

/** 匹配所有 ASS 标签 {\xxx} */
const ASS_TAG_RE = /\{[^}]*\}/g;

/**
 * 解析 ASS 时间戳为毫秒数
 * @param value - ASS 格式时间字符串（如 "1:23:45.67" 或 "0:01:23.456"）
 * @returns 对应毫秒数
 */
const parseAssTime = (value: string): number => {
  const parts = value.split(":");
  if (parts.length < 3) return 0;
  const hr = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  const secParts = parts[2].split(".");
  const sec = parseInt(secParts[0], 10);
  const fractionStr = secParts[1] ?? "0";
  let ms = 0;
  if (fractionStr.length === 2) {
    ms = parseInt(fractionStr, 10) * 10;
  } else if (fractionStr.length === 1) {
    ms = parseInt(fractionStr, 10) * 100;
  } else {
    ms = parseInt(fractionStr.slice(0, 3), 10);
  }
  return ((hr * 60 + min) * 60 + sec) * 1000 + ms;
};

/**
 * 从文本中解析卡拉OK 逐字标签为单词数组
 * @param text - 包含卡拉OK 标签的文本
 * @param lineStart - 当前行的起始时间毫秒数
 * @returns 逐字单词数组，无卡拉OK 标签返回 null
 */
const parseKaraokeWords = (text: string, lineStart: number): LyricWord[] | null => {
  KARAOKE_RE.lastIndex = 0;
  const words: LyricWord[] = [];
  let cursor = lineStart;
  let match: RegExpExecArray | null;

  while ((match = KARAOKE_RE.exec(text)) !== null) {
    const durationCs = parseInt(match[1], 10);
    const word = match[2];
    if (!word && durationCs === 0) continue;

    const startTime = cursor;
    const endTime = cursor + durationCs * 10;
    if (word) {
      words.push({ startTime, endTime, word });
    }
    cursor = endTime;
  }

  return words.length > 0 ? words : null;
};

/**
 * 剥除 ASS 格式样式特效标签
 * @param text - 包含样式的原始文本
 * @returns 剥除特效标签后的纯文本
 */
const stripAssTags = (text: string): string => text.replace(ASS_TAG_RE, "");

interface DialogueLine {
  startTime: number;
  endTime: number;
  style: string;
  speaker: string;
  text: string;
}

/**
 * 解析 ASS 字幕文本
 * @param text - ASS 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseASS = (text: string, options: ParseOptions = {}): LyricResult => {
  const { extractMetadata = false, cleanKangxi = false } = options;
  const content = cleanKangxi ? normalizeKangxi(text) : text;

  const metadata: LyricMetadata = {};
  const dialogues: DialogueLine[] = [];

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (extractMetadata && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const propKey = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const propVal = trimmed.slice(colonIdx + 1).trim();
      if (propKey === "title") metadata.title = [propVal];
      else if (propKey === "original script" || propKey === "author") metadata.authors = [propVal];
    }

    const match = DIALOGUE_RE.exec(trimmed);
    if (!match) continue;

    const parts = trimmed.split(",");
    const dialogueText = parts.slice(9).join(",");
    dialogues.push({
      startTime: parseAssTime(match[1]),
      endTime: parseAssTime(match[2]),
      style: match[3].trim().toLowerCase(),
      speaker: match[4].trim().toLowerCase(),
      text: dialogueText,
    });
  }

  const groups = new Map<string, { orig?: DialogueLine; ts?: DialogueLine; roma?: DialogueLine }>();
  for (const dialogue of dialogues) {
    const speaker = dialogue.speaker;
    const style = dialogue.style;
    const isTrans =
      style === "ts" ||
      style === "translate" ||
      style === "translation" ||
      speaker.includes("trans") ||
      style.includes("trans");
    const isRoma =
      style === "roma" ||
      style === "roman" ||
      style === "romaji" ||
      speaker.includes("roman") ||
      speaker.includes("roma") ||
      style.includes("roman") ||
      style.includes("roma");

    const track = speaker || (style.startsWith("v") ? style : "");
    const trackBase = track.replace(/-(trans|roman|roma)$/, "");
    const key = `${dialogue.startTime}-${dialogue.endTime}-${trackBase}`;
    const group = groups.get(key) ?? {};

    if (isTrans) {
      group.ts = dialogue;
    } else if (isRoma) {
      group.roma = dialogue;
    } else {
      group.orig = dialogue;
    }
    groups.set(key, group);
  }

  const lines: LyricLine[] = [];
  for (const group of groups.values()) {
    const source = group.orig;
    if (!source) continue;

    const karaokeWords = parseKaraokeWords(source.text, source.startTime);
    const words: LyricWord[] = karaokeWords ?? [
      { startTime: source.startTime, endTime: source.endTime, word: stripAssTags(source.text) },
    ];

    const translation = group.ts ? stripAssTags(group.ts.text).trim() : "";
    const translatedLyric = isMeaningfulTranslation(translation) ? translation : "";
    const romanLyric = group.roma ? stripAssTags(group.roma.text).trim() : "";

    const track = source.speaker || source.style;
    const isDuet = track.includes("v2");
    const isBG = track.includes("bg");

    const line: LyricLine = {
      words,
      translatedLyric,
      romanLyric,
      startTime: source.startTime,
      endTime: source.endTime,
      isBG,
      isDuet,
    };
    lines.push(karaokeWords ? line : markLineTimed(line));
  }

  lines.sort((lineA, lineB) => lineA.startTime - lineB.startTime);

  if (extractMetadata) {
    const hasWordTiming = lines.some((line) => (line.words?.length ?? 0) > 1);
    metadata.timingMode = hasWordTiming ? "Word" : "Line";
  }

  return {
    lines,
    metadata,
  };
};
