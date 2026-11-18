import type { LyricLine, LyricWord } from "../types";
import { getLineText } from "./text";

/** 行首括号（全 / 半角），允许前导空白 */
const OPEN_PAREN_RE = /^\s*[（(]/;

/** 闭括号后允许尾随的语气标点符号与空白字符集 */
const TRAILING_PUNCT_CLASS = "[!?,.~!！?？，。~…、:：\\s]";

/** 闭括号及允许尾随的常见标点符号和空格 */
const CLOSE_PAREN_RE = new RegExp(`[）)]${TRAILING_PUNCT_CLASS}*$`, "u");

/** 仅由允许的语气标点与空白组成的正则 */
const TRAILING_PUNCT_ONLY_RE = new RegExp(`^${TRAILING_PUNCT_CLASS}*$`, "u");

/** 汉字匹配 */
const HAN_RE = /\p{Script=Han}/u;

/** 日文假名 */
const KANA_ONLY_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}\u30fc\s]+$/u;

/**
 * 拼接单词数组为纯文本字符串
 * @param words - 歌词单词数组
 * @returns 拼接后的纯文本
 */
const joinedWords = (words: LyricWord[]): string => getLineText(words);

/**
 * 剥除文本两端的括号、尾随语气标点与空白字符
 * @param text - 待处理文本
 * @returns 剥除括号与标点后的纯文本
 */
export const stripParensAndPunctuation = (text: string): string =>
  text
    .replace(/^[\s（(]+/, "")
    .replace(CLOSE_PAREN_RE, "")
    .trim();

/**
 * 检查文本是否被单一对外部括号完整包裹（中途未提前闭合，防止首尾假象）
 * @param text - 待检查的完整行文本
 * @returns 是否整行完全由同一对括号包裹
 */
export const isFullyEnclosedByParens = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(") && !trimmed.startsWith("（")) {
    return false;
  }
  let depth = 0;
  let firstCloseAtEnd = -1;

  for (let charIndex = 0; charIndex < trimmed.length; charIndex++) {
    const char = trimmed[charIndex];
    if (char === "(" || char === "（") {
      depth++;
    } else if (char === ")" || char === "）") {
      depth--;
      if (depth < 0) return false;
      if (depth === 0) {
        const remaining = trimmed.slice(charIndex + 1);
        if (TRAILING_PUNCT_ONLY_RE.test(remaining)) {
          firstCloseAtEnd = charIndex;
          break;
        }
        return false;
      }
    }
  }

  return depth === 0 && firstCloseAtEnd !== -1;
};

/**
 * 剥除单词数组首尾的包裹括号，清理空节点并修补起止时间
 * @param words - 待处理的单词数组
 * @param originalStartTime - 原始起始时间戳
 * @param originalEndTime - 原始结束时间戳
 * @returns 清理后的有效单词数组，若全空则返回 null
 */
const stripParensFromWords = (
  words: LyricWord[],
  originalStartTime: number,
  originalEndTime: number,
): LyricWord[] | null => {
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    if (OPEN_PAREN_RE.test(words[wordIndex].word)) {
      words[wordIndex].word = words[wordIndex].word.replace(OPEN_PAREN_RE, "");
      break;
    }
  }

  for (let wordIndex = words.length - 1; wordIndex >= 0; wordIndex--) {
    if (CLOSE_PAREN_RE.test(words[wordIndex].word)) {
      words[wordIndex].word = words[wordIndex].word.replace(CLOSE_PAREN_RE, "");
      break;
    }
  }

  const cleaned = words.filter((word) => word.word !== "");
  if (cleaned.length === 0) return null;

  cleaned[0].startTime = Math.min(cleaned[0].startTime, originalStartTime);
  cleaned[cleaned.length - 1].endTime = Math.max(
    cleaned[cleaned.length - 1].endTime,
    originalEndTime,
  );
  return cleaned;
};

/**
 * 检测整行是否为背景人声并就地剥离包裹括号（清除空节点并保持时间跨度）
 * @param words - 行内单词数组，命中时原地修改首尾单词并清理空节点
 * @param enabled - 是否启用括号启发式检测
 * @returns 是否为背景人声行
 */
export const detectBackgroundLine = (words: LyricWord[], enabled = true): boolean => {
  if (!enabled || words.length === 0) return false;

  const fullText = joinedWords(words);
  if (!isFullyEnclosedByParens(fullText)) return false;

  const innerText = stripParensAndPunctuation(fullText);
  if (!innerText) return false;

  const originalStartTime = words[0].startTime;
  const originalEndTime = words[words.length - 1].endTime;

  const cleaned = stripParensFromWords(words, originalStartTime, originalEndTime);
  if (!cleaned) return false;

  words.length = 0;
  words.push(...cleaned);
  return true;
};

