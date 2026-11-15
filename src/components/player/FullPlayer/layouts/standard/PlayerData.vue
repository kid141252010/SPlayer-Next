<script setup lang="ts">
import type { SSelectOption } from "@/components/ui/SSelect.vue";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { getQualityLabel, getQualityLevel, isDolbyAtmosQuality } from "@/utils/quality";
import { canNavigateToResource, type ResourceNavigationTarget } from "@/utils/navigate";
import { getValidArtists } from "@shared/utils/track";
import { usePlayerResources } from "@/components/player/usePlayerResources";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** 对齐方式 */
    align?: "center" | "left" | "right";
    /** 简单模式 */
    simple?: boolean;
  }>(),
  {
    align: "center",
    simple: false,
  },
);

const media = useMediaStore();
const status = useStatusStore();
const settings = useSettingsStore();

/** 加载中的歌曲 */
const displayTrack = computed(() => media.track ?? status.currentTrack);
const artists = computed(() => getValidArtists(displayTrack.value?.artists));

/** 歌词来源偏好下拉选项 */
const lyricSourceOptions = computed<SSelectOption[]>(() => [
  { value: "auto", label: t("settings.lyricSourcePreference.auto") },
  { value: "qqmusic", label: t("settings.lyricSourcePreference.qqmusic") },
  { value: "kugou", label: t("settings.lyricSourcePreference.kugou") },
  { value: "netease", label: t("settings.lyricSourcePreference.netease") },
  { value: "self", label: t("settings.lyricSourcePreference.self") },
]);

/** 当前歌曲是否手动选择过歌词，此时来源偏好不生效 */
const manualPicked = ref(false);

// 歌词每次重新加载（切歌、应用或恢复手动选择）都会变，借此刷新
watch(
  () => media.activeLyric,
  async () => {
    const track = media.track;
    const picked = track ? Boolean(await window.api.lyrics.getManualMatch(toRaw(track))) : false;
    if (track === media.track) manualPicked.value = picked;
  },
  { immediate: true },
);

const { artistTarget, albumTarget, isArtistLinkable, isAlbumLinkable, goToResource } =
  usePlayerResources(displayTrack, true);

/** 来源标签 */
const sourceLabel = computed(() => {
  if (displayTrack.value?.cloud) return "CLOUD";
  const source = displayTrack.value?.source;
  if (!source) return "LOCAL";
  if (source === "local") return "LOCAL";
  if (source === "streaming") return "STREAMING";
  return source.toUpperCase();
});

/** 音质等级标签 */
const quality = computed(() => media.detail?.quality ?? displayTrack.value?.quality);
const qualityLabel = computed(() => getQualityLabel(quality.value));

/** 是否为杜比全景声 */
const isDolbyAtmos = computed(() => isDolbyAtmosQuality(quality.value));
const dolbyAtmosTitle = computed(() => "Dolby Atmos");

/** 是否为无损级别（显示图标） */
const showLosslessIcon = computed(() => {
  const level = getQualityLevel(quality.value);
  return level === "hi-res" || level === "lossless";
});

/** 歌词格式标签 */
const lyricLabel = computed(() => media.activeLyric?.format.toUpperCase() ?? "NO-LRC");

/** 专辑文本 */
const albumText = computed(() => displayTrack.value?.album?.name ?? "");

/** 当前实际加载歌曲的播放来源 */
const playbackSource = computed(() => media.playbackContext);
const playbackSourceTarget = computed<ResourceNavigationTarget | null>(() => {
  const context = playbackSource.value;
  const name = context?.originName?.trim();
  if (!context || !name || context.originType === "track") return null;
  if (context.originType === "page") {
    return { type: "page", id: context.originId, name };
  }
  if (!context.provider) return null;
  return {
    type: context.originType,
    source: context.provider,
    serverId: displayTrack.value?.serverId,
    id: context.originId,
    name,
  };
});
const playbackSourceText = computed(() => playbackSourceTarget.value?.name ?? "");
const isPlaybackSourceLinkable = computed(() =>
  playbackSourceTarget.value ? canNavigateToResource(playbackSourceTarget.value) : false,
);

const alignItems = computed(() => {
  if (props.align === "left") return "items-start";
  if (props.align === "right") return "items-end";
  return "items-center";
});
</script>

