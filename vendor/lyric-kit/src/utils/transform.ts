import type { LyricLine } from "../types";

/**
 * 批量转换歌词文本（支持主字、注音、翻译并安全回填）
 * @param lines - 原始歌词行数组
 * @param transformer - 文本批量转换函数
 * @returns 转换后的全新歌词行数组
 */
export const transformLyricText = async (
  lines: LyricLine[],
  transformer: (texts: string[]) => string[] | Promise<string[]>,
): Promise<LyricLine[]> => {
  if (!lines || lines.length === 0) return lines;

  // 收集所有需要转换的文本片段并记录位置
  const textsToConvert: string[] = [];
  const textPositions: Array<
    | { type: "translated"; lineIndex: number }
    | { type: "word"; lineIndex: number; wordIndex: number }
    | { type: "ruby"; lineIndex: number; wordIndex: number; rubyIndex: number }
  > = [];

  for (let lIdx = 0; lIdx < lines.length; lIdx++) {
    const line = lines[lIdx];

    // 翻译文本
    if (line.translatedLyric) {
      textsToConvert.push(line.translatedLyric);
      textPositions.push({ type: "translated", lineIndex: lIdx });
    }

    // 逐字文本
    if (line.words) {
      for (let wIdx = 0; wIdx < line.words.length; wIdx++) {
        const word = line.words[wIdx];
        if (word.word) {
          textsToConvert.push(word.word);
          textPositions.push({ type: "word", lineIndex: lIdx, wordIndex: wIdx });
        }

        // 注音文本
        if (word.ruby) {
          for (let rIdx = 0; rIdx < word.ruby.length; rIdx++) {
            const ruby = word.ruby[rIdx];
            if (ruby.word) {
              textsToConvert.push(ruby.word);
              textPositions.push({
                type: "ruby",
                lineIndex: lIdx,
                wordIndex: wIdx,
                rubyIndex: rIdx,
              });
            }
          }
        }
      }
    }
  }

  if (textsToConvert.length === 0) return lines;

  const convertedTexts = await transformer(textsToConvert);
  if (!convertedTexts || convertedTexts.length !== textsToConvert.length) {
    throw new Error("Transformer output length mismatch with input texts");
  }

  // 深拷贝原始结构，避免突变原对象
  const resultLines: LyricLine[] = lines.map((line) => ({
    ...line,
    words: line.words.map((wordItem) => ({
      ...wordItem,
      ruby: wordItem.ruby ? wordItem.ruby.map((rubyItem) => ({ ...rubyItem })) : undefined,
    })),
  }));

  for (let textIndex = 0; textIndex < convertedTexts.length; textIndex++) {
    const pos = textPositions[textIndex];
    const converted = convertedTexts[textIndex];

    if (pos.type === "translated") {
      resultLines[pos.lineIndex].translatedLyric = converted;
    } else if (pos.type === "word") {
      resultLines[pos.lineIndex].words[pos.wordIndex].word = converted;
    } else if (pos.type === "ruby") {
      const rubyArr = resultLines[pos.lineIndex].words[pos.wordIndex].ruby;
      if (rubyArr?.[pos.rubyIndex]) {
        rubyArr[pos.rubyIndex].word = converted;
      }
    }
  }

  return resultLines;
};
