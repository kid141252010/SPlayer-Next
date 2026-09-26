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

/** 获取 hook.wasm 的绝对路径 */
const resolveWasmPath = (): string => {
  try {
    if (typeof app !== "undefined" && app && typeof app.getAppPath === "function") {
      return app.isPackaged
        ? path.join(process.resourcesPath, "apple-music", "hook.wasm")
        : path.join(app.getAppPath(), "resources", "apple-music", "hook.wasm");
    }
  } catch {
    // 忽略异常，降级到 process.cwd()
  }
  return path.join(process.cwd(), "resources", "apple-music", "hook.wasm");
};

/**
 * Apple Music 音轨与分片本地 WASM 解密器
 */
export class AmDecryptor {
  private wasm: WasmExports | null = null;
  private wasmInitPromise: Promise<WasmExports> | null = null;
  private fixedTemplateObj: Record<string, unknown> | null = null;

  /**
   * 初始化并预热 WASM 运行时环境
   */
  public async warmup(): Promise<void> {
    try {
      await this.getWasm();
    } catch (err) {
      amLog.warn("[decryptor] hook.wasm 预热失败", err);
    }
  }

  /**
   * 初始化并获取 WASM 导出实例
   * @returns WASM 导出对象
   */
  private async getWasm(): Promise<WasmExports> {
    if (this.wasm) return this.wasm;
    if (this.wasmInitPromise) return this.wasmInitPromise;

    this.wasmInitPromise = (async () => {
      const wasmPath = resolveWasmPath();
      if (!fs.existsSync(wasmPath)) {
        throw new Error(`hook.wasm 资源文件不存在: ${wasmPath}`);
      }
      const buffer = await fs.promises.readFile(wasmPath);

      // 提取内置固定模板 JSON 作为缺省上下文（供无完整上下文的上游合成完整模板）
      try {
        const str = buffer.toString("latin1");
        const target = '"rcx": "0x97"';
        const idx = str.indexOf(target);
        if (idx !== -1) {
          const start = str.lastIndexOf("{", idx);
          const end = str.indexOf("}", idx);
          if (start !== -1 && end !== -1) {
            this.fixedTemplateObj = JSON.parse(str.slice(start, end + 1));
          }
        }
      } catch (err) {
        amLog.warn("[decryptor] 解析内置固定模板元数据异常", err);
      }

      const { instance } = await WebAssembly.instantiate(buffer, {});
      const exports = instance.exports as unknown as WasmExports;
      this.wasm = exports;
      amLog.info("[decryptor] hook.wasm 载入成功");
      return exports;
    })();

    try {
      return await this.wasmInitPromise;
    } catch (err) {
      this.wasmInitPromise = null;
      throw err;
    }
  }

  /**
   * 读取 WASM 内部最近一次错误信息
   * @param w - WASM 导出对象
   * @returns 错误字符串
   */
  private lastError(w: WasmExports): string {
    const ptr = w.hook_error_ptr();
    const len = w.hook_error_len();
    if (!ptr || !len) return "未知 WASM 错误";
    return new TextDecoder().decode(new Uint8Array(w.memory.buffer, ptr, len));
  }

