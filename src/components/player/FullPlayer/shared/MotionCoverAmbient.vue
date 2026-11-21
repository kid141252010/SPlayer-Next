<script setup lang="ts">
import {
  createMotionCoverEdgeProjection,
  MOTION_COVER_EDGE_OVERSCAN,
  MOTION_COVER_NEAR_RADIUS,
  type MotionCoverEdgeProjection,
} from "./motionCoverEdgeProjection";

const props = defineProps<{
  video?: HTMLVideoElement;
  container?: HTMLElement;
  active: boolean;
}>();
const nearRef = ref<HTMLCanvasElement>();
const farRef = ref<HTMLCanvasElement>();
const ready = ref(false);
const projection = shallowRef<MotionCoverEdgeProjection | null>(null);
const containerTarget = computed(() => props.container);
const videoTarget = computed(() => props.video);

// 几何仅在布局或源尺寸变化时重建，帧回调只复用八格投射。
const FRAME_INTERVAL_MS = 1000 / 15;
let rebuildCurrentProjection: (() => void) | undefined;
let updatePlayback: (() => void) | undefined;
const rebuildProjection = () => rebuildCurrentProjection?.();

const nearStyle = computed(() => {
  const bounds = projection.value?.nearBounds;
  return bounds
    ? {
        maskSize: `${bounds.width}px ${bounds.height}px`,
        maskPosition: `${bounds.left}px ${bounds.top}px`,
      }
    : undefined;
});

watch(
  [videoTarget, containerTarget, nearRef, farRef],
  ([video, container, nearCanvas, farCanvas], _previous, onCleanup) => {
    ready.value = false;
    projection.value = null;
    if (!video || !container || !nearCanvas || !farCanvas) return;

    let nearContext: CanvasRenderingContext2D | null = null;
    let farContext: CanvasRenderingContext2D | null = null;
    let frameId: number | undefined;
    let hasPresentedFrame = false;
    let lastPaintAt = -Infinity;

    const paintCurrentFrame = () => {
      const geometry = projection.value;
      if (
        !geometry ||
        !nearContext ||
        !farContext ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      nearContext.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
      for (const [sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY] of geometry.patches) {
        nearContext.save();
        nearContext.translate(dx + (flipX ? dw : 0), dy + (flipY ? dh : 0));
        nearContext.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        nearContext.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
        nearContext.restore();
      }
      farContext.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
      farContext.drawImage(nearCanvas, 0, 0);
      ready.value = true;
    };

    const rebuild = () => {
      const containerRect = container.getBoundingClientRect();
      const videoRect = video.getBoundingClientRect();
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const feather = Number.parseFloat(
        getComputedStyle(container).getPropertyValue("--cover-feather"),
      );
      let geometry: MotionCoverEdgeProjection | null = null;
      if (sourceWidth > 0 && sourceHeight > 0) {
        const scale = Math.min(videoRect.width / sourceWidth, videoRect.height / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        geometry = createMotionCoverEdgeProjection({
          sourceWidth,
          sourceHeight,
          viewportWidth: containerRect.width,
          viewportHeight: containerRect.height,
          content: {
            left: videoRect.left - containerRect.left + (videoRect.width - width) / 2,
            top: videoRect.top - containerRect.top + (videoRect.height - height) / 2,
            width,
            height,
          },
          feather: feather > 0 ? feather : 18,
        });
      }
      nearContext = nearCanvas.getContext("2d");
      farContext = farCanvas.getContext("2d");
      projection.value = geometry;
      if (!geometry || !nearContext || !farContext) {
        ready.value = false;
        return;
      }
      if (nearCanvas.width !== geometry.canvasWidth) nearCanvas.width = geometry.canvasWidth;
      if (nearCanvas.height !== geometry.canvasHeight) nearCanvas.height = geometry.canvasHeight;
      if (farCanvas.width !== geometry.canvasWidth) farCanvas.width = geometry.canvasWidth;
      if (farCanvas.height !== geometry.canvasHeight) farCanvas.height = geometry.canvasHeight;
      if (hasPresentedFrame) paintCurrentFrame();
    };

    const paint: VideoFrameRequestCallback = (now) => {
      frameId = undefined;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        hasPresentedFrame = true;
        if (!props.active || !ready.value || now - lastPaintAt >= FRAME_INTERVAL_MS) {
          paintCurrentFrame();
          lastPaintAt = now;
        }
      }
      if (props.active) frameId = video.requestVideoFrameCallback(paint);
    };
    const cancelFrame = () => {
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
      frameId = undefined;
    };
    const syncPlayback = () => {
      cancelFrame();
      // 冷启动即暂停仍等待一次真实呈现帧；暂停已有画面时只冻结，不清空。
      if (props.active || !hasPresentedFrame) frameId = video.requestVideoFrameCallback(paint);
    };
    const onEmptied = () => {
      hasPresentedFrame = false;
      lastPaintAt = -Infinity;
      projection.value = null;
      ready.value = false;
      syncPlayback();
    };

    rebuildCurrentProjection = rebuild;
    updatePlayback = syncPlayback;
    video.addEventListener("loadedmetadata", rebuild);
    video.addEventListener("resize", rebuild);
    video.addEventListener("emptied", onEmptied);
    rebuild();
    syncPlayback();
    onCleanup(() => {
      cancelFrame();
      video.removeEventListener("loadedmetadata", rebuild);
      video.removeEventListener("resize", rebuild);
      video.removeEventListener("emptied", onEmptied);
      rebuildCurrentProjection = undefined;
      updatePlayback = undefined;
    });
  },
  { immediate: true, flush: "post" },
);

useResizeObserver([containerTarget, videoTarget], rebuildProjection);
watch(
  () => props.active,
  () => updatePlayback?.(),
  { flush: "post" },
);
</script>

<template>
  <div
    class="motion-cover-ambient"
    aria-hidden="true"
    :data-motion-cover-ambient-ready="ready ? '' : undefined"
    :style="{
      inset: `${-MOTION_COVER_EDGE_OVERSCAN}px`,
      visibility: ready ? 'visible' : 'hidden',
      '--motion-cover-near-radius': `${MOTION_COVER_NEAR_RADIUS}px`,
    }"
  >
    <canvas ref="farRef" class="motion-cover-ambient-far" />
    <canvas ref="nearRef" class="motion-cover-ambient-near" :style="nearStyle" />
  </div>
</template>
