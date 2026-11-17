import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { createPinia, defineStore, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settings";
import { useStatusStore } from "@/stores/status";
import { useSpatialStore } from "@/stores/spatial";
import zhCN from "@/i18n/locales/zh-CN.json";
import Toolbar from "../Toolbar.vue";
import AppleLayout from "../FullPlayer/layouts/apple/AppleLayout.vue";
import SpatialScene from "./SpatialScene.vue";

const useTestSettingsStore = defineStore("settings", {
  state: () => ({
    appearance: { showQualitySwitch: false },
    isDesktopLyricOpen: false,
    system: { player: { joc: { mode: "off", hrtf: "D2", gainDb: 0 } } },
  }),
  actions: {
    async setSystem(_path: string, value: unknown) {
      this.system.player.joc.mode = String(value);
    },
  },
});
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (pinia?: Pinia) => useTestSettingsStore(pinia),
}));
vi.mock("@/core/player", () => ({ __v_isRef: false, setVolume: vi.fn() }));
vi.mock("@/stores/media", () => ({
  useMediaStore: () => ({ parsedLyric: [], lyricLoading: false }),
}));
vi.mock("../FullPlayer/context", () => ({
  useFullPlayer: () => ({ onBarEnter: vi.fn(), onBarLeave: vi.fn() }),
}));

const mounted: Array<{ wrapper: VueWrapper; host: HTMLElement }> = [];

beforeEach(() => {
  // 隔离浏览器绘图和原生 IPC；真实组件及其打开、关闭和模式选择流程照常运行。
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("api", {
    player: {
      setJocControls: vi.fn().mockResolvedValue({ success: true }),
      getJocScene: vi.fn().mockResolvedValue({ success: true, data: null }),
    },
  });
});

afterEach(async () => {
  for (const { wrapper, host } of mounted.splice(0)) {
    wrapper.unmount();
    host.remove();
  }
  await flushPromises();
  vi.unstubAllGlobals();
});

/** 将实际工具栏与全局声场放在同一消费链，整个过程不连接音频引擎。 */
function render({ cover = false, apple = false } = {}) {
  const pinia = createPinia();
  const settings = useSettingsStore(pinia);
  const status = useStatusStore(pinia);
  const spatial = useSpatialStore(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h("div", [
          apple ? h(AppleLayout) : h(Toolbar, { cover }),
          spatial.open ? h(SpatialScene) : null,
        ]),
    }),
    {
      attachTo: host,
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          teleport: true,
          SPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
          SButton: { template: '<button><slot name="icon" /><slot /></button>' },
          SDropdownMenu: true,
          SSlider: true,
          EqualizerDialog: true,
          SpeedDialog: true,
          AutoCloseDialog: true,
          AbLoopDialog: true,
          FmModeDialog: true,
          QualityControl: true,
          QueuePopover: true,
          IconLucideVolumeX: true,
          IconLucideVolume1: true,
          IconLucideVolume2: true,
          IconLucideCaptions: true,
          IconLucideListMusic: true,
          PlayerTopBar: true,
          PlayerCover: true,
          AppleControls: true,
          PlayerLyric: true,
          QueuePanel: true,
          IconSpAmLyricsActive: true,
          IconSpAmLyrics: true,
          IconSpAmPlaylistActive: true,
          IconSpAmPlaylist: true,
        },
      },
    },
  );
  mounted.push({ wrapper, host });
  return { wrapper, settings, status };
}

describe("空间声场入口", () => {
  it.each([false, true])(
    "快捷音质关闭、无音源且未启用 JOC 时仍能从工具栏打开（cover=%s）",
    async (cover) => {
      const { wrapper, settings } = render({ cover });
      const setSystem = vi.spyOn(settings, "setSystem");
      await wrapper.get('[aria-label="打开空间声场"]').trigger("click");
      expect(wrapper.get('[role="dialog"]').attributes("aria-label")).toBe("空间声场");
      expect(wrapper.get('[role="status"]').text()).toContain("对象渲染当前已关闭");
      expect(wrapper.get<HTMLSelectElement>("select").element.value).toBe("off");
      expect(setSystem).not.toHaveBeenCalled();
    },
  );

  it("Apple 右下角从左侧空间声场打开，关闭后仍可使用最右侧列表开关", async () => {
    const { wrapper, status } = render({ apple: true });
    const actions = wrapper.get('[data-player-layout="bottom-bar"]');
    const entry = actions.get('[aria-label="打开空间声场"]');
    expect(actions.element.firstElementChild).toBe(entry.element);
    await entry.trigger("click");
    expect(wrapper.get('[role="dialog"]').attributes("aria-label")).toBe("空间声场");
    await wrapper.get('[aria-label="关闭"]').trigger("click");
    await actions.get("button:last-child").trigger("click");
    expect(status.fullQueueOpen).toBe(true);
  });

  it("在声场内选择模式，区分未加载、无 JOC 数据、已生效及扬声器模式", async () => {
    const { wrapper, status } = render();
    await wrapper.get('[aria-label="打开空间声场"]').trigger("click");
    await wrapper.get("select").setValue("binaural");
    expect(wrapper.get('[role="status"]').text()).toContain("尚未播放音源");
    status.currentSource = "ordinary.flac";
    await nextTick();
    expect(wrapper.get('[role="status"]').text()).toContain("不含 JOC 元数据");
    status.jocActive = true;
    await nextTick();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    await wrapper.get("select").setValue("speaker");
    expect(wrapper.get('[role="status"]').text()).toContain("Speaker 2.0");
  });

  it("关闭后移除声场并把焦点归还打开按钮", async () => {
    const { wrapper } = render();
    const entry = wrapper.get<HTMLButtonElement>('[aria-label="打开空间声场"]');
    entry.element.focus();
    await entry.trigger("click");
    await wrapper.get('[aria-label="关闭"]').trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(entry.element);
  });
});
