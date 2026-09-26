import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { store } from "@main/store";
import { systemLog } from "@main/utils/logger";
import { fetch as undiciFetch, Agent, ProxyAgent, Socks5ProxyAgent } from "undici";
import type { Dispatcher } from "undici";

const PROXY_TEST_URL = "https://www.baidu.com";

let proxyAgent: Dispatcher | null = null;
let proxyAgentUrl = "";
let defaultDispatcher: Dispatcher | null = null;

const isManualProxyProtocol = (value: string): value is "http" | "https" | "socks5" =>
  value === "http" || value === "https" || value === "socks5";

/** 默认直连 dispatcher（允许 legacy renegotiation） */
const getDefaultDispatcher = (): Dispatcher => {
  if (!defaultDispatcher) {
    defaultDispatcher = new Agent({
      connect: {
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      },
    });
  }
  return defaultDispatcher;
};

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

const getProxyDispatcher = (input?: string | URL): Dispatcher => {
  if (input && isDirectUrl(input)) return getDefaultDispatcher();
  const url = getEffectiveProxyUrl();
  if (!url) return getDefaultDispatcher();
  if (!proxyAgent || proxyAgentUrl !== url) {
    proxyAgent?.close().catch(() => {});
    proxyAgent = url.startsWith("socks5://") ? new Socks5ProxyAgent(url) : new ProxyAgent(url);
    proxyAgentUrl = url;
    systemLog.info(`[proxy] node fetch proxy=${url}`);
  }
  return proxyAgent;
};

/** Node fetch 包装：统一使用 undici 并注入支持 legacy SSL 的 dispatcher */
export const fetchWithProxy = (input: string | URL, init?: RequestInit): Promise<Response> => {
  const dispatcher = getProxyDispatcher(input);
  return undiciFetch(input, { ...(init as RequestInit), dispatcher } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;
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
