/** 默认无意义占位符正则：纯标点、斜杠、波浪线、省略号或连接符等无字面意义的占位行 */
export const DEFAULT_PLACEHOLDER_RE = /^[\s/\\_.\-—~～·•…]+$/;

/** 默认非歌词免责声明与平台版权关键词：著作权水印、大模型 AI 翻译声明等 */
export const DEFAULT_DISCLAIMER_KEYWORDS: readonly string[] = [
  "著作权",
  "版权所有",
  "未经许可",
  "大模型提供",
  "机器翻译",
  "\u0054\u004d\u0045 AI",
];

/**
 * 检查文本是否为有实际含义的歌词/翻译内容
 * 过滤纯标点符号占位符（如 //、/）与平台版权水印、大模型翻译声明等非歌词文本
 * @param text - 待检查的歌词或翻译文本
 * @param extraKeywords - 可选追加的自定义排除关键字列表
 * @returns 是否为有意义的有效内容
 */
export const isMeaningfulTranslation = (
  text: string,
  extraKeywords?: readonly string[],
): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (DEFAULT_PLACEHOLDER_RE.test(trimmed)) return false;
  for (const keyword of DEFAULT_DISCLAIMER_KEYWORDS) {
    if (trimmed.includes(keyword)) return false;
  }
  if (extraKeywords) {
    for (const keyword of extraKeywords) {
      if (trimmed.includes(keyword)) return false;
    }
  }
  return true;
};
