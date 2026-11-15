// @vitest-environment node

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  getStatus: vi.fn(() => ({ state: "paused", positionMs: 42, volume: 0.5 })),
}));
vi.mock("electron", () => ({
  app: { getName: () => "SPlayer-Next", getVersion: () => "test" },
}));
vi.mock("@main/store", () => ({ store: { get: () => true } }));
vi.mock("@main/utils/logger", () => ({
  serverLog: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@main/services/playerControl", () => ({
  playerControl: { play: mocks.play, getStatus: mocks.getStatus },
}));
vi.mock("@main/services/nowPlaying", () => ({}));
vi.mock("node:os", () => ({
  default: {
    hostname: () => "music-box",
    networkInterfaces: () => ({
      ethernet: [{ family: "IPv4", address: "192.168.50.8" }],
    }),
  },
}));

import { buildServerApp } from "./app";
import { getWsClientCount, wsBroadcast } from "./broadcast";

let server: Server | undefined;
let wss: WebSocketServer | undefined;
const clients = new Set<WebSocket>();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of wss?.clients ?? []) client.terminate();
  if (server) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  server = undefined;
  wss = undefined;
});

const startLocalServer = async (): Promise<string> => {
  wss = new WebSocketServer({ noServer: true });
  server = createAdaptorServer({
    fetch: buildServerApp(false).fetch,
    websocket: { server: wss },
  }) as Server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
};

const connect = (url: string, headers: Record<string, string>): WebSocket => {
  const client = new WebSocket(url, { headers, handshakeTimeout: 2000 });
  clients.add(client);
  // 拒绝升级时 ws 会发出 error，具体拒绝状态由 unexpected-response 断言。
  client.on("error", () => {});
  return client;
};

describe("外部 API 来源边界", () => {
  it.each([undefined, "http://localhost:5173", "https://127.0.0.1:8080", "http://[::1]:3000"])(
    "无 Origin 原生客户端和受支持本机来源可控制并查询：%s",
    async (origin) => {
      const app = buildServerApp(false);
      const headers: Record<string, string> = { host: "127.0.0.1:14558" };
      if (origin !== undefined) headers.origin = origin;
      const control = await app.request("/api/play", { method: "POST", headers });
      expect(control.status).toBe(200);
      expect(await control.json()).toEqual({ ok: true });
      expect(mocks.play).toHaveBeenCalledTimes(1);
      const status = await app.request("/api/status", { headers });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ state: "paused", position: 42 });
      expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { host: "127.0.0.1:14558", origin: "https://evil.example" },
    { host: "127.0.0.1:14558", origin: "null" },
    { host: "127.0.0.1:14558", origin: "" },
    { host: "127.0.0.1:14558", origin: "file://localhost" },
    { host: "127.0.0.1:14558", origin: "http://localhost@evil.example" },
    { host: "127.0.0.1:14558", origin: "http://localhost.evil.example" },
    { host: "127.0.0.1:14558", origin: "http://localhost/path" },
    { host: "evil.example:14558" },
    { host: "localhost.evil.example:14558", origin: "http://localhost" },
    { host: "localhost:99999" },
    { host: "localhost:14558, evil.example" },
    {},
  ] as Record<string, string>[])(
    "拒绝恶意或畸形 HTTP 来源，业务操作不会发生：%j",
    async (headers) => {
      const app = buildServerApp(false);
      for (const [path, method] of [
        ["/api/play", "POST"],
        ["/api/status", "GET"],
      ]) {
        const result = await app.request(path, { method, headers });
        expect(result.status).toBe(403);
      }
      expect(mocks.play).not.toHaveBeenCalled();
      expect(mocks.getStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])("接受本机 Host：%s", async (host) => {
    const response = await buildServerApp(false).request("/api/play", {
      method: "POST",
      headers: { host: `${host}:14558` },
    });
    expect(response.status).toBe(200);
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it("只有显式 LAN 模式接受本机网卡地址和机器名，仍拒绝任意域名及网页来源", async () => {
    for (const host of ["192.168.50.8", "music-box"]) {
      for (const origin of [undefined, `http://${host}:8080`]) {
        const headers: Record<string, string> = { host: `${host}:14558` };
        if (origin !== undefined) headers.origin = origin;
        const denied = await buildServerApp(false).request("/api/play", {
          method: "POST",
          headers,
        });
        expect(denied.status).toBe(403);
        const allowed = await buildServerApp(true).request("/api/play", {
          method: "POST",
          headers,
        });
        expect(allowed.status).toBe(200);
      }
    }
    expect(mocks.play).toHaveBeenCalledTimes(4);
    for (const headers of [
      { host: "evil.example:14558" },
      { host: "192.168.50.8:14558", origin: "https://evil.example" },
      { host: "192.168.50.8:14558", origin: "http://192.168.50.99:8080" },
    ] as Record<string, string>[]) {
      const denied = await buildServerApp(true).request("/api/play", {
        method: "POST",
        headers,
      });
      expect(denied.status).toBe(403);
    }
    expect(mocks.play).toHaveBeenCalledTimes(4);
  });

  it("真实 WS 升级在注册连接及接收命令前拒绝恶意 Origin / Host", async () => {
    const url = await startLocalServer();
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { host: "evil.example:14558" },
      { host: "evil.example:14558", origin: "http://localhost" },
      { origin: "https://evil.example", "x-forwarded-host": "localhost" },
    ] as Record<string, string>[]) {
      const result = Promise.withResolvers<number | undefined>();
      const client = connect(url, headers);
      client.once("open", () => result.resolve(101));
      client.once("unexpected-response", (_request, response) => {
        response.resume();
        result.resolve(response.statusCode);
        client.terminate();
      });
      expect(await result.promise).toBe(403);
      expect(getWsClientCount()).toBe(0);
    }
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("真实 WS 原生及本机浏览器客户端可收到 hello、控制回执和播放事件", async () => {
    const url = await startLocalServer();
    for (const origin of [undefined, "http://localhost:5173", "https://127.0.0.1:8080"]) {
      const client = connect(url, origin === undefined ? {} : { origin });
      const hello = once(client, "message");
      await once(client, "open");
      expect(JSON.parse(String((await hello)[0]))).toMatchObject({ kind: "hello" });

      const ack = once(client, "message");
      client.send(JSON.stringify({ op: "play" }));
      expect(JSON.parse(String((await ack)[0]))).toEqual({ kind: "ack", op: "play" });

      const event = once(client, "message");
      wsBroadcast({ type: "state", data: { state: "playing" } });
      expect(JSON.parse(String((await event)[0]))).toEqual({
        kind: "event",
        type: "state",
        data: { state: "playing" },
      });
      const closed = once(client, "close");
      client.close();
      await closed;
    }
    expect(mocks.play).toHaveBeenCalledTimes(3);
  });
});