<template>
  <div
    v-if="displayTrack"
    class="w-full flex flex-col gap-[0.5em] overflow-hidden px-2"
    style="font-size: clamp(12px, calc(14 / 1080 * 100vh), 16px)"
    :class="alignItems"
  >
    <!-- 标题 -->
    <SMarquee fit class="max-w-full text-[2em] font-semibold leading-tight">
      {{ displayTrack.title }}
    </SMarquee>
    <!-- 副标题/注释 -->
    <div
      v-if="!simple && displayTrack.comment"
      class="max-w-full text-[1.4em] text-cover/40 truncate"
    >
      {{ displayTrack.comment }}
    </div>
    <!-- 元信息标签行 -->
    <div class="flex items-center gap-1.5 text-[1em] my-1 text-cover/60">
      <span
        class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30"
      >
        {{ sourceLabel }}
      </span>
      <span
        v-if="displayTrack.contentRating === 'explicit' || displayTrack.explicit"
        class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30"
        title="Explicit"
      >
        EXPLICIT
      </span>
      <span
        v-else-if="displayTrack.contentRating === 'clean'"
        class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30"
        title="Clean"
      >
        CLEAN
      </span>
      <span
        class="inline-flex items-center gap-1 leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30 cursor-pointer transition-colors hover:border-cover/60"
        @click="status.audioInfoOpen = true"
      >
        <IconSpLossless v-if="showLosslessIcon" class="text-[1.4em] -my-[0.4em]" />
        {{ qualityLabel }}
      </span>
      <span
        v-if="isDolbyAtmos"
        class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/40 font-semibold tracking-wide text-cover/90 cursor-pointer transition-colors hover:border-cover/70"
        :title="dolbyAtmosTitle"
        @click="status.audioInfoOpen = true"
      >
        DOLBY ATMOS
      </span>
      <STooltip
        v-if="manualPicked"
        :content="t('player.lyricMatch.preferenceIgnored')"
        :side-offset="8"
        side="top"
        cover
      >
        <span
          class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30"
        >
          {{ lyricLabel }}
        </span>
      </STooltip>
      <SPopselect
        v-else
        v-model="settings.lyric.lyricSourcePreference"
        :options="lyricSourceOptions"
        side="top"
        :side-offset="8"
        cover
      >
        <template #trigger>
          <span
            class="inline-flex items-center justify-center leading-none px-1.5 py-1.2 rounded-md border border-solid border-cover/30 cursor-pointer transition-colors hover:border-cover/60"
          >
            {{ lyricLabel }}
          </span>
        </template>
      </SPopselect>
    </div>
    <!-- 歌手 -->
    <div class="max-w-full flex items-center gap-1.5 text-[1.2em] text-cover/60">
      <IconLucideMic class="shrink-0 translate-y-px text-cover/40" />
      <span class="truncate">
        <template v-if="artists.length">
          <template v-for="(artist, index) in artists" :key="artist.id ?? index">
            <span
              :class="
                isArtistLinkable(artist) ? 'cursor-pointer transition-colors hover:text-cover' : ''
              "
              @click="goToResource(artistTarget(artist))"
            >
              {{ artist.name }}
            </span>
            <span v-if="index < artists.length - 1" class="mx-0.5 opacity-50">/</span>
          </template>
        </template>
        <span v-else class="opacity-50">{{ t("playlist.unknownArtist") }}</span>
      </span>
    </div>
    <!-- 专辑 -->
    <div v-if="albumText" class="max-w-full flex items-center gap-1.5 text-[1.2em] text-cover/60">
      <IconLucideDisc3 class="shrink-0 translate-y-px text-cover/40" />
      <span
        class="truncate"
        :class="isAlbumLinkable ? 'cursor-pointer transition-colors hover:text-cover' : ''"
        @click="goToResource(albumTarget)"
      >
        {{ albumText }}
      </span>
    </div>
    <!-- 播放来源 -->
    <div
      v-if="!simple && settings.player.showPlaybackSource && playbackSourceText"
      class="max-w-full flex items-center gap-1.5 text-[1.2em] text-cover/60"
    >
      <IconLucideLink2 class="shrink-0 translate-y-px text-cover/40" />
      <span
        class="truncate"
        :class="isPlaybackSourceLinkable ? 'cursor-pointer transition-colors hover:text-cover' : ''"
        @click="goToResource(playbackSourceTarget)"
      >
        {{ playbackSourceText }}
      </span>
    </div>
  </div>
</template>
