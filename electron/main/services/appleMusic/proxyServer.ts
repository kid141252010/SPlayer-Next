import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { amLog } from "@main/utils/logger";
import { fetchWithProxy } from "@main/utils/proxy";
import { amDecryptor, type AmTemplate } from "./decryptor";
import { parseMediaPlaylist, type ParsedMediaPlaylist, type MediaSegment } from "./playlist";

interface StreamSession {
  adamId: string;
  m3u8Url: string;
  upstreamUrl: string;
  authHeader?: string;
  /** 初始化段就绪与轨道模板就绪相互独立，失败的模板可重新获取 */
  readyPromise?: Promise<ParsedMediaPlaylist>;
  playbackPromise?: Promise<void>;
  playlist?: ParsedMediaPlaylist;
  templates: Map<string, Promise<AmTemplate>>;
  controller: AbortController;
  patchedInit?: Buffer;
  /** 已解密切片的内存缓存与在途请求合并，key = start offset */
  fragCache: Map<number, Promise<Buffer>>;
  /** 最近访问时间戳，供 LRU 淘汰 */
  lastAccessTime: number;
  /** 当前活跃推流中的连接数，防止推流途中被 LRU 淘汰并误释放解密模板 */
  activeRequests: number;
}

/** 缓存最近解析的媒体会话，避免频繁重复解析清单元数据与反复向 CDN 拉取 */
const sessionCache = new Map<string, StreamSession>();
const MAX_SESSIONS = 8;
/** 单个会话最多内存驻留的切片数，避免高码率无损音频占用过多内存 */
const MAX_CACHED_FRAGMENTS = 8;
/** 滑动窗口前向预取切片数 */
const PREFETCH_AHEAD = 2;
/** 单次普通请求超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 覆盖上游密钥服务的 15 秒处理窗口与网络开销 */
const KEY_TIMEOUT_MS = 20_000;
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
 * 终止会话，等待在途解密退出后释放所属模板
 * @param session - 被淘汰或停止的会话
 */
const disposeSession = (session: StreamSession): void => {
  session.controller.abort();
  const templates = [...session.templates.values()];
  void Promise.allSettled([
    session.readyPromise,
    session.playbackPromise,
    ...session.fragCache.values(),
    ...templates,
  ])
    .then(async () => {
      for (const pending of templates) {
        const template = await pending.catch(() => null);
        if (template) await amDecryptor.freeTemplate(template);
      }
    })
    .catch((error) => amLog.warn("[proxy] 释放解密会话失败", error));
  session.templates.clear();
  session.fragCache.clear();
};

/** 淘汰超出容量的空闲会话，活跃播放和预热不参与淘汰 */
const trimSessions = (): void => {
  while (sessionCache.size > MAX_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, session] of sessionCache) {
      if (session.activeRequests === 0 && session.lastAccessTime < oldestTime) {
        oldestKey = key;
        oldestTime = session.lastAccessTime;
      }
    }
    if (!oldestKey) break;
    disposeSession(sessionCache.get(oldestKey)!);
    sessionCache.delete(oldestKey);
  }
};

/**
 * 获取会话并持有租约，隔离不同上游和凭证的解密上下文
 * @param adamId - 曲目 ID
 * @param m3u8Url - Apple 媒体清单地址
 * @param upstreamUrl - 密钥服务根地址
 * @param token - 可选认证令牌
 * @returns 由调用方在 finally 中释放租约的会话
 */
const getOrCreateSession = (
  adamId: string,
  m3u8Url: string,
  upstreamUrl: string,
  token?: string,
): StreamSession => {
  const { cleanUpstreamUrl, authHeader } = resolveUpstreamAuth(upstreamUrl, token);
  const cacheKey = JSON.stringify([adamId, m3u8Url, cleanUpstreamUrl, authHeader]);
  let session = sessionCache.get(cacheKey);
  if (!session) {
    session = {
      adamId,
      m3u8Url,
      upstreamUrl: cleanUpstreamUrl,
      authHeader,
      templates: new Map(),
      controller: new AbortController(),
      fragCache: new Map(),
      lastAccessTime: Date.now(),
      activeRequests: 0,
    };
    sessionCache.set(cacheKey, session);
  }
  session.lastAccessTime = Date.now();
  session.activeRequests++;
  trimSessions();
  return session;
};

/**
 * 释放请求或预热持有的会话租约
 * @param session - 已完成消费的会话
 */
