// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("@main/utils/logger", () => ({ amLog: { info: vi.fn(), warn: vi.fn() } }));

import { AmDecryptor } from "./decryptor";

// 原样取自 am-hook/crates/am-mp4/src/fixed_template.json，不合成 ctx/state。
const templateJson = fs.readFileSync(
  new URL("./__fixtures__/template.json", import.meta.url),
  "utf8",
);
const template = JSON.parse(templateJson) as Record<string, unknown>;
const wasmUrl = new URL("../../../../resources/apple-music/hook.wasm", import.meta.url);

/** 按 am-hook 的 MP4 单测构造两个 32 字节 sample，包含需要等长改写的 senc。 */
const fragment = (): Buffer => {
  const box = (type: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, body]);
  };
  const tfhdBody = Buffer.alloc(12);
  tfhdBody.writeUInt32BE(0x020010);
  tfhdBody.writeUInt32BE(1, 4);
  tfhdBody.writeUInt32BE(32, 8);
  const tfhd = box("tfhd", tfhdBody);
  const senc = box("senc", Buffer.alloc(8));
  const trunBody = Buffer.alloc(12);
  trunBody.writeUInt32BE(1);
  trunBody.writeUInt32BE(2, 4);
  const moofLength = 8 + 8 + tfhd.length + senc.length + 8 + trunBody.length;
  trunBody.writeUInt32BE(moofLength + 8, 8);
  return Buffer.concat([
    box("moof", box("traf", Buffer.concat([tfhd, senc, box("trun", trunBody)]))),
    box("mdat", Buffer.alloc(64, 0xab)),
  ]);
};

/** 独立调用资源中的真实 WASM 固定模板，作为公开接口结果的逐字节参考。 */
const referenceFragment = async (): Promise<Buffer> => {
  const { instance } = await WebAssembly.instantiate(await fs.promises.readFile(wasmUrl), {});
  const w = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    hook_alloc: (len: number) => number;
    hook_free: (ptr: number, len: number) => void;
    hook_fixed_template: () => number;
    hook_decrypt_fragment: (handle: number, ptr: number, len: number) => number;
  };
  const input = fragment();
  const handle = w.hook_fixed_template();
  const ptr = w.hook_alloc(input.length);
  try {
    new Uint8Array(w.memory.buffer, ptr, input.length).set(input);
    expect(w.hook_decrypt_fragment(handle, ptr, input.length)).toBe(1);
    return Buffer.from(new Uint8Array(w.memory.buffer, ptr, input.length));
  } finally {
    w.hook_free(ptr, input.length);
  }
};

