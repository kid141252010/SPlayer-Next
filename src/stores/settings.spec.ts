import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "vue";
import { createPinia, disposePinia, type Pinia } from "pinia";
import persistedState from "pinia-plugin-persistedstate";
import { useSettingsStore } from "./settings";

let pinia: Pinia;
let originalApi: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  const subscribe = () => () => {};
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
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
  pinia = createPinia().use(persistedState);
  createApp({}).use(pinia);
});

afterEach(() => {
  disposePinia(pinia);
  localStorage.clear();
  if (originalApi) Object.defineProperty(window, "api", originalApi);
  else Reflect.deleteProperty(window, "api");
});

describe("旧设置存档迁移", () => {
  it.each([
    { enabled: true, expected: "ncm" },
    { enabled: false, expected: "off" },
  ])("旧动态封面开关 $enabled 迁入新来源并移除旧字段", ({ enabled, expected }) => {
    localStorage.setItem(
      "settings",
      JSON.stringify({
        player: { dynamicCover: enabled, preferPluginSource: true, transitionMode: "automix" },
        preset: { noPinyin: true },
        lyric: { autoGenerateWordByWord: true },
      }),
    );
    const settings = useSettingsStore(pinia);
    expect(settings.player.motionCoverSource).toBe(expected);
    expect(settings.player.preferPluginSource).toBe(true);
    expect(settings.player.transitionMode).toBe("automix");
    expect(settings.preset.noPinyin).toBe(true);
    expect(settings.lyric.autoGenerateWordByWord).toBe(true);
    settings.$persist();
    const saved = JSON.parse(localStorage.getItem("settings")!);
    expect(saved.player.motionCoverSource).toBe(expected);
    expect(saved.player).not.toHaveProperty("dynamicCover");
  });

  it.each(["off", "ncm", "am", "amFirst"])(
    "旧开关不能覆盖用户显式保存的来源 %s",
    (motionCoverSource) => {
      localStorage.setItem(
        "settings",
        JSON.stringify({ player: { dynamicCover: true, motionCoverSource } }),
      );
      const settings = useSettingsStore(pinia);
      expect(settings.player.motionCoverSource).toBe(motionCoverSource);
      settings.$persist();
      expect(JSON.parse(localStorage.getItem("settings")!).player.motionCoverSource).toBe(
        motionCoverSource,
      );
    },
  );

  it("废弃过渡模式迁至关闭，但保留交叉淡化与 AutoMix", () => {
    localStorage.setItem("settings", JSON.stringify({ player: { transitionMode: "gapless" } }));
    const settings = useSettingsStore(pinia);
    expect(settings.player.transitionMode).toBe("none");
    settings.player.transitionMode = "crossfade";
    settings.$persist();
    settings.$hydrate();
    expect(settings.player.transitionMode).toBe("crossfade");
    settings.player.transitionMode = "automix";
    settings.$persist();
    settings.$hydrate();
    expect(settings.player.transitionMode).toBe("automix");
  });
});
