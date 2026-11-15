<script setup lang="ts">
import type { SSelectOption } from "@/components/ui/SSelect.vue";
import type { QualityLevel } from "@/utils/quality";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
import { useStatusStore } from "@/stores/status";
import type { JocMode } from "@shared/types/joc";
import { getQualityLabel, isDolbyAtmosQuality } from "@/utils/quality";
import * as player from "@/core/player";
import { isPlatform } from "@shared/types/platform";

withDefaults(defineProps<{ cover?: boolean }>(), { cover: false });

const { t } = useI18n();
const media = useMediaStore();
const settings = useSettingsStore();
const status = useStatusStore();

/** 是否支持切换在线音质 */
const canSwitchQuality = computed(() => isPlatform(media.track?.source) && !media.track?.cloud);

/** 实际播放音质；详情加载前使用歌曲自身的音质信息。 */
const quality = computed(() => media.detail?.quality ?? media.track?.quality);
const qualityLabel = computed(() => getQualityLabel(quality.value));

/** 是否为杜比全景声 */
const isDolbyAtmos = computed(() => isDolbyAtmosQuality(quality.value));
const displayQualityLabel = computed(() => {
  if (isDolbyAtmos.value && status.jocActive && settings.system.player.joc.mode !== "off") {
    return t(
      settings.system.player.joc.mode === "binaural"
        ? "settings.jocMode.activeBinaural"
        : "settings.jocMode.activeSpeaker",
    );
  }
  if (isDolbyAtmos.value) return "Atmos";
  return qualityLabel.value;
});
const dolbyAtmosTooltip = computed(() => {
  if (!isDolbyAtmos.value) return t("settings.songLevel.unsupportedHint");
  return "杜比全景声 (Dolby Atmos)";
});

/** 音质偏好下拉选项 */
const qualityOptions = computed<SSelectOption[]>(() => [
  { value: "lq", label: t("settings.songLevel.lq") },
  { value: "sq", label: t("settings.songLevel.sq") },
  { value: "hq", label: t("settings.songLevel.hq") },
  { value: "lossless", label: t("settings.songLevel.lossless") },
  { value: "hi-res", label: t("settings.songLevel.hi-res") },
]);

/** 对象渲染模式与设置页使用同一份持久化配置 */
const jocOptions = computed<SSelectOption[]>(() => [
  { value: "off", label: t("settings.jocMode.off") },
  { value: "speaker", label: t("settings.jocMode.speaker") },
  { value: "binaural", label: t("settings.jocMode.binaural") },
]);

/**
 * 写入对象渲染模式，由主进程配置链路更新原生引擎
 * @param mode - 选中的对象渲染模式
 * @returns 配置写入完成
 */
const onJocModeChange = async (mode: string | number | boolean): Promise<void> => {
  await settings.setSystem("player.joc.mode", mode as JocMode);
};

const chipBase =
  "inline-flex min-w-9 shrink-0 items-center justify-center px-2 py-1 leading-none rounded-md border border-solid text-xs";

/** 切换音质 */
const onQualityChange = (value: string | number | boolean): void => {
  settings.player.songLevel = value as QualityLevel;
  void player.reloadCurrentTrack();
};
</script>

<template>
  <SPopover
    v-if="isDolbyAtmos && media.track"
    side="top"
    :side-offset="8"
    :cover="cover"
    content-class="w-72 p-3"
  >
    <template #trigger>
      <button
        type="button"
        :class="[
          chipBase,
          'cursor-pointer',
          cover
            ? 'border-cover/30 text-cover/80'
            : 'border-on-surface-variant/30 text-on-surface-variant',
        ]"
      >
        {{ displayQualityLabel }}
      </button>
    </template>
    <div class="space-y-3">
      <div class="text-sm font-medium">{{ t("settings.section.joc") }}</div>
      <p class="text-xs opacity-70">{{ t("settings.jocMode.description") }}</p>
      <SSelect
        :model-value="settings.system.player.joc.mode"
        :options="jocOptions"
        :aria-label="t('settings.jocMode.label')"
        @update:model-value="onJocModeChange"
      />
      <template v-if="canSwitchQuality">
        <div class="text-sm">{{ t("settings.songLevel.switchTitle") }}</div>
        <SSelect
          :model-value="settings.player.songLevel"
          :options="qualityOptions"
          @update:model-value="onQualityChange"
        />
      </template>
    </div>
  </SPopover>
  <SPopselect
    v-else-if="canSwitchQuality && media.track"
    :model-value="settings.player.songLevel"
    :options="qualityOptions"
    side="top"
    :side-offset="8"
    :cover="cover"
    @update:model-value="onQualityChange"
  >
    <template #header>
      <div
        :class="[
          'w-0 min-w-full px-2.5 pt-2 pb-1.5 text-xs leading-snug border-b border-b-solid',
          cover
            ? 'text-cover/55 border-b-white/10'
            : 'text-on-surface-variant/70 border-b-on-surface/8',
        ]"
      >
        <div class="mb-0.5 text-sm font-medium" :class="cover ? 'text-cover' : 'text-on-surface'">
          {{ t("settings.songLevel.switchTitle") }}
        </div>
        {{ t("settings.songLevel.switchHint") }}
      </div>
    </template>
    <template #trigger>
      <span
        :class="[
          chipBase,
          'cursor-pointer transition-colors',
          cover
            ? 'border-cover/30 text-cover/80 hover:border-cover/60'
            : 'border-on-surface-variant/30 text-on-surface-variant hover:border-on-surface-variant/60',
        ]"
      >
        {{ displayQualityLabel }}
      </span>
    </template>
  </SPopselect>
  <STooltip v-else-if="media.track" :content="dolbyAtmosTooltip" :side-offset="16" side="top">
    <span
      :class="[
        chipBase,
        cover
          ? 'border-cover/25 text-cover/55'
          : 'border-on-surface-variant/25 text-on-surface-variant/80',
      ]"
    >
      {{ displayQualityLabel }}
    </span>
  </STooltip>
</template>
