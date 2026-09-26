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
}

export interface MediaInit {
  url: string;
  start: number;
  end: number;
}

export interface ParsedMediaPlaylist {
  mediaUrl: string;
  adamId: string;
  keyUri: string | null;
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
  let keyUri: string | null = null;
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
    return { start, end: start + len - 1 };
  };

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const method = (/METHOD=([^,]+)/.exec(line) || [])[1];
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      currentKey = method === "NONE" || !uri ? null : uri;
      if (currentKey && currentKey !== FIXED_KEY_URI && !keyUri) {
        keyUri = currentKey;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = /URI="([^"]+)"/.exec(line);
      const rangeMatch = /BYTERANGE="([^"]+)"/.exec(line);
      if (!uriMatch || !rangeMatch) {
        throw new Error("M3U8 缺少有效的 #EXT-X-MAP 头信息");
      }
      const range = parseByterange(rangeMatch[1], 0);
      init = {
        url: new URL(uriMatch[1], playlistUrl).href,
        ...range,
      };
      next = init.end + 1;
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice(8));
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const r = parseByterange(line.slice(17), next);
      next = r.end + 1;
      const dur = pendingDuration || 0;
      const keyType = currentKey === FIXED_KEY_URI ? "fixed" : currentKey ? "track" : "none";
      segments.push({
        index: segments.length,
        ...r,
        time: duration,
        duration: dur,
        keyType,
      });
      duration += dur;
      pendingDuration = null;
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
    keyUri,
    init,
    segments,
    duration,
    totalSize,
  };
};
