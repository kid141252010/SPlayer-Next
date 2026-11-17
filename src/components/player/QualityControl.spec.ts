import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import zhCN from "@/i18n/locales/zh-CN.json";
import QualityControl from "./QualityControl.vue";

const mocks = vi.hoisted(() => ({
  media: {
    track: null as { source: string; quality: { codec: string; channels: number } } | null,
    detail: null,
  },
  settings: {
    system: { player: { joc: { mode: "off" } } },
    player: { songLevel: "hq" },
    setSystem: vi.fn(),
  },
}));
vi.mock("@/stores/media", () => ({ useMediaStore: () => mocks.media }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("@/core/player", () => ({ reloadCurrentTrack: vi.fn() }));

/**
 * 创建保留受控值、更新事件和插槽的面板桩组件
 * @param template - 桩模板
 * @returns 测试组件
 */
const createStub = (template: string) =>
  defineComponent({
    props: { modelValue: [String, Number, Boolean], options: Array },
    emits: ["update:modelValue"],
    template,
  });
const popover = createStub('<div><slot name="trigger" /><slot /></div>');
const select = createStub('<div class="select" />');

/**
 * 使用真实中文词条挂载质量面板
 * @returns 可断言的组件实例
 */
const render = () =>
  mount(QualityControl, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: { SPopover: popover, SSelect: select, SPopselect: true, STooltip: popover },
    },
  });

describe("Atmos 对象渲染质量面板", () => {
  beforeEach(() => {
    mocks.media = reactive({
      track: { source: "local", quality: { codec: "eac3", channels: 6 } },
      detail: null,
    });
    mocks.settings = reactive({
      system: { player: { joc: { mode: "off" } } },
      player: { songLevel: "hq" },
      setSystem: vi.fn(async (_path: string, value: string) => {
        mocks.settings.system.player.joc.mode = value;
      }),
    });
  });
  it("本地杜比音源统一显示音质名称，模式选择与设置页同步", async () => {
    const wrapper = render();
    expect(wrapper.get("button").text()).toBe("Dolby Atmos");
    wrapper.findComponent(select).vm.$emit("update:modelValue", "binaural");
    await flushPromises();
    expect(mocks.settings.setSystem).toHaveBeenCalledWith("player.joc.mode", "binaural");
    expect(wrapper.findComponent(select).props("modelValue")).toBe("binaural");
    mocks.settings.system.player.joc.mode = "speaker";
    await nextTick();
    expect(wrapper.get("button").text()).toBe("Dolby Atmos");
    expect(wrapper.findComponent(select).props("modelValue")).toBe("speaker");
  });
  it("双耳模式下显示完整音质名称，质量面板不提供空间场景入口", () => {
    mocks.settings.system.player.joc.mode = "binaural";
    const wrapper = render();
    expect(wrapper.get("button").text()).toBe("Dolby Atmos");
    expect(wrapper.text()).not.toContain(zhCN.scene.open);
  });
  it("普通音频和空曲目不显示对象渲染选择器", async () => {
    mocks.media.track!.quality = { codec: "flac", channels: 2 };
    const wrapper = render();
    expect(wrapper.findComponent(select).exists()).toBe(false);
    mocks.media.track = null;
    await nextTick();
    expect(wrapper.text()).toBe("");
  });
});
