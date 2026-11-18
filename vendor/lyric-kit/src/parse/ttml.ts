import { normalizeKangxi } from "../clean/kangxi";
import { isMeaningfulTranslation } from "../clean/meaningful";
import type {
  DOMParserConstructor,
  DOMParserLike,
  LyricLine,
  LyricMetadata,
  LyricResult,
  LyricWord,
  ParseOptions,
  TTMLAgent,
  TTMLPlatformId,
} from "../types";
import { pickLangIndex } from "../utils/pickLanguage";
import { alignRomanization } from "../utils/roman";
import { parseTTMLTime } from "../utils/timestamp";
import { markLineTimed } from "./timing";

export type { DOMParserConstructor, DOMParserLike };
export { alignRomanization };

const NS = {
  TT: "http://www.w3.org/ns/ttml",
  TTM: "http://www.w3.org/ns/ttml#metadata",
  ITUNES: "http://music.apple.com/lyric-ttml-internal",
  AMLL: "http://www.example.com/ns/amll",
  XML: "http://www.w3.org/XML/1998/namespace",
  TTS: "http://www.w3.org/ns/ttml#styling",
} as const;

const Elements = {
  Title: "title",
  Name: "name",
  Meta: "meta",
  ITunesMetadata: "iTunesMetadata",
  Songwriters: "songwriters",
  Songwriter: "songwriter",
  Translation: "translation",
  Translations: "translations",
  Transliteration: "transliteration",
  Transliterations: "transliterations",
  Text: "text",
  Agent: "agent",
  Div: "div",
  P: "p",
  Span: "span",
} as const;

const Attributes = {
  Key: "key",
  Value: "value",
  Lang: "lang",
  Timing: "timing",
  For: "for",
  SongPart: "songPart",
  SongPartKebab: "song-part",
  Begin: "begin",
  End: "end",
  Role: "role",
  Type: "type",
  Ruby: "ruby",
  Obscene: "obscene",
  EmptyBeat: "empty-beat",
  Id: "id",
} as const;

const Values = {
  MusicName: "musicName",
  Artists: "artists",
  Album: "album",
  ISRC: "isrc",
  TTMLAuthorGithub: "ttmlAuthorGithub",
  TTMLAuthorGithubLogin: "ttmlAuthorGithubLogin",
  NCMMusicId: "ncmMusicId",
  QQMusicId: "qqMusicId",
  SpotifyId: "spotifyId",
  AppleMusicId: "appleMusicId",
  RoleBg: "x-bg",
  RoleTranslation: "x-translation",
  RoleRoman: "x-roman",
  Group: "group",
  Person: "person",
  Other: "other",
  RubyContainer: "container",
  RubyBase: "base",
  RubyTextContainer: "textContainer",
  RubyText: "text",
} as const;

const MULTI_SPACE_RE = /\s+/g;

/**
 * 规范化文本空白字符
 * @param text - 原始文本内容
 * @param trim - 是否去除首尾空白，默认为 true
 * @returns 归一化后的文本
 */
const normalizeText = (text: string | null | undefined, trim = true): string => {
  if (!text) return "";
  const normalized = text.replace(MULTI_SPACE_RE, " ");
  return trim ? normalized.trim() : normalized;
};

/**
 * 剥除文本首尾的全半角括号与空白
 * @param text - 待处理的原始文本
 * @returns 剥除括号后的文本
 */
const stripParens = (text: string): string =>
  text
    .trim()
    .replace(/^[(（]+/, "")
    .replace(/[)）]+$/, "")
    .trim();

/**
 * 获取 XML 元素的属性值，依次尝试命名空间、回退名称与本地名称
 * @param element - XML DOM 元素
 * @param ns - 属性命名空间 URI
 * @param localName - 属性本地名称
 * @param fallbackAttrName - 可选的回退完整属性名
 * @returns 属性字符串值，不存在返回 null
 */
const getAttr = (
  element: Element,
  ns: string,
  localName: string,
  fallbackAttrName?: string,
): string | null => {
  if (fallbackAttrName) {
    const fallbackVal = element.getAttribute(fallbackAttrName);
    if (fallbackVal !== null) return fallbackVal;
  }
  const direct = element.getAttribute(localName);
  if (direct !== null) return direct;

  const val = element.getAttributeNS(ns, localName);
  if (val !== null) return val;

  const attrs = element.attributes;
  if (attrs) {
    const len = attrs.length;
    for (let attrIndex = 0; attrIndex < len; attrIndex++) {
      const attr = attrs[attrIndex];
      const attrLocalName = attr.localName || attr.name.split(":").pop();
      if (attrLocalName === localName) return attr.value;
    }
  }

  return null;
};

