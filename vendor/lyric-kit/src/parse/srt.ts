import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type { LyricLine, LyricResult, ParseOptions } from "../types";
import { markLineTimed } from "./timing";

/** 兼容整秒时间戳，并保留时间后面的字幕坐标扩展 */
const TIME_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:[,.](\d{1,3}))?(?=\s|$)/;

/**
 * 解析 SRT 时间戳为毫秒数
 * @param value - SRT 格式时间字符串（如 "01:23:45,678"）
 * @returns 对应毫秒数，格式无效时返回 null
 */
const parseSrtTime = (value: string): number | null => {
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const hr = parseInt(match[1], 10);
  const min = parseInt(match[2], 10);
  const sec = parseInt(match[3], 10);
  const fraction = match[4] ?? "0";
  let ms = parseInt(fraction, 10);
  if (fraction.length === 1) ms *= 100;
  else if (fraction.length === 2) ms *= 10;
  return ((hr * 60 + min) * 60 + sec) * 1000 + ms;
};

/**
 * 解析 SRT 字幕文本
 * @param text - SRT 文本内容
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseSRT = (text: string, options: ParseOptions = {}): LyricResult => {
  const { cleanKangxi = false, multiLineMode = "join" } = options;
  const content = cleanKangxi ? normalizeKangxi(text) : text;

  const lines: LyricLine[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\n+/);

  for (const block of blocks) {
    const parts = block.trim().split("\n");
    if (parts.length < 2) continue;

    let timeLineIdx = 0;
    if (/^\d+$/.test(parts[0].trim())) {
      timeLineIdx = 1;
    }

    if (parts.length <= timeLineIdx) continue;

    const timeLine = parts[timeLineIdx];
    const arrowIdx = timeLine.indexOf("-->");
    if (arrowIdx === -1) continue;

    const startTime = parseSrtTime(timeLine.slice(0, arrowIdx));
    const endTime = parseSrtTime(timeLine.slice(arrowIdx + 3));
    if (startTime === null || endTime === null || endTime < startTime) continue;

    const textLines = parts
      .slice(timeLineIdx + 1)
      .filter((line) => line.trim())
      .map((line) => line.trim());
    if (textLines.length === 0) continue;

    let mainText = "";
    let translatedLyric = "";
    let romanLyric = "";

    if (multiLineMode === "bilingual") {
      mainText = textLines[0] ?? "";
      const translation = textLines[1] ?? "";
      translatedLyric = isMeaningfulTranslation(translation) ? translation : "";
      romanLyric = textLines[2] ?? "";
    } else {
      mainText = textLines.join(" ");
    }

    lines.push(
      markLineTimed({
        words: [{ startTime, endTime, word: mainText }],
        translatedLyric,
        romanLyric,
        startTime,
        endTime,
        isBG: false,
        isDuet: false,
      }),
    );
  }

  return {
    lines,
    metadata: options?.extractMetadata ? { timingMode: "Line" } : {},
  };
};
