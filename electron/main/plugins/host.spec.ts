// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCallMethod, PluginGrant } from "@shared/types/plugin";
import { PluginErrorCodes } from "@shared/defaults/plugin-api";

const mocks = vi.hoisted(() => ({
  sendHostResult: vi.fn(),
  getStreamUrl: vi.fn(),
  prewarm: vi.fn(),
}));
vi.mock("./host-process", () => ({ pluginHost: { sendHostResult: mocks.sendHostResult } }));
vi.mock("./net", () => ({ hostRequest: vi.fn() }));
vi.mock("./storage", () => ({
  pluginStorageGet: vi.fn(),
  pluginStorageKeys: vi.fn(),
  pluginStorageRemove: vi.fn(),
  pluginStorageSet: vi.fn(),
}));
vi.mock("@main/services/playerControl", () => ({ playerControl: {} }));
vi.mock("@main/services/appleMusic", () => ({
  appleMusicProxy: { getStreamUrl: mocks.getStreamUrl, prewarm: mocks.prewarm },
}));
vi.mock("@main/services/music", () => ({
  searchOnline: vi.fn(),
  searchLibrary: vi.fn(),
  trackSchema: {},
}));
vi.mock("@main/services/platformApi", () => ({ callPlatformApi: vi.fn() }));
vi.mock("@main/services/nowPlaying", () => ({ lightSnapshot: vi.fn() }));
vi.mock("electron", () => ({ Notification: {} }));

import { dispatchHostCall } from "./host";

const methods = ["appleMusic.getStreamUrl", "appleMusic.prewarm"] as const;
const args = ["123", "https://plugin.invalid/master.m3u8", "https://plugin.invalid", "token"];
const resultUrl = "http://127.0.0.1/stream/123";

beforeEach(() => {
  mocks.getStreamUrl.mockReset().mockResolvedValue(resultUrl);
  mocks.prewarm.mockReset().mockResolvedValue(undefined);
});

describe("Apple Music 宿主网络授权", () => {
  it.each(methods)("撤销 network 后 %s 不启动任何代理操作", async (method) => {
    let grants: PluginGrant[] = ["network"];
    const getGrants = () => grants;
    grants = [];
    await dispatchHostCall("plugin", getGrants, "denied", method, args);

    expect(mocks.getStreamUrl).not.toHaveBeenCalled();
    expect(mocks.prewarm).not.toHaveBeenCalled();
    expect(mocks.sendHostResult).toHaveBeenCalledExactlyOnceWith(
      "plugin",
      "denied",
      false,
      undefined,
      {
        code: PluginErrorCodes.PERMISSION_DENIED,
        message: 'plugin "plugin" lacks "network" grant',
      },
    );
  });

  it.each(methods)("允许 network 时 %s 执行真实分派并返回结果", async (method) => {
    await dispatchHostCall("plugin", () => ["network"], "allowed", method, args);

    const target = method === "appleMusic.getStreamUrl" ? mocks.getStreamUrl : mocks.prewarm;
    expect(target).toHaveBeenCalledExactlyOnceWith(...args);
    expect(mocks.sendHostResult).toHaveBeenCalledExactlyOnceWith(
      "plugin",
      "allowed",
      true,
      method === "appleMusic.getStreamUrl" ? resultUrl : undefined,
    );
  });

  it.each(methods)("%s 进行中撤销授权后不会把结果交给插件", async (method: HostCallMethod) => {
    const pending = Promise.withResolvers<string>();
    const target = method === "appleMusic.getStreamUrl" ? mocks.getStreamUrl : mocks.prewarm;
    target.mockReturnValueOnce(pending.promise);
    let grants: PluginGrant[] = ["network"];
    const dispatch = dispatchHostCall("plugin", () => grants, "revoked", method, args);
    expect(target).toHaveBeenCalledOnce();
    grants = [];
    pending.resolve(resultUrl);
    await dispatch;

    expect(mocks.sendHostResult).toHaveBeenCalledWith(
      "plugin",
      "revoked",
      false,
      undefined,
      expect.objectContaining({ code: PluginErrorCodes.PERMISSION_DENIED }),
    );
  });
});
