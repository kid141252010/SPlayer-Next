import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { computed, defineComponent, h } from "vue";
import { createI18n } from "vue-i18n";
import SettingsItem from "@/components/settings/SettingsItem.vue";
import playerCategory from "./player";

const mocks = vi.hoisted(() => ({
  enabled: false as boolean | string,
  cache: { enabled: false, cacheStreaming: false },
  joc: { mode: "off" },
  player: { preloadNextTrack: false, transitionMode: "none" },
  confirm: vi.fn(),
  setSystem: vi.fn(),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    system: { cache: { songCache: mocks.cache }, player: { joc: mocks.joc } },
    player: mocks.player,
    setSystem: mocks.setSystem,
  }),
}));
vi.mock("@/composables/useDialog", () => ({ dialog: { confirm: mocks.confirm } }));
vi.mock("@/settings/useSettingModel", () => ({
  useSettingModel: () =>
    computed({
      get: () => mocks.enabled,
      set: (value: boolean | string) => {
        mocks.enabled = value;
      },
    }),
}));
vi.mock("@/components/settings/custom/DeviceSelector.vue", () => ({ default: {} }));
vi.mock("~icons/lucide/play", () => ({ default: {} }));
vi.mock("@/utils/config", () => ({ isWin: true }));
vi.mock("@/core/player", () => ({ getActiveDeviceId: vi.fn() }));
vi.mock("@/services/deviceVolume", () => ({ setDeviceVolume: vi.fn() }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => ({ volume: 1 }) }));

const item = playerCategory
  .sections!.flatMap((section) => section.items)
  .find((item) => item.key === "preloadNextTrack")!;
const transitionItem = playerCategory
  .sections!.flatMap((section) => section.items)
  .find((item) => item.key === "transitionMode")!;

describe("对象渲染设置", () => {
  it("使用持久化系统配置，双耳模式才显示完整 HRTF 列表", () => {
    const section = playerCategory.sections!.find((section) => section.id === "joc")!;
    expect(section.tag?.text).toBe("Beta");
    const [mode, hrtf, gain] = section.items;
    expect(mode!.binding?.path).toBe("system.player.joc.mode");
    expect(mode!.defaultValue).toBe("off");
    expect(hrtf!.defaultValue).toBe("D2");
    expect(hrtf!.options).toHaveLength(20);
    for (const value of ["off", "speaker", "binaural"]) {
      mocks.joc.mode = value;
      expect(hrtf!.visible!()).toBe(value === "binaural");
    }
    expect([gain!.defaultValue, gain!.min, gain!.max]).toEqual([0, -12, 6]);
  });
});
/** 创建点击后回传指定值的按钮桩组件 */
const createButtonStub = (value: boolean | string) =>
  defineComponent({
    emits: ["update:modelValue"],
    setup:
      (_props, { emit }) =>
      () =>
        h("button", { onClick: () => emit("update:modelValue", value) }, String(value)),
  });

describe("开启预载的缓存确认", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = false;
    mocks.cache = { enabled: false, cacheStreaming: false };
    mocks.player.preloadNextTrack = false;
    mocks.player.transitionMode = "none";
    mocks.setSystem.mockResolvedValue(undefined);
  });

  for (const confirmed of [false, true]) {
    it(confirmed ? "确认后开启预载及两项缓存" : "取消后不改变预载和缓存设置", async () => {
      mocks.confirm.mockResolvedValue(confirmed);
      const wrapper = mount(SettingsItem, {
        props: { item },
        global: {
          plugins: [
            createI18n({ legacy: false, locale: "zh-CN", missingWarn: false, fallbackWarn: false }),
          ],
          stubs: { SSwitch: createButtonStub(true) },
        },
      });
      await wrapper.get("button").trigger("click");
      await flushPromises();
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.enabled).toBe(confirmed);
      if (confirmed) {
        expect(mocks.setSystem.mock.calls).toEqual([
          ["cache.songCache.enabled", true],
          ["cache.songCache.cacheStreaming", true],
        ]);
      } else {
        expect(mocks.setSystem).not.toHaveBeenCalled();
      }
      wrapper.unmount();
    });
  }

  it("两项缓存已经开启时无需再次确认", () => {
    mocks.cache = { enabled: true, cacheStreaming: true };
    expect(item.confirm!.when!(true)).toBe(false);
    expect(item.confirm!.when!(false)).toBe(false);
  });
});

describe("播放过渡设置", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = "none";
    mocks.cache = { enabled: false, cacheStreaming: false };
    mocks.player.preloadNextTrack = false;
    mocks.player.transitionMode = "none";
    mocks.setSystem.mockResolvedValue(undefined);
  });

  for (const confirmed of [false, true]) {
    it(confirmed ? "开启交叉过渡时启用预载和缓存" : "取消确认时保留无过渡", async () => {
      mocks.confirm.mockResolvedValue(confirmed);
      const wrapper = mount(SettingsItem, {
        props: { item: transitionItem },
        global: {
          plugins: [
            createI18n({ legacy: false, locale: "zh-CN", missingWarn: false, fallbackWarn: false }),
          ],
          stubs: { SSelect: createButtonStub("crossfade") },
        },
      });
      await wrapper.get("button").trigger("click");
      await flushPromises();
      expect(mocks.enabled).toBe(confirmed ? "crossfade" : "none");
      expect(mocks.player.preloadNextTrack).toBe(confirmed);
      expect(mocks.setSystem).toHaveBeenCalledTimes(confirmed ? 2 : 0);
      wrapper.unmount();
    });
  }
});