/**
 * 字符串数组去重
 * @param arr - 待去重的字符串数组
 * @returns 去重后的字符串数组
 */
const dedupe = (arr?: string[]): string[] => {
  if (!arr || arr.length === 0) return [];
  if (arr.length === 1) return arr;
  return Array.from(new Set(arr));
};

interface SidecarItem {
  lang: string | null;
  text: string;
  words?: LyricWord[];
}

interface ReplacementItem {
  lang: string | null;
  element: Element;
}

interface SidecarEntry {
  translations?: SidecarItem[];
  romanizations?: SidecarItem[];
  replacements?: ReplacementItem[];
  bgTranslations?: SidecarItem[][];
  bgRomanizations?: SidecarItem[][];
  bgReplacements?: ReplacementItem[][];
}

type SidecarMap = Record<string, SidecarEntry>;

/**
 * 解析文档头部元数据与翻译/音译 Sidecar
 * @param doc - XML 文档对象
 * @returns 包含元数据和 Sidecar 映射的对象
 */
const parseHead = (
  doc: Document,
): {
  metadata: LyricMetadata;
  sidecar: SidecarMap;
} => {
  const metadata: LyricMetadata = {
    title: [],
    artist: [],
    album: [],
    isrc: [],
    authorIds: [],
    authorNames: [],
    songwriters: [],
    agents: {},
    platformIds: {},
    rawProperties: {},
  };
  const sidecar: SidecarMap = {};

  /**
   * 按照本地标签名查找子元素（忽略 XML 命名空间前缀）
   * @param root - 根元素或文档节点
   * @param targetLocalName - 目标本地标签名
   * @param prefix - 可选的命名空间前缀
   * @returns 匹配的 DOM 元素数组
   */
  const findElementsByLocalName = (
    root: Element | Document,
    targetLocalName: string,
    prefix?: string,
  ): Element[] => {
    const byLocal = root.getElementsByTagName(targetLocalName);
    if (byLocal.length > 0) return Array.from(byLocal);

    if (prefix) {
      const byPrefixed = root.getElementsByTagName(`${prefix}:${targetLocalName}`);
      if (byPrefixed.length > 0) return Array.from(byPrefixed);
    }

    const res: Element[] = [];
    const all = root.getElementsByTagName("*");
    const lower = targetLocalName.toLowerCase();
    const len = all.length;
    for (let elemIndex = 0; elemIndex < len; elemIndex++) {
      const el = all[elemIndex];
      const name = el.localName || el.tagName.split(":").pop();
      if (name?.toLowerCase() === lower) {
        res.push(el);
      }
    }
    return res;
  };

  const head =
    doc.getElementsByTagName("head")[0] ||
    findElementsByLocalName(doc as unknown as Element, "head")[0];
  if (!head) return { metadata, sidecar };

  // 标题元数据
  const titles = findElementsByLocalName(head, Elements.Title);
  for (const titleEl of titles) {
    const text = titleEl.textContent?.trim();
    if (text) metadata.title?.push(text);
  }

  // 演唱者与声部
  const agents = findElementsByLocalName(head, Elements.Agent);
  for (const agent of agents) {
    const id = getAttr(agent, NS.XML, Attributes.Id, "xml:id");
    if (!id) continue;
    const type = getAttr(agent, NS.TTM, Attributes.Type, "ttm:type") || "";

    const nameEl = findElementsByLocalName(agent, Elements.Name)[0];
    const name = nameEl?.textContent?.trim() || undefined;

    const agentObj: TTMLAgent = { id, type: type || undefined, name };
    if (!metadata.agents) metadata.agents = {};
    metadata.agents[id] = agentObj;
  }

  // AMLL 扩展元数据
  const metas = findElementsByLocalName(head, Elements.Meta);
  for (const metaEl of metas) {
    const key = getAttr(metaEl, NS.AMLL, Attributes.Key, "amll:key") || metaEl.getAttribute("key");
    const value = (
      getAttr(metaEl, NS.AMLL, Attributes.Value, "amll:value") || metaEl.getAttribute("value")
    )?.trim();
    if (!key || !value) continue;

    switch (key) {
      case Values.MusicName:
        metadata.title?.push(value);
        break;
      case Values.Artists:
        metadata.artist?.push(value);
        break;
      case Values.Album:
        metadata.album?.push(value);
        break;
      case Values.ISRC:
        metadata.isrc?.push(value);
        break;
      case Values.TTMLAuthorGithub:
        metadata.authorIds?.push(value);
        break;
      case Values.TTMLAuthorGithubLogin:
        metadata.authorNames?.push(value);
        break;
      case Values.NCMMusicId:
      case Values.QQMusicId:
      case Values.SpotifyId:
      case Values.AppleMusicId:
        if (!metadata.platformIds) metadata.platformIds = {};
        (metadata.platformIds[key as TTMLPlatformId] ??= []).push(value);
        break;
      default:
        if (!metadata.rawProperties) metadata.rawProperties = {};
        (metadata.rawProperties[key] ??= []).push(value);
        break;
    }
  }

  // 词曲作者、翻译与音译扩展
  const iTunesMetas = findElementsByLocalName(head, Elements.ITunesMetadata);
  const metadataContainers = findElementsByLocalName(head, "metadata");
  const scopeContainers = Array.from(new Set([...iTunesMetas, ...metadataContainers, head]));

  const processedTransContainers = new Set<Element>();
  const processedTranslitContainers = new Set<Element>();
  const processedSongwriterContainers = new Set<Element>();

  for (const container of scopeContainers) {
    const songwritersList = findElementsByLocalName(container, Elements.Songwriters);
    for (const songwritersContainer of songwritersList) {
      if (processedSongwriterContainers.has(songwritersContainer)) continue;
      processedSongwriterContainers.add(songwritersContainer);
      const writers = findElementsByLocalName(songwritersContainer, Elements.Songwriter);
      for (const writer of writers) {
        const name = writer.textContent?.trim();
        if (name) metadata.songwriters?.push(name);
      }
    }

    /**
     * 解析翻译或音译容器节点并归纳进 Sidecar 映射
     * @param containerName - 外层容器标签名
     * @param itemName - 内部条目标签名
     * @param type - 条目类型（translations 或 romanizations）
     * @param processedSet - 已处理元素集合（用于去重）
     * @returns 无返回值
     */
    const processEntries = (
      containerName: string,
      itemName: string,
      type: "translations" | "romanizations",
      processedSet: Set<Element>,
    ): void => {
      const containers = findElementsByLocalName(container, containerName);
      for (const itemContainer of containers) {
        if (processedSet.has(itemContainer)) continue;
        processedSet.add(itemContainer);
        const items = findElementsByLocalName(itemContainer, itemName);
        for (const item of items) {
          // replacement 单独保留，按偏好语言替换正文，不参与字幕选择。
          const isReplacement =
            type === "translations" && item.getAttribute(Attributes.Type) === "replacement";
          const lang = getAttr(item, NS.XML, Attributes.Lang, "xml:lang");
          const textNodes = findElementsByLocalName(item, Elements.Text);
          for (const textNode of textNodes) {
            const forId = textNode.getAttribute(Attributes.For);
            if (!forId) continue;
            if (isReplacement) {
              if (!textNode.textContent?.trim()) continue;
              const entry = (sidecar[forId] ??= {});
              (entry.replacements ??= []).push({ lang, element: textNode });
              let bgIndex = 0;
              for (const node of Array.from(textNode.childNodes)) {
                if (node.nodeType !== 1) continue;
                const child = node as Element;
                if (getAttr(child, NS.TTM, Attributes.Role, "ttm:role") !== Values.RoleBg) continue;
                const backgrounds = (entry.bgReplacements ??= []);
                (backgrounds[bgIndex++] ??= []).push({ lang, element: child });
              }
              continue;
            }

            let mainText = "";
            let bgIndex = 0;
            const mainWords: LyricWord[] = [];

            for (const node of Array.from(textNode.childNodes)) {
              if (node.nodeType === 3) {
                mainText += node.textContent ?? "";
              } else if (node.nodeType === 1) {
                const childEl = node as Element;
                const isBg =
                  getAttr(childEl, NS.TTM, Attributes.Role, "ttm:role") === Values.RoleBg;
                const raw = childEl.textContent ?? "";
                const normalized = normalizeText(raw, false);
                const clean = normalized.trim();
                const beginAttr = getAttr(childEl, NS.XML, Attributes.Begin);
                const endAttr = getAttr(childEl, NS.XML, Attributes.End);

                if (isBg) {
                  const bgText = stripParens(normalized);
                  const bgWords: LyricWord[] = [];
                  const innerSpans = childEl.getElementsByTagName("span");
                  if (innerSpans.length > 0) {
                    for (let spanIndex = 0; spanIndex < innerSpans.length; spanIndex++) {
                      const sp = innerSpans[spanIndex];
                      const spB = getAttr(sp, NS.XML, Attributes.Begin);
                      const spE = getAttr(sp, NS.XML, Attributes.End);
                      const spClean = stripParens(normalizeText(sp.textContent ?? "", false));
                      if (spB && spE && spClean.trim()) {
                        bgWords.push({
                          word: spClean,
                          startTime: parseTTMLTime(spB),
                          endTime: parseTTMLTime(spE),
                        });
                      }
                    }
                  } else if (beginAttr && endAttr && clean) {
                    bgWords.push({
                      word: stripParens(normalized),
                      startTime: parseTTMLTime(beginAttr),
                      endTime: parseTTMLTime(endAttr),
                    });
                  }
                  if (bgText) {
                    const entry = (sidecar[forId] ??= {});
                    const bgType = type === "translations" ? "bgTranslations" : "bgRomanizations";
                    const bgEntries = (entry[bgType] ??= []);
                    (bgEntries[bgIndex] ??= []).push({
                      lang,
                      text: bgText,
                      words: bgWords.length > 0 ? bgWords : undefined,
                    });
                  }
                  bgIndex++;
                } else {
                  mainText += raw;
                  const innerSpans = childEl.getElementsByTagName("span");
                  if (innerSpans.length > 0) {
                    for (let spanIndex = 0; spanIndex < innerSpans.length; spanIndex++) {
                      const sp = innerSpans[spanIndex];
                      const spB = getAttr(sp, NS.XML, Attributes.Begin);
                      const spE = getAttr(sp, NS.XML, Attributes.End);
                      const spRaw = sp.textContent ?? "";
                      const spClean = normalizeText(spRaw, false);
                      if (spB && spE && spClean.trim()) {
                        mainWords.push({
                          word: spClean,
                          startTime: parseTTMLTime(spB),
                          endTime: parseTTMLTime(spE),
                        });
                      }
                    }
                  } else if (beginAttr && endAttr && clean) {
                    mainWords.push({
                      word: normalized,
                      startTime: parseTTMLTime(beginAttr),
                      endTime: parseTTMLTime(endAttr),
                    });
                  }
                }
              }
            }

            mainText = normalizeText(mainText);
            if (mainText) {
              const entry = (sidecar[forId] ??= {});
              (entry[type] ??= []).push({
                lang,
                text: mainText,
                words: mainWords.length > 0 ? mainWords : undefined,
              });
            }
          }
        }
      }
    };

    processEntries(
      Elements.Translations,
      Elements.Translation,
      "translations",
      processedTransContainers,
    );
    processEntries(
      Elements.Transliterations,
      Elements.Transliteration,
      "romanizations",
      processedTranslitContainers,
    );
  }

  // 去重
  metadata.title = dedupe(metadata.title);
  metadata.artist = dedupe(metadata.artist);
  metadata.album = dedupe(metadata.album);
  metadata.isrc = dedupe(metadata.isrc);
  metadata.authorIds = dedupe(metadata.authorIds);
  metadata.authorNames = dedupe(metadata.authorNames);
  metadata.songwriters = dedupe(metadata.songwriters);

  return { metadata, sidecar };
};

