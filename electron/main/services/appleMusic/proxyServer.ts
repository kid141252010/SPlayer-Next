import http from "node:http";
import { amLog } from "@main/utils/logger";
import { amDecryptor } from "./decryptor";
import { parseMediaPlaylist, type ParsedMediaPlaylist, type MediaSegment } from "./playlist";

interface StreamSession {
  adamId: string;
  m3u8Url: string;
  upstreamUrl: string;
  playlist?: ParsedMediaPlaylist;
  keyTemplateJson?: string;
  trackHandle?: number;
  fixedHandle?: number;
  patchedInit?: Buffer;
  /** 已解密切片的内存缓存与在途请求合并，key = start offset */
  fragCache: Map<number, Promise<Buffer>>;
}

/** 缓存最近解析的媒体会话，避免频繁重复解析清单元数据与反复向 CDN 拉取 */
const sessionCache = new Map<string, StreamSession>();
const MAX_SESSIONS = 2;
/** 单个会话最多内存驻留的切片数，避免高码率无损音频占用过多内存 */
const MAX_CACHED_FRAGMENTS = 6;

/**
 * 获取或创建流会话
 * @param adamId - 曲目 Adam ID
 * @param m3u8Url - Apple 官方 CDN 的 media m3u8 地址
 * @param upstreamUrl - am-hook 上游服务根地址
 * @returns 会话结构体
 */
const getOrCreateSession = (
  adamId: string,
  m3u8Url: string,
  upstreamUrl: string,
): StreamSession => {
  const cacheKey = `${adamId}:${m3u8Url}`;
  let session = sessionCache.get(cacheKey);
  if (!session) {
    session = {
      adamId,
      m3u8Url,
      upstreamUrl,
      fragCache: new Map(),
    };
    sessionCache.set(cacheKey, session);
    if (sessionCache.size > MAX_SESSIONS) {
      const oldestKey = sessionCache.keys().next().value;
      if (oldestKey) {
        const oldSession = sessionCache.get(oldestKey);
        if (oldSession?.trackHandle) {
          void amDecryptor.freeTemplate(oldSession.trackHandle);
        }
        oldSession?.fragCache.clear();
        sessionCache.delete(oldestKey);
      }
    }
  }
  return session;
};

/**
 * 带有超时控制与 Range 头的二进制拉取
 * @param url - 请求目标 URL
 * @param start - 起始字节偏移
 * @param end - 结束字节偏移
 * @param signal - 中止信号
 * @returns 响应二进制 Buffer
 */
const fetchByteRange = async (
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const res = await fetch(url, {
    headers: {
      Range: `bytes=${start}-${end}`,
      "User-Agent": "iTunes/12.11.3 (Windows; Microsoft Windows 10.0.19045)",
    },
    signal,
  });

  if (!res.ok && res.status !== 206) {
    throw new Error(`CDN 响应异常 HTTP ${res.status} [${start}-${end}]`);
  }

  const arrayBuf = await res.arrayBuffer();
  let buf = Buffer.from(arrayBuf);
  const expectedLen = end - start + 1;

  // 上游若忽略 Range 返回全量数据，按需精确截取
  if (res.status === 200 && buf.length > expectedLen) {
    buf = buf.subarray(start, end + 1);
  }

  return buf;
};

/**
 * 获取（或在途合并拉取）并原地解密单个音频切片
 * @param session - 当前流媒体会话
 * @param seg - 切片定义
 * @param signal - 中止信号
 * @returns 已解密的切片 Buffer
 */
const getDecryptedSegment = (
  session: StreamSession,
  seg: MediaSegment,
  signal?: AbortSignal,
): Promise<Buffer> => {
  let inFlight = session.fragCache.get(seg.start);
  if (!inFlight) {
    inFlight = (async () => {
      const raw = await fetchByteRange(session.playlist!.mediaUrl, seg.start, seg.end, signal);

      const handle =
        seg.keyType === "fixed"
          ? session.fixedHandle
          : seg.keyType === "track"
            ? session.trackHandle
            : 0;

      return amDecryptor.decryptFragment(handle || 0, raw, session.patchedInit);
    })();

    if (session.fragCache.size >= MAX_CACHED_FRAGMENTS) {
      const oldestKey = session.fragCache.keys().next().value;
      if (oldestKey !== undefined) session.fragCache.delete(oldestKey);
    }
    session.fragCache.set(seg.start, inFlight);
    // 若请求失败，不缓存错误，以便下一次重试
    inFlight.catch(() => {
      if (session.fragCache.get(seg.start) === inFlight) {
        session.fragCache.delete(seg.start);
      }
    });
  }
  return inFlight;
};

/**
 * 本地 Apple Music 音频解密与边下边播流媒体代理服务
 */
