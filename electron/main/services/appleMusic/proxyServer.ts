import http from "node:http";
import { amLog } from "@main/utils/logger";
import { fetchWithProxy } from "@main/utils/proxy";
import { amDecryptor } from "./decryptor";
import { parseMediaPlaylist, type ParsedMediaPlaylist, type MediaSegment } from "./playlist";

interface StreamSession {
  adamId: string;
  m3u8Url: string;
  upstreamUrl: string;
  token?: string;
  authHeader?: string;
  /** 会话就绪 Promise（并发安全，防重入与防止连接断开误杀） */
  readyPromise?: Promise<ParsedMediaPlaylist>;
  playlist?: ParsedMediaPlaylist;
  keyTemplateJson?: string;
  trackHandle?: number;
  fixedHandle?: number;
  patchedInit?: Buffer;
  /** 已解密切片的内存缓存与在途请求合并，key = start offset */
  fragCache: Map<number, Promise<Buffer>>;
  /** 最近访问时间戳，供 LRU 淘汰 */
  lastAccessTime: number;
}

/** 缓存最近解析的媒体会话，避免频繁重复解析清单元数据与反复向 CDN 拉取 */
const sessionCache = new Map<string, StreamSession>();
const MAX_SESSIONS = 2;
/** 单个会话最多内存驻留的切片数，避免高码率无损音频占用过多内存 */
const MAX_CACHED_FRAGMENTS = 8;
/** 滑动窗口前向预取切片数 */
const PREFETCH_AHEAD = 2;
/** 单次普通请求超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 分片下载请求超时时间（毫秒），确保无损与高解析度音频切片有充裕缓冲时间 */
const FRAGMENT_TIMEOUT_MS = 30_000;
/** 网络请求最大失败重试次数 */
const MAX_NETWORK_RETRIES = 2;

/**
 * 解析并清理 upstream 地址与认证凭证
 * 兼容 `https://token@host`、`https://user:pass@host` 格式以及显式传入的 token
 */
export function resolveUpstreamAuth(
  upstreamUrl: string,
  explicitToken?: string,
): {
  cleanUpstreamUrl: string;
  token?: string;
  authHeader?: string;
} {
  let raw = upstreamUrl.trim();
  let token = explicitToken?.trim() || undefined;
  let authHeader: string | undefined;

  try {
    const u = new URL(raw);
    if (u.username) {
      if (u.password) {
        const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
        authHeader = `Basic ${Buffer.from(creds).toString("base64")}`;
      } else {
        token = decodeURIComponent(u.username);
      }
      u.username = "";
      u.password = "";
      raw = u.origin + u.pathname.replace(/\/+$/, "");
    }
  } catch {
    // 忽略格式解析错误
  }

  const cleanUpstreamUrl = raw.replace(/\/+$/, "");
  if (!authHeader && token) {
    authHeader = `Bearer ${token}`;
  }

  return { cleanUpstreamUrl, token, authHeader };
}

/**
 * 获取或创建流会话
 * @param adamId - 曲目 Adam ID
 * @param m3u8Url - Apple 官方 CDN 的 media m3u8 地址
 * @param upstreamUrl - am-hook 上游服务根地址
 * @param token - 可选鉴权 Token
 * @returns 会话结构体
 */
const getOrCreateSession = (
  adamId: string,
  m3u8Url: string,
  upstreamUrl: string,
  token?: string,
): StreamSession => {
  const {
    cleanUpstreamUrl,
    token: resolvedToken,
    authHeader,
  } = resolveUpstreamAuth(upstreamUrl, token);
  const cacheKey = `${adamId}:${m3u8Url}`;
  let session = sessionCache.get(cacheKey);
  const now = Date.now();

  if (!session) {
    session = {
      adamId,
      m3u8Url,
      upstreamUrl: cleanUpstreamUrl,
      token: resolvedToken,
      authHeader,
      fragCache: new Map(),
      lastAccessTime: now,
    };
    sessionCache.set(cacheKey, session);

    if (sessionCache.size > MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, sess] of sessionCache) {
        if (sess.lastAccessTime < oldestTime) {
          oldestTime = sess.lastAccessTime;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        const oldSession = sessionCache.get(oldestKey);
        if (oldSession?.trackHandle) {
          void amDecryptor.freeTemplate(oldSession.trackHandle);
        }
        oldSession?.fragCache.clear();
        sessionCache.delete(oldestKey);
      }
    }
  } else {
    session.lastAccessTime = now;
  }
  return session;
};