describe("Apple Music 真实 WASM 解密模板", () => {
  it("拒绝 contentKey-only、失败响应、损坏 JSON 和缺失寄存器，不加载 WASM", async () => {
    const decryptor = new AmDecryptor();
    const read = vi.spyOn(fs.promises, "readFile");
    await expect(decryptor.loadTemplate({ contentKey: template.contentKey })).rejects.toThrow(
      "ctx",
    );
    await expect(
      decryptor.loadTemplate({ code: 500, msg: "key failed", data: template }),
    ).rejects.toThrow("code=500");
    await expect(decryptor.loadTemplate({ code: "0", data: template })).rejects.toThrow("code=0");
    await expect(decryptor.loadTemplate({ data: template })).rejects.toThrow("code=undefined");
    await expect(decryptor.loadTemplate("{broken")).rejects.toThrow();
    await expect(decryptor.loadTemplate({ code: 0, data: "{broken" })).rejects.toThrow();
    await expect(decryptor.loadTemplate({ ...template, state: "AA==" })).rejects.toThrow("state");
    await expect(decryptor.loadTemplate({ ...template, rcx: undefined })).rejects.toThrow("rcx");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["完整扁平 JSON", templateJson],
    ["完整对象包装", { code: 0, msg: "ok", data: template }],
    ["JSON 字符串包装", JSON.stringify({ code: 0, msg: "ok", data: templateJson })],
  ])("%s 的实际解密与固定模板逐字节一致，moof/mdat 保持等长", async (_name, input) => {
    const decryptor = new AmDecryptor();
    const expected = await referenceFragment();
    const token = await decryptor.loadTemplate(input);
    expect(typeof token).toBe("object");
    const encrypted = fragment();
    const output = await decryptor.decryptFragment(token, Buffer.from(encrypted), Buffer.alloc(0));
    expect(output).toEqual(expected);
    expect(output.length).toBe(encrypted.length);
    expect(output.subarray(-64)).not.toEqual(encrypted.subarray(-64));
    expect(output.includes(Buffer.from("senc"))).toBe(false);
    expect(output.includes(Buffer.from("free"))).toBe(true);
    await decryptor.freeTemplate(token);
  });

  it("reset 后旧凭证重载真实 JSON，固定凭证重新绑定，不复用已释放的新实例指针", async () => {
    const decryptor = new AmDecryptor();
    const old = await decryptor.loadTemplate(templateJson);
    const fixed = await decryptor.getFixedTemplate();
    const expected = await decryptor.decryptFragment(old, fragment(), Buffer.alloc(0));
    decryptor.reset();
    const read = vi.spyOn(fs.promises, "readFile");
    // 占用并释放新实例的模板分配，旧实例的相同数值指针也不再可用。
    const current = await Promise.all([
      decryptor.loadTemplate(templateJson),
      decryptor.loadTemplate(templateJson),
      decryptor.loadTemplate(templateJson),
    ]);
    for (const token of current) await decryptor.freeTemplate(token);
    expect(await decryptor.decryptFragment(old, fragment(), Buffer.alloc(0))).toEqual(expected);
    expect(await decryptor.decryptFragment(fixed, fragment(), Buffer.alloc(0))).toEqual(expected);
    expect(await decryptor.getFixedTemplate()).toBe(fixed);
    expect(read).toHaveBeenCalledTimes(1);
    await decryptor.freeTemplate(old);
  });

  it("轨道模板释放幂等且释放后拒绝使用，固定模板不可释放，旧 owner 释放不初始化 WASM", async () => {
    const decryptor = new AmDecryptor();
    const old = await decryptor.loadTemplate(templateJson);
    const fixed = await decryptor.getFixedTemplate();
    decryptor.reset();
    const read = vi.spyOn(fs.promises, "readFile");
    await decryptor.freeTemplate(old);
    await decryptor.freeTemplate(old);
    await decryptor.freeTemplate(fixed);
    expect(read).not.toHaveBeenCalled();
    await expect(decryptor.decryptFragment(old, fragment(), Buffer.alloc(0))).rejects.toThrow(
      "已释放",
    );
    expect(read).not.toHaveBeenCalled();
    const expected = await referenceFragment();
    expect(await decryptor.decryptFragment(fixed, fragment(), Buffer.alloc(0))).toEqual(expected);
    const current = await decryptor.loadTemplate({ ...template, r9: "0x0", rbp: "0x0" });
    await decryptor.freeTemplate(current);
    await decryptor.freeTemplate(current);
    await expect(decryptor.decryptFragment(current, fragment(), Buffer.alloc(0))).rejects.toThrow(
      "已释放",
    );
  });

  it("只有显式 null 跳过解密，真实 WASM 失败必须拒绝而不返回原始密文", async () => {
    const decryptor = new AmDecryptor();
    const encrypted = fragment();
    expect(await decryptor.decryptFragment(null, Buffer.from(encrypted), Buffer.alloc(0))).toEqual(
      encrypted,
    );
    const fixed = await decryptor.getFixedTemplate();
    await expect(
      decryptor.decryptFragment(fixed, Buffer.alloc(32), Buffer.alloc(0)),
    ).rejects.toThrow("切片解密失败");
    expect(await decryptor.decryptFragment(fixed, fragment(), Buffer.alloc(0))).toEqual(
      await referenceFragment(),
    );
  });

  it("并发初始化期间手动 reset 不让旧初始化任务覆盖当前实例", async () => {
    const decryptor = new AmDecryptor();
    const bytes = fs.readFileSync(wasmUrl);
    const delayed = Promise.withResolvers<typeof bytes>();
    const read = vi.spyOn(fs.promises, "readFile").mockImplementationOnce(() => delayed.promise);
    const oldLoading = decryptor.loadTemplate(templateJson);
    decryptor.reset();
    const current = await decryptor.loadTemplate(templateJson);
    delayed.resolve(bytes);
    const old = await oldLoading;
    expect(read).toHaveBeenCalledTimes(2);
    const expected = await decryptor.decryptFragment(current, fragment(), Buffer.alloc(0));
    expect(await decryptor.decryptFragment(old, fragment(), Buffer.alloc(0))).toEqual(expected);
    expect(read).toHaveBeenCalledTimes(2);
    await decryptor.freeTemplate(old);
    await decryptor.freeTemplate(current);
  });
});
