/** CJK 部首补充、康熙部首、CJK 兼容表意文字——均与标准汉字同形/近形异码 */
const COMPAT_RE = /[\u2E80-\u2EFF\u2F00-\u2FDF\uF900-\uFAFF]/g;

/**
 * 将康熙部首、兼容表意文字等同形异码字符还原为标准汉字
 * @param text - 原始歌词文本
 * @returns 还原为标准汉字后的文本
 */
export const normalizeKangxi = (text: string): string =>
  text.replace(COMPAT_RE, (char) => char.normalize("NFKC"));
