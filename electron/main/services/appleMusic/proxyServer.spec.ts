// @vitest-environment node
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("@main/utils/logger", () => ({
  amLog: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@main/utils/proxy", () => ({
  fetchWithProxy: (input: string | URL, init?: RequestInit) => fetch(input, init),
}));

import { AppleMusicProxyServer } from "./proxyServer";

/**
 * 构造无附加状态的完整 MP4 box
 * @param type - box 类型
 * @param payload - box 内容
 * @returns 含长度头的 box
 */
const box = (type: string, payload = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
};

const init = box("ftyp", Buffer.from("M4A \0\0\0\0M4A "));
const fragments = [0x31, 0x57, 0xab].map((value) =>
  Buffer.concat([box("moof"), box("mdat", Buffer.alloc(80, value))]),
);
const source = Buffer.concat([init, ...fragments]);
const starts = [
  init.length,
  init.length + fragments[0]!.length,
  init.length + 2 * fragments[0]!.length,
];

/**
 * 生成含明确换钥边界的单文件媒体清单
 * @param keys - 各片密钥，null 表示 METHOD=NONE
 * @returns VOD 媒体清单
 */
const playlist = (keys: Array<string | null>): string =>
  [
    "#EXTM3U",
    `#EXT-X-MAP:URI="audio.mp4",BYTERANGE="${init.length}@0"`,
    ...fragments.flatMap((fragment, index) => [
      keys[index] === null
        ? "#EXT-X-KEY:METHOD=NONE"
        : `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${keys[index]}"`,
      "#EXTINF:14.95365,",
      `#EXT-X-BYTERANGE:${fragment.length}@${starts[index]}`,
      "audio.mp4",
    ]),
    "#EXT-X-ENDLIST",
  ].join("\n");

const fixed = "skd://itunes.apple.com/P000000000/s1/e1";
const trackA = "skd://itunes.apple.com/test/c6";
const trackB = "skd://itunes.apple.com/test/c7";
let proxy: AppleMusicProxyServer;
let upstream: http.Server;
let origin: string;
let keys: Array<string | null>;
let failedKeys: Set<string>;
let template: string;
let rangeFault: "short" | "offset" | "body" | "partial200" | "full200" | undefined;
let faultUsed: boolean;

/**
 * 返回当前测试的真实回环代理地址
 * @returns 带源清单与上游地址的代理 URL
 */
const requestUrl = async (): Promise<string> => {
  const params = new URLSearchParams({
    adamId: "1",
    m3u8: `${origin}/song.m3u8`,
    upstream: origin,
  });
  return `http://127.0.0.1:${await proxy.start()}/am-stream?${params}`;
};

beforeEach(async () => {
  keys = [null, null, null];
  failedKeys = new Set();
  rangeFault = undefined;
  faultUsed = false;
  template = await fs.readFile(new URL("./__fixtures__/template.json", import.meta.url), "utf8");
  proxy = new AppleMusicProxyServer();
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url!, origin);
    if (req.method === "HEAD") return void res.end();
    if (url.pathname === "/song.m3u8") return void res.end(playlist(keys));
    if (url.pathname === "/key") {
      res.writeHead(failedKeys.has(url.searchParams.get("uri")!) ? 503 : 200);
      res.end(failedKeys.has(url.searchParams.get("uri")!) ? "unavailable" : template);
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "")!;
    const start = Number(range[1]);
    const end = Number(range[2]);
    const bytes = source.subarray(start, end + 1);
    const applyFault = start === starts[1] && !faultUsed && rangeFault !== undefined;
    if (applyFault) faultUsed = true;
    if (applyFault && rangeFault === "full200") {
      res.writeHead(200, { "Content-Length": source.length });
      res.end(source);
      return;
    }
    if (applyFault && rangeFault === "partial200") {
      res.writeHead(200, { "Content-Length": bytes.length });
      res.end(bytes);
      return;
    }
    const payload = applyFault && rangeFault === "short" ? bytes.subarray(0, -4) : bytes;
    res.writeHead(206, {
      "Content-Length": payload.length,
      "Content-Range": `bytes ${applyFault && rangeFault === "offset" ? start + 1 : start}-${end}/${source.length}`,
    });
    if (applyFault && rangeFault === "body") {
      res.flushHeaders();
      res.write(payload.subarray(0, 4));
      setImmediate(() => res.destroy());
    } else {
      res.end(payload);
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  proxy.stop();
  upstream.closeAllConnections();
  const closed = once(upstream, "close");
  upstream.close();
  await closed;
});

describe("Apple Music 解密 HTTP 边界", () => {
  it("换钥失败不能返回试听直链或密文，恢复后同一会话可重新开播", async () => {
    keys = [fixed, trackA, trackA];
    failedKeys.add(trackA);
    await expect(proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin)).rejects.toThrow();
    const response = await fetch(await requestUrl());
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("text/plain");
    failedKeys.clear();
    const playable = await proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin);
    const recovered = await fetch(playable);
    expect(recovered.status).toBe(200);
    expect(Buffer.from(await recovered.arrayBuffer())).toEqual(source);
  });

  it("后续换钥失败会中止完整响应，恢复时不能复用错误模板或缓存", async () => {
    keys = [fixed, trackA, trackB];
    failedKeys.add(trackB);
    const playable = await proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin);
    const response = await fetch(playable);
    await expect(response.arrayBuffer()).rejects.toThrow();
    failedKeys.clear();
    const recovered = await fetch(playable);
    expect(Buffer.from(await recovered.arrayBuffer())).toEqual(source);
  });

  it.each(["short", "offset", "body", "partial200"] as const)(
    "CDN %s 响应必须重试，不能输出短片或错位片",
    async (fault) => {
      rangeFault = fault;
      const playable = await proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin);
      const response = await fetch(playable);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    },
  );

  it("CDN 忽略 Range 返回整文件时按原坐标截取，不把全文件当成当前分片", async () => {
    rangeFault = "full200";
    const playable = await proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin);
    const response = await fetch(playable);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
  });

  it("片中、跨换片点和末尾 Range 必须等于完整文件真实字节", async () => {
    const playable = await proxy.getStreamUrl("1", `${origin}/song.m3u8`, origin);
    for (const [range, start, end] of [
      [`bytes=${starts[1]! - 3}-${starts[1]! + 7}`, starts[1]! - 3, starts[1]! + 7],
      [`bytes=${starts[1]! + 9}-${starts[1]! + 15}`, starts[1]! + 9, starts[1]! + 15],
      ["bytes=-4", source.length - 4, source.length - 1],
      [`bytes=${source.length - 4}-999999`, source.length - 4, source.length - 1],
    ] as const) {
      const response = await fetch(playable, { headers: { Range: range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${source.length}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(source.subarray(start, end + 1));
    }
    const pastEnd = await fetch(playable, { headers: { Range: `bytes=${source.length}-` } });
    expect(pastEnd.status).toBe(416);
    expect(pastEnd.headers.get("content-range")).toBe(`bytes */${source.length}`);
  });
});
