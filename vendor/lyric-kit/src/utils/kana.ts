import type { LyricLine, LyricSpan, LyricWord } from "../types";

/**
 * 匹配可被 kana 注音、且按字符计数的 CJK 基字符
 *
 * - CJK 统一表意文字基本区 `\u4e00-\u9fff`
 * - CJK 统一表意文字扩展 A `\u3400-\u4dbf`
 * - 日文汉字叠字 々 `\u3005`
 * - 日文符号 〆 `\u3006`
 */
const CJK_BASE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3005\u3006]/;

/**
 * 匹配需要按逐词 token 计数的半角或全角数字
 */
const DIGIT_REGEX = /[0-9０-９]/;

/** 单个假名注音单元 */
export interface KanaUnit {
  /** 对应的连续汉字数量 */
  kanjiCount: number;
  /** 假名注音纯文本 */
  kanaText: string;
  /** 若假名自身切分了逐字时间戳，则包含细分片段 */
  spans?: LyricSpan[];
}

/**
 * 解析 QRC / KRC 中的 [kana: ...] 单行标签内容
 * @param rawKanaTag - 包含 [kana:...] 的完整标签字符串或标签内部内容
 * @returns 解析后的注音单元序列
 */
export const parseKanaUnits = (rawKanaTag: string): KanaUnit[] => {
  const content = rawKanaTag.replace(/^\[kana:/, "").replace(/\]$/, "");
  const units: KanaUnit[] = [];

  let charIndex = 0;
  while (charIndex < content.length) {
    const currentChar = content[charIndex];

    // 汉字计数字符（1-9）
    if (currentChar >= "1" && currentChar <= "9") {
      const kanjiCount = parseInt(currentChar, 10);
      charIndex++;

      let kanaText = "";
      const spans: LyricSpan[] = [];

      while (charIndex < content.length) {
        const nextChar = content[charIndex];

        // 遇到下一个汉字计数（不在时间戳括号内），结束当前单元
        if (nextChar >= "1" && nextChar <= "9") {
          break;
        }

        // 处理带时间戳的假名，如 か(2964,296)
        if (nextChar === "(") {
          const closeParenIndex = content.indexOf(")", charIndex);
          if (closeParenIndex !== -1) {
            const timeSlice = content.slice(charIndex + 1, closeParenIndex);
            const commaIndex = timeSlice.indexOf(",");
            if (commaIndex !== -1) {
              const startMs = parseInt(timeSlice.slice(0, commaIndex), 10);
              const durationMs = parseInt(timeSlice.slice(commaIndex + 1), 10);
              if (!Number.isNaN(startMs) && !Number.isNaN(durationMs)) {
                const targetChar = kanaText[kanaText.length - 1] || "";
                spans.push({
                  word: targetChar,
                  startTime: startMs,
                  endTime: startMs + durationMs,
                });
              }
            }
            charIndex = closeParenIndex + 1;
            continue;
          }
        }

        kanaText += nextChar;
        charIndex++;
      }

      units.push({
        kanjiCount,
        kanaText,
        spans: spans.length > 0 ? spans : undefined,
      });
    } else {
      // 容错步进
      charIndex++;
    }
  }

  return units;
};

/** 汉字在歌词中的定位项 */
interface KanjiLocation {
  charIndexInWord: number;
  charLength: number;
  wordRef: LyricWord;
}

/**
 * 将解析出的 [kana: ...] 注音对齐并挂载到歌词行的每个 LyricWord 上
 * @param lines - 已解析出的歌词行列表
 * @param rawKanaTag - [kana:...] 标签字符串
 * @param timingOffset - 仅作用于标签内显式音节时间戳的偏移毫秒数
 */
