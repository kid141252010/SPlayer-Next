import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type { LyricFormat, LyricInput, LyricLine, LyricResult, ParseOptions } from "../types";
import { applyKanaToLines } from "../utils/kana";
import { alignRomanization } from "../utils/roman";
import { parseASS } from "./ass";
import { parseKRC } from "./krc";
import { parseLRC } from "./lrc";
import { parseLyS } from "./lys";
import { parseQRC } from "./qrc";
import { parseSRT } from "./srt";
import { isLineTimed } from "./timing";
import { parseTTML } from "./ttml";
import { parseYRC } from "./yrc";

export { alignRomanization } from "../utils/roman";
export { parseASS } from "./ass";
export { parseKRC } from "./krc";
export { parseLRC } from "./lrc";
export { parseLyS } from "./lys";
export { parseQRC } from "./qrc";
export { parseSRT } from "./srt";
export type { DOMParserConstructor, DOMParserLike } from "./ttml";
export { parseTTML } from "./ttml";
export { parseYRC } from "./yrc";

/** 对齐容差（毫秒） */
const ALIGN_TOLERANCE_MS = 300;

/**
 * 根据内容特征检测歌词格式
 * @param text - 歌词文本内容
 * @returns 检测到的格式
 * @default "lrc"
 */
export const detectFormat = (text: string): LyricFormat => {
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("[Script Info]") ||
    /^\[V4\+? Styles\]/m.test(text) ||
    /^Dialogue:\s*\d+,\d+:\d{2}:\d{2}(?:\.\d{1,3})?,/m.test(text)
  ) {
    return "ass";
  }
  if (/^(?:\d+\r?\n)?\d{1,2}:\d{2}:\d{2}(?:[,.]\d{1,3})?\s*-->/.test(trimmed)) return "srt";
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    if (/LyricContent="|<QrcInfos|<Lyric_/.test(text)) return "qrc";
    if (trimmed.startsWith("<tt") || /<tt\s/i.test(text)) return "ttml";
  }
  if (/\[\d+,\d+\]\(\d+,\d+,\d+\)/.test(text)) return "yrc";
  if (/\[\d+,\d+\][^[\n]+\(\d+,\d+\)/.test(text)) return "qrc";
  if (/^\[\d\][^[\]]+\(\d+,\d+\)/m.test(text)) return "lys";
  if (/\[id:\$\d+\]/i.test(text) || /<\d+,\d+(?:,\d+)?>/.test(text)) return "krc";
  return "lrc";
};

/**
 * 根据指定格式调用对应的解析器解析歌词内容
 * @param text - 待解析的歌词文本
 * @param format - 歌词格式
 * @param options - 解析配置选项
 * @returns 解析后的歌词结果对象
 */
const parseContent = (
  text: string,
  format: LyricFormat,
  options: ParseOptions = {},
): LyricResult => {
  switch (format) {
    case "ttml":
      return parseTTML(text, options);
    case "qrc":
      return parseQRC(text, options);
    case "krc":
      return parseKRC(text, options);
    case "yrc":
      return parseYRC(text, options);
    case "lrc":
      return parseLRC(text, options);
    case "lys":
      return parseLyS(text, options);
    case "srt":
      return parseSRT(text, options);
    case "ass":
      return parseASS(text, options);
  }
};

/**
 * 获取单行歌词的所有词拼接纯文本
 * @param line - 歌词行对象
 * @returns 拼接后的纯文本字符串
 */
const lineText = (line: LyricLine): string =>
  line.words
    .map((word) => word.word)
    .join("")
    .trim();

/**
 * 判断歌词行是否具备可用于逐字音译对齐的时间信息
 * @param line - 歌词行对象
 * @returns 是否具备逐字时间信息
 */
const hasWordTiming = (line: LyricLine): boolean => {
  if (isLineTimed(line)) return false;
  const { words } = line;
  return words.length > 1 || (words.length === 1 && words[0].endTime > words[0].startTime);
};

/**
 * 将翻译/音译歌词按时间戳对齐到主歌词行
 * @param lines - 主歌词行数组（原地修改）
 * @param transLines - 已解析的翻译/音译歌词行
 * @param field - 写入目标字段名称
 * @returns 无返回值（原地修改）
 */
