// @vitest-environment node
import { deflateSync } from "node:zlib";
import { loadScript } from "./loader";
import { describe, expect, it, vi } from "vitest";
import { INSTALL_URL_MAX_SIZE } from "@shared/defaults/plugin-api";

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("electron", () => ({ net: { fetch } }));

import { fetchScript } from "./net";

const url = "https://plugin.invalid/source.js";

describe("脚本下载的流式字节上限", () => {
  it.each([undefined, "1", "invalid"])(
    "缺失或伪造 Content-Length=%s 时按实际消费量拒绝并取消流",
    async (length) => {
      const cancel = vi.fn();
      const chunks = [
        new Uint8Array(INSTALL_URL_MAX_SIZE / 2),
        new Uint8Array(INSTALL_URL_MAX_SIZE / 2),
        new Uint8Array(1),
        new Uint8Array(1024),
      ];
      let consumed = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(chunks[consumed++]);
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, {
        headers: length === undefined ? {} : { "content-length": length },
      });
      fetch.mockResolvedValueOnce(response);

      await expect(fetchScript(url)).rejects.toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
      expect(consumed).toBe(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );

  it("长度头超限时不读取正文并取消响应", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    fetch.mockResolvedValueOnce(
      new Response(body, { headers: { "content-length": String(INSTALL_URL_MAX_SIZE + 1) } }),
    );

    await expect(fetchScript(url)).rejects.toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("恰好到达字节上限时保留跨块 UTF-8 字符并释放 reader", async () => {
    const source = "a".repeat(INSTALL_URL_MAX_SIZE - 3) + "中";
    const bytes = new TextEncoder().encode(source);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 2));
        controller.enqueue(bytes.subarray(bytes.length - 2));
        controller.close();
      },
      cancel,
    });
    fetch.mockResolvedValueOnce(new Response(body));

    expect(await fetchScript(url)).toBe(source);
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("读取失败时原样报错并释放 reader", async () => {
    const failure = new Error("stream failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    fetch.mockResolvedValueOnce(new Response(body));

    await expect(fetchScript(url)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});

it("更新检查消费远端 gz_ 时下载虽合法，解压超限仍在解析前拒绝", async () => {
  const compressed = "gz_" + deflateSync("a".repeat(INSTALL_URL_MAX_SIZE + 1)).toString("base64");
  fetch.mockResolvedValueOnce(new Response(compressed));

  const downloaded = await fetchScript(url);
  expect(downloaded).toBe(compressed);
  expect(() => loadScript(downloaded, false)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
});
