<script setup lang="ts">
import { useSpatialStore } from "@/stores/spatial";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { SceneInteraction } from "./interaction";
import { createSceneLoop } from "./loop";
import { hue, TAU } from "./math";
import "./scene.css";
import { usePopupZIndex } from "@/composables/useZIndex";

const spatial = useSpatialStore();
const status = useStatusStore();
const settings = useSettingsStore();
const { t } = useI18n();
const { zIndex, acquire } = usePopupZIndex();
acquire();
const root = useTemplateRef<HTMLElement>("root");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const bottom = useTemplateRef<HTMLElement>("bottom");
const levels = shallowRef(Array<number>(16).fill(0));
const error = ref(false);
let renderer: SceneInteraction;
let loop: ReturnType<typeof createSceneLoop>;

/** 入口始终可达，单独说明当前为何没有对象声场数据 */
const unavailableMessage = computed(() => {
  if (error.value) return t("scene.error");
  if (settings.system.player.joc.mode === "off") return t("scene.disabled");
  if (settings.system.player.joc.mode === "speaker") return t("scene.speakerOnly");
  if (!status.currentSource) return t("scene.noSource");
  return status.jocActive ? "" : t("scene.waiting");
});

/** 只在用户主动选择时修改模式，打开声场不触发自动播放或切换 */
function onModeChange(event: Event): void {
  void settings.setSystem("player.joc.mode", (event.target as HTMLSelectElement).value);
}

const readout = computed(() => {
  let yaw = spatial.controls.yaw % TAU;
  if (yaw > Math.PI) yaw -= TAU;
  if (yaw < -Math.PI) yaw += TAU;
  const pitch = spatial.controls.pitch;
  return (
    t("scene.pose", {
      turn: t(yaw >= 0 ? "scene.turnLeft" : "scene.turnRight"),
      yaw: Math.round((Math.abs(yaw) * 180) / Math.PI),
      tilt: t(pitch >= 0 ? "scene.tiltUp" : "scene.tiltDown"),
      pitch: Math.round((Math.abs(pitch) * 180) / Math.PI),
    }) +
    " · " +
    t("scene.position", { x: spatial.controls.x.toFixed(1), y: spatial.controls.y.toFixed(1) })
  );
});

/** 关闭界面而保留共享控件和混音状态 */
function close(): void {
  spatial.open = false;
}
/** 切换第一人称应援棒 */
function toggleStick(): void {
  spatial.view.stickOn = !spatial.view.stickOn;
  if (spatial.view.stickOn) spatial.view.view = "first";
}
/** 让 Tab 留在模态声场内 */
function trapFocus(event: KeyboardEvent): void {
  const elements = Array.from(
    root.value!.querySelectorAll<HTMLElement>("button, input, select, canvas"),
  );
  const first = elements[0],
    last = elements[elements.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === root.value)
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || document.activeElement === root.value)
  ) {
    event.preventDefault();
    first.focus();
  }
}
/** 输出通道名称及其操作用途 */
function channelLabel(index: number, action: "solo" | "mute"): string {
  return `${index === 0 ? t("scene.lfe") : t("scene.object", { n: index })} · ${t(`scene.${action}`)}`;
}