export const pairTranslation = (
  lines: LyricLine[],
  transLines: LyricLine[],
  field: "translatedLyric" | "romanLyric",
): void => {
  if (lines.length === 0 || transLines.length === 0) return;
  const assignedMain = new Set<LyricLine>();
  const assignedTrans = new Set<LyricLine>();
  const assign = (main: LyricLine, trans: LyricLine): void => {
    assignedMain.add(main);
    assignedTrans.add(trans);
    const text = lineText(trans);
    if (isMeaningfulTranslation(text)) main[field] = text;
    if (field === "romanLyric" && hasWordTiming(main) && hasWordTiming(trans)) {
      alignRomanization(main.words, trans.words);
    }
  };

  const pairGroup = (main: LyricLine[], trans: LyricLine[]): void => {
    if (main.length === 0 || trans.length === 0) return;
    main.sort((a, b) => a.startTime - b.startTime);
    trans.sort((a, b) => a.startTime - b.startTime);
    const matched = new Set<LyricLine>();
    const pending: LyricLine[] = [];
    // 先预留所有精确时间戳，避免容差匹配抢占后续的精确匹配
    let exactIndex = 0;
    for (const item of trans) {
      while (exactIndex < main.length && main[exactIndex].startTime < item.startTime) exactIndex++;
      if (main[exactIndex]?.startTime === item.startTime) {
        const target = main[exactIndex++];
        assign(target, item);
        matched.add(target);
      } else pending.push(item);
    }

    if (pending.length === 0) return;
    const available = main.filter((line) => !matched.has(line));
    if (available.length === 0) return;
    const next = createAvailableIndex(available.length);
    const previous = createAvailableIndex(available.length);
    const lowerBound = (time: number): number => {
      let low = 0;
      let high = available.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (available[mid].startTime < time) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    for (const item of pending) {
      const low = lowerBound(item.startTime);
      const right = next.find(low);
      const left = available.length - 1 - previous.find(available.length - low);
      const leftDiff = left >= 0 ? item.startTime - available[left].startTime : Infinity;
      const rightDiff =
        right < available.length ? available[right].startTime - item.startTime : Infinity;
      if (Math.min(leftDiff, rightDiff) > ALIGN_TOLERANCE_MS) continue;
      const nearest = leftDiff <= rightDiff ? left : right;
      // 同时间戳的多个候选保持输入顺序
      const index = next.find(lowerBound(available[nearest].startTime));
      assign(available[index], item);
      next.remove(index);
      previous.remove(available.length - 1 - index);
    }
  };
  const pairGroups = (
    main: LyricLine[],
    trans: LyricLine[],
    mode: "agent" | "voice" | "background" | "any",
  ): void => {
    if (main.length === 0 || trans.length === 0) return;
    const groups = new Map<string, { main: LyricLine[]; trans: LyricLine[] }>();
    for (const [items, field] of [
      [main, "main"],
      [trans, "trans"],
    ] as const) {
      for (const item of items) {
        const key = JSON.stringify([
          mode !== "any" && item.isBG,
          (mode === "voice" || (mode === "agent" && !item.agentId)) && item.isDuet,
          mode === "agent" ? (item.agentId ?? "") : "",
        ]);
        let group = groups.get(key);
        if (!group) {
          group = { main: [], trans: [] };
          groups.set(key, group);
        }
        group[field].push(item);
      }
    }
    for (const group of groups.values()) pairGroup(group.main, group.trans);
  };

  pairGroups(lines, transLines, "agent");
  // 逐步兼容未标记歌手或声部的辅助文件，双方明确标记的不同歌手不互相回退。
  for (const mode of ["voice", "background", "any"] as const) {
    if (assignedTrans.size === transLines.length || assignedMain.size === lines.length) return;
    pairGroups(
      lines.filter((line) => !assignedMain.has(line)),
      transLines.filter((line) => !assignedTrans.has(line) && !line.agentId),
      mode,
    );
    pairGroups(
      lines.filter((line) => !assignedMain.has(line) && !line.agentId),
      transLines.filter((line) => !assignedTrans.has(line) && !!line.agentId),
      mode,
    );
  }
};

/** 跳过已消费索引，通过路径压缩避免密集时间戳反复线性扫描，末项为越界哨兵 */
const createAvailableIndex = (length: number) => {
  const parents = Uint32Array.from({ length: length + 1 }, (_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  return {
    find,
    remove: (index: number): void => {
      parents[index] = find(index + 1);
    },
  };
};

/**
 * 解析歌词主入口函数
 * @param input - 歌词输入载荷（纯文本字符串或 LyricInput 载荷对象）
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseLyric = (input: string | LyricInput, options: ParseOptions = {}): LyricResult => {
  const payload: LyricInput = typeof input === "string" ? { content: input } : input;
  const { format } = options;
  const actualFormat = format ?? payload.format ?? detectFormat(payload.content);

  // QRC/KRC 的 kana 按原始基字符计数，外部注音也必须在部首归一化前对齐。
  const deferKangxi =
    payload.kana && options.cleanKangxi && (actualFormat === "qrc" || actualFormat === "krc");
  const collectKanaOffset =
    payload.kana &&
    options.applyOffset &&
    ["lrc", "qrc", "krc", "yrc", "lys"].includes(actualFormat);
  const mainResult = parseContent(payload.content, actualFormat, {
    ...options,
    ...(deferKangxi ? { cleanKangxi: false } : {}),
    ...(collectKanaOffset ? { extractMetadata: true } : {}),
  });
  const lines = mainResult.lines;

  if (payload.translation) {
    const transFormat = payload.translationFormat ?? detectFormat(payload.translation);
    pairTranslation(
      lines,
      parseContent(payload.translation, transFormat, options).lines,
      "translatedLyric",
    );
  }

  if (payload.romaji) {
    const romajiFormat = payload.romajiFormat ?? detectFormat(payload.romaji);
    pairTranslation(lines, parseContent(payload.romaji, romajiFormat, options).lines, "romanLyric");
  }

  if (payload.kana && !lines.some((line) => line.words.some((word) => word.ruby?.length))) {
    applyKanaToLines(lines, payload.kana, collectKanaOffset ? mainResult.metadata.offset : 0);
  }

  if (deferKangxi) {
    for (const line of lines) {
      for (const word of line.words) word.word = normalizeKangxi(word.word);
    }
  }

  return {
    lines,
    metadata: options.extractMetadata ? mainResult.metadata : {},
  };
};
