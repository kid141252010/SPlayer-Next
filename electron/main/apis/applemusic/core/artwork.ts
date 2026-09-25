/**
 * Apple Music 封面 URL 格式化工具
 * Apple Music artwork.url 模板形如：
 *   https://.../{w}x{h}bb.{f}
 *   https://.../{w}x{h}bb.jpg
 *   https://.../{w}x{h}SC.FPESS04.jpg?l=zh-Hans
 */

/**
 * 格式化 Apple Music 封面地址
 * @param urlTemplate - 带有 {w} 和 {h} 占位符的 URL 模板
 * @param width - 宽度（默认 300）
 * @param height - 高度（默认同 width）
 * @param format - 图片扩展名（默认 jpg）
 * @returns 完整封面 URL
 */
export const formatAMArtworkUrl = (
  urlTemplate?: string | null,
  width: number = 300,
  height: number = width,
  format: string = "jpg",
): string | undefined => {
  if (!urlTemplate) return undefined;
  return urlTemplate
    .replace("{w}", String(width))
    .replace("{h}", String(height))
    .replace("{f}", format);
};

/**
 * 获取 Apple Music 超高清原图封面（5000x5000，由服务端自动回退到实际最高画质并保持原图比例）
 * @param urlTemplate - 带有 {w} 和 {h} 占位符的 URL 模板
 * @returns 高清封面 URL
 */
export const formatAMOriginalArtworkUrl = (urlTemplate?: string | null): string | undefined =>
  formatAMArtworkUrl(urlTemplate, 5000, 5000);