const releaseSession = (session: StreamSession): void => {
  session.activeRequests--;
  trimSessions();
};

/**
 * 在同一次超时与重试范围内读取并验证完整响应体
 * @param url - 上游地址
 * @param read - 响应体读取与边界验证
 * @param init - 请求参数
 * @param timeoutMs - 每次请求的完整耗时上限
 * @returns 已读取并验证的数据
 */
const fetchWithRetry = async <T>(
  url: string,
  read: (response: Response) => Promise<T>,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    init?.signal?.throwIfAborted();
    let response: Response | undefined;
    let retryable = true;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchWithProxy(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        headers: {
          "User-Agent": "iTunes/12.11.3 (Windows; Microsoft Windows 10.0.19045)",
          ...init?.headers,
        },
      });
      if (!response.ok) {
        retryable = response.status >= 500 || response.status === 429;
        throw new Error(`上游响应异常 HTTP ${response.status}`);
      }
      return await read(response);
    } catch (error) {
      lastError = error;
      if (init?.signal?.aborted || !retryable) throw error;
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
    if (attempt < MAX_NETWORK_RETRIES)
      await delay(100 * (attempt + 1), undefined, { signal: init?.signal ?? undefined });
  }
  throw lastError;
};

/**
 * 读取精确的 CDN 字节区间，短读、错位与响应体错误均参与重试
 * @param url - 媒体文件地址
 * @param start - 闭区间起点
 * @param end - 闭区间终点
 * @param signal - 会话取消信号
 * @returns 与请求范围等长的原始分片
 */
const fetchByteRangeWithRetry = (
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Buffer> =>
  fetchWithRetry(
    url,
    async (response) => {
      const expectedLength = end - start + 1;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        if (
          !range ||
          Number(range[1]) !== start ||
          Number(range[2]) !== end ||
          !Number.isSafeInteger(Number(range[3])) ||
          Number(range[3]) <= end
        ) {
          throw new Error(`CDN 返回错位的 Content-Range [${start}-${end}]`);
        }
      } else if (response.status !== 200) {
        throw new Error(`CDN 不支持字节读取 HTTP ${response.status}`);
      }
      let bytes = Buffer.from(await response.arrayBuffer());
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) !== bytes.length) {
        throw new Error(`CDN 响应体长度不符 [${start}-${end}]`);
      }
      if (response.status === 200) {
        if (bytes.length < end + 1) throw new Error("CDN 忽略 Range 且未返回完整文件");
        bytes = Buffer.from(bytes.subarray(start, end + 1));
      }
      if (bytes.length !== expectedLength) {
        throw new Error(`CDN 分片长度不符，期望 ${expectedLength}，实际 ${bytes.length}`);
      }
      return bytes;
    },
    { headers: { Range: `bytes=${start}-${end}` }, signal },
    FRAGMENT_TIMEOUT_MS,
  );

/**
 * 向 MP4 Init Segment（moov 容器中的 mvhd, tkhd, mdhd）注入曲目真实总时长
 * 使 FFmpeg 解封装器在首播无需扫描文件尾部即可瞬间原生识别出完整曲目时长
 * @param initBuf - 已修补的 Init Segment 内存 Buffer
 * @param durationSecs - 曲目真实总秒数（来自 M3U8 清单累加）
 * @returns 注入时长后的 Buffer
 */