/**
 * 带有超时控制、代理支持与自动重试的通用 HTTP 请求
 * @param url - 请求目标 URL
 * @param init - 请求配置
 * @param retries - 重试次数
 * @param timeoutMs - 超时时间（毫秒）
 * @returns 响应对象
 */
const fetchWithRetry = async (
  url: string,
  init?: RequestInit,
  retries = MAX_NETWORK_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetchWithProxy(url, {
        ...init,
        signal: combinedSignal,
        headers: {
          "User-Agent": "iTunes/12.11.3 (Windows; Microsoft Windows 10.0.19045)",
          ...init?.headers,
        },
      });

      if (!res.ok && res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (init?.signal?.aborted) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/**
 * 带有超时控制、重试与 Range 头的二进制拉取
 * @param url - 请求目标 URL
 * @param start - 起始字节偏移
 * @param end - 结束字节偏移
 * @param signal - 中止信号
 * @returns 响应二进制 Buffer
 */
const fetchByteRangeWithRetry = async (
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Range: `bytes=${start}-${end}`,
      },
      signal,
    },
    MAX_NETWORK_RETRIES,
    FRAGMENT_TIMEOUT_MS,
  );

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
 * 并发安全地初始化会话并准备元数据（M3U8 解析、Init 段修补、密钥模板加载并发进行）
 * @param session - 媒体流会话
 * @returns 解析后的播放列表结构
 */
const ensureSessionReady = async (session: StreamSession): Promise<ParsedMediaPlaylist> => {
  if (session.playlist && session.patchedInit && session.fixedHandle !== undefined) {
    return session.playlist;
  }

  if (!session.readyPromise) {
    session.readyPromise = (async () => {
      // 1. 拉取 M3U8 清单
      const m3u8Res = await fetchWithRetry(session.m3u8Url);
      if (!m3u8Res.ok) throw new Error(`拉取 M3U8 清单失败 HTTP ${m3u8Res.status}`);
      const m3u8Text = await m3u8Res.text();
      const playlist = parseMediaPlaylist(m3u8Text, session.m3u8Url);
      session.playlist = playlist;

      // 2. 并发初始化 Init 段、Key 模板和 Fixed 模板
      const initTask = (async () => {
        const rawInit = await fetchByteRangeWithRetry(
          playlist.mediaUrl,
          playlist.init.start,
          playlist.init.end,
        );
        session.patchedInit = await amDecryptor.patchInit(rawInit);
      })();

      const keyTask = (async () => {
        if (!playlist.keyUri) return;
        const keyReqUrl = `${session.upstreamUrl}/key?adamId=${encodeURIComponent(session.adamId)}&uri=${encodeURIComponent(playlist.keyUri)}`;
        const headers: Record<string, string> = {};
        if (session.authHeader) {
          headers.Authorization = session.authHeader;
        }
        const keyRes = await fetchWithRetry(keyReqUrl, { headers });
        if (!keyRes.ok) {
          throw new Error(`拉取解密密钥模板失败 HTTP ${keyRes.status} (${keyReqUrl})`);
        }
        session.keyTemplateJson = await keyRes.text();
        session.trackHandle = await amDecryptor.loadTemplate(session.keyTemplateJson, {
          adamId: session.adamId,
          keyUri: playlist.keyUri,
        });
      })();

      const fixedTask = (async () => {
        session.fixedHandle = await amDecryptor.getFixedTemplate();
      })();

      await Promise.all([initTask, keyTask, fixedTask]);
      return playlist;
    })().catch((err) => {
      session.readyPromise = undefined;
      throw err;
    });
  }

  return session.readyPromise;
};

