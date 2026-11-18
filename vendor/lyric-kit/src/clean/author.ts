import type { LyricFormat } from "../types";
import { defaultAuthors } from "./excludeRules";

/** 支持从 [by:...] 标签中提取制作者的歌词格式集合 */
const TAG_BASED_FORMATS = new Set<LyricFormat>(["lrc", "qrc", "krc", "yrc", "lys"]);

/**
 * 判断是否应排除该制作者
 * @param author - 制作者名称或账号
 * @param extraKeywords - 可选的追加排除关键词列表
 * @returns 命中排除规则时返回 true
 */
export const shouldExcludeAuthor = (author: string, extraKeywords?: readonly string[]): boolean => {
  const lower = author.toLowerCase();
  const keywords = extraKeywords ? [...defaultAuthors, ...extraKeywords] : defaultAuthors;
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
};

/**
 * 从歌词原始内容中提取「歌词文件制作者」列表
 * @param content - 歌词原始文本
 * @param format - 歌词格式
 * @param extraKeywords - 可选的追加排除关键词列表
 * @returns 作者账号/名称的数组
 */
export const extractLyricAuthors = (
  content: string,
  format: LyricFormat,
  extraKeywords?: readonly string[],
): string[] => {
  if (format === "ttml") {
    // 优先提取 ttmlAuthorGithubLogin，作为可以直接用于跳转 GitHub 的账号
    const logins = [...content.matchAll(/key="ttmlAuthorGithubLogin"\s+value="([^"]*)"/g)]
      .map((match) => match[1].trim())
      .filter((login) => login && !shouldExcludeAuthor(login, extraKeywords));
    if (logins.length > 0) {
      return Array.from(new Set(logins));
    }
    // 如果无 login 标识，从 ttmlAuthorGithub 主页链接中截取最后的用户名
    const bases = [...content.matchAll(/key="ttmlAuthorGithub"\s+value="([^"]*)"/g)]
      .map((match) => {
        const val = match[1].trim();
        const parts = val.split("/");
        return parts[parts.length - 1] || val;
      })
      .filter((base) => base && !shouldExcludeAuthor(base, extraKeywords));
    return Array.from(new Set(bases));
  }

  if (TAG_BASED_FORMATS.has(format)) {
    const match = content.match(/\[by:([^\]]+)\]/i)?.[1]?.trim();
    return match && !shouldExcludeAuthor(match, extraKeywords) ? [match] : [];
  }

  return [];
};