onMounted(() => {
  const previousFocus = document.activeElement as HTMLElement | null;
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  const abort = new AbortController();
  renderer = new SceneInteraction(
    canvas.value!,
    spatial.controls,
    spatial.view,
    (key, values) => t(key, values ?? {}),
    spatial.update,
    close,
    root.value!,
  );
  loop = createSceneLoop({
    api: window.api.player,
    controls: () => {
      const { yaw, pitch, roll, x, y, z, focus, height, gains } = spatial.controls;
      return { yaw, pitch, roll, x, y, z, focus, height, gains: gains!.slice() };
    },
    revision: () => spatial.revision,
    readable: () => status.jocActive && settings.system.player.joc.mode === "binaural",
    error: (reason) => {
      error.value = true;
      console.error("[spatial]", reason);
    },
    tick: (dt, scene) => {
      renderer.frameDt = dt;
      renderer.animate(dt);
      renderer.ingest(scene, dt);
      renderer.draw();
      levels.value = [renderer.lfe, ...renderer.objects.map((object) => object.level)];
    },
  });
  /** 按显示区域与实际 DPR 重建画布缓存 */
  const fit = (): void => renderer.fit(bottom.value!.offsetHeight);
  const resize = new ResizeObserver(fit);
  resize.observe(canvas.value!);
  resize.observe(bottom.value!);
  /** 隐藏或失焦时停掉所有动画和轮询 */
  const pause = (): void => {
    loop.stop();
    renderer.suspend();
  };
  /** 回到可见窗口时恢复，避免后台继续转头或漫步 */
  const resume = (): void => {
    if (!document.hidden) {
      fit();
      loop.start();
    }
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()), {
    signal: abort.signal,
  });
  window.addEventListener("blur", pause, { signal: abort.signal });
  window.addEventListener("focus", resume, { signal: abort.signal });
  window.addEventListener("resize", fit, { signal: abort.signal });
  const stopTrack = watch(
    () => status.currentSource,
    () => {
      loop.reset();
      error.value = false;
      renderer.lastScene = null;
      renderer.objects.forEach((object) => {
        object.pos = null;
        object.target = null;
        object.trail = [];
        object.level = 0;
      });
    },
  );
  root.value!.focus();
  resume();
  onBeforeUnmount(() => {
    const { yaw, pitch, roll, x, y, z, focus, height, gains } = spatial.controls;
    void window.api.player
      .setJocControls({ yaw, pitch, roll, x, y, z, focus, height, gains: gains!.slice() })
      .then((result) => {
        if (!result.success) throw new Error(result.error);
      })
      .catch((reason) => console.error("[spatial]", reason));
    loop.stop();
    renderer.dispose();
    resize.disconnect();
    abort.abort();
    stopTrack();
    document.body.style.overflow = previousOverflow;
    previousFocus?.focus();
  });
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="joc-scene"
      :style="{ zIndex }"
      :class="{ 'is-locked': spatial.view.locked, 'is-look': spatial.view.look }"
      role="dialog"
      aria-modal="true"
      :aria-label="t('scene.title')"
      tabindex="-1"
      @keydown.tab="trapFocus"
    >
      <canvas
        ref="canvas"
        class="joc-scene-canvas"
        role="img"
        :aria-label="t('scene.hint')"
        tabindex="0"
      />
      <header class="joc-scene-top">
        <h2 class="joc-scene-title">{{ t("scene.title") }}</h2>
        <span class="joc-scene-status">HRTF {{ settings.system.player.joc.hrtf }}</span>
        <button class="joc-scene-close" type="button" :aria-label="t('scene.close')" @click="close">
          ×
        </button>
        <label class="joc-scene-mode">
          <span>{{ t("settings.jocMode.label") }}</span>
          <select :value="settings.system.player.joc.mode" @change="onModeChange">
            <option value="off">{{ t("settings.jocMode.off") }}</option>
            <option value="speaker">{{ t("settings.jocMode.speaker") }}</option>
            <option value="binaural">{{ t("settings.jocMode.binaural") }}</option>
          </select>
        </label>
      </header>
      <p v-if="unavailableMessage" class="joc-scene-message" role="status">
        {{ unavailableMessage }}
      </p>
      <footer ref="bottom" class="joc-scene-bottom">
        <div class="joc-scene-mixer" role="group" :aria-label="t('scene.mixer')">
          <div
            v-for="(_, index) in levels"
            :key="index"
            class="joc-scene-chip"
            :class="{ 'is-silent': spatial.controls.gains![index] === 0 }"
            :style="{ '--chip-hue': hue(index) }"
            @pointerenter="renderer.hover = index - 1"
            @pointerleave="renderer.hover = -1"
          >
            <span class="joc-scene-meter">
              <span
                class="joc-scene-meter-fill"
                :style="{ transform: `scaleY(${levels[index]})` }"
              />
            </span>
            <span class="joc-scene-chip-name">{{ index === 0 ? t("scene.lfe") : index }}</span>
            <button
              type="button"
              class="joc-scene-chip-solo"
              :aria-label="channelLabel(index, 'solo')"
              :aria-pressed="spatial.controls.solo.includes(index)"
              @click="renderer.toggle('solo', index)"
            >
              S
            </button>
            <button
              type="button"
              class="joc-scene-chip-mute"
              :aria-label="channelLabel(index, 'mute')"
              :aria-pressed="spatial.controls.mute.includes(index)"
              @click="renderer.toggle('mute', index)"
            >
              M
            </button>
          </div>
        </div>
        <div class="joc-scene-controls">
          <div class="joc-scene-segment" role="radiogroup" :aria-label="t('scene.view')">
            <button
              v-for="view in ['orbit', 'first'] as const"
              :key="view"
              class="joc-scene-segment-option"
              role="radio"
              :aria-checked="spatial.view.view === view"
              @click="renderer.setView(view)"
            >
              {{ t(view === "orbit" ? "scene.viewOrbit" : "scene.viewFirst") }}
            </button>
          </div>
          <button
            class="joc-scene-toggle"
            :aria-pressed="spatial.view.tour"
            :title="t('scene.tourTip')"
            @click="spatial.view.tour = !spatial.view.tour"
          >
            {{ t("scene.tour") }}
          </button>
          <button
            class="joc-scene-toggle"
            :aria-pressed="spatial.view.walk"
            :title="t('scene.walkTip')"
            @click="spatial.view.walk = !spatial.view.walk"
          >
            {{ t("scene.walk") }}
          </button>
          <button
            class="joc-scene-toggle"
            :aria-pressed="spatial.view.look"
            :title="t('scene.lookTip')"
            @click="renderer.toggleLook()"
          >
            {{ t("scene.look") }}
          </button>
          <button
            class="joc-scene-toggle"
            :aria-pressed="spatial.view.stickOn"
            :title="t('scene.stickTip')"
            @click="toggleStick"
          >
            {{ t("scene.stick") }}
          </button>
          <label class="joc-scene-slider" :title="t('scene.focusTip')">
            {{ t("scene.focus") }}
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="spatial.controls.focus"
              @input="spatial.update({ focus: Number(($event.target as HTMLInputElement).value) })"
            />
            <span class="joc-scene-slider-value">
              {{ Math.round(spatial.controls.focus * 100) }}%
            </span>
          </label>
          <label class="joc-scene-slider" :title="t('scene.heightTip')">
            {{ t("scene.height") }}
            <input
              type="range"
              min="1"
              max="3"
              step="0.1"
              :value="spatial.controls.height"
              @input="spatial.update({ height: Number(($event.target as HTMLInputElement).value) })"
            />
            <span class="joc-scene-slider-value">×{{ spatial.controls.height.toFixed(1) }}</span>
          </label>
          <button class="joc-scene-action" @click="renderer.resetPose()">
            {{ t("scene.reset") }}
          </button>
          <button class="joc-scene-action" @click="spatial.update({ solo: [], mute: [] })">
            {{ t("scene.restore") }}
          </button>
          <span class="joc-scene-readout">{{ readout }}</span>
        </div>
        <p class="joc-scene-hint">
          {{ t("scene.hint") }}
          <span class="joc-scene-notice">{{ t("scene.notice") }}</span>
        </p>
      </footer>
    </div>
  </Teleport>
</template>
