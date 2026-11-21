<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import { useFullPlayer } from "../../context";

const status = useStatusStore();
const media = useMediaStore();
const { immersive } = useFullPlayer();

const hasLyric = computed(() => media.parsedLyric.length > 0 || media.lyricLoading);

/** 全屏封面没有隐藏歌词的入口，歌词列仅让位给播放队列 */
const lyricVisible = computed(() => hasLyric.value && !status.fullQueueOpen);
</script>

<template>
  <!-- 封面压在频谱与遮罩之下 -->
  <div class="full-cover-stage absolute inset-0 -z-1 pointer-events-none">
    <PlayerCover class="full-cover size-full" motion-variant="tall" ambient />
  </div>
  <!-- 顶/底栏渐变遮罩 -->
  <div
    data-player-layout="mask-top"
    class="cover-mask-top absolute top-0 inset-x-0 h-14 z-5 pointer-events-none transition-opacity duration-400"
    :class="immersive ? 'opacity-0' : 'opacity-100'"
  />
  <div
    data-player-layout="mask-bottom"
    class="cover-mask-bottom absolute bottom-0 inset-x-0 h-20 z-5 pointer-events-none transition-opacity duration-400"
    :class="immersive ? 'opacity-0' : 'opacity-100'"
  />
  <PlayerTopBar />
  <div class="full-cover-content absolute top-14 inset-x-0 bottom-20">
    <!-- 右侧信息与歌词 -->
    <div
      class="full-cover-column group absolute inset-y-0 left-[48%] right-0 pl-8 pr-20 flex flex-col transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
      :class="status.fullQueueOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'"
    >
      <PlayerLyric :visible="lyricVisible">
        <template #header>
          <div class="shrink-0 pt-2 pb-6 pl-[calc(1em-0.5rem)]">
            <PlayerData align="left" simple />
          </div>
        </template>
      </PlayerLyric>
      <LyricActions />
    </div>
    <!-- 播放队列 -->
    <div
      class="full-cover-column absolute inset-y-0 left-[48%] right-0 pl-4 py-6 flex items-center"
      :class="status.fullQueueOpen ? '' : 'pointer-events-none'"
    >
      <Transition
        enter-active-class="transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
        leave-to-class="opacity-0"
      >
        <div v-if="status.fullQueueOpen" class="w-full h-full">
          <QueuePanel @close="status.fullQueueOpen = false" />
        </div>
      </Transition>
    </div>
  </div>
  <PlayerBottomBar />
</template>

<style scoped>
/* 贴近窗口边缘展示完整画幅，只有背景光晕向整屏扩散。 */
.full-cover {
  container-type: size;
  --cover-padding: clamp(4px, 0.65vmin, 10px);
  --cover-width: max(0px, calc(48cqw - 2 * var(--cover-padding)));
  --cover-height: max(0px, calc(100cqh - 2 * var(--cover-padding)));
}

.full-cover :deep(.motion-cover-ambient) {
  position: absolute;
  inset: -4%;
  z-index: 0;
  width: 108%;
  height: 108%;
  opacity: 0.7;
  filter: blur(clamp(28px, 4vw, 64px)) saturate(1.15) brightness(0.8);
  mask-image: linear-gradient(to right, black 40%, rgba(0, 0, 0, 0.65) 100%);
}

.full-cover :deep(.player-cover-still),
.full-cover :deep(video[data-motion-variant]) {
  --cover-ratio: 1;
  inset: var(--cover-padding) auto var(--cover-padding) var(--cover-padding);
  width: min(var(--cover-width), calc(var(--cover-height) * var(--cover-ratio)));
  height: min(var(--cover-height), calc(var(--cover-width) / var(--cover-ratio)));
  margin-block: auto;
  object-fit: contain;
  mask-image:
    linear-gradient(to right, transparent, black 4px, black calc(100% - 12px), transparent),
    linear-gradient(to bottom, transparent, black 4px, black calc(100% - 4px), transparent);
  mask-composite: intersect;
}

.full-cover :deep(.player-cover-still) {
  z-index: 1;
}

.full-cover :deep(.player-cover-still img) {
  object-fit: contain;
}

.full-cover[data-motion-ready] :deep(.player-cover-still) {
  visibility: hidden;
}

.full-cover :deep(video[data-motion-variant="tall"]) {
  --cover-ratio: 0.75;
  --cover-width: max(0px, calc(54cqw - 2 * var(--cover-padding)));
}

.full-cover-stage:has([data-motion-ready] video[data-motion-variant="tall"])
  ~ .full-cover-content
  .full-cover-column {
  left: min(54%, calc(75vh + 1rem));
}

/* 多段非线性 alpha，避免暗色渐变出色阶 */
.cover-mask-top {
  background-image: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.5) 0%,
    rgba(0, 0, 0, 0.44) 12%,
    rgba(0, 0, 0, 0.36) 25%,
    rgba(0, 0, 0, 0.27) 40%,
    rgba(0, 0, 0, 0.18) 55%,
    rgba(0, 0, 0, 0.1) 70%,
    rgba(0, 0, 0, 0.04) 85%,
    rgba(0, 0, 0, 0) 100%
  );
}

.cover-mask-bottom {
  background-image: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.5) 0%,
    rgba(0, 0, 0, 0.44) 12%,
    rgba(0, 0, 0, 0.36) 25%,
    rgba(0, 0, 0, 0.27) 40%,
    rgba(0, 0, 0, 0.18) 55%,
    rgba(0, 0, 0, 0.1) 70%,
    rgba(0, 0, 0, 0.04) 85%,
    rgba(0, 0, 0, 0) 100%
  );
}
</style>
