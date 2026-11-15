// @vitest-environment node

import { createServer } from "node:http";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type * as NodeServer from "@hono/node-server";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  port: 0,
  holdListen: true,
  servers: [] as Server[],
  binds: [] as Array<() => void>,
  broadcast: vi.fn(),
  play: vi.fn(),
}));
vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeServer>();
  return {
    ...actual,
    serve: vi.fn((options: Parameters<typeof actual.serve>[0]) => {
      const server = actual.createAdaptorServer(options) as Server;
      mocks.servers.push(server);
      const bind = () => server.listen(options.port ?? 0, options.hostname);
      if (mocks.holdListen) mocks.binds.push(bind);
      else bind();
      return server;
    }),
  };
});
vi.mock("electron", () => ({
  app: { getName: () => "SPlayer-Next", getVersion: () => "test" },
}));
vi.mock("@main/store", () => ({
  store: {
    get: (key: string) => {
      if (key === "externalApi.enabled") return mocks.enabled;
      if (key === "externalApi.port") return mocks.port;
      if (key === "externalApi.allowLan") return false;
      return true;
    },
  },
}));
vi.mock("@main/utils/logger", () => ({
  serverLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@main/utils/broadcast", () => ({ broadcast: mocks.broadcast }));
vi.mock("@main/services/playerControl", () => ({ playerControl: { play: mocks.play } }));
vi.mock("@main/services/nowPlaying", () => ({}));

import { serve } from "@hono/node-server";
import { getServerStatus, restartServer, startServer, stopServer } from "./index";

const clients = new Set<WebSocket | Socket>();
const extraServers = new Set<Server>();

beforeEach(() => {
  mocks.enabled = true;
  mocks.port = 0;
  mocks.holdListen = true;
  mocks.servers.length = 0;
  mocks.binds.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const client of clients) {
    if (client instanceof WebSocket) client.terminate();
    else client.destroy();
  }
  clients.clear();
  const stopped = stopServer();
  for (const bind of mocks.binds.splice(0)) bind();
  await stopped;
  for (const server of extraServers) {
    if (!server.listening) continue;
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  extraServers.clear();
});

const assertPortReleased = async (port: number): Promise<void> => {
  const probe = createServer();
  extraServers.add(probe);
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  const closed = once(probe, "close");
  probe.close();
  await closed;
};

describe("外部 API 服务生命周期", () => {
  it("并发启动 single-flight，停止会等待并作废尚未完成的监听", async () => {
    const first = startServer();
    expect(startServer()).toBe(first);
    expect(serve).toHaveBeenCalledTimes(1);
    const server = mocks.servers[0];
    let port = 0;
    server.once("listening", () => {
      port = (server.address() as AddressInfo).port;
    });
    const stopped = stopServer();
    expect(stopServer()).toBe(stopped);
    let completed = false;
    void stopped.then(() => (completed = true));
    await Promise.resolve();
    expect(completed).toBe(false);

    mocks.binds.shift()!();
    await stopped;
    expect(await first).toMatchObject({ listening: false, port: null });
    expect(server.listening).toBe(false);
    expect(port).toBeGreaterThan(0);
    expect(mocks.broadcast.mock.calls.some(([, status]) => status.listening)).toBe(false);
    await assertPortReleased(port);
  });

  it("重复停止作废关闭期间排队的旧启动，不会在停止完成后偷偷重启", async () => {
    const first = startServer();
    const stopped = stopServer();
    const queued = startServer();
    expect(stopServer()).toBe(stopped);
    mocks.binds.shift()!();
    await Promise.all([first, stopped, queued]);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(getServerStatus()).toMatchObject({ listening: false, port: null });
    expect(mocks.servers.every((server) => !server.listening)).toBe(true);
  });

  it("关闭已监听服务时回收 WS 和升级未完成的 TCP，返回后端口立即可重用", async () => {
    mocks.holdListen = false;
    const status = await startServer();
    const port = status.port!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.add(ws);
    const hello = once(ws, "message");
    await once(ws, "open");
    expect(JSON.parse(String((await hello)[0]))).toMatchObject({ kind: "hello" });
    const socket = createConnection({ host: "127.0.0.1", port });
    clients.add(socket);
    await once(socket, "connect");
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    const wsClosed = once(ws, "close");
    const tcpClosed = Promise.withResolvers<void>();
    socket.once("close", () => tcpClosed.resolve());
    // 强制回收未完成升级的连接在 Windows 上可先发 ECONNRESET，再触发 close。
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") tcpClosed.reject(error);
    });
    await Promise.all([stopServer(), wsClosed, tcpClosed.promise]);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(socket.destroyed).toBe(true);
    expect(getServerStatus()).toMatchObject({ listening: false, port: null });
    await assertPortReleased(port);
  });

  it("旧启动的错误和监听回调不能覆盖新服务状态或关闭新端口", async () => {
    const occupied = createServer();
    extraServers.add(occupied);
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    mocks.port = (occupied.address() as AddressInfo).port;
    mocks.holdListen = false;
    const failed = startServer();
    const oldServer = mocks.servers[0];
    const oldListening = oldServer.listeners("listening")[0];
    const oldError = oldServer.listeners("error")[0];
    expect(await failed).toMatchObject({
      listening: false,
      error: { code: "EADDRINUSE" },
    });

    mocks.port = 0;
    const current = await startServer();
    expect(current).toMatchObject({ listening: true, error: null });
    oldListening.call(oldServer);
    oldError.call(oldServer, Object.assign(new Error("旧启动错误"), { code: "EADDRINUSE" }));
    expect(getServerStatus()).toEqual(current);
    const response = await fetch(`http://127.0.0.1:${current.port}/api/play`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it("重启等待旧的在途监听完成并释放后，只启动一台新服务", async () => {
    const first = startServer();
    const oldServer = mocks.servers[0];
    let oldPort = 0;
    oldServer.once("listening", () => {
      oldPort = (oldServer.address() as AddressInfo).port;
    });
    const restarted = restartServer();
    mocks.holdListen = false;
    mocks.binds.shift()!();
    await first;
    const current = await restarted;
    expect(current.listening).toBe(true);
    expect(serve).toHaveBeenCalledTimes(2);
    expect(oldServer.listening).toBe(false);
    expect(mocks.servers[1].listening).toBe(true);
    // 操作系统可能立即复用旧临时端口；停止新服务后统一验证旧端口已释放。
    await stopServer();
    await assertPortReleased(oldPort);
  });
});
