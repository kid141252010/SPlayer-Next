import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { amLog } from "@main/utils/logger";

interface WasmExports {
  memory: WebAssembly.Memory;
  hook_alloc: (size: number) => number;
  hook_free: (ptr: number, size: number) => void;
  hook_error_ptr: () => number;
  hook_error_len: () => number;
  hook_fixed_template: () => number;
  hook_template_load: (ptr: number, len: number) => number;
  hook_template_free: (handle: number) => void;
  hook_patch_init: (ptr: number, len: number) => void;
  hook_decrypt_fragment: (handle: number, ptr: number, len: number) => number;
  hook_repair_alac: (ptr: number, len: number, initPtr: number, initLen: number) => number;
}

declare const templateBrand: unique symbol;

/** 解密模板凭证；只由所属解密器创建，不暴露 WASM 实例内的指针。 */
export interface AmTemplate {
  readonly [templateBrand]: true;
}

interface TemplateRecord {
  fixed: boolean;
  json: string | null;
  owner: WasmExports | null;
  handle: number;
  released: boolean;
}

/** 获取 hook.wasm 的绝对路径。 */
const resolveWasmPath = (): string => {
  try {
    if (typeof app !== "undefined" && app && typeof app.getAppPath === "function") {
      return app.isPackaged
        ? path.join(process.resourcesPath, "apple-music", "hook.wasm")
        : path.join(app.getAppPath(), "resources", "apple-music", "hook.wasm");
    }
  } catch {
    // 忽略 Electron 路径查询异常，降级到 process.cwd()。
  }
  return path.join(process.cwd(), "resources", "apple-music", "hook.wasm");
};

/** 在 /key 系统边界检查真实模板，禁止用 contentKey 合成执行上下文。 */
const parseTemplate = (input: string | Record<string, unknown>): string => {
  let payload: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  if (!isObject(payload)) throw new Error("解密模板必须是 JSON 对象");
  if ("code" in payload || "data" in payload) {
    if (payload.code !== 0) {
      throw new Error(
        `解密模板响应失败（code=${String(payload.code)}）: ${String(payload.msg ?? "")}`,
      );
    }
    payload = typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data;
  }
  if (!isObject(payload)) throw new Error("解密模板 data 必须是 JSON 对象");
  if (Object.values(payload).some((value) => value !== null && typeof value === "object")) {
    throw new Error("解密模板必须是完整的扁平对象");
  }

  for (const [field, minLength] of [
    ["ctx", 0x8000],
    ["state", 0x2000],
  ] as const) {
    const value = payload[field];
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error(`解密模板缺少有效的 ${field} 上下文`);
    }
    const bytes = Buffer.from(value, "base64");
    const canonical = bytes.toString("base64");
    if (
      bytes.length < minLength ||
      (value.includes("=") ? canonical !== value : canonical.replace(/=+$/, "") !== value)
    ) {
      throw new Error(`解密模板 ${field} 上下文无效或长度不足`);
    }
  }
  for (const field of ["rcx", "rax", "rdx", "r9", "rbp"] as const) {
    const value = payload[field];
    if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]{1,16}$/.test(value.trim())) {
      throw new Error(`解密模板缺少有效的 ${field} 寄存器`);
    }
  }
  return JSON.stringify(payload);
};

/** Apple Music 音轨与分片本地 WASM 解密器。 */
export class AmDecryptor {
  private wasm: WasmExports | null = null;
  private wasmInitPromise: Promise<WasmExports> | null = null;
  private readonly templates = new WeakMap<AmTemplate, TemplateRecord>();
  private fixedTemplate: AmTemplate | null = null;

  /** 初始化并预热 WASM 运行时环境。 */
  public async warmup(): Promise<void> {
    try {
      await this.getWasm();
    } catch (err) {
      amLog.warn("[decryptor] hook.wasm 预热失败", err);
    }
  }

  /** 只发布当前初始化任务的实例；reset 前的异步任务不能覆盖新实例。 */
  private async getWasm(): Promise<WasmExports> {
    for (;;) {
      if (this.wasm) return this.wasm;
      if (!this.wasmInitPromise) {
        this.wasmInitPromise = (async () => {
          const buffer = await fs.promises.readFile(resolveWasmPath());
          const { instance } = await WebAssembly.instantiate(buffer, {});
          return instance.exports as unknown as WasmExports;
        })();
      }
      const pending = this.wasmInitPromise;
      let w: WasmExports;
      try {
        w = await pending;
      } catch (err) {
        if (this.wasmInitPromise !== pending) continue;
        this.wasmInitPromise = null;
        throw err;
      }
      if (this.wasmInitPromise !== pending) continue;
      if (!this.wasm) amLog.info("[decryptor] hook.wasm 载入成功");
      this.wasm = w;
      return w;
    }
  }

  /** await 之后再次确认所有权，后续 WASM 操作同步完成，不留下 reset 竞态窗口。 */
  private async withWasm<T>(operation: (w: WasmExports) => T): Promise<T> {
    for (;;) {
      const w = await this.getWasm();
      if (w === this.wasm) return operation(w);
    }
  }

