import type { LyricLine, LyricMetadata, LyricResult, LyricWord } from "../types";
import { formatTtmlTime } from "../utils/timestamp";

/**
 * 转义 XML 特殊字符
 * @param text - 原始字符串
 * @returns 转义后的 XML 安全字符串
 */
const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * 将单个单词生成为带有时间与属性的 span 节点字符串
 * @param word - 歌词单词对象
 * @returns span 节点 XML 字符串
 */
const singleWordSpan = (word: LyricWord): string => {
  const obsceneAttr = word.obscene ? ' amll:obscene="true"' : "";
  const emptyBeatAttr = word.emptyBeat !== undefined ? ` amll:empty-beat="${word.emptyBeat}"` : "";
  if (word.ruby && word.ruby.length > 0) {
    const rubySpans = word.ruby
      .map(
        (rubyItem) =>
          `<span tts:ruby="text" begin="${formatTtmlTime(rubyItem.startTime)}" end="${formatTtmlTime(rubyItem.endTime)}">${escapeXml(rubyItem.word)}</span>`,
      )
      .join("");

    return `<span tts:ruby="container"${obsceneAttr}${emptyBeatAttr}><span tts:ruby="base">${escapeXml(word.word)}</span><span tts:ruby="textContainer">${rubySpans}</span></span>`;
  }

  return `<span begin="${formatTtmlTime(word.startTime)}" end="${formatTtmlTime(word.endTime)}"${obsceneAttr}${emptyBeatAttr}>${escapeXml(word.word)}</span>`;
};

/**
 * 将歌词行中的所有单词拼接为 span 序列
 * @param line - 歌词行对象
 * @returns 拼接后的 span 字符串
 */
const wordSpans = (line: LyricLine): string => line.words.map(singleWordSpan).join("");

/**
 * 生成包含角色的辅助 span 节点（如翻译或音译）
 * @param role - 角色标识符（如 x-translation 或 x-roman）
 * @param text - 显示文本
 * @returns span 节点 XML 字符串
 */
const roleSpan = (role: string, text: string): string =>
  `      <span ttm:role="${role}">${escapeXml(text)}</span>`;

/**
 * 生成背景人声 span 节点
 * @param bg - 背景人声歌词行对象
 * @returns span 节点 XML 字符串
 */
const bgSpan = (bg: LyricLine): string => {
  const agentAttr = bg.agentId ? ` ttm:agent="${escapeXml(bg.agentId)}"` : "";
  const beginAttr = ` begin="${formatTtmlTime(bg.startTime)}"`;
  const endAttr = ` end="${formatTtmlTime(bg.endTime)}"`;

  const childSpans: string[] = [];
  childSpans.push(`        ${wordSpans(bg)}`);
  if (bg.translatedLyric) {
    childSpans.push(roleSpan("x-translation", bg.translatedLyric));
  }
  if (bg.romanLyric) {
    childSpans.push(roleSpan("x-roman", bg.romanLyric));
  }

  return `      <span ttm:role="x-bg"${agentAttr}${beginAttr}${endAttr}>\n${childSpans.join("\n")}\n      </span>`;
};

/**
 * 将主歌词行及其关联背景音序列化为段落 XML
 * @param main - 主歌词行对象
 * @param bgs - 背景音歌词行列表
 * @returns 段落 XML 字符串
 */
const paragraph = (main: LyricLine, bgs: LyricLine[]): string => {
  const agent = main.isDuet
    ? ' ttm:agent="v2"'
    : main.agentId
      ? ` ttm:agent="${escapeXml(main.agentId)}"`
      : "";
  const key = main.id ? ` itunes:key="${escapeXml(main.id)}"` : "";
  const begin = ` begin="${formatTtmlTime(main.startTime)}"`;
  const end = ` end="${formatTtmlTime(main.endTime)}"`;

  const linesXml: string[] = [];
  linesXml.push(`      ${wordSpans(main)}`);
  if (main.translatedLyric) linesXml.push(roleSpan("x-translation", main.translatedLyric));
  if (main.romanLyric) linesXml.push(roleSpan("x-roman", main.romanLyric));
  for (const bg of bgs) linesXml.push(bgSpan(bg));

  return `    <p${key}${agent}${begin}${end}>\n${linesXml.join("\n")}\n    </p>`;
};

/**
 * 构建 TTML 头部元数据 XML 片段
 * @param metadata - 歌词元数据对象
 * @returns 头部 XML 字符串；无元数据时返回空字符串
 */
