import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MotionCoverAmbient from "./MotionCoverAmbient.vue";

const createVideo = () => {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", {
    value: HTMLMediaElement.HAVE_CURRENT_DATA,
    configurable: true,
  });
  const frames = new Map<number, VideoFrameRequestCallback>();
  let nextId = 0;
  video.requestVideoFrameCallback = (callback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  };
  video.cancelVideoFrameCallback = (id) => {
    frames.delete(id);
  };
  return { video, frames };
};

const capturePaints = () => {
  const paints: { video: HTMLVideoElement; time: number }[] = [];
  const context = {
    drawImage: (video: HTMLVideoElement) => {
      paints.push({ video, time: video.currentTime });
    },
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return paints;
};

const MediaElement = HTMLMediaElement;
beforeEach(() => {
  // happy-dom 未实现媒体常量，补齐浏览器真实的 HAVE_CURRENT_DATA 值。
  vi.stubGlobal(
    "HTMLMediaElement",
    class extends MediaElement {
      static readonly HAVE_CURRENT_DATA = 2;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("动态封面实时光晕", () => {
  it("暂停首帧也可显示，后续使用前景视频的新帧而不是静态封面", async () => {
    const source = createVideo();
    Object.defineProperty(source.video, "readyState", { value: 0 });
    const paints = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, active: false },
    });
    try {
      await nextTick();
      expect(paints).toHaveLength(0);
      Object.defineProperty(source.video, "readyState", {
        value: HTMLMediaElement.HAVE_CURRENT_DATA,
      });
      const [firstId, firstFrame] = [...source.frames.entries()][0];
      source.frames.delete(firstId);
      firstFrame(performance.now(), {} as VideoFrameCallbackMetadata);
      expect(paints.at(-1)).toEqual({ video: source.video, time: 0 });
      expect(source.frames.size).toBe(0);

      await wrapper.setProps({ active: true });
      source.video.currentTime = 1;
      const [id, callback] = [...source.frames.entries()][0];
      source.frames.delete(id);
      callback(performance.now() + 1000, {} as VideoFrameCallbackMetadata);
      expect(paints.at(-1)).toEqual({ video: source.video, time: 1 });
    } finally {
      wrapper.unmount();
    }
  });

  it("暂停、切换视频和卸载后取消旧视频的帧回调", async () => {
    const first = createVideo();
    const second = createVideo();
    second.video.currentTime = 3;
    const paints = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: first.video, active: true },
    });
    try {
      await nextTick();
      expect(first.frames.size).toBe(1);
      await wrapper.setProps({ active: false });
      expect(first.frames.size).toBe(0);
      await wrapper.setProps({ active: true });
      expect(first.frames.size).toBe(1);
      await wrapper.setProps({ video: second.video });
      expect(first.frames.size).toBe(0);
      expect(paints.at(-1)).toEqual({ video: second.video, time: 3 });
      expect(second.frames.size).toBe(1);
    } finally {
      wrapper.unmount();
    }
    expect(second.frames.size).toBe(0);
  });
});
