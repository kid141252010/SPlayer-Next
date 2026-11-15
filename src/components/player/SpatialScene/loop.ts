import { FRAME_INTERVAL, parseScene } from "./math";
import type { SceneData } from "./math";
import type { PlayerApi } from "@shared/types/player";

/** 可见场景唯一的动画和原生轮询入口，每种 IPC 最多一个请求在途 */
export function createSceneLoop(options: {
  api: Pick<PlayerApi, "getJocScene" | "setJocControls">;
  tick: (dt: number, scene: SceneData | null) => void;
  controls: () => Parameters<PlayerApi["setJocControls"]>[0];
  revision: () => number;
  readable: () => boolean;
  error: (error: unknown) => void;
}) {
  let running = false,
    frame = 0,
    generation = 0,
    last = 0,
    next = 0;
  let reading = false,
    writing = false,
    failed = false,
    sent = -1;
  let scene: SceneData | null = null;
  /** 合并控件更新，慢 IPC 不积压请求 */
  function flush(): void {
    if (writing || sent === options.revision()) return;
    writing = true;
    const revision = options.revision();
    sent = revision;
    void options.api
      .setJocControls(options.controls())
      .then((result) => {
        if (!result.success) throw new Error(result.error);
      })
      .catch(options.error)
      .finally(() => {
        writing = false;
      });
  }
  /** 根据单调时钟节流绘制和非重叠读取，忽略隐藏前的异步结果 */
  function tick(time: number): void {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    if (time + 2 < next) return;
    next = Math.max(next, time - FRAME_INTERVAL) + FRAME_INTERVAL;
    const dt = Math.min(0.1, Math.max(0, (time - last) / 1000));
    last = time;
    if (!options.readable()) scene = null;
    if (!reading && !failed && options.readable()) {
      reading = true;
      const token = generation;
      void options.api
        .getJocScene()
        .then((result) => {
          if (!running || token !== generation) return;
          if (!result.success) throw new Error(result.error);
          scene = parseScene(result.data ?? null);
        })
        .catch((error) => {
          if (running && token === generation) {
            failed = true;
            options.error(error);
          }
        })
        .finally(() => {
          reading = false;
        });
    }
    options.tick(dt, scene);
    flush();
  }
  /** 显示或重新获得可见性后启动，不补算后台时间 */
  function start(): void {
    if (running) return;
    running = true;
    failed = false;
    last = performance.now();
    next = 0;
    frame = requestAnimationFrame(tick);
  }
  /** 立即停止绘制、原生轮询和控件发送，并使旧响应失效 */
  function stop(): void {
    running = false;
    generation++;
    cancelAnimationFrame(frame);
  }
  /** 换曲清理旧场景并允许新音源重新读取 */
  function reset(): void {
    scene = null;
    generation++;
    failed = false;
  }
  return { start, stop, reset };
}
