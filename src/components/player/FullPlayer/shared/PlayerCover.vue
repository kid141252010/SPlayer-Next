<script lang="ts">
const hdCache = shallowRef<{ id: string; data: string } | null>(null);
</script>

<script setup lang="ts">
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import type { MotionCoverVariant } from "@shared/types/player";

const props = defineProps<{ motionVariant?: MotionCoverVariant }>();
const media = useMediaStore();
const status = useStatusStore();
const settings = useSettingsStore();

/** 加载中的歌曲使用队列当前项作为封面兜底 */
const displayTrack = computed(() => media.track ?? status.currentTrack);

const coverSrc = computed(() =>
  displayTrack.value?.source === "local" && hdCache.value?.id === displayTrack.value.id
    ? hdCache.value.data
    : displayTrack.value?.coverOriginal || displayTrack.value?.cover,
);

watchEffect(async () => {
  const id = displayTrack.value?.id;
  if (!status.isPlayerExpanded || status.trackLoading || !id) return;
  if (displayTrack.value?.source !== "local" || hdCache.value?.id === id) return;
  const r = await window.api.player.getCoverRaw();
  if (
    displayTrack.value?.source !== "local" ||
    displayTrack.value.id !== id ||
    !r.success ||
    !r.data
  )
    return;
  hdCache.value = { id, data: r.data };
});

let layerId = 0;

const createLayer = () => ({
  id: ++layerId,
  src: coverSrc.value,
  fallback: displayTrack.value?.cover,
});

const layers = shallowRef([createLayer()]);

// 新图解码后才淡入，淡入结束前底层旧图保持不动，最多两层
watch([coverSrc, () => displayTrack.value?.cover], async () => {
  const layer = createLayer();
  const decodes = [layer.src, layer.fallback].filter(Boolean).map((src) => {
    const image = new Image();
    image.src = src!;
    return image.decode();
  });
  await Promise.any(decodes).catch(() => {});
  if (layer.id === layerId) layers.value = [layers.value[0], layer];
});

const motion = shallowRef<{
  key: string;
  src: string;
  variant: MotionCoverVariant;
  replay: boolean;
} | null>(null);
const motionReady = ref(false);
const videoRef = ref<HTMLVideoElement>();
const waitingReplay = ref(false);
const motionKey = computed(() => {
  const track = displayTrack.value;
  return `${settings.player.motionCoverSource}:${props.motionVariant ?? "square"}:${track?.source}:${track?.serverId ?? ""}:${track?.id}`;
});

watch(
  [motionKey, () => status.isPlayerExpanded && !status.trackLoading],
  async ([key, active], _previous, onCleanup) => {
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    if (motion.value && motion.value.key !== key) {
      motion.value = null;
      motionReady.value = false;
      waitingReplay.value = false;
    }
    const track = displayTrack.value;
    const source = settings.player.motionCoverSource;
    if (!active || source === "off" || !track?.id || motion.value) return;
    const result = await window.api.motionCover
      .resolve(toRaw(track), source, props.motionVariant ?? "square")
      .catch((error) => {
        console.warn("[PlayerCover] resolve motion cover failed:", error);
        return null;
      });
    if (!cancelled && result) {
      motion.value = {
        key,
        src: result.url,
        variant: result.variant,
        // AM 的缓存视频无缝循环；NCM 保留两秒静态封面后的再放送。
        replay: source === "ncm" || (source === "amFirst" && !result.url.startsWith("cache:")),
      };
    }
  },
  { immediate: true },
);

const visibility = useDocumentVisibility();
const { start: startReplay, stop: stopReplay } = useTimeoutFn(
  () => {
    if (!videoRef.value) return;
    videoRef.value.currentTime = 0;
    waitingReplay.value = false;
    motionReady.value = true;
  },
  2000,
  { immediate: false },
);

// 一处协调播放、隐藏暂停与再放送，收起/卸载时不会留第二套定时器。
watch(
  [videoRef, () => status.isPlaying, visibility, () => status.isPlayerExpanded, waitingReplay],
  ([video, playing, visible, expanded, waiting], [previousVideo]) => {
    if (previousVideo && previousVideo !== video) previousVideo.pause();
    stopReplay();
    if (!video) return;
    if (!playing || visible !== "visible" || !expanded || waiting) video.pause();
    else void video.play().catch(() => {});
    if (playing && visible === "visible" && expanded && waiting) startReplay();
  },
);

const onVideoEnded = (event: Event): void => {
  if (event.target !== videoRef.value || !motion.value?.replay) return;
  motionReady.value = false;
  waitingReplay.value = true;
};

/**
 * 移除后立即释放解码器与缓冲，不等 GC
 * @param el - 离场的视频元素
 */
const releaseVideo = (el: Element) => {
  const video = el as HTMLVideoElement;
  video.removeAttribute("src");
  video.load();
};

// 切换布局时组件直接卸载，不经过离场过渡
onBeforeUnmount(() => {
  stopReplay();
  if (videoRef.value) releaseVideo(videoRef.value);
});
</script>

<template>
  <!-- 外观由布局决定，这里只负责高清封面加载与共享过渡标记 -->
  <div data-player-cover="full" class="relative overflow-hidden shrink-0">
    <!-- 切歌交叉淡入 -->
    <TransitionGroup
      :css="!settings.reducedMotion"
      enter-active-class="transition-opacity duration-500 ease-linear"
      enter-from-class="opacity-0"
      @after-enter="layers = layers.slice(-1)"
    >
      <DetailCover
        v-for="layer in layers"
        :key="layer.id"
        :src="layer.src"
        :fallback="layer.fallback"
        class="absolute! inset-0 size-full"
      />
    </TransitionGroup>
    <!-- 动态封面 -->
    <Transition
      leave-active-class="transition-opacity duration-500"
      leave-to-class="opacity-0"
      @after-leave="releaseVideo"
    >
      <video
        v-if="motion && status.isPlayerExpanded"
        ref="videoRef"
        :key="motion.src"
        :src="motion.src"
        muted
        :loop="!motion.replay"
        playsinline
        class="absolute inset-0 z-2 size-full transition-opacity duration-500"
        :class="[
          motion?.variant === 'tall' ? 'object-contain' : 'object-cover',
          motionReady ? 'opacity-100' : 'opacity-0',
        ]"
        @loadeddata="$event.target === videoRef && (motionReady = true)"
        @ended="onVideoEnded"
      />
    </Transition>
  </div>
</template>
