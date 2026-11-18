import type { LyricLine, SerializeOptions } from "../types";
import { getLineText } from "../utils/text";
import { formatLrcTime, formatTtmlTime } from "../utils/timestamp";

/**
 * 将背景人声文本包裹括号，防止回读与翻译冲突
 * @param text - 原始文本
 * @returns 括号包裹后的文本
 */
const formatBgText = (text: string): string => {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("(") && trimmed.endsWith(")")) ||
    (trimmed.startsWith("（") && trimmed.endsWith("）"))
  ) {
    return text;
  }
  return `(${text})`;
};

/**
 * 将歌词行序列化为标准逐行 LRC 格式
 * @param lines - 歌词行数组
 * @returns LRC 格式字符串
 */
export const toLRC = (lines: LyricLine[], options: SerializeOptions = {}): string => {
  const out: string[] = [];
  const formatTime = options.roundTrip ? formatTtmlTime : formatLrcTime;
  for (const line of lines) {
    let text = getLineText(line);
    if (!text) continue;
    if (line.isBG) text = formatBgText(text);
    const ts = `[${formatTime(line.startTime)}]`;
    out.push(`${ts}${text}`);
    appendAuxiliary(out, line, ts, options.roundTrip);
  }
  return out.join("\n");
};

/** 同步辅助行的声部标记，用占位翻译保留只有罗马音时的字段位置 */
const appendAuxiliary = (out: string[], line: LyricLine, ts: string, roundTrip = false): void => {
  const wrap = (text: string): string => (roundTrip && line.isBG ? formatBgText(text) : text);
  if (line.translatedLyric || (roundTrip && line.romanLyric)) {
    out.push(`${ts}${wrap(line.translatedLyric || "//")}`);
  }
  if (line.romanLyric) out.push(`${ts}${wrap(line.romanLyric)}`);
};

/**
 * 将歌词行序列化为逐字增强型 LRC 格式
 * @param lines - 歌词行数组
 * @returns 增强型 LRC 格式字符串
 */
export const toEnhancedLRC = (lines: LyricLine[], options: SerializeOptions = {}): string => {
  const out: string[] = [];
  const formatTime = options.roundTrip ? formatTtmlTime : formatLrcTime;
  for (const line of lines) {
    if (line.words.length === 0) continue;
    const lineTs = `[${formatTime(line.startTime)}]`;
    let body = line.words
      .map((word, index) => {
        let text = word.word;
        if (options.roundTrip && line.isBG) {
          if (index === 0) text = `(${text}`;
          if (index === line.words.length - 1) text += ")";
        }
        let part = `<${formatTime(word.startTime)}>${text}`;
        if (
          options.roundTrip &&
          word.endTime > word.startTime &&
          word.endTime !== line.words[index + 1]?.startTime
        ) {
          part += `<${formatTime(word.endTime)}>`;
        }
        return part;
      })
      .join("");
    if (!body.trim()) continue;
    if (line.isBG && !options.roundTrip) body = formatBgText(body);
    out.push(`${lineTs}${body}`);
    appendAuxiliary(out, line, lineTs, options.roundTrip);
  }
  return out.join("\n");
};
