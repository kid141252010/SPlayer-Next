import type { LyricLanguage, LyricLine } from "../types";

/** 日语假名：平假名 + 片假名 + 半角假名 + 促音/长音符号 */
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC\uFF66-\uFF9F]/u;

/** 韩文：谚文音节 + 谚文字母 + 谚文兼容字母 */
const HANGUL_RE = /[\p{Script=Hangul}\u3130-\u318F]/u;

/** 中日韩统一表意文字（含扩展 A 区） */
const HAN_RE = /\p{Script=Han}/u;

/** 拉丁字母；数字与标点不能作为英文判断依据 */
const LATIN_RE = /\p{Script=Latin}/u;

/**
 * 假名/谚文行与汉字行数量比例的判定阈值。
 * 典型日文歌中助词及假名普遍存在，假名行数与汉字行数比例通常高于 50%；
 * 华语歌曲中偶发插入单句日文/韩文时该比值通常极低（< 0.2）。
 * 取 0.37 作为兼顾双语混杂与纯汉字歌名的经验分水岭。
 */
const CJK_RATIO_THRESHOLD = 0.37;

/**
 * 判断歌词行是否包含有效的翻译歌词
 * @param line - 歌词行对象
 * @returns 是否包含非空翻译
 */
const hasTranslation = (line: LyricLine): boolean => line.translatedLyric.trim().length > 0;

/**
 * 为歌词行自动推断并填充语言代码（ja / ko / zh-CN / und-Latn）
 *
 * - Han 脚本无法独立区分中日韩，会结合行内 ruby 注音、全文翻译和 CJK 比例进行推断；
 * - 拉丁文字使用 BCP 47 的 und-Latn，避免误标为英语。
 *
 * @param lines - 歌词行数组（原地更新各行 language 属性）
 * @returns 无返回值（原地修改）
 */
export const applyLyricLanguages = (lines: LyricLine[]): void => {
  const lineContents = lines.map((line) =>
    line.words
      .map((word) => {
        // 将 ruby 注音内容一并纳入字符集扫描，以考虑纯汉字但 ruby 为假名的情况
        const rubyText = word.ruby?.map((span) => span.word).join("");
        return `${word.word}${rubyText ? `(${rubyText})` : ""}`;
      })
      .join(""),
  );

  // 统计全局行级 CJK 特征
  let hanLineCount = 0;
  let kanaLineCount = 0;
  let hangulLineCount = 0;
  let kanaTranslatedCount = 0;
  let hangulTranslatedCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const content = lineContents[index];
    const isTranslated = hasTranslation(lines[index]);

    if (HAN_RE.test(content)) {
      hanLineCount++;
    }
    if (KANA_RE.test(content)) {
      kanaLineCount++;
      if (isTranslated) kanaTranslatedCount++;
    }
    if (HANGUL_RE.test(content)) {
      hangulLineCount++;
      if (isTranslated) hangulTranslatedCount++;
    }
  }

  const hasHan = hanLineCount > 0;
  const hasKana = kanaLineCount > 0;
  const hasHangul = hangulLineCount > 0;

  // CJK 翻译启发式标志
  const allKanaTranslated = hasKana && kanaTranslatedCount === kanaLineCount;
  const allHangulTranslated = hasHangul && hangulTranslatedCount === hangulLineCount;

  // CJK 比例判定
  const kanaRatio = hasHan ? kanaLineCount / hanLineCount : Number.POSITIVE_INFINITY;
  const hangulRatio = hasHan ? hangulLineCount / hanLineCount : Number.POSITIVE_INFINITY;

  let mainCJK: LyricLanguage = "zh-CN";
  if (hasHan) {
    if (kanaRatio > CJK_RATIO_THRESHOLD && hangulRatio > CJK_RATIO_THRESHOLD) {
      mainCJK = hangulLineCount > kanaLineCount ? "ko" : "ja";
    } else if (kanaRatio > CJK_RATIO_THRESHOLD) {
      mainCJK = "ja";
    } else if (hangulRatio > CJK_RATIO_THRESHOLD) {
      mainCJK = "ko";
    } else {
      mainCJK = "zh-CN";
    }
  }

  // 判断纯汉字行的语言
  const getPureHanLineLang = (line: LyricLine): LyricLanguage => {
    const isTranslated = hasTranslation(line);

    if (allKanaTranslated) {
      return isTranslated ? "ja" : "zh-CN";
    }
    if (allHangulTranslated) {
      return isTranslated ? "ko" : "zh-CN";
    }

    return mainCJK;
  };

  // 逐行标注
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const content = lineContents[index];

    if (KANA_RE.test(content)) {
      line.language = "ja";
    } else if (HANGUL_RE.test(content)) {
      line.language = "ko";
    } else if (HAN_RE.test(content)) {
      line.language = getPureHanLineLang(line);
    } else if (LATIN_RE.test(content)) {
      line.language = "und-Latn";
    } else {
      delete line.language;
    }
  }
};
