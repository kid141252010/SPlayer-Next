import type { LyricLine, SerializeOptions } from "../types";
import { getLineText } from "../utils/text";
import { formatSrtTime } from "../utils/timestamp";

/**
 * 将歌词行序列化为 SRT 字幕文本
 * @param lines - 歌词行数组
 * @returns SRT 格式字符串
 */
export const toSRT = (lines: LyricLine[], options: SerializeOptions = {}): string => {
  const blocks: string[] = [];
  let index = 1;

  for (const line of lines) {
    const text = getLineText(line);
    if (!text) continue;

    const timeHeader = `${formatSrtTime(line.startTime)} --> ${formatSrtTime(line.endTime)}`;
    const textRows: string[] = [];

    if (options.roundTrip) {
      textRows.push(text);
      if (line.translatedLyric || line.romanLyric) textRows.push(line.translatedLyric || "//");
      if (line.romanLyric) textRows.push(line.romanLyric);
    } else {
      if (line.romanLyric) textRows.push(line.romanLyric);
      if (line.translatedLyric) textRows.push(line.translatedLyric);
      textRows.push(text);
    }

    blocks.push(`${index++}\n${timeHeader}\n${textRows.join("\n")}`);
  }

  return blocks.join("\n\n");
};
