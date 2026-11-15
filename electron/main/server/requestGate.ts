import os from "node:os";
import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** 只信任明确的本机地址，不解析客户端提供的域名，避免 DNS rebinding。 */
export const createRequestGate = (allowLan: boolean): MiddlewareHandler => {
  const allowedHosts = new Set(LOOPBACK_HOSTS);
  if (allowLan) {
    allowedHosts.add(os.hostname().toLowerCase());
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const address of interfaces ?? []) {
        if (address.family === "IPv4") allowedHosts.add(address.address);
      }
    }
  }

  return async (c, next) => {
    const host = c.req.header("host");
    const authority = host?.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i);
    if (
      !authority ||
      !allowedHosts.has(authority[1].toLowerCase()) ||
      (authority[2] !== undefined && Number(authority[2]) > 65535)
    ) {
      return c.json({ error: "invalid Host" }, 403);
    }

    // 原生客户端通常没有 Origin；浏览器必须来自可信本机页面。
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      try {
        const source = new URL(origin);
        if (
          (source.protocol !== "http:" && source.protocol !== "https:") ||
          source.origin !== origin ||
          !allowedHosts.has(source.hostname)
        ) {
          return c.json({ error: "invalid Origin" }, 403);
        }
      } catch {
        return c.json({ error: "invalid Origin" }, 403);
      }
    }

    await next();
    return;
  };
};