  /** panic 立即废弃实例；包括分配、错误读取和释放在内的所有导出都经过此处。 */
  private callWasm<T>(w: WasmExports, operation: () => T): T {
    try {
      return operation();
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError && this.wasm === w) this.reset();
      throw err;
    }
  }

  /** 将输入拷入当前堆；panic 后禁止 finally 再访问已经不可信的分配器。 */
  private withBuffer<T>(w: WasmExports, bytes: Uint8Array, operation: (ptr: number) => T): T {
    const ptr = this.callWasm(w, () => w.hook_alloc(bytes.length));
    if (!ptr) throw new Error("WASM 缓冲区分配失败");
    try {
      new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
      return operation(ptr);
    } finally {
      if (this.wasm === w) this.callWasm(w, () => w.hook_free(ptr, bytes.length));
    }
  }

  /** 读取 WASM 内部最近一次错误信息。 */
  private lastError(w: WasmExports): string {
    const ptr = this.callWasm(w, () => w.hook_error_ptr());
    const len = this.callWasm(w, () => w.hook_error_len());
    if (!ptr || !len) return "未知 WASM 错误";
    return new TextDecoder().decode(new Uint8Array(w.memory.buffer, ptr, len));
  }

  private templateRecord(template: AmTemplate): TemplateRecord {
    const record = this.templates.get(template);
    if (!record) throw new Error("解密模板不属于当前解密器");
    if (record.released) throw new Error("解密模板已释放");
    return record;
  }

  /** 实例更换后，轨道模板从保留的原始 JSON 重载，固定模板重新向 WASM 获取。 */
  private templateHandle(w: WasmExports, record: TemplateRecord): number {
    if (record.owner === w) return record.handle;
    let handle: number;
    if (record.fixed) {
      handle = this.callWasm(w, () => w.hook_fixed_template());
    } else {
      const encoded = new TextEncoder().encode(record.json!);
      handle = this.withBuffer(w, encoded, (ptr) => {
        const loaded = this.callWasm(w, () => w.hook_template_load(ptr, encoded.length));
        if (!loaded) throw new Error(`加载解密模板失败: ${this.lastError(w)}`);
        return loaded;
      });
    }
    if (!handle) throw new Error("获取固定解密模板失败");
    record.owner = w;
    record.handle = handle;
    return handle;
  }

  /** 修补 fMP4 Init Segment，保持盒结构等长。 */
  public async patchInit(initBuf: Buffer): Promise<Buffer> {
    return this.withWasm((w) =>
      this.withBuffer(w, initBuf, (ptr) => {
        this.callWasm(w, () => w.hook_patch_init(ptr, initBuf.length));
        return Buffer.from(new Uint8Array(w.memory.buffer, ptr, initBuf.length));
      }),
    );
  }

  /** 载入真实完整模板，支持 /key 的 { code: 0, msg, data } 包装。 */
  public async loadTemplate(input: string | Record<string, unknown>): Promise<AmTemplate> {
    const json = parseTemplate(input);
    return this.withWasm((w) => {
      const record: TemplateRecord = {
        fixed: false,
        json,
        owner: null,
        handle: 0,
        released: false,
      };
      this.templateHandle(w, record);
      const template = Object.freeze({}) as AmTemplate;
      this.templates.set(template, record);
      return template;
    });
  }

  /** 获取固定模板凭证；固定模板由 WASM 持有，不能释放。 */
  public async getFixedTemplate(): Promise<AmTemplate> {
    return this.withWasm((w) => {
      if (!this.fixedTemplate) {
        this.fixedTemplate = Object.freeze({}) as AmTemplate;
        this.templates.set(this.fixedTemplate, {
          fixed: true,
          json: null,
          owner: null,
          handle: 0,
          released: false,
        });
      }
      this.templateHandle(w, this.templateRecord(this.fixedTemplate));
      return this.fixedTemplate;
    });
  }

  /** 幂等释放轨道模板；旧实例的指针不能传给新实例，也不能因此初始化新实例。 */
  public async freeTemplate(template: AmTemplate): Promise<void> {
    const record = this.templates.get(template);
    if (!record) throw new Error("解密模板不属于当前解密器");
    if (record.fixed || record.released) return;
    record.released = true;
    const { owner, handle } = record;
    record.owner = null;
    record.handle = 0;
    record.json = null;
    if (owner && owner === this.wasm) {
      this.callWasm(owner, () => owner.hook_template_free(handle));
    }
  }

  /**
   * 原地解密分片，再按当前轨道 init 修复 ALAC，始终保持 moof/mdat 等长。
   * null 仅供调用者明确标记 METHOD=NONE 的未加密分片使用。
   */
  public async decryptFragment(
    template: AmTemplate | null,
    fragBuf: Buffer,
    initBuf: Buffer,
  ): Promise<Buffer> {
    if (template !== null) this.templateRecord(template);
    return this.withWasm((w) => {
      const handle =
        template === null ? null : this.templateHandle(w, this.templateRecord(template));
      return this.withBuffer(w, fragBuf, (fragPtr) => {
        if (handle !== null) {
          const ok = this.callWasm(w, () =>
            w.hook_decrypt_fragment(handle, fragPtr, fragBuf.length),
          );
          if (!ok) throw new Error(`切片解密失败: ${this.lastError(w)}`);
        }
        if (initBuf.length > 0) {
          this.withBuffer(w, initBuf, (initPtr) => {
            const ok = this.callWasm(w, () =>
              w.hook_repair_alac(fragPtr, fragBuf.length, initPtr, initBuf.length),
            );
            if (!ok) throw new Error(`ALAC 结构修复失败: ${this.lastError(w)}`);
          });
        }
        // hook_alloc 可能触发 memory.grow，任何分配之后都重新获取内存视图。
        fragBuf.set(new Uint8Array(w.memory.buffer, fragPtr, fragBuf.length));
        return fragBuf;
      });
    });
  }

  /** 废弃当前实例与初始化任务；未释放的模板凭证在下一次使用时自动重载。 */
  public reset(): void {
    amLog.warn("[decryptor] 重置 WASM 运行时状态");
    this.wasm = null;
    this.wasmInitPromise = null;
  }
}

/** 全局单例解密器。 */
export const amDecryptor = new AmDecryptor();
