/** 语言标签别名映射表 */
const LANG_TAG_ALIASES: Record<string, string> = {
  "zh-cn": "zh-hans-cn",
  "zh-sg": "zh-hans-sg",
  "zh-tw": "zh-hant-tw",
  "zh-hk": "zh-hant-hk",
  "zh-mo": "zh-hant-mo",
};

/**
 * 规范化 BCP-47 语言代码标签
 * @param lang - 原始语言字符串
 * @returns 小写短横线分隔的规范语言标签
 */
const normalizeLang = (lang: string | null | undefined): string =>
  (lang ?? "").toLowerCase().replace(/_/g, "-");

/** 中文轨道的简繁字形，兼容 zh-CN / zh-TW 等地区别名。 */
const getChineseScript = (lang: string): string | undefined => {
  const canonical = LANG_TAG_ALIASES[lang] ?? lang;
  return /^zh-(hans|hant)(?:-|$)/.exec(canonical)?.[1];
};

/**
 * 根据偏好语言从多语言候选列表中挑选最优匹配索引
 * @param langs - 候选语言代码列表
 * @param preferred - 偏好语言代码
 * @returns 最优匹配的索引，langs 或 preferred 不规范时返回 0，无匹配返回 -1
 */
export const pickLangIndex = (langs: (string | null)[], preferred: string): number => {
  if (langs.length === 0) return -1;

  const normalizedOptions = langs.map((lang) => normalizeLang(lang));
  if (normalizedOptions.every((lang) => !lang)) return 0;

  const normalizedPreferred = normalizeLang(preferred);
  if (!normalizedPreferred) return 0;

  // 泛化到 zh 时仍保留显式的简繁约束，不能回退到相反字形的轨道。
  const preferredScript = getChineseScript(normalizedPreferred);
  if (preferredScript) {
    for (let i = 0; i < normalizedOptions.length; i++) {
      const script = getChineseScript(normalizedOptions[i]);
      if (script && script !== preferredScript) normalizedOptions[i] = "";
    }
  }
  const wants = [normalizedPreferred];

  // 将 wants 拆分，比如 zh-hans-cn -> zh-hans-cn, zh-hans, zh
  const normalizedPreferredSubtags = normalizedPreferred.split("-");
  for (let i = normalizedPreferredSubtags.length - 1; i > 0; i--) {
    wants.push(normalizedPreferredSubtags.slice(0, i).join("-"));
  }

  // 如有 alias，则在 wants 中加入 alias
  // 比如 zh-cn -> zh-cn, zh-hans-cn, zh-hans, zh
  for (const alias in LANG_TAG_ALIASES) {
    let index = wants.indexOf(alias);
    if (index === -1) continue;
    index++;

    const mapped = LANG_TAG_ALIASES[alias];
    if (wants.includes(mapped)) continue;

    wants.splice(index, 0, mapped);
    index++;

    const mappedSubtags = mapped.split("-");

    for (let i = mappedSubtags.length - 1; i > 0; i--) {
      const partial = mappedSubtags.slice(0, i).join("-");
      if (wants.includes(partial)) break;

      wants.splice(index, 0, partial);
      index++;
    }
  }

  // 匹配
  for (const tag of wants) {
    const exactMatchIndex = normalizedOptions.indexOf(tag);
    if (exactMatchIndex !== -1) return exactMatchIndex;
    const prefixMatchIndex = normalizedOptions.findIndex((lang) => lang.startsWith(`${tag}-`));
    if (prefixMatchIndex !== -1) return prefixMatchIndex;
  }

  return -1;
};
