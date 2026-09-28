/**
 * 判断是否应短路 FFmpeg 的尾部索引探针
 * @param startOffset - 请求起始字节
 * @param firstSegmentEnd - 第 0 分片结束字节
 * @param lastSegmentStart - 最后一个分片起始字节
 * @param contentLength - 请求字节数
 * @param trackHandleReady - 曲目解密模板是否已就绪
 * @returns 是否返回零填充探针数据
 */
export const shouldShortCircuitProbe = (
  startOffset: number,
  firstSegmentEnd: number,
  lastSegmentStart: number,
  contentLength: number,
  trackHandleReady: boolean,
): boolean =>
  !trackHandleReady &&
  startOffset > firstSegmentEnd &&
  startOffset >= lastSegmentStart &&
  contentLength <= 65_536;