const injectDurationToInit = (initBuf: Buffer, durationSecs: number): Buffer => {
  if (durationSecs <= 0) return initBuf;
  const copy = Buffer.from(initBuf);

  // 1. mvhd (Movie Header Box)
  const mvhdIdx = copy.indexOf("mvhd");
  let movieTimescale = 48000;
  if (mvhdIdx >= 4) {
    const ver = copy.readUInt8(mvhdIdx + 4);
    if (ver === 0 && copy.length >= mvhdIdx + 24) {
      movieTimescale = copy.readUInt32BE(mvhdIdx + 16);
      const targetDuration = Math.round(durationSecs * movieTimescale);
      copy.writeUInt32BE(targetDuration, mvhdIdx + 20);
    } else if (ver === 1 && copy.length >= mvhdIdx + 36) {
      movieTimescale = copy.readUInt32BE(mvhdIdx + 24);
      const targetDuration = BigInt(Math.round(durationSecs * movieTimescale));
      copy.writeBigUInt64BE(targetDuration, mvhdIdx + 28);
    }
  }

  // 2. tkhd (Track Header Box)
  // FullBox(4B) + creation(4/8B) + mod(4/8B) + track_id(4B) + reserved(4B) -> duration
  const tkhdIdx = copy.indexOf("tkhd");
  if (tkhdIdx >= 4) {
    const ver = copy.readUInt8(tkhdIdx + 4);
    if (ver === 0 && copy.length >= tkhdIdx + 28) {
      const targetDuration = Math.round(durationSecs * movieTimescale);
      copy.writeUInt32BE(targetDuration, tkhdIdx + 24);
    } else if (ver === 1 && copy.length >= tkhdIdx + 40) {
      const targetDuration = BigInt(Math.round(durationSecs * movieTimescale));
      copy.writeBigUInt64BE(targetDuration, tkhdIdx + 32);
    }
  }

  // 3. mdhd (Media Header Box)
  // FullBox(4B) + creation(4/8B) + mod(4/8B) + timescale(4B) -> duration
  const mdhdIdx = copy.indexOf("mdhd");
  if (mdhdIdx >= 4) {
    const ver = copy.readUInt8(mdhdIdx + 4);
    if (ver === 0 && copy.length >= mdhdIdx + 24) {
      const mdhdTimescale = copy.readUInt32BE(mdhdIdx + 16);
      const targetDuration = Math.round(durationSecs * mdhdTimescale);
      copy.writeUInt32BE(targetDuration, mdhdIdx + 20);
    } else if (ver === 1 && copy.length >= mdhdIdx + 36) {
      const mdhdTimescale = copy.readUInt32BE(mdhdIdx + 24);
      const targetDuration = BigInt(Math.round(durationSecs * mdhdTimescale));
      copy.writeBigUInt64BE(targetDuration, mdhdIdx + 28);
    }
  }

  return copy;
};

/**
 * 按清单中每片的实际密钥缓存模板，失败项移除后允许重新获取
 * @param session - 所属会话
 * @param segment - 明确声明加密方式和密钥的分片
 * @returns 未加密片返回 null，加密片必须返回有效模板
 */
const getSegmentTemplate = (
  session: StreamSession,
  segment: MediaSegment,
): Promise<AmTemplate | null> => {
  const signal = session.controller.signal;
  if (signal.aborted) return Promise.reject(signal.reason);
  if (segment.keyType === "none") return Promise.resolve(null);
  const keyUri = segment.keyUri!;
  let pending = session.templates.get(keyUri);
  if (!pending) {
    pending = (async () => {
      if (segment.keyType === "fixed") return amDecryptor.getFixedTemplate();
      const params = new URLSearchParams({ adamId: session.adamId, uri: keyUri });
      const json = await fetchWithRetry(
        `${session.upstreamUrl}/key?${params.toString()}`,
        (response) => response.text(),
        {
          headers: session.authHeader ? { Authorization: session.authHeader } : undefined,
          signal,
        },
        KEY_TIMEOUT_MS,
      );
      signal.throwIfAborted();
      return amDecryptor.loadTemplate(json);
    })();
    session.templates.set(keyUri, pending);
    void pending.catch(() => {
      if (session.templates.get(keyUri) === pending) session.templates.delete(keyUri);
    });
  }
  return pending;
};

/**
 * 初始化清单与 init，不把它们就绪误当作轨道密钥就绪
 * @param session - 所属会话
 * @returns 已验证的媒体清单
 */
const ensureSessionReady = (session: StreamSession): Promise<ParsedMediaPlaylist> => {
  if (!session.readyPromise) {
    session.readyPromise = (async () => {
      const signal = session.controller.signal;
      const playlist = await fetchWithRetry(
        session.m3u8Url,
        async (response) => parseMediaPlaylist(await response.text(), session.m3u8Url),
        { signal },
      );
      session.playlist = playlist;
      const initTask = (async () => {
        const raw = await fetchByteRangeWithRetry(
          playlist.init.url,
          playlist.init.start,
          playlist.init.end,
          signal,
        );
        const patched = await amDecryptor.patchInit(raw);
        session.patchedInit = injectDurationToInit(patched, playlist.duration);
      })();
      // 密钥握手与 init 下载并发；开播门槛会再次等待并处理失败
      for (const segment of [
        playlist.segments[0],
        playlist.segments.find((item) => item.keyType === "track"),
      ]) {
        if (segment) void getSegmentTemplate(session, segment).catch(() => {});
      }
      await initTask;
      signal.throwIfAborted();
      return playlist;
    })();
    const pending = session.readyPromise;
    void pending.catch(() => {
      if (session.readyPromise === pending) session.readyPromise = undefined;
    });
  }
  return session.readyPromise;
};

