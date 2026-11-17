/**
 * 外部 API 服务器：HTTP (Hono) + WebSocket
 */

import type { Server } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { store } from "@main/store";
import { serverLog } from "@main/utils/logger";
import { broadcast } from "@main/utils/broadcast";
import type { ExternalApiStatus } from "@shared/types/settings";
import { buildServerApp } from "./app";

interface ServerInstance {
  server: Server;
  wss: WebSocketServer;
  sockets: Set<Socket>;
  ready: Promise<void>;
  started: Promise<ExternalApiStatus>;
  cancelled: boolean;
  closing: Promise<void> | null;
}

let instance: ServerInstance | null = null;
let stopping: Promise<void> | null = null;
let startEpoch = 0;
let runningPort: number | null = null;
let runningHost: string | null = null;
let runningAllowLan = false;
let lastError: { code: string; message: string } | null = null;

/**
 * 取局域网展示地址，绑定 0.0.0.0 时作为展示给用户的局域网入口
 * 优先常见家用/企业网段：WSL2/Hyper-V 的虚拟交换机常占用 172.x 且排在物理网卡前
 */
const getLanAddress = (): string | null => {
  const candidates: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }
  return (
    candidates.find((address) => address.startsWith("192.168.")) ??
    candidates.find((address) => address.startsWith("10.")) ??
    candidates[0] ??
    null
  );
};

export const getServerStatus = (): ExternalApiStatus => ({
  listening: runningPort !== null,
  allowLan: runningAllowLan,
  host: runningHost,
  port: runningPort,
  error: lastError,
});

/** 向渲染进程同步外部 API 服务状态 */
const publishStatus = (): void => broadcast("externalApi:status", getServerStatus());

/** 等待绑定完成后关闭，避免 listen 尚在排队时 close 漏停端口。 */
const closeInstance = (target: ServerInstance): Promise<void> => {
  if (target.closing) return target.closing;
  target.closing = target.ready.then(async () => {
    const wsClosed = Promise.withResolvers<void>();
    const httpClosed = Promise.withResolvers<void>();
    for (const client of target.wss.clients) client.terminate();
    target.wss.close(() => wsClosed.resolve());
    target.server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        serverLog.warn("外部 API 关闭异常:", error);
      }
      httpClosed.resolve();
    });
    // 同时回收 HTTP 请求及尚未完成升级的连接，不能只关闭已注册的 WS。
    for (const socket of target.sockets) socket.destroy();
    await Promise.all([wsClosed.promise, httpClosed.promise]);
  });
  return target.closing;
};

/** 启动外部 API 服务；并发调用共用同一次绑定。 */
export const startServer = (): Promise<ExternalApiStatus> => {
  if (stopping) {
    const epoch = startEpoch;
    return stopping.then(() => (epoch === startEpoch ? startServer() : getServerStatus()));
  }
  if (instance) return instance.started;
  if (!store.get("externalApi.enabled")) return Promise.resolve(getServerStatus());

  const port = store.get("externalApi.port");
  // 默认仅本机可访问；服务自身无鉴权，开放局域网需用户显式开启。
  const allowLan = store.get("externalApi.allowLan");
  const hostname = allowLan ? "0.0.0.0" : "127.0.0.1";
  const app = buildServerApp(allowLan);
  const wss = new WebSocketServer({ noServer: true });
  const ready = Promise.withResolvers<void>();
  const started = Promise.withResolvers<ExternalApiStatus>();
  const server = serve({
    fetch: app.fetch,
    port,
    hostname,
    websocket: { server: wss },
  }) as Server;
  const target: ServerInstance = {
    server,
    wss,
    sockets: new Set(),
    ready: ready.promise,
    started: started.promise,
    cancelled: false,
    closing: null,
  };
  instance = target;
  server.on("connection", (socket) => {
    if (target.cancelled) {
      socket.destroy();
      return;
    }
    target.sockets.add(socket);
    socket.once("close", () => target.sockets.delete(socket));
  });

  let settled = false;
  const finishCancelled = (): void => {
    void closeInstance(target).then(() => {
      if (instance === target) instance = null;
      started.resolve(getServerStatus());
    });
  };
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    ready.resolve();
    if (instance === target && !target.cancelled) {
      lastError = { code: error.code ?? "UNKNOWN", message: error.message };
      serverLog.error(`外部 API 监听 ${port} 失败 (${lastError.code}): ${lastError.message}`);
      publishStatus();
    }
    finishCancelled();
  });
  server.once("listening", () => {
    if (settled) return;
    settled = true;
    ready.resolve();
    if (target.cancelled || instance !== target) {
      finishCancelled();
      return;
    }
    const address = server.address();
    runningPort = typeof address === "object" && address ? address.port : port;
    runningAllowLan = allowLan;
    runningHost = allowLan ? (getLanAddress() ?? "0.0.0.0") : hostname;
    lastError = null;
    publishStatus();
    serverLog.info(`外部 API 已启动: http://${hostname}:${runningPort}`);
    started.resolve(getServerStatus());
  });
  return started.promise;
};

/** 停止外部 API 服务；停止完成后，旧启动不能重新发布或遗留监听。 */
export const stopServer = (): Promise<void> => {
  startEpoch++;
  if (stopping) return stopping;
  const target = instance;
  if (!target) return Promise.resolve();
  target.cancelled = true;
  runningPort = null;
  runningHost = null;
  runningAllowLan = false;
  publishStatus();
  const stopped = closeInstance(target).then(() => {
    if (instance === target) instance = null;
    if (stopping === stopped) stopping = null;
    serverLog.info("外部 API 已关闭");
  });
  stopping = stopped;
  return stopped;
};

/** 配置变更后重启服务 */
export const restartServer = async (): Promise<ExternalApiStatus> => {
  await stopServer();
  return startServer();
};