const buildHeadXml = (metadata?: LyricMetadata): string => {
  if (!metadata) return "";
  const metaLines: string[] = [];

  if (metadata.agents) {
    for (const [id, agent] of Object.entries(metadata.agents)) {
      const type = agent.type || (id === "v2" ? "group" : "person");
      const nameXml = agent.name
        ? `\n        <ttm:name type="full">${escapeXml(agent.name)}</ttm:name>\n      `
        : "";
      metaLines.push(
        `      <ttm:agent type="${escapeXml(type)}" xml:id="${escapeXml(agent.id || id)}">${nameXml}</ttm:agent>`,
      );
    }
  }

  if (metadata.songwriters && metadata.songwriters.length > 0) {
    const songwriterNodes = metadata.songwriters
      .map((writer) => `        <itunes:songwriter>${escapeXml(writer)}</itunes:songwriter>`)
      .join("\n");
    metaLines.push(`      <itunes:songwriters>\n${songwriterNodes}\n      </itunes:songwriters>`);
  }

  const addAmllMeta = (key: string, value: string): void => {
    metaLines.push(`      <amll:meta key="${escapeXml(key)}" value="${escapeXml(value)}" />`);
  };

  for (const val of metadata.title ?? []) addAmllMeta("musicName", val);
  for (const val of metadata.artist ?? []) addAmllMeta("artists", val);
  for (const val of metadata.album ?? []) addAmllMeta("album", val);
  for (const val of metadata.isrc ?? []) addAmllMeta("isrc", val);
  for (const val of metadata.authorIds ?? []) addAmllMeta("ttmlAuthorGithub", val);
  for (const val of metadata.authorNames ?? []) addAmllMeta("ttmlAuthorGithubLogin", val);

  if (metadata.platformIds) {
    for (const [key, values] of Object.entries(metadata.platformIds)) {
      for (const val of values ?? []) addAmllMeta(key, val);
    }
  }

  if (metadata.rawProperties) {
    for (const [key, values] of Object.entries(metadata.rawProperties)) {
      for (const val of values ?? []) addAmllMeta(key, val);
    }
  }

  if (metaLines.length === 0) return "";
  return `  <head>\n    <metadata>\n${metaLines.join("\n")}\n    </metadata>\n  </head>`;
};

/**
 * 将歌词行序列化为标准 TTML XML
 * @param input - 歌词行数组或包含元数据的解析结果对象
 * @returns TTML XML 字符串
 */
export const toTTML = (input: LyricLine[] | LyricResult): string => {
  const lines = Array.isArray(input) ? input : input.lines;
  const metadata = Array.isArray(input) ? undefined : input.metadata;

  const groups: { main: LyricLine; bg: LyricLine[] }[] = [];
  for (const line of lines) {
    if (line.isBG && groups.length) groups[groups.length - 1].bg.push(line);
    else groups.push({ main: line, bg: [] });
  }

  // 按 songPart 分组包裹 <div>
  const divBlocks: string[] = [];
  let currentPart: string | undefined;
  let currentLines: string[] = [];

  /**
   * 将当前累积的段落行刷新为包含歌曲分段的 div 块
   * @returns 无返回值
   */
  const flushDiv = (): void => {
    if (currentLines.length === 0) return;
    const partAttr = currentPart ? ` itunes:song-part="${escapeXml(currentPart)}"` : "";
    divBlocks.push(`    <div${partAttr}>\n${currentLines.join("\n")}\n    </div>`);
    currentLines = [];
  };

  for (const group of groups) {
    if (group.main.songPart !== currentPart) {
      flushDiv();
      currentPart = group.main.songPart;
    }
    currentLines.push(`      ${paragraph(group.main, group.bg)}`);
  }
  flushDiv();

  const langAttr = metadata?.language ? ` xml:lang="${escapeXml(metadata.language)}"` : "";
  const timingAttr = metadata?.timingMode
    ? ` itunes:timing="${escapeXml(metadata.timingMode)}"`
    : "";

  const rootOpen = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:amll="http://www.example.com/ns/amll"${langAttr}${timingAttr}>`;

  const headXml = buildHeadXml(metadata);
  const parts = ['<?xml version="1.0" encoding="utf-8"?>', rootOpen];
  if (headXml) parts.push(headXml);
  parts.push("  <body>", divBlocks.join("\n"), "  </body>", "</tt>");

  return parts.join("\n");
};
