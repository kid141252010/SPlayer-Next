/**
 * Apple Music HLS Media Playlist (.m3u8) 解析器
 */

const FIXED_KEY_URI = "skd://itunes.apple.com/P000000000/s1/e1";

export interface MediaSegment {
  index: number;
  start: number;
  end: number;
  duration: number;
  time: number;
  keyType: "fixed" | "track" | "none";
  keyUri: string | null;
}

export interface MediaInit {
  url: string;
  start: number;
  end: number;
}

export interface ParsedMediaPlaylist {
  mediaUrl: string;
  adamId: string;
  init: MediaInit;
  segments: MediaSegment[];
  duration: number;
  totalSize: number;
}

/**
 * 解析 Apple 官方 Media M3U8 清单，提取 Init 头部与各个分片的字节范围与解密模式
 * @param text - M3U8 文本内容
 * @param playlistUrl - M3U8 请求的 URL（用于解析相对路径）
 * @returns 解析后的播放列表结构体
 */
export const parseMediaPlaylist = (text: string, playlistUrl: string): ParsedMediaPlaylist => {
  const fileName = new URL(playlistUrl).pathname.split("/").pop() || "";
  const adamId = (/_A(\d+)_/.exec(fileName) || [])[1] || "";

  let init: MediaInit | null = null;
  let currentKey: string | null = null;
  let duration = 0;
  let pendingDuration: number | null = null;
  let next = 0;
  const segments: MediaSegment[] = [];

  const parseByterange = (
    value: string,
    fallbackOffset: number,
  ): { start: number; end: number } => {
    const [lenStr, offStr] = value.replace(/"/g, "").trim().split("@");
    const len = Number(lenStr);
    const start = offStr === undefined ? fallbackOffset : Number(offStr);
    const end = start + len - 1;
    if (!Number.isSafeInteger(end)) throw new Error("M3U8 分片字节范围超出安全整数范围");
    if (!Number.isSafeInteger(len) || len <= 0 || !Number.isSafeInteger(start) || start < 0) {
      throw new Error("M3U8 含无效的分片字节范围");
    }
    return { start, end };
  };

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const method = (/METHOD=([^,]+)/.exec(line) || [])[1];
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      if (method !== "NONE" && (method !== "SAMPLE-AES" || !uri?.startsWith("skd://"))) {
        throw new Error("M3U8 含不支持的音频加密方式或缺少密钥 URI");
      }
      currentKey = method === "NONE" ? null : uri;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = /URI="([^"]+)"/.exec(line);
      const rangeMatch = /BYTERANGE="([^"]+)"/.exec(line);
      if (!uriMatch || !rangeMatch) {
        throw new Error("M3U8 缺少有效的 #EXT-X-MAP 头信息");
      }
      const range = parseByterange(rangeMatch[1], 0);
      if (init || range.start !== 0) throw new Error("M3U8 初始化段必须从文件起点开始");
      init = {
        url: new URL(uriMatch[1], playlistUrl).href,
        ...range,
      };
      next = init.end + 1;
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice(8));
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const r = parseByterange(line.slice(17), next);
      if (
        !init ||
        r.start !== next ||
        pendingDuration === null ||
        !Number.isFinite(pendingDuration) ||
        pendingDuration <= 0
      ) {
        throw new Error("M3U8 分片范围或时长不连续");
      }
      next = r.end + 1;
      const dur = pendingDuration || 0;
      const keyType = currentKey === FIXED_KEY_URI ? "fixed" : currentKey ? "track" : "none";
      segments.push({
        index: segments.length,
        ...r,
        time: duration,
        duration: dur,
        keyType,
        keyUri: currentKey,
      });
      duration += dur;
      pendingDuration = null;
    } else if (line && !line.startsWith("#")) {
      if (!init || new URL(line, playlistUrl).href !== init.url) {
        throw new Error("M3U8 分片必须与初始化段位于同一媒体文件");
      }
    }
  }

  if (!init || segments.length === 0) {
    throw new Error("M3U8 格式异常：未找到初始化段或音轨分片");
  }

  const lastSegment = segments[segments.length - 1];
  const totalSize = lastSegment.end + 1;

  return {
    mediaUrl: init.url,
    adamId,
    init,
    segments,
    duration,
    totalSize,
  };
};