  /**
   * 修补 fMP4 Init Segment（抹除 DRM 伪装盒与标记）
   * @param initBuf - 原始 Init Segment 字节
   * @returns 修补后的 Init Segment
   */
  public async patchInit(initBuf: Buffer): Promise<Buffer> {
    const w = await this.getWasm();
    const copy = Buffer.from(initBuf);
    const len = copy.length;
    const ptr = w.hook_alloc(len);
    try {
      new Uint8Array(w.memory.buffer, ptr, len).set(copy);
      w.hook_patch_init(ptr, len);
      copy.set(new Uint8Array(w.memory.buffer, ptr, len));
      return copy;
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) {
        this.reset();
      }
      throw err;
    } finally {
      w.hook_free(ptr, len);
    }
  }

  /**
   * 载入轨道解密模板 JSON
   * 自动兼容完整的 am-hook 模板与 wrapper-manager 精简 contentKey 响应
   * @param templateInput - 上游 /key 返回的模板 JSON 文本或对象
   * @param overrides - 可选的元数据覆盖字段（adamId, keyUri）
   * @returns 模板句柄
   */
  public async loadTemplate(
    templateInput: string | Record<string, unknown>,
    overrides?: { adamId?: string; keyUri?: string },
  ): Promise<number> {
    const w = await this.getWasm();
    let finalJsonStr =
      typeof templateInput === "string" ? templateInput.trim() : JSON.stringify(templateInput);

    try {
      const parsed = typeof templateInput === "string" ? JSON.parse(templateInput) : templateInput;
      const payload =
        parsed && typeof parsed === "object" && "data" in parsed && parsed.data
          ? (parsed.data as Record<string, unknown>)
          : (parsed as Record<string, unknown>);

      // 若上游仅返回 contentKey（无 ctx/state 执行上下文），基于内置固定模板合成合法结构
      if (
        payload &&
        (!payload.ctx || !payload.state) &&
        payload.contentKey &&
        this.fixedTemplateObj
      ) {
        const merged = {
          ...this.fixedTemplateObj,
          adamId: overrides?.adamId ?? payload.adamId ?? this.fixedTemplateObj.adamId,
          keyUri: overrides?.keyUri ?? payload.keyUri ?? this.fixedTemplateObj.keyUri,
          contentKey: payload.contentKey,
        };
        finalJsonStr = JSON.stringify(merged);
      }
    } catch {
      // 保持原始字符串传递
    }

    const encoded = new TextEncoder().encode(finalJsonStr);
    const len = encoded.length;
    const ptr = w.hook_alloc(len);
    let handle = 0;
    try {
      new Uint8Array(w.memory.buffer, ptr, len).set(encoded);
      handle = w.hook_template_load(ptr, len);
      if (!handle) {
        throw new Error(`加载解密模板失败: ${this.lastError(w)}`);
      }
      return handle;
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) {
        this.reset();
      }
      throw err;
    } finally {
      w.hook_free(ptr, len);
    }
  }

  /**
   * 获取固定模板句柄（用于预热与通用分片）
   * @returns 固定模板句柄
   */
  public async getFixedTemplate(): Promise<number> {
    const w = await this.getWasm();
    return w.hook_fixed_template();
  }

  /**
   * 释放解密模板句柄
   * @param handle - 模板句柄
   */
  public async freeTemplate(handle: number): Promise<void> {
    if (!handle) return;
    const w = await this.getWasm();
    try {
      w.hook_template_free(handle);
    } catch (err) {
      amLog.warn("[decryptor] 释放模板句柄异常", err);
    }
  }

  /**
   * 原地解密单个音频切片（.m4s）并修复 ALAC 结构
   * @param handle - 模板句柄（固定模板或轨道模板）
   * @param fragBuf - 原始加密切片字节
   * @param initBuf - 已修补的 Init Segment 字节（若提供则修复 ALAC 头部）
   * @returns 解密后的切片字节
   */
  public async decryptFragment(handle: number, fragBuf: Buffer, initBuf?: Buffer): Promise<Buffer> {
    const w = await this.getWasm();
    const fragLen = fragBuf.length;
    const fragPtr = w.hook_alloc(fragLen);
    let initPtr = 0;
    const initLen = initBuf && initBuf.length > 0 ? initBuf.length : 0;

    try {
      new Uint8Array(w.memory.buffer, fragPtr, fragLen).set(fragBuf);

      if (handle) {
        const ok = w.hook_decrypt_fragment(handle, fragPtr, fragLen);
        if (!ok) throw new Error(`切片解密失败: ${this.lastError(w)}`);
      }

      if (initLen > 0 && initBuf) {
        initPtr = w.hook_alloc(initLen);
        // 注意：hook_alloc 可能触发 WASM memory grow，每次访问需从 w.memory.buffer 重新生成视图
        new Uint8Array(w.memory.buffer, initPtr, initLen).set(initBuf);
        const ok = w.hook_repair_alac(fragPtr, fragLen, initPtr, initLen);
        if (!ok) throw new Error(`ALAC 结构修复失败: ${this.lastError(w)}`);
      }

      fragBuf.set(new Uint8Array(w.memory.buffer, fragPtr, fragLen));
      return fragBuf;
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) {
        this.reset();
      }
      throw err;
    } finally {
      if (initPtr && initLen > 0) {
        w.hook_free(initPtr, initLen);
      }
      w.hook_free(fragPtr, fragLen);
    }
  }

  /**
   * 重置 WASM 实例（在发生 RuntimeError panic 时调用）
   */
  public reset(): void {
    amLog.warn("[decryptor] 重置 WASM 运行时状态");
    this.wasm = null;
    this.wasmInitPromise = null;
  }
}

/** 全局单例解密器 */
export const amDecryptor = new AmDecryptor();