/**
 * 首片和第一个轨道密钥片均成功解密后才允许播放或下载
 * @param session - 所属会话
 * @returns 完整媒体清单
 */
const ensurePlaybackReady = async (session: StreamSession): Promise<ParsedMediaPlaylist> => {
  const playlist = await ensureSessionReady(session);
  if (!session.playbackPromise) {
    session.playbackPromise = (async () => {
      const first = playlist.segments[0];
      const firstTrack = playlist.segments.find((segment) => segment.keyType === "track");
      await Promise.all([
        getDecryptedSegment(session, first),
        ...(firstTrack && firstTrack !== first ? [getDecryptedSegment(session, firstTrack)] : []),
      ]);
    })();
    const pending = session.playbackPromise;
    void pending.catch(() => {
      if (session.playbackPromise === pending) session.playbackPromise = undefined;
    });
  }
  await session.playbackPromise;
  session.controller.signal.throwIfAborted();
  return playlist;
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
      void getDecryptedSegment(session, nextSeg).catch(() => {});
    }
  }
};

/**
 * 获取（或在途合并拉取）并原地解密单个音频切片
 * @param session - 当前流媒体会话
 * @param seg - 切片定义
 * @returns 已解密的切片 Buffer
 */
const getDecryptedSegment = (session: StreamSession, seg: MediaSegment): Promise<Buffer> => {
  let inFlight = session.fragCache.get(seg.start);
  if (!inFlight) {
    inFlight = (async () => {
      const playlist = await ensureSessionReady(session);
      const signal = session.controller.signal;
      const [raw, template] = await Promise.all([
        fetchByteRangeWithRetry(playlist.mediaUrl, seg.start, seg.end, signal),
        getSegmentTemplate(session, seg),
      ]);
      signal.throwIfAborted();
      const decrypted = await amDecryptor.decryptFragment(template, raw, session.patchedInit!);
      if (decrypted.length !== seg.end - seg.start + 1) {
        throw new Error(`解密分片 #${seg.index} 改变了字节长度`);
      }
      return decrypted;
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
 * 推送分片并等待背压解除，连接关闭时同时移除全部等待监听
 * @param response - 客户端响应
 * @param bytes - 本次真实字节
 * @returns 响应仍可继续时返回 true
 */
const writeChunk = async (response: http.ServerResponse, bytes: Buffer): Promise<boolean> => {
  if (response.destroyed) return false;
  if (response.write(bytes)) return true;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const finish = (writable: boolean): void => {
    response.off("drain", onDrain);
    response.off("close", onClose);
    resolve(writable);
  };
  const onDrain = (): void => finish(true);
  const onClose = (): void => finish(false);
  response.once("drain", onDrain);
  response.once("close", onClose);
  if (response.destroyed) onClose();
  return promise;
};

/**
 * 本地 Apple Music 音频解密与边下边播流媒体代理服务
 */
export class AppleMusicProxyServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private startPromise: Promise<number> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private activeUpstreamUrl: string = "";
  private activeAuthHeader?: string;

  /**
   * 启动本地回环 HTTP 服务
   * @returns 分配的服务端口
   */
  public start(): Promise<number> {
    if (this.server && this.port > 0) return Promise.resolve(this.port);
    if (this.startPromise) return this.startPromise;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        amLog.error("[proxy] 处理流媒体请求异常", error);
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        } else {
          res.destroy();
        }
      });
    });
    this.server = server;
    this.startPromise = promise;
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (this.server !== server || !address || typeof address !== "object") {
        server.close();
        reject(new Error("本地代理服务已停止"));
        return;
      }
      this.port = address.port;
      amLog.info(`[proxy] 本地流媒体代理服务已就绪: http://127.0.0.1:${this.port}`);
      resolve(this.port);
    });
    server.on("error", (error) => {
      if (this.server === server) this.server = null;
      reject(error);
    });
    void promise
      .finally(() => {
        if (this.startPromise === promise) this.startPromise = null;
      })
      .catch(() => {});
    return promise;
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
    const session = getOrCreateSession(adamId, m3u8Url, upstreamUrl, token);
    this.keepUpstreamAlive(cleanUpstreamUrl, session.authHeader);
    const params = new URLSearchParams({
      adamId,
      m3u8: m3u8Url,
      upstream: upstreamUrl,
    });
    if (resolvedToken) {
      params.set("token", resolvedToken);
    }

    try {
      const playlist = await ensurePlaybackReady(session);
      params.set("size", String(playlist.totalSize));
      params.set("duration", String(playlist.duration));
      triggerPrefetch(session, 0);
    } finally {
      releaseSession(session);
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

    res.on("close", () => {
      isClientClosed = true;
    });

    try {
      const playlist = await ensurePlaybackReady(session);
      const totalSize = playlist.totalSize;

      // 解析客户端传入的 Range 头
      let startOffset = 0;
      let endOffset = totalSize - 1;
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
          res.end();
          return;
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          startOffset = Math.max(0, totalSize - suffix);
          if (suffix === 0) startOffset = totalSize;
        } else {
          startOffset = Number(match[1]);
          if (match[2]) endOffset = Math.min(Number(match[2]), totalSize - 1);
        }
      }
      if (
        !Number.isSafeInteger(startOffset) ||
        !Number.isSafeInteger(endOffset) ||
        startOffset >= totalSize ||
        startOffset > endOffset
      ) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
        return;
      }
      const contentLength = endOffset - startOffset + 1;

      res.writeHead(rangeHeader ? 206 : 200, {
        ...(rangeHeader
          ? { "Content-Range": `bytes ${startOffset}-${endOffset}/${totalSize}` }
          : {}),
        "Accept-Ranges": "bytes",
        "Content-Length": contentLength,
        "Content-Type": "audio/mp4",
        "Cache-Control": "no-cache",
      });

      // 流式按序输出数据
      const reqStart = performance.now();
      amLog.info(
        `[proxy:req] 开始推流 adamId=${adamId} Range=${rangeHeader ?? "all"} start=${startOffset} end=${endOffset}`,
      );

      let written = 0;
      const patchedInit = session.patchedInit!;
      const initLen = patchedInit.length;
      if (startOffset < initLen) {
        const initSliceEnd = Math.min(initLen - 1, endOffset);
        const initSlice = patchedInit.subarray(startOffset, initSliceEnd + 1);
        if (!(await writeChunk(res, initSlice))) return;
        written += initSlice.length;
        amLog.debug(
          `[proxy:init] Init段已推送 len=${initSlice.length} 耗时=${(performance.now() - reqStart).toFixed(1)}ms`,
        );
      }

      // Range 坐标始终对应原位解密后的完整文件
      const relevantSegments = playlist.segments.filter(
        (seg) => seg.end >= startOffset && seg.start <= endOffset,
      );

      for (const seg of relevantSegments) {
        if (res.destroyed || isClientClosed) return;

        // 触发前向滑动窗口预取
        triggerPrefetch(session, seg.index);

        const segStart = performance.now();
        const fragBuf = await getDecryptedSegment(session, seg);
        const segWaitMs = (performance.now() - segStart).toFixed(1);
        if (res.destroyed || isClientClosed) return;
        const chunk = fragBuf.subarray(
          Math.max(0, startOffset - seg.start),
          Math.min(fragBuf.length, endOffset - seg.start + 1),
        );

        if (chunk.length > 0) {
          const writeStart = performance.now();
          if (!(await writeChunk(res, chunk))) return;
          written += chunk.length;
          const drainMs = (performance.now() - writeStart).toFixed(1);
          amLog.info(
            `[proxy:seg] 推送分片 #${seg.index} (${seg.keyType}) size=${chunk.length} 获取等待=${segWaitMs}ms 写入Drain=${drainMs}ms 累计=${(performance.now() - reqStart).toFixed(1)}ms`,
          );
        }
      }
      if (written !== contentLength) {
        throw new Error(`响应字节数不符，期望 ${contentLength}，实际 ${written}`);
      }

      res.end();
      amLog.info(
        `[proxy:done] 推流完成 adamId=${adamId} 总耗时=${(performance.now() - reqStart).toFixed(1)}ms`,
      );
    } catch (err) {
      if (!isClientClosed) {
        amLog.error(`[proxy] 推流过程中发生错误 (adamId: ${adamId})`, err);
      }
      if (!res.headersSent && !res.destroyed && !isClientClosed) {
        res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Apple Music 音频解密未就绪");
      } else {
        res.destroy();
      }
    } finally {
      releaseSession(session);
    }
  }

  /**
   * 预热 init、真实轨道模板及换钥边界两侧分片
   * @param adamId - 曲目 ID
   * @param m3u8Url - Apple CDN 的 Media M3U8 清单地址
   * @param upstreamUrl - am-hook 上游服务地址
   * @param token - 可选鉴权 Token
   */
  public async prewarm(
    adamId: string,
    m3u8Url: string,
    upstreamUrl: string,
    token?: string,
  ): Promise<void> {
    await this.start();
    const session = getOrCreateSession(adamId, m3u8Url, upstreamUrl, token);
    this.keepUpstreamAlive(session.upstreamUrl, session.authHeader);
    try {
      await ensurePlaybackReady(session);
    } catch (err) {
      amLog.warn(`[proxy] 预热曲目会话失败 (adamId: ${adamId})`, err);
    } finally {
      releaseSession(session);
    }
  }

  /**
   * 启动或更新上游服务的常驻长连接保活心跳
   * 每 40 秒向远端发送一次轻量 HEAD 请求，防止对端 Nginx/CDN 或本地 NAT 网关掐断空闲 TCP/TLS 隧道
   * 确保只要应用活着，该长连接就一直牢牢握住
   * @param upstreamUrl - 上游服务根地址
   * @param authHeader - 可选认证头
   */
  public keepUpstreamAlive(upstreamUrl: string, authHeader?: string): void {
    const { cleanUpstreamUrl } = resolveUpstreamAuth(upstreamUrl);
    if (!cleanUpstreamUrl) return;

    this.activeUpstreamUrl = cleanUpstreamUrl;
    this.activeAuthHeader = authHeader;

    if (!this.heartbeatTimer) {
      // 首次立即触发一次握手建立连接
      void this.pingUpstream();
      // 以 40 秒为周期常驻保活（对端常见空闲超时为 60s ~ 65s）
      this.heartbeatTimer = setInterval(() => {
        void this.pingUpstream();
      }, 40_000);
      this.heartbeatTimer.unref();
      amLog.info(`[proxy] 已启动上游常驻长连接保活守护: ${cleanUpstreamUrl}`);
    }
  }

  private consecutiveHeartbeatFailures = 0;

  /**
   * 向当前上游发送极轻量 HEAD 请求维持 TCP+TLS 握手并检测连接健康
   */
  private async pingUpstream(): Promise<void> {
    if (!this.activeUpstreamUrl) return;
    try {
      const headers: Record<string, string> = {};
      if (this.activeAuthHeader) {
        headers.Authorization = this.activeAuthHeader;
      }
      await fetchWithProxy(this.activeUpstreamUrl, {
        method: "HEAD",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (this.consecutiveHeartbeatFailures > 0) {
        amLog.info(`[proxy] 上游长连接已自愈恢复握手: ${this.activeUpstreamUrl}`);
      }
      this.consecutiveHeartbeatFailures = 0;
      amLog.debug(`[proxy] 上游长连接心跳保活成功: ${this.activeUpstreamUrl}`);
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      // 连续多次失败时，说明网络已断开或系统休眠导致 socket 失效
      if (this.consecutiveHeartbeatFailures === 2) {
        amLog.warn(
          `[proxy] 上游心跳保活连续失败，可能存在网络抖动或休眠断网: ${this.activeUpstreamUrl}`,
          err,
        );
      }
    }
  }

  /**
   * 系统休眠唤醒事件处理：快速重置心跳并触发长连接自愈握手
   */
  public onSystemResume(): void {
    if (!this.activeUpstreamUrl) return;
    amLog.info("[proxy] 检测到系统休眠唤醒，立即重置并重新建立上游长连接握手");
    this.consecutiveHeartbeatFailures = 0;
    // 延迟 1 秒等待操作系统网卡与 DNS 服务在唤醒后就绪
    setTimeout(() => {
      void this.pingUpstream();
    }, 1000);
  }

  /**
   * 销毁并停止本地代理服务
   */
  public stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.activeUpstreamUrl = "";
    this.activeAuthHeader = undefined;
    for (const session of sessionCache.values()) disposeSession(session);
    sessionCache.clear();
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections();
      this.server = null;
      this.port = 0;
      amLog.info("[proxy] 本地代理服务已停止");
    }
  }
}

/** 全局单例代理服务 */
export const appleMusicProxy = new AppleMusicProxyServer();