/**
 * 触发切片滑动窗口前向预取
 * @param session - 当前流媒体会话
 * @param currentIndex - 当前处理的切片下标
 */
const triggerPrefetch = (session: StreamSession, currentIndex: number): void => {
  const segments = session.playlist?.segments;
  if (!segments) return;
  for (let k = 1; k <= PREFETCH_AHEAD; k++) {
    const nextSeg = segments[currentIndex + k];
    if (nextSeg) {
      void getDecryptedSegment(session, nextSeg);
    }
  }
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
      const raw = await fetchByteRangeWithRetry(
        session.playlist!.mediaUrl,
        seg.start,
        seg.end,
        signal,
      );

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
    // 若请求失败，不缓存错误以便下次重试
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
   * 构造该音轨对应的本地播放代理直链并触发后台会话预热
   * @param adamId - 曲目 ID
   * @param m3u8Url - Apple CDN 的 Media M3U8 清单地址
   * @param upstreamUrl - am-hook 上游服务地址
   * @param token - 可选鉴权 Token
   * @returns 本地可播放的 HTTP URL
   */
  public async getStreamUrl(
    adamId: string,
    m3u8Url: string,
    upstreamUrl: string,
    token?: string,
  ): Promise<string> {
    const port = await this.start();
    const { cleanUpstreamUrl, token: resolvedToken } = resolveUpstreamAuth(upstreamUrl, token);
    const session = getOrCreateSession(adamId, m3u8Url, cleanUpstreamUrl, resolvedToken);

    // 提前触发后台并发预热：解析 M3U8、修补 Init、获取密钥模板并预取第 0 个分片
    void (async () => {
      try {
        const playlist = await ensureSessionReady(session);
        if (playlist.segments.length > 0) {
          void getDecryptedSegment(session, playlist.segments[0]);
        }
      } catch (err) {
        amLog.warn("[proxy] 会话预热未完成", err);
      }
    })();

    const params = new URLSearchParams({
      adamId,
      m3u8: m3u8Url,
      upstream: cleanUpstreamUrl,
    });
    if (resolvedToken) {
      params.set("token", resolvedToken);
    }
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
    const token = parsedUrl.searchParams.get("token") || undefined;

    if (!adamId || !m3u8Url || !upstream) {
      res.writeHead(400);
      res.end("缺少必要参数: adamId, m3u8, upstream");
      return;
    }

    const session = getOrCreateSession(adamId, m3u8Url, upstream, token);
    let isClientClosed = false;

    req.on("close", () => {
      isClientClosed = true;
    });

    try {
      const playlist = await ensureSessionReady(session);
      const totalSize = playlist.totalSize;

      // 解析客户端传入的 Range 头
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

      // 流式按序输出数据
      // 1. 检查是否包含 Init Segment 范围
      const patchedInit = session.patchedInit!;
      const initLen = patchedInit.length;
      if (startOffset < initLen) {
        const initSliceEnd = Math.min(initLen - 1, endOffset);
        const initSlice = patchedInit.subarray(startOffset, initSliceEnd + 1);
        if (!res.write(initSlice)) {
          await new Promise((r) => res.once("drain", r));
        }
      }

      // 2. 寻找相交的分片并进行滑动窗口流式推送
      const relevantSegments = playlist.segments.filter(
        (seg) => seg.end >= startOffset && seg.start <= endOffset,
      );

      for (let i = 0; i < relevantSegments.length; i++) {
        if (res.destroyed || isClientClosed) break;
        const seg = relevantSegments[i];

        // 触发前向滑动窗口预取
        triggerPrefetch(session, seg.index);

        const fragBuf = await getDecryptedSegment(session, seg);
        if (res.destroyed || isClientClosed) break;

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
      if (!isClientClosed) {
        amLog.error(`[proxy] 推流过程中发生错误 (adamId: ${adamId})`, err);
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
