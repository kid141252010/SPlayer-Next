import { parseLyric } from "../parse";
import type {
  LyricInput,
  LyricLine,
  LyricResult,
  ParseOptions,
  SerializeLyricFormat,
  SerializeOptions,
} from "../types";
import { toEnhancedLRC, toLRC } from "./lrc";
import { toSRT } from "./srt";
import { toTTML } from "./ttml";

export { toEnhancedLRC, toLRC } from "./lrc";
export { toSRT } from "./srt";
export { toTTML } from "./ttml";

type SerializeInput = LyricLine[] | LyricResult | LyricInput | string;

/** @deprecated 解析配置请放入 options.parse，原有扁平调用仍兼容 */
export function serializeLyric(
  input: SerializeInput,
  target: SerializeLyricFormat | undefined,
  options: ParseOptions,
): string;

/**
 * 歌词序列化统一入口函数
 * @param input - 待序列化的歌词行数组、LyricResult 解析结果、LyricInput 对象或原生歌词字符串
 * @param target - 目标导出格式
 * @default "lrc"
 * @param options - 导出配置，原始文本的解析配置放入 parse
 * @returns 格式化后的字符串；若无有效内容返回空字符串
 */
export function serializeLyric(
  input: SerializeInput,
  target?: SerializeLyricFormat,
  options?: SerializeOptions,
): string;
export function serializeLyric(
  input: SerializeInput,
  target: SerializeLyricFormat = "lrc",
  options: SerializeOptions | ParseOptions = {},
): string {
  // 兼容原有扁平解析参数，嵌套配置存在时优先使用
  const parseOptions = {
    extractMetadata: true,
    ...options,
    ...("parse" in options ? options.parse : {}),
  };
  const exportOptions = "roundTrip" in options ? { roundTrip: options.roundTrip } : {};
  const parsed = Array.isArray(input)
    ? { lines: input, metadata: {} }
    : typeof input === "string"
      ? parseLyric(input, parseOptions)
      : "lines" in input
        ? input
        : parseLyric(input, parseOptions);

  if (!parsed.lines || parsed.lines.length === 0) return "";

  switch (target) {
    case "ttml":
      return toTTML(parsed);
    case "elrc":
      return toEnhancedLRC(parsed.lines, exportOptions);
    case "srt":
      return toSRT(parsed.lines, exportOptions);
    default:
      return toLRC(parsed.lines, exportOptions);
  }
}