export const applyKanaToLines = (
  lines: LyricLine[],
  rawKanaTag: string,
  timingOffset = 0,
): void => {
  if (!rawKanaTag?.includes("[kana:")) return;

  const units = parseKanaUnits(rawKanaTag);
  if (units.length === 0) return;

  // 1. 扫描正文中所有汉字的位置索引
  const kanjiLocations: KanjiLocation[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const currentLine = lines[lineIndex];
    for (let wordIndex = 0; wordIndex < currentLine.words.length; wordIndex++) {
      const currentWord = currentLine.words[wordIndex];
      const wordText = currentWord.word;
      let charIndex = 0;
      while (charIndex < wordText.length) {
        if (CJK_BASE_REGEX.test(wordText[charIndex])) {
          kanjiLocations.push({
            charIndexInWord: charIndex,
            charLength: 1,
            wordRef: currentWord,
          });
          charIndex++;
          continue;
        }

        // 连续数字串只消费一个基字符，例如 `27` 计一次，`22/7` 计两次。
        if (DIGIT_REGEX.test(wordText[charIndex])) {
          const firstNumberIndex = charIndex;
          while (charIndex < wordText.length && DIGIT_REGEX.test(wordText[charIndex])) {
            charIndex++;
          }
          kanjiLocations.push({
            charIndexInWord: firstNumberIndex,
            charLength: charIndex - firstNumberIndex,
            wordRef: currentWord,
          });
          continue;
        }

        charIndex++;
      }
    }
  }

  if (kanjiLocations.length === 0) return;

  // 2. 顺序对齐注音单元与汉字
  let kanjiLocationPointer = 0;

  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    if (kanjiLocationPointer >= kanjiLocations.length) break;

    const unit = units[unitIndex];
    const matchCount = Math.min(unit.kanjiCount, kanjiLocations.length - kanjiLocationPointer);
    const targetKanjiLocs = kanjiLocations.slice(
      kanjiLocationPointer,
      kanjiLocationPointer + matchCount,
    );
    kanjiLocationPointer += matchCount;

    // 若假名内容为空（无注音占位符），仅消费汉字游标
    if (!unit.kanaText) continue;

    // 存在时间戳细分音节
    if (unit.spans && unit.spans.length > 0) {
      // 挂载到第一个汉字所在的 word
      const primaryWord = targetKanjiLocs[0].wordRef;
      if (!primaryWord.ruby) {
        primaryWord.ruby = [];
      }
      primaryWord.ruby.push(
        ...unit.spans.map((span) => ({
          ...span,
          startTime: Math.max(0, span.startTime + timingOffset),
          endTime: Math.max(0, span.endTime + timingOffset),
        })),
      );
      continue;
    }

    // 纯文本假名（无细分时间戳）
    if (targetKanjiLocs.length === 1) {
      // 单汉字对应
      const singleLoc = targetKanjiLocs[0];
      const targetWord = singleLoc.wordRef;
      const totalChars = targetWord.word.length;

      let rubyStartTime = targetWord.startTime;
      let rubyEndTime = targetWord.endTime;

      // 如果 word 包含多个字符且汉字只是其中一部分，按字符位置切分估算起止时间
      if (totalChars > 1 && rubyEndTime > rubyStartTime) {
        const charDuration = (rubyEndTime - rubyStartTime) / totalChars;
        rubyStartTime = Math.round(targetWord.startTime + singleLoc.charIndexInWord * charDuration);
        rubyEndTime = Math.round(
          targetWord.startTime + (singleLoc.charIndexInWord + singleLoc.charLength) * charDuration,
        );
      }

      if (!targetWord.ruby) {
        targetWord.ruby = [];
      }
      targetWord.ruby.push({
        word: unit.kanaText,
        startTime: rubyStartTime,
        endTime: rubyEndTime,
      });
    } else {
      // 多个汉字联合对应注音（例如 "2きょう" 对应 "今日"）
      const firstLoc = targetKanjiLocs[0];
      const lastLoc = targetKanjiLocs[targetKanjiLocs.length - 1];
      const targetWord = firstLoc.wordRef;

      const rubyStartTime = firstLoc.wordRef.startTime;
      const rubyEndTime = lastLoc.wordRef.endTime;

      if (!targetWord.ruby) {
        targetWord.ruby = [];
      }
      targetWord.ruby.push({
        word: unit.kanaText,
        startTime: rubyStartTime,
        endTime: Math.max(rubyEndTime, rubyStartTime),
      });
    }
  }
};
