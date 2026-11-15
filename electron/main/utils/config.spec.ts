import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getName: () => "SPlayer", getVersion: () => "1.0.0" },
}));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: true } }));
vi.mock("@main/store", () => ({ store: { get: vi.fn() } }));
vi.mock("./paths", () => ({ defaultCacheDir: "cache" }));

describe("HRTF 资源路径", () => {
  it("开发目录与打包目录均定位到分发的 joc 资源", async () => {
    const { getJocHrtfPath } = await import("./config");
    expect(getJocHrtfPath("D2")).toBe(
      path.join(process.cwd(), "resources/joc/joc-hrtf-D2.jochrtf"),
    );
    mocks.app.isPackaged = true;
    vi.stubGlobal("process", { ...process, resourcesPath: "/app/resources" });
    try {
      expect(getJocHrtfPath("H20")).toBe(path.join("/app/resources/joc/joc-hrtf-H20.jochrtf"));
    } finally {
      vi.unstubAllGlobals();
      mocks.app.isPackaged = false;
    }
  });
});