/**
 * 把一行里「行尾的 (…) 段」拆成独立的背景人声行（主歌词（和声）这类行内和声）
 * @param line - 已构建的一行（命中时 words / endTime 被原地修改）
 * @param enabled - 是否启用括号启发式检测
 * @returns 拆出的背景人声行；未命中返回 null
 */
export const splitTrailingBackground = (line: LyricLine, enabled = true): LyricLine | null => {
  if (!enabled) return null;
  const words = line.words;
  if (words.length === 0) return null;

  if (words.length === 1) {
    const text = words[0].word;
    const trimmed = text.trimEnd();
    if (!CLOSE_PAREN_RE.test(trimmed)) return null;

    const closeIdx = trimmed.search(CLOSE_PAREN_RE);
    if (closeIdx === -1) return null;

    let depth = 0;
    let openIdx = -1;
    for (let scanIndex = closeIdx; scanIndex >= 0; scanIndex--) {
      const char = trimmed[scanIndex];
      if (char === ")" || char === "）") {
        depth++;
      } else if (char === "(" || char === "（") {
        depth--;
        if (depth === 0) {
          openIdx = scanIndex;
          break;
        }
      }
    }

    if (openIdx <= 0) return null;

    const mainPart = trimmed.slice(0, openIdx).trimEnd();
    if (!mainPart) return null;

    const bgPart = trimmed.slice(openIdx);
    const bgContent = stripParensAndPunctuation(bgPart);
    if (!bgContent) return null;

    const prevChar = Array.from(mainPart).at(-1) ?? "";
    if (HAN_RE.test(prevChar) && KANA_ONLY_RE.test(bgContent)) return null;

    words[0].word = mainPart;
    return {
      words: [
        {
          startTime: line.startTime,
          endTime: line.endTime,
          word: bgContent,
        },
      ],
      translatedLyric: "",
      romanLyric: "",
      startTime: line.startTime,
      endTime: line.endTime,
      isBG: true,
      isDuet: line.isDuet,
    };
  }

  const lastWord = words[words.length - 1];
  if (!CLOSE_PAREN_RE.test(lastWord.word)) return null;

  let depth = 0;
  let openIndex = -1;
  let openCharIndex = -1;

  for (let index = words.length - 1; index >= 0; index--) {
    const wordText = words[index].word;
    for (let charIdx = wordText.length - 1; charIdx >= 0; charIdx--) {
      const char = wordText[charIdx];
      if (char === ")" || char === "）") {
        depth++;
      } else if (char === "(" || char === "（") {
        depth--;
        if (depth === 0) {
          openIndex = index;
          openCharIndex = charIdx;
          break;
        }
      }
    }
    if (depth === 0 && openIndex !== -1) break;
  }

  if (openIndex < 0) return null;

  const boundaryWord = words[openIndex];
  const prefix = boundaryWord.word.slice(0, openCharIndex);
  const suffix = boundaryWord.word.slice(openCharIndex);
  const mainText = (joinedWords(words.slice(0, openIndex)) + prefix).trimEnd();
  const bgText = stripParensAndPunctuation(suffix + joinedWords(words.slice(openIndex + 1)));
  if (!mainText || !bgText) return null;
  if (HAN_RE.test(Array.from(mainText).at(-1) ?? "") && KANA_ONLY_RE.test(bgText)) return null;

  const bgWords: LyricWord[] = words.slice(openIndex).map((word) => ({ ...word }));
  bgWords[0].word = suffix;
  // 括号紧随主词且未包含和声文字时，不把主词的时长归给和声。
  // 若同一计时词包含两侧文字，沿用原时间跨度，不推测词内的精确分界。
  if (prefix.trim() && !suffix.slice(1).trim()) {
    bgWords[0].startTime = boundaryWord.endTime;
  }

  const originalBgStart = bgWords[0].startTime;
  const originalBgEnd = bgWords[bgWords.length - 1].endTime;

  const cleaned = stripParensFromWords(bgWords, originalBgStart, originalBgEnd);
  if (!cleaned) return null;

  const mainWords = words.slice(0, openIndex).filter((word) => word.word !== "");
  if (prefix.trim()) mainWords.push({ ...boundaryWord, word: prefix.trimEnd() });
  if (mainWords.length === 0) return null;

  line.words = mainWords;
  line.endTime = line.words[line.words.length - 1].endTime;

  return {
    words: cleaned,
    translatedLyric: "",
    romanLyric: "",
    startTime: cleaned[0].startTime,
    endTime: cleaned[cleaned.length - 1].endTime,
    isBG: true,
    isDuet: line.isDuet,
  };
};
