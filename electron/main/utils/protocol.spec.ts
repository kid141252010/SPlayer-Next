// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCacheProtocol, handleCacheProtocolOnPartition, toCacheUrl } from "./protocol";

const mocks = vi.hoisted(() => ({
  root: "",
  fetch: vi.fn(),
  handle: vi.fn(),
  partitionHandle: vi.fn(),
}));
vi.mock("electron", () => ({
  net: { fetch: mocks.fetch },
  protocol: { handle: mocks.handle },
  session: { fromPartition: () => ({ protocol: { handle: mocks.partitionHandle } }) },
}));
vi.mock("./config", () => ({ getAppCacheDir: () => mocks.root }));

type Handler = (request: Request) => Response | Promise<Response>;
let directory: string;
let handler: Handler;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "splayer-cache-protocol-"));
  mocks.root = path.join(directory, "app-cache");
  await fs.mkdir(mocks.root);
  mocks.fetch.mockImplementation(async (url: string) => {
    const target = new URL(url);
    expect(target.protocol).toBe("file:");
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
    return new Response(await fs.readFile(fileURLToPath(target)));
  });
  handleCacheProtocol();
  handler = mocks.handle.mock.calls[0][1] as Handler;
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("缓存协议的磁盘路径边界", () => {
  it.each(["cache#封面", "cache%封面", "缓存目录 音乐", "cache#100%音乐"])(
    "缓存根目录 %s 的文件完整可读",
    async (rootName) => {
      mocks.root = path.join(directory, rootName);
      await fs.mkdir(path.join(mocks.root, "covers"), { recursive: true });
      const filename = path.join(mocks.root, "covers", "album.jpg");
      await fs.writeFile(filename, "完整封面");

      const response = await handler(new Request(toCacheUrl(filename)!));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("完整封面");
      expect(fileURLToPath(mocks.fetch.mock.calls[0][0])).toBe(filename);
    },
  );

  it.each(["封面#终章.jpg", "100%完成.jpg", "space + & = @.jpg", "literal%23name.jpg"])(
    "相对文件名 %s 编码后仍读取原文件",
    async (name) => {
      await fs.mkdir(path.join(mocks.root, "covers"));
      const filename = path.join(mocks.root, "covers", name);
      await fs.writeFile(filename, name);

      const url = toCacheUrl(filename)!;
      expect(url).toBe(`cache://covers/${encodeURIComponent(name)}`);
      const response = await handler(new Request(url));

      expect(await response.text()).toBe(name);
      expect(fileURLToPath(mocks.fetch.mock.calls[0][0])).toBe(filename);
    },
  );

  it("问号属于文件名时编码，缓存失效查询串不参与路径解析", async () => {
    // Windows 文件名不允许问号，独立验证 URL 编码，再用合法文件覆盖真实读取。
    const reservedName = path.join(mocks.root, "covers", "album?version=1.jpg");
    expect(toCacheUrl(reservedName)).toBe("cache://covers/album%3Fversion%3D1.jpg");
    await fs.mkdir(path.join(mocks.root, "covers"));
    const filename = path.join(mocks.root, "covers", "album#100%.jpg");
    await fs.writeFile(filename, "失效前");
    const url = toCacheUrl(filename)!;

    const first = await handler(new Request(`${url}?v=old`));
    expect(await first.text()).toBe("失效前");
    await fs.writeFile(filename, "失效后");
    const second = await handler(new Request(`${url}?v=new&extra=%3F%23`));

    expect(await second.text()).toBe("失效后");
    expect(mocks.fetch.mock.calls.map(([target]) => target)).toEqual([
      mocks.fetch.mock.calls[0][0],
      mocks.fetch.mock.calls[0][0],
    ]);
  });

  it.each([
    "cache://covers/..%2F..%2Foutside.txt",
    "cache://..%2Fapp-cache-sibling%2Fprivate.txt",
    "cache://covers/..%5C..%5Coutside.txt",
  ])("拒绝编码目录逃逸 %s，不将越界路径交给 net.fetch", async (url) => {
    // 反斜杠只在 Windows 是分隔符；其它平台用实际的正斜杠逃逸验证边界。
    const requestUrl = path.sep === "\\" ? url : url.replaceAll("%5C", "%2F");
    await fs.writeFile(path.join(directory, "outside.txt"), "不可读取");
    const response = await handler(new Request(requestUrl));

    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("不为缓存根目录或外部路径生成链接", () => {
    expect(toCacheUrl(mocks.root)).toBeUndefined();
    expect(toCacheUrl(path.join(directory, "outside.txt"))).toBeUndefined();
    expect(toCacheUrl(path.join(directory, "app-cache-sibling", "private.txt"))).toBeUndefined();
    expect(toCacheUrl(null)).toBeUndefined();
  });

  it("独立分区复用相同边界与文件 URL 编码", async () => {
    mocks.root = path.join(directory, "分区#100%");
    await fs.mkdir(mocks.root);
    const filename = path.join(mocks.root, "封面#.jpg");
    await fs.writeFile(filename, "分区封面");
    handleCacheProtocolOnPartition("persist:test");
    const partitionHandler = mocks.partitionHandle.mock.calls[0][1] as Handler;

    expect(partitionHandler).toBe(handler);
    const response = await partitionHandler(new Request(toCacheUrl(filename)!));
    expect(await response.text()).toBe("分区封面");
    expect(fileURLToPath(mocks.fetch.mock.calls[0][0])).toBe(filename);
  });
});
