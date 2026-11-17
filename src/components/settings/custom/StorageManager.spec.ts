import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createApp, defineComponent, nextTick } from "vue";
import { createPinia, disposePinia, type Pinia } from "pinia";
import persistedState from "pinia-plugin-persistedstate";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSystemConfig } from "@shared/defaults/settings";
import { useSettingsStore } from "@/stores/settings";
import StorageManager from "./StorageManager.vue";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  reset: vi.fn(),
  clearAllData: vi.fn(),
}));
vi.mock("@/composables/useDialog", () => ({ dialog: { confirm: mocks.confirm } }));
vi.mock("@/composables/useToast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@/utils/config", () => ({ APP_VERSION: "test" }));

let pinia: Pinia;
let wrapper: VueWrapper;
let originalApi: PropertyDescriptor | undefined;
let backend = structuredClone(defaultSystemConfig);

beforeEach(() => {
  localStorage.clear();
  backend = structuredClone(defaultSystemConfig);
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  const subscribe = () => () => {};
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      config: {
        reset: mocks.reset,
        clearAllData: mocks.clearAllData,
        getAll: async () => structuredClone(backend),
      },
      desktopLyric: { onConfigChange: subscribe },
      dynamicIsland: { onConfigChange: subscribe },
      window: {
        onDesktopLyricVisibilityChange: subscribe,
        onDynamicIslandVisibilityChange: subscribe,
        onTaskbarLyricVisibilityChange: subscribe,
        isDesktopLyricOpen: async () => false,
        isDynamicIslandOpen: async () => false,
        isTaskbarLyricOpen: async () => false,
      },
    },
  });
  mocks.confirm.mockResolvedValue(true);
  mocks.reset.mockImplementation(async () => {
    backend = structuredClone(defaultSystemConfig);
  });
  mocks.clearAllData.mockResolvedValue(undefined);
  pinia = createPinia().use(persistedState);
  createApp({}).use(pinia);
  wrapper = mount(StorageManager, {
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "zh-CN", missingWarn: false, fallbackWarn: false }),
      ],
      stubs: {
        SButton: defineComponent({
          props: { disabled: Boolean, loading: Boolean, type: String, variant: String },
          template: '<button :disabled="disabled"><slot /></button>',
        }),
      },
    },
  });
});
afterEach(() => {
  wrapper.unmount();
  disposePinia(pinia);
  localStorage.clear();
  if (originalApi) Object.defineProperty(window, "api", originalApi);
  else Reflect.deleteProperty(window, "api");
});

describe("存储管理的真实设置消费者", () => {
  it("等待后端效果复位，再原位重置 Pinia 并持久化，同时保持当前界面", async () => {
    const settings = useSettingsStore(pinia);
    const defaultMotionCoverSource = settings.player.motionCoverSource;
    const defaultFontSize = settings.lyric.fontSize;
    settings.player.motionCoverSource = "am";
    settings.lyric.fontSize = 90;
    settings.system.player.equalizer.enabled = true;
    const resetReady = Promise.withResolvers<void>();
    mocks.reset.mockImplementationOnce(async () => {
      await resetReady.promise;
      backend = structuredClone(defaultSystemConfig);
    });

    await wrapper.findAll("button")[2]!.trigger("click");
    await flushPromises();
    expect(settings.lyric.fontSize).toBe(90);
    expect(mocks.success).not.toHaveBeenCalled();
    resetReady.resolve();
    await flushPromises();
    await nextTick();

    expect(settings.player.motionCoverSource).toBe(defaultMotionCoverSource);
    expect(settings.lyric.fontSize).toBe(defaultFontSize);
    expect(settings.system.player.equalizer.enabled).toBe(
      defaultSystemConfig.player.equalizer.enabled,
    );
    expect(JSON.parse(localStorage.getItem("settings")!).lyric.fontSize).toBe(defaultFontSize);
    expect(wrapper.findAll("button")[2]!.attributes("disabled")).toBeUndefined();
    expect(mocks.success).toHaveBeenCalledWith("settings.resetSettings.done");
    expect(mocks.clearAllData).not.toHaveBeenCalled();
  });

  it("全部清理只请求主进程受控重启，不先清 live store 或提前提示完成", async () => {
    const settings = useSettingsStore(pinia);
    settings.lyric.fontSize = 90;
    await nextTick();
    const persisted = localStorage.getItem("settings");
    const accepted = Promise.withResolvers<void>();
    mocks.clearAllData.mockReturnValueOnce(accepted.promise);

    await wrapper.findAll("button")[3]!.trigger("click");
    await flushPromises();
    expect(mocks.clearAllData).toHaveBeenCalledOnce();
    expect(wrapper.findAll("button")[2]!.attributes("disabled")).toBeDefined();
    expect(settings.lyric.fontSize).toBe(90);
    expect(localStorage.getItem("settings")).toBe(persisted);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    accepted.resolve();
    await flushPromises();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("底层设备复位失败时不清空渲染设置或提示成功，并明确显示错误", async () => {
    const settings = useSettingsStore(pinia);
    settings.lyric.fontSize = 90;
    mocks.reset.mockRejectedValueOnce(new Error("device unavailable"));
    await wrapper.findAll("button")[2]!.trigger("click");
    await flushPromises();
    expect(settings.lyric.fontSize).toBe(90);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("device unavailable");
  });

  it("取消确认不会修改内存或持久化设置", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    const settings = useSettingsStore(pinia);
    settings.lyric.fontSize = 90;
    await wrapper.findAll("button")[2]!.trigger("click");
    await flushPromises();
    expect(settings.lyric.fontSize).toBe(90);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