interface ParsedParagraphState {
  fullText: string;
  words: LyricWord[];
  translations: Array<{ lang: string | null; text: string }>;
  romanizations: Array<{ lang: string | null; text: string }>;
  bgLines: LyricLine[];
}

/**
 * 解析并创建可用的 DOMParser 实例
 * @param options - TTML 解析配置选项
 * @returns DOMParser 实例
 */
const resolveDomParser = (options?: ParseOptions): DOMParserLike => {
  if (options?.domParser) {
    if (typeof options.domParser === "function") {
      const Ctor = options.domParser as DOMParserConstructor;
      return new Ctor();
    }
    return options.domParser;
  }
  if (typeof DOMParser !== "undefined") {
    return new DOMParser();
  }
  throw new Error(
    "DOMParser is not available in current environment. Please pass a domParser in options.",
  );
};

/**
 * 解析 TTML 格式歌词文本
 * @param text - 符合 TTML 规范的 XML 歌词字符串
 * @param options - 解析配置选项
 * @returns 歌词解析结果
 */
export const parseTTML = (text: string, options: ParseOptions = {}): LyricResult => {
  const { extractMetadata = false, preferredLang = "", cleanKangxi = false } = options;
  const content = cleanKangxi ? normalizeKangxi(text) : text;
  const parser = resolveDomParser(options);
  const doc = parser.parseFromString(content, "application/xml");

  if (doc.querySelector?.("parsererror") || doc.getElementsByTagName("parsererror")[0]) {
    throw new Error("Invalid TTML XML");
  }

  const { metadata, sidecar } = parseHead(doc);

  const root = doc.documentElement;
  if (root) {
    const lang = getAttr(root, NS.XML, Attributes.Lang, "xml:lang");
    if (lang) {
      metadata.language = lang;
    }
    const timing =
      getAttr(root, NS.ITUNES, Attributes.Timing, "itunes:timing") ||
      getAttr(root, "", Attributes.Timing);
    if (timing === "Word" || timing === "Line") {
      metadata.timingMode = timing;
    }
  }

  const resultLines: LyricLine[] = [];

  let currentBlockIndex = 0;

  /**
   * 递归解析段落或背景音节点的内容、逐字时间戳与内嵌角色
   * @param element - 当前 DOM 元素
   * @param parentKey - 父级节点的 key 标识
   * @param skipBackground - 是否跳过内嵌背景音，默认 false
   * @returns 解析后的段落状态（包含文本、单词、翻译与音译）
   */
  const parseCommonContent = (
    element: Element,
    parentKey: string | null,
    skipBackground = false,
  ): ParsedParagraphState => {
    const state: ParsedParagraphState = {
      fullText: "",
      words: [],
      translations: [],
      romanizations: [],
      bgLines: [],
    };

    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) {
        const rawText = node.textContent || "";
        const isFormatting = rawText.includes("\n");
        if (isFormatting && rawText.trim().length === 0) continue;

        const normalizedWText = normalizeText(rawText, false);
        state.fullText += normalizedWText;

        if (!isFormatting && normalizedWText.length > 0 && normalizedWText.trim().length === 0) {
          if (state.words.length > 0) {
            state.words[state.words.length - 1].word += normalizedWText;
          }
        }
      } else if (node.nodeType === 1) {
        const el = node as Element;
        const role = getAttr(el, NS.TTM, Attributes.Role, "ttm:role");
        const rubyAttr = getAttr(el, NS.TTS, Attributes.Ruby, "tts:ruby");

        if (rubyAttr === Values.RubyContainer) {
          const obsceneAttr = getAttr(el, NS.AMLL, Attributes.Obscene, "amll:obscene");
          const isObscene = obsceneAttr === "true";

          const emptyBeatAttr = getAttr(el, NS.AMLL, Attributes.EmptyBeat, "amll:empty-beat");
          const emptyBeat = emptyBeatAttr ? parseInt(emptyBeatAttr, 10) : undefined;

          let baseText = "";
          const rubyTags: Array<{ word: string; startTime: number; endTime: number }> = [];

          for (const childNode of Array.from(el.childNodes)) {
            if (childNode.nodeType !== 1) continue;
            const childEl = childNode as Element;
            const childRubyAttr = getAttr(childEl, NS.TTS, Attributes.Ruby, "tts:ruby");

            if (childRubyAttr === Values.RubyBase) {
              baseText = normalizeText(childEl.textContent, false);
            } else if (childRubyAttr === Values.RubyTextContainer) {
              for (const textNode of Array.from(childEl.childNodes)) {
                if (textNode.nodeType !== 1) continue;
                const tNode = textNode as Element;
                const tAttr = getAttr(tNode, NS.TTS, Attributes.Ruby, "tts:ruby");
                if (tAttr === Values.RubyText) {
                  const begin = getAttr(tNode, NS.XML, Attributes.Begin);
                  const end = getAttr(tNode, NS.XML, Attributes.End);
                  const rubyWord = normalizeText(tNode.textContent, false).trim();
                  if (rubyWord && begin && end) {
                    rubyTags.push({
                      word: rubyWord,
                      startTime: parseTTMLTime(begin),
                      endTime: parseTTMLTime(end),
                    });
                  }
                }
              }
            }
          }

          if (baseText) {
            state.fullText += baseText;
            let startTime = 0;
            let endTime = 0;
            if (rubyTags.length > 0) {
              startTime = Math.min(...rubyTags.map((ruby) => ruby.startTime));
              endTime = Math.max(...rubyTags.map((ruby) => ruby.endTime));
            }

            if (baseText.trim().length > 0) {
              state.words.push({
                word: baseText,
                startTime,
                endTime,
                ruby: rubyTags.length > 0 ? rubyTags : undefined,
                obscene: isObscene ? true : undefined,
                emptyBeat,
              });
            }
          }
        } else if (role === Values.RoleBg) {
          if (skipBackground) continue;
          // 背景歌词（role="x-bg"）
          const bgBegin = getAttr(el, NS.XML, Attributes.Begin);
          const bgEnd = getAttr(el, NS.XML, Attributes.End);
          const bgState = parseCommonContent(el, parentKey, true);
          const sourceBgWords = bgState.words;
          applyPreferredReplacement(
            bgState,
            parentKey ? sidecar[parentKey]?.bgReplacements?.[state.bgLines.length] : undefined,
          );
          const timingWords = bgState.words.length > 0 ? bgState.words : sourceBgWords;

          let bgStart = bgBegin ? parseTTMLTime(bgBegin) : 0;
          let bgEndMs = bgEnd ? parseTTMLTime(bgEnd) : 0;
          if (timingWords.length > 0) {
            const childStart = Math.min(...timingWords.map((word) => word.startTime));
            const childEnd = Math.max(...timingWords.map((word) => word.endTime));
            if (bgStart === 0 || (childStart > 0 && childStart < bgStart)) bgStart = childStart;
            if (bgEndMs === 0 || childEnd > bgEndMs) bgEndMs = childEnd;
          }

          // 背景音自身无时间时继承父级时间
          if (!bgStart) {
            const pBegin = getAttr(element, NS.XML, Attributes.Begin);
            if (pBegin) bgStart = parseTTMLTime(pBegin);
          }
          if (!bgEndMs) {
            const pEnd = getAttr(element, NS.XML, Attributes.End);
            if (pEnd) bgEndMs = parseTTMLTime(pEnd);
          }

          // 背景歌词去掉首尾括号（与原项目保持一致，无条件剥离）
          if (bgState.words.length > 0) {
            const first = bgState.words[0];
            first.word = first.word.replace(/^[(（]+/, "").trimStart();
            if (!first.word) bgState.words.shift();

            if (bgState.words.length > 0) {
              const last = bgState.words[bgState.words.length - 1];
              last.word = last.word.replace(/[)）]+$/, "").trimEnd();
              if (!last.word) bgState.words.pop();
            }
          }

          // 若背景音无逐字 span，回退为单词行
          const cleanBgText = stripParens(normalizeText(bgState.fullText));
          const isLineTimedBg = bgState.words.length === 0;
          if (isLineTimedBg && cleanBgText) {
            bgState.words.push({
              word: cleanBgText,
              startTime: bgStart,
              endTime: bgEndMs,
            });
          }

          let trans = "";
          let roman = "";
          let selectedBgRomanWords: LyricWord[] | undefined;

          if (parentKey && sidecar[parentKey]) {
            const sc = sidecar[parentKey];
            const bgIndex = state.bgLines.length;
            const bgTranslations = sc.bgTranslations?.[bgIndex];
            if (bgTranslations?.length) {
              const idx = pickLangIndex(
                bgTranslations.map((transItem) => transItem.lang),
                preferredLang,
              );
              if (idx !== -1) trans = bgTranslations[idx].text;
            }
            const bgRomanizations = sc.bgRomanizations?.[bgIndex];
            if (bgRomanizations?.length) {
              roman = bgRomanizations[0].text;
              selectedBgRomanWords = bgRomanizations[0].words;
            }
          }

          // 回退到背景行内翻译/音译
          if (!trans && bgState.translations.length > 0) {
            const idx = pickLangIndex(
              bgState.translations.map((transItem) => transItem.lang),
              preferredLang,
            );
            if (idx !== -1 && isMeaningfulTranslation(bgState.translations[idx].text)) {
              trans = bgState.translations[idx].text;
            }
          }
          if (!roman && bgState.romanizations.length > 0) {
            roman = bgState.romanizations[0].text;
          }

          if (stripParens(trans) === cleanBgText) trans = "";
          if (stripParens(roman) === cleanBgText) {
            roman = "";
          } else if (selectedBgRomanWords && !isLineTimedBg) {
            alignRomanization(bgState.words, selectedBgRomanWords);
          }

          const bgAgent = getAttr(el, NS.TTM, Elements.Agent, "ttm:agent");

          const bgLine: LyricLine = {
            words: bgState.words,
            translatedLyric: isMeaningfulTranslation(trans) ? trans : "",
            romanLyric: roman,
            startTime: bgStart,
            endTime: bgEndMs,
            isBG: true,
            isDuet: false,
            agentId: bgAgent || undefined,
          };
          state.bgLines.push(isLineTimedBg ? markLineTimed(bgLine) : bgLine);
        } else if (role === Values.RoleTranslation) {
          const lang = getAttr(el, NS.XML, Attributes.Lang, "xml:lang");
          const transText = normalizeText(el.textContent);
          if (transText) state.translations.push({ lang, text: transText });
        } else if (role === Values.RoleRoman) {
          const lang = getAttr(el, NS.XML, Attributes.Lang, "xml:lang");
          const romanText = normalizeText(el.textContent);
          if (romanText) state.romanizations.push({ lang, text: romanText });
        } else {
          const wBegin = getAttr(el, NS.XML, Attributes.Begin);
          const wEnd = getAttr(el, NS.XML, Attributes.End);

          const obsceneAttr = getAttr(el, NS.AMLL, Attributes.Obscene, "amll:obscene");
          const isObscene = obsceneAttr === "true";

          const emptyBeatAttr = getAttr(el, NS.AMLL, Attributes.EmptyBeat, "amll:empty-beat");
          const emptyBeat = emptyBeatAttr ? parseInt(emptyBeatAttr, 10) : undefined;

          const rawWText = el.textContent || "";
          const normalizedWText = normalizeText(rawWText, false);
          state.fullText += normalizedWText;

          if (wBegin && wEnd) {
            const isFormatting = rawWText.includes("\n");
            const cleanText = isFormatting ? normalizedWText.trim() : normalizedWText;

            if (cleanText.trim().length > 0) {
              state.words.push({
                word: cleanText,
                startTime: parseTTMLTime(wBegin),
                endTime: parseTTMLTime(wEnd),
                obscene: isObscene ? true : undefined,
                emptyBeat,
              });
            }
          }
        }
      }
    }

    if (state.words.length > 0) {
      state.words[0].word = state.words[0].word.trimStart();
      const last = state.words[state.words.length - 1];
      last.word = last.word.trimEnd();
    }

    return state;
  };

  /** 先按语言选择正文替换轨，再由调用方执行时间推导与辅助歌词去重。 */
  const applyPreferredReplacement = (
    state: ParsedParagraphState,
    replacements?: ReplacementItem[],
  ): void => {
    if (!preferredLang || !replacements?.length) return;
    const index = pickLangIndex(
      replacements.map((item) => item.lang),
      preferredLang,
    );
    if (index === -1) return;
    const replacement = parseCommonContent(replacements[index].element, null, true);
    if (!replacement.fullText.trim()) return;
    state.fullText = replacement.fullText;
    state.words = replacement.words;
  };

  let lastPersonAgentId: string | null = null;
  let lastPersonIsDuet = false;

  /**
   * 确定当前演唱者是否属于对唱侧（右对齐）
   *
   * 设计考量：
   * - 针对双人声部交替场景（如男女对唱），通过跟踪最后切换的 person agent，在声部切换时翻转 isDuet 状态，
   *   实现主声部与对唱声部分别左右布局渲染。
   * - 若声部为 Group（合唱）则保持居中；若声明为 Other 则初始判定为对唱。
   * - 此启发式规则在多 agent 频繁交替时效果最佳。
   * @param agentId - 演唱者标识符
   * @returns 是否属于对唱声部
   */
  const determineDuet = (agentId: string | undefined): boolean => {
    const aid = agentId || "v1";
    const agent = metadata.agents?.[aid];
    const isGroup = agent?.type === Values.Group;
    const isOther = agent?.type === Values.Other;

    if (isGroup) {
      return false;
    }

    if (lastPersonAgentId === null) {
      const current = !!isOther;
      lastPersonAgentId = aid;
      lastPersonIsDuet = current;
      return current;
    }

    if (lastPersonAgentId === aid) {
      return lastPersonIsDuet;
    }

    const current = !lastPersonIsDuet;
    lastPersonAgentId = aid;
    lastPersonIsDuet = current;
    return current;
  };

  /**
   * 解析单个歌词行元素（<p>）并追加至结果列表
   * @param paragraph - 段落 DOM 元素
   * @param songPart - 所属歌曲分段名称
   * @param blockIdx - 所属段落区块序号
   * @returns 无返回值
   */
  const processLineElement = (paragraph: Element, songPart?: string, blockIdx?: number): void => {
    const begin = getAttr(paragraph, NS.XML, Attributes.Begin);
    const end = getAttr(paragraph, NS.XML, Attributes.End);
    const lineAgent = getAttr(paragraph, NS.TTM, Elements.Agent, "ttm:agent");
    const key =
      getAttr(paragraph, NS.ITUNES, Attributes.Key, "itunes:key") || paragraph.getAttribute("id");

    const state = parseCommonContent(paragraph, key, false);
    const sourceWords = state.words;
    applyPreferredReplacement(state, key ? sidecar[key]?.replacements : undefined);

    let startTime = begin ? parseTTMLTime(begin) : 0;
    let endTime = end ? parseTTMLTime(end) : 0;

    // 与 AMLL 一致，逐字和背景人声共同扩展行时间，缺失边界分别推导。
    const timedElements = [
      ...(state.words.length > 0 ? state.words : sourceWords),
      ...state.bgLines,
    ];
    if (timedElements.length > 0) {
      const childStart = Math.min(...timedElements.map((item) => item.startTime));
      const childEnd = Math.max(...timedElements.map((item) => item.endTime));
      if (startTime === 0 || (childStart > 0 && childStart < startTime)) startTime = childStart;
      if (endTime === 0 || childEnd > endTime) endTime = childEnd;
    }

    // 逐行翻译与音译决策
    let translatedLyric = "";
    let romanLyric = "";
    let selectedRomanWords: LyricWord[] | undefined;

    // 优先从 sidecar 获取
    if (key && sidecar[key]) {
      const sc = sidecar[key];
      if (sc.translations?.length) {
        const idx = pickLangIndex(
          sc.translations.map((transItem) => transItem.lang),
          preferredLang,
        );
        if (idx !== -1 && isMeaningfulTranslation(sc.translations[idx].text)) {
          translatedLyric = sc.translations[idx].text;
        }
      }
      if (sc.romanizations?.length) {
        romanLyric = sc.romanizations[0].text;
        selectedRomanWords = sc.romanizations[0].words;
      }
    }

    // 回退到行内翻译与音译
    if (!translatedLyric && state.translations.length > 0) {
      const idx = pickLangIndex(
        state.translations.map((transItem) => transItem.lang),
        preferredLang,
      );
      if (idx !== -1 && isMeaningfulTranslation(state.translations[idx].text)) {
        translatedLyric = state.translations[idx].text;
      }
    }
    if (!romanLyric && state.romanizations.length > 0) {
      romanLyric = state.romanizations[0].text;
    }

    const originalText = normalizeText(state.fullText);
    if (translatedLyric === originalText) translatedLyric = "";
    if (romanLyric === originalText) {
      romanLyric = "";
    } else if (selectedRomanWords && state.words.length > 0) {
      alignRomanization(state.words, selectedRomanWords);
    }

    // 对唱判定
    const isDuet = determineDuet(lineAgent || undefined);

    // 回退单字行
    const isLineTimedMain = state.words.length === 0;
    if (isLineTimedMain && state.fullText.trim().length > 0) {
      state.words.push({
        word: state.fullText.trim(),
        startTime,
        endTime,
      });
    }

    const mainLine: LyricLine = {
      id: key || undefined,
      words: state.words,
      translatedLyric,
      romanLyric,
      startTime,
      endTime,
      isBG: false,
      isDuet,
      agentId: lineAgent || undefined,
      songPart: songPart || undefined,
      blockIndex: blockIdx,
    };

    resultLines.push(isLineTimedMain ? markLineTimed(mainLine) : mainLine);
    if (state.bgLines.length > 0) {
      for (const bg of state.bgLines) {
        bg.isDuet = isDuet;
      }
      resultLines.push(...state.bgLines);
    }
  };

  const body = doc.getElementsByTagName("body")[0];
  if (body) {
    for (const node of Array.from(body.childNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tagName = el.localName || el.tagName.toLowerCase().split(":").pop();

      if (tagName === Elements.Div) {
        currentBlockIndex++;
        const songPart =
          getAttr(el, NS.ITUNES, Attributes.SongPartKebab, "itunes:song-part") ||
          getAttr(el, NS.ITUNES, Attributes.SongPart, "itunes:songPart") ||
          undefined;

        const pNodes = Array.from(el.getElementsByTagName("p"));
        for (const paragraphNode of pNodes) {
          processLineElement(paragraphNode, songPart, currentBlockIndex);
        }
      } else if (tagName === Elements.P) {
        currentBlockIndex++;
        processLineElement(el, undefined, currentBlockIndex);
      }
    }
  }

  if (!metadata.timingMode) {
    const hasWordTiming = resultLines.some((line) => (line.words?.length ?? 0) > 1);
    metadata.timingMode = hasWordTiming ? "Word" : "Line";
  }

  return {
    lines: resultLines,
    metadata: extractMetadata ? metadata : {},
  };
};
