<script setup lang="ts">
const props = defineProps<{ video?: HTMLVideoElement; active: boolean }>();
const canvasRef = ref<HTMLCanvasElement>();

// 光晕只需低分辨率色彩，每秒至多更新 15 次；共用前景视频，不另开解码器。
const FRAME_INTERVAL_MS = 1000 / 15;

watch(
  [() => props.video, canvasRef, () => props.active],
  ([video, canvas, active], previous, onCleanup) => {
    if (!video || !canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    let frameId: number | undefined;
    let lastPaintAt = -Infinity;
    const paint: VideoFrameRequestCallback = (now) => {
      frameId = undefined;
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        (!active || now - lastPaintAt >= FRAME_INTERVAL_MS)
      ) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        lastPaintAt = now;
      }
      if (active) frameId = video.requestVideoFrameCallback(paint);
    };

    // 暂停时也保留当前真实视频帧；恢复、切歌和卸载均由本次监听清理。
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      lastPaintAt = performance.now();
    }
    // loadeddata 可能早于首帧提交；首次挂载即使暂停也等一次真实呈现帧。
    if (active || previous[0] !== video || previous[1] !== canvas) {
      frameId = video.requestVideoFrameCallback(paint);
    }
    onCleanup(() => {
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
    });
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <canvas ref="canvasRef" width="96" height="96" aria-hidden="true" />
</template>
