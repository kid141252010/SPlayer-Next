import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { app, session, webContents, type Session } from "electron";
import { store } from "@main/store";
import { systemLog } from "@main/utils/logger";
import {
  Agent,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

const PROXY_TEST_URL = "https://www.baidu.com";

let proxyAgent: Dispatcher | null = null;
let proxyAgentUrl = "";
let defaultDispatcher: Dispatcher | null = null;
let globalProxyUrl: string | null = null;

const isManualProxyProtocol = (value: string): value is "http" | "https" | "socks5" =>
  value === "http" || value === "https" || value === "socks5";
/** 当前手动代理地址；off 或配置无效时返回 null，保持原生直连行为 */
export const getNetworkProxyUrl = (): string | null => {
  const config = store.get("system.networkProxy");
  if (!isManualProxyProtocol(config.protocol)) return null;
  const host = config.host.trim();
  const port = Number(config.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${config.protocol}://${host}:${port}`;
};

/** 从 Windows 注册表读取当前系统代理配置（非 Windows 或未启用时返回 null） */
export const getSystemProxyUrl = (): string | null => {
  if (process.platform !== "win32") return null;
  try {
    const output = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
      { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const enabledMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
    const isEnabled = enabledMatch ? parseInt(enabledMatch[1], 16) === 1 : false;
    if (!isEnabled) return null;

    const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!serverMatch || !serverMatch[1]) return null;

    const raw = serverMatch[1].trim();
    if (raw.includes("=")) {
      const httpPart = raw.split(";").find((s) => s.trim().startsWith("http="));
      if (httpPart) {
        const val = httpPart.split("=")[1]?.trim();
        return val
          ? val.startsWith("http://") || val.startsWith("https://")
            ? val
            : `http://${val}`
          : null;
      }
    }
    return raw.startsWith("http://") || raw.startsWith("https://") ? raw : `http://${raw}`;
  } catch {
    return null;
  }
};

/** 当前生效的有效代理地址（优先应用手动配置，其次回退系统代理） */
export const getEffectiveProxyUrl = (): string | null => {
  return getNetworkProxyUrl() ?? getSystemProxyUrl();
};

/** 同步代理设置到进程环境变量，确保 Rust reqwest 等原生模块及子进程生效 */
export const syncProxyEnv = (): void => {
  const proxyUrl = getEffectiveProxyUrl();
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.all_proxy = proxyUrl;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";
    process.env.no_proxy = "localhost,127.0.0.1,::1";
    systemLog.info(`[proxy] 环境变量已同步代理: ${proxyUrl}`);
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    systemLog.info("[proxy] 环境变量代理已清空 (直连)");
  }
};

/** 判断是否属于无需通过网络代理的直连地址（回环地址或 Apple 官方 CDN） */
export const isDirectUrl = (input: string | URL): boolean => {
  try {
    const urlStr = typeof input === "string" ? input : input.href;
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
    if (host.endsWith(".apple.com") || host.endsWith(".itunes.apple.com") || host === "apple.com") {
      return true;
    }
  } catch {
    // 忽略异常
  }
  return false;
};

/**
 * 获取代理连接池，地址变化时重建并关闭旧连接池
 * @param url - 代理地址
 * @returns 与全局 fetch 共用的代理连接池
 */
const getProxyAgent = (url: string): Dispatcher => {
  if (!proxyAgent || proxyAgentUrl !== url) {
    proxyAgent?.close().catch(() => {});
    proxyAgent = url.startsWith("socks5://") ? new Socks5ProxyAgent(url) : new ProxyAgent(url);
    proxyAgentUrl = url;
    systemLog.info(`[proxy] node fetch proxy=${url}`);
  }
  return proxyAgent;
};

/** Node fetch 包装：复用当前代理或直连连接池 */
export const fetchWithProxy = async (
  input: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = isDirectUrl(input) ? null : getNetworkProxyUrl();
  let dispatcher: Dispatcher;
  if (url) {
    dispatcher = getProxyAgent(url);
  } else {
    defaultDispatcher ??= new Agent({
      connect: {
        keepAlive: true,
        keepAliveInitialDelay: 10_000,
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      },
      keepAliveTimeout: 86_400_000,
      keepAliveMaxTimeout: 86_400_000,
      maxRequestsPerClient: 0,
      pipelining: 1,
      connections: 64,
    });
    dispatcher = defaultDispatcher;
  }
  return undiciFetch(input, { ...(init as RequestInit), dispatcher } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;
};

/** 让全局 fetch 跟随代理设置；未配置代理时不改动全局连接池 */
export const applyGlobalFetchProxy = async (): Promise<void> => {
  const url = getNetworkProxyUrl();
  if (url === globalProxyUrl) return;
  if (url) {
    setGlobalDispatcher(getProxyAgent(url));
  } else {
    // 恢复内置 fetch 的默认直连行为，旧代理连接池随之关闭
    setGlobalDispatcher(new Agent());
    proxyAgent?.close().catch(() => {});
    proxyAgent = null;
  }
  globalProxyUrl = url;
};

/**
 * 为 Chromium 会话应用代理设置；关闭时强制直连，不跟随系统代理
 * @param ses - 目标会话
 */
const applySessionProxy = (ses: Session): Promise<void> => {
  const url = getNetworkProxyUrl();
  return ses.setProxy(url ? { mode: "fixed_servers", proxyRules: url } : { mode: "direct" });
};

/** 将代理设置同步到所有已存在的 Chromium 会话 */
export const applySessionsProxy = async (): Promise<void> => {
  const sessions = new Set([
    session.defaultSession,
    ...webContents.getAllWebContents().map((contents) => contents.session),
  ]);
  await Promise.all([...sessions].map(applySessionProxy));
};

/** 新建的会话创建时即应用代理设置，需在 app ready 之前调用 */
export const initNetworkProxy = (): void => {
  applyGlobalFetchProxy().catch((err) => systemLog.warn("[proxy] apply fetch proxy failed", err));
  app.on("session-created", (ses) => {
    applySessionProxy(ses).catch((err) =>
      systemLog.warn("[proxy] apply session proxy failed", err),
    );
  });
};

/** 测试当前代理是否可用 */
export const testNetworkProxy = async (): Promise<boolean> => {
  if (!getNetworkProxyUrl()) return false;
  try {
    const res = await fetchWithProxy(PROXY_TEST_URL, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch (err) {
    systemLog.warn("[proxy] test failed", err);
    return false;
  }
};
