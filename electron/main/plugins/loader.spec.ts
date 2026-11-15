// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { INSTALL_URL_MAX_SIZE } from "@shared/defaults/plugin-api";
import { decompressIfNeeded, loadScript } from "./loader";

const header = "/**\n * @name Boundary plugin\n * @version 1.0.0\n */\n";

describe("插件最终源码字节上限", () => {
  it("普通源码与 gz_ 在合法 UTF-8 字节边界均可解析元数据", () => {
    const source = header + "a".repeat(INSTALL_URL_MAX_SIZE - Buffer.byteLength(header) - 3) + "中";
    const compressed = "gz_" + deflateSync(source).toString("base64");

    for (const raw of [source, compressed]) {
      const loaded = loadScript(raw, false);
      expect(loaded.source).toBe(source);
      expect(Buffer.byteLength(loaded.source)).toBe(INSTALL_URL_MAX_SIZE);
      expect(loaded.manifest.name).toBe("Boundary plugin");
      expect(loaded.manifest.version).toBe("1.0.0");
      expect(loaded.decompressed).toBe(raw === compressed);
    }
  });

  it("普通源码按 UTF-8 字节数而非字符数拒绝，且先于元数据解析", () => {
    const source = "/** @apiLevel 999999 */\n" + "中".repeat(INSTALL_URL_MAX_SIZE / 3);
    expect(source.length).toBeLessThan(INSTALL_URL_MAX_SIZE);
    expect(() => loadScript(source, false)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
    expect(() => decompressIfNeeded(source)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
  });

  it("小型 gz_ 的膨胀结果超限时在源码加载前拒绝", () => {
    const compressed = "gz_" + deflateSync("a".repeat(INSTALL_URL_MAX_SIZE + 1)).toString("base64");
    expect(Buffer.byteLength(compressed)).toBeLessThan(100_000);

    expect(() => decompressIfNeeded(compressed)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
    expect(() => loadScript(compressed, false)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
  });

  it("UTF-8 替换字符导致解码后的源码超限时同样拒绝", () => {
    const compressed =
      "gz_" + deflateSync(Buffer.alloc(INSTALL_URL_MAX_SIZE / 3 + 1, 0xff)).toString("base64");
    expect(() => loadScript(compressed, false)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
  });

  it("本地文件导入同样拒绝普通与压缩超限源码", () => {
    const directory = mkdtempSync(join(tmpdir(), "splayer-plugin-size-"));
    const path = join(directory, "source.js");
    const source = "a".repeat(INSTALL_URL_MAX_SIZE + 1);
    try {
      for (const raw of [source, "gz_" + deflateSync(source).toString("base64")]) {
        writeFileSync(path, raw);
        expect(() => loadScript(path, true)).toThrow("PLUGIN_INSTALL_URL_TOO_LARGE");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("无效压缩包保留解压错误而非伪装成合法源码", () => {
    expect(() => loadScript("gz_bm90IGRlZmxhdGU=", false)).toThrow();
  });
});