export class AppleMusicProxyServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private isStarting: boolean = false;

  /**
   * 启动本地回环 HTTP 服务
   * @returns 分配的服务端口
   */
  public async start(): Promise<number> {
    if (this.server && this.port > 0) return this.port;
    if (this.isStarting) {
      while (this.isStarting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return this.port;
    }

    this.isStarting = true;

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          amLog.error("[proxy] 处理流媒体请求异常", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal Server Error");
          }
        });
      });

      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          this.server = srv;
          this.isStarting = false;
          amLog.info(`[proxy] 本地流媒体代理服务已就绪: http://127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          this.isStarting = false;
          reject(new Error("无法获取本地代理服务端口"));
        }
      });

      srv.on("error", (err) => {
        this.isStarting = false;
        amLog.error("[proxy] 本地服务启动失败", err);
        reject(err);
      });
    });
  }

  /**
   * 构造该音轨对应的本地播放代理直链
   * @param adamId - 曲目 ID
   * @param m3u8Url - Apple CDN 的 Media M3U8 清单地址
   * @param upstreamUrl - am-hook 上游服务地址
   * @returns 本地可播放的 HTTP URL
   */
  public async getStreamUrl(adamId: string, m3u8Url: string, upstreamUrl: string): Promise<string> {
    const port = await this.start();
    const params = new URLSearchParams({
      adamId,
      m3u8: m3u8Url,
      upstream: upstreamUrl,
    });
    return `http://127.0.0.1:${port}/am-stream?${params.toString()}`;
  }

  /**
   * 处理进入的流媒体 HTTP 请求
   * @param req - HTTP 请求对象
   * @param res - HTTP 响应对象
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (parsedUrl.pathname !== "/am-stream") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const adamId = parsedUrl.searchParams.get("adamId");
    const m3u8Url = parsedUrl.searchParams.get("m3u8");
    const upstream = parsedUrl.searchParams.get("upstream");

    if (!adamId || !m3u8Url || !upstream) {
      res.writeHead(400);
      res.end("缺少必要参数: adamId, m3u8, upstream");
      return;
    }

    const session = getOrCreateSession(adamId, m3u8Url, upstream);
    const abortCtrl = new AbortController();

    req.on("close", () => {
      abortCtrl.abort();
    });

    try {
      // 1. 初始化元数据：解析 M3U8 清单
      if (!session.playlist) {
        const m3u8Res = await fetch(m3u8Url, { signal: abortCtrl.signal });
        if (!m3u8Res.ok) throw new Error(`拉取 M3U8 清单失败 HTTP ${m3u8Res.status}`);
        const m3u8Text = await m3u8Res.text();
        session.playlist = parseMediaPlaylist(m3u8Text, m3u8Url);
      }

      const { playlist } = session;

      // 2. 初始化 Init Segment（修补 DRM 结构）
      if (!session.patchedInit) {
        const rawInit = await fetchByteRange(
          playlist.mediaUrl,
          playlist.init.start,
          playlist.init.end,
          abortCtrl.signal,
        );
        session.patchedInit = await amDecryptor.patchInit(rawInit);
      }

      // 3. 初始化解密句柄
      if (session.fixedHandle === undefined) {
        session.fixedHandle = await amDecryptor.getFixedTemplate();
      }

      if (playlist.keyUri && !session.trackHandle) {
        const keyReqUrl = `${upstream}/key?adamId=${encodeURIComponent(adamId)}&uri=${encodeURIComponent(playlist.keyUri)}`;
        const keyRes = await fetch(keyReqUrl, { signal: abortCtrl.signal });
        if (!keyRes.ok) throw new Error(`拉取解密密钥模板失败 HTTP ${keyRes.status}`);
        session.keyTemplateJson = await keyRes.text();
        session.trackHandle = await amDecryptor.loadTemplate(session.keyTemplateJson);
      }

      const totalSize = playlist.totalSize;

      // 4. 解析客户端传入的 Range 头
      let startOffset = 0;
      let endOffset = totalSize - 1;
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (match) {
          startOffset = Number.parseInt(match[1], 10);
          if (match[2]) {
            endOffset = Number.parseInt(match[2], 10);
          }
        }
      }

      if (startOffset >= totalSize || endOffset >= totalSize || startOffset > endOffset) {
        res.writeHead(416, {
          "Content-Range": `bytes */${totalSize}`,
        });
        res.end();
        return;
      }

      const contentLength = endOffset - startOffset + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${startOffset}-${endOffset}/${totalSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": contentLength,
        "Content-Type": "audio/mp4",
        "Cache-Control": "no-cache",
      });

      // 5. 流式按序输出数据
      // 5.1 检查是否包含 Init Segment 范围
      const initLen = session.patchedInit.length;
      if (startOffset < initLen) {
        const initSliceEnd = Math.min(initLen - 1, endOffset);
        const initSlice = session.patchedInit.subarray(startOffset, initSliceEnd + 1);
        if (!res.write(initSlice)) {
          await new Promise((r) => res.once("drain", r));
        }
      }

      // 5.2 寻找相交的分片
      const relevantSegments = playlist.segments.filter(
        (seg) => seg.end >= startOffset && seg.start <= endOffset,
      );

      for (const seg of relevantSegments) {
        if (res.destroyed || abortCtrl.signal.aborted) break;

        const fragBuf = await getDecryptedSegment(session, seg, abortCtrl.signal);
        if (res.destroyed || abortCtrl.signal.aborted) break;

        // 如果请求的 Range 只涵盖分片的一部分，做局部切片
        let chunk = fragBuf;
        if (startOffset > seg.start) {
          const cutStart = startOffset - seg.start;
          chunk = chunk.subarray(cutStart);
        }
        if (endOffset < seg.end) {
          const cutEnd = chunk.length - (seg.end - endOffset);
          chunk = chunk.subarray(0, cutEnd);
        }

        if (chunk.length > 0) {
          if (!res.write(chunk)) {
            await new Promise((r) => res.once("drain", r));
          }
        }
      }

      res.end();
    } catch (err) {
      if (!abortCtrl.signal.aborted) {
        amLog.error("[proxy] 推流过程中发生错误", err);
      }
      if (!res.destroyed) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * 销毁并停止本地代理服务
   */
  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
      sessionCache.clear();
      amLog.info("[proxy] 本地代理服务已停止");
    }
  }
}

/** 全局单例代理服务 */
export const appleMusicProxy = new AppleMusicProxyServer();
