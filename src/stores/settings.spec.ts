import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
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

describe("设置原位重置", () => {
  it("恢复存档后重置默认值，保留响应式引用并持久化到下一次启动", async () => {
    const baselinePinia = createPinia().use(persistedState);
    createApp({}).use(baselinePinia);
    const baseline = useSettingsStore(baselinePinia);
    await nextTick();
    const defaults = JSON.parse(JSON.stringify(baseline.$state)) as typeof baseline.$state;
    disposePinia(baselinePinia);
    localStorage.setItem(
      "settings",
      JSON.stringify({
        locale: "en-US",
        appearance: { reduceMotion: true, sidebarHiddenKeys: ["search"] },
        player: { motionCoverSource: "am", transitionMode: "automix" },
        preset: { noPinyin: true, skipTrackKeywords: ["旧关键词"] },
        lyric: { fontSize: 90, lyricSourceOrder: ["qqmusic"] },
      }),
    );
    const settings = useSettingsStore(pinia);
    // 初始窗口快照先完成，随后模拟窗口已打开，避免快照覆盖测试安排。
    await nextTick();
    const appearance = settings.appearance;
    const player = settings.player;
    const lyric = settings.lyric;
    const equalizer = settings.system.player.equalizer;
    settings.system.player.equalizer.enabled = true;
    settings.system.player.lyricOffsets["netease:123"] = 800;
    settings.isDesktopLyricOpen = true;

    settings.$reset();
    await nextTick();

    expect(settings.appearance).toBe(appearance);
    expect(settings.player).toBe(player);
    expect(settings.lyric).toBe(lyric);
    expect(settings.system.player.equalizer).toBe(equalizer);
    expect(settings.locale).toBe(defaults.locale);
    expect(settings.appearance.reduceMotion).toBe(defaults.appearance.reduceMotion);
    expect(settings.appearance.sidebarHiddenKeys).toEqual(defaults.appearance.sidebarHiddenKeys);
    expect(settings.player.motionCoverSource).toBe(defaults.player.motionCoverSource);
    expect(settings.player.transitionMode).toBe(defaults.player.transitionMode);
    expect(settings.preset.noPinyin).toBe(defaults.preset.noPinyin);
    expect(settings.preset.skipTrackKeywords).toEqual(defaults.preset.skipTrackKeywords);
    expect(settings.lyric.fontSize).toBe(defaults.lyric.fontSize);
    expect(settings.lyric.lyricSourceOrder).toEqual(defaults.lyric.lyricSourceOrder);
    expect(settings.system.player.equalizer.enabled).toBe(defaults.system.player.equalizer.enabled);
    expect(settings.system.player.lyricOffsets).toEqual(defaults.system.player.lyricOffsets);
    // 窗口并未关闭，实际可见状态不能被设置重置伪造成关闭。
    expect(settings.isDesktopLyricOpen).toBe(true);

    const saved = JSON.parse(localStorage.getItem("settings")!);
    expect(saved.player.motionCoverSource).toBe(defaults.player.motionCoverSource);
    expect(saved.lyric.fontSize).toBe(defaults.lyric.fontSize);
    expect(saved).not.toHaveProperty("system");
    disposePinia(pinia);
    pinia = createPinia().use(persistedState);
    createApp({}).use(pinia);
    const restarted = useSettingsStore(pinia);
    expect(restarted.locale).toBe(defaults.locale);
    expect(restarted.player.transitionMode).toBe(defaults.player.transitionMode);
    expect(restarted.lyric.fontSize).toBe(defaults.lyric.fontSize);
  });

  it("再次重置不会复用已被用户修改的默认数组", () => {
    const settings = useSettingsStore(pinia);
    settings.$reset();
    const lyricOrder = [...settings.lyric.lyricSourceOrder];
    const sidebarKeys = [...settings.appearance.sidebarNavGroups[0]!.keys];
    settings.lyric.lyricSourceOrder.splice(0);
    settings.appearance.sidebarNavGroups[0]!.keys.splice(0);
    settings.$reset();
    expect(settings.lyric.lyricSourceOrder).toEqual(lyricOrder);
    expect(settings.appearance.sidebarNavGroups[0]!.keys).toEqual(sidebarKeys);
  });
});
