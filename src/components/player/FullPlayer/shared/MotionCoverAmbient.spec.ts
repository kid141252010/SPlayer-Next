import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import MotionCoverAmbient from "./MotionCoverAmbient.vue";

const rect = (left: number, top: number, width: number, height: number) =>
  DOMRect.fromRect({ x: left, y: top, width, height });

const createContainer = () => {
  const container = document.createElement("div");
  container.style.setProperty("--cover-feather", "18px");
  const measure = vi
    .spyOn(container, "getBoundingClientRect")
    .mockReturnValue(rect(70, 40, 800, 600));
  return { container, measure };
};

const createVideo = () => {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA, configurable: true },
    videoWidth: { value: 360, configurable: true },
    videoHeight: { value: 480, configurable: true },
  });
  const measure = vi
    .spyOn(video, "getBoundingClientRect")
    .mockReturnValue(rect(270, 140, 300, 400));
  const addListener = vi.spyOn(video, "addEventListener");
  const removeListener = vi.spyOn(video, "removeEventListener");
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
  const present = (now: number) => {
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames.entries()][0];
    frames.delete(id);
    callback(now, { mediaTime: video.currentTime } as VideoFrameCallbackMetadata);
  };
  return { video, frames, present, measure, addListener, removeListener };
};

interface CapturedContext {
  clearRect: Mock;
  save: Mock;
  translate: Mock;
  scale: Mock;
  drawImage: Mock;
  restore: Mock;
}

const createContext = () => ({
  clearRect: vi.fn(),
  save: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  drawImage: vi.fn(),
  restore: vi.fn(),
});

const capturePaints = () => {
  const contexts = new Map<HTMLCanvasElement, CapturedContext>();
  const unavailable = new Set<HTMLCanvasElement>();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      if (unavailable.has(this)) return null;
      if (!contexts.has(this)) contexts.set(this, createContext());
      return contexts.get(this) as unknown as CanvasRenderingContext2D;
    });
  return { contexts, unavailable, getContext };
};

class ManualResizeObserver {
  static instances: ManualResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe = (target: Element) => this.targets.add(target);
  unobserve = (target: Element) => this.targets.delete(target);
  disconnect = vi.fn(() => this.targets.clear());
  trigger = () => this.callback([], this as unknown as ResizeObserver);
}

const resize = () =>
  ManualResizeObserver.instances
    .filter((observer) => observer.targets.size)
    .forEach((observer) => observer.trigger());
const MediaElement = HTMLMediaElement;
beforeEach(() => {
  ManualResizeObserver.instances = [];
  // happy-dom 不提供真实媒体常量、布局和尺寸观察，显式补齐浏览器边界。
  vi.stubGlobal(
    "HTMLMediaElement",
    class extends MediaElement {
      static readonly HAVE_CURRENT_DATA = 2;
    },
  );
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("动态封面外围实时光晕", () => {
  it("初次暂停也等待真实呈现帧，双 canvas 共用外围画面且不会开启循环", async () => {
    const source = createVideo();
    const { container } = createContainer();
    const { contexts, getContext } = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, container, active: false },
    });
    try {
      await nextTick();
      const near = wrapper.get(".motion-cover-ambient-near").element as HTMLCanvasElement;
      const far = wrapper.get(".motion-cover-ambient-far").element as HTMLCanvasElement;
      const nearContext = contexts.get(near)!;
      const farContext = contexts.get(far)!;
      expect(nearContext.drawImage).not.toHaveBeenCalled();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      expect((wrapper.element as HTMLElement).style.visibility).toBe("hidden");
      expect([near.width, near.height, far.width, far.height]).toEqual([384, 313, 384, 313]);

      source.present(1000);
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
      expect(nearContext.clearRect).toHaveBeenCalledWith(0, 0, 384, 313);
      expect(nearContext.drawImage).toHaveBeenCalledTimes(8);
      expect(nearContext.drawImage.mock.calls.every(([video]) => video === source.video)).toBe(
        true,
      );
      expect(nearContext.drawImage.mock.calls[0].slice(1, 7)).toEqual([0, 0, 28.8, 38.4, 0, 0]);
      expect(nearContext.translate.mock.calls[0][0]).toBeCloseTo((362 * 384) / 1088);
      expect(nearContext.translate.mock.calls[0][1]).toBeCloseTo((262 * 313) / 888);
      expect(nearContext.scale.mock.calls).toEqual([
        [-1, -1],
        [1, -1],
        [-1, -1],
        [-1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
        [-1, -1],
      ]);
      expect(nearContext.save).toHaveBeenCalledTimes(8);
      expect(nearContext.restore).toHaveBeenCalledTimes(8);
      expect(farContext.clearRect).toHaveBeenCalledWith(0, 0, 384, 313);
      expect(farContext.drawImage).toHaveBeenCalledExactlyOnceWith(near, 0, 0);
      expect(
        getContext.mock.calls.every(([, options]) => !options || options.alpha !== false),
      ).toBe(true);
      expect(source.frames.size).toBe(0);
    } finally {
      wrapper.unmount();
    }
  });

  it("播放按 15Hz 上限取同一视频的新帧，帧回调内不测量布局", async () => {
    const source = createVideo();
    const { container, measure } = createContainer();
    const { contexts } = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, container, active: true },
    });
    try {
      await nextTick();
      const context = contexts.get(
        wrapper.get(".motion-cover-ambient-near").element as HTMLCanvasElement,
      )!;
      measure.mockClear();
      source.measure.mockClear();
      source.present(1000);
      source.video.currentTime = 1;
      source.present(1030);
      expect(context.drawImage).toHaveBeenCalledTimes(8);
      source.present(1070);
      expect(context.drawImage).toHaveBeenCalledTimes(16);
      expect(context.drawImage.mock.calls.every(([video]) => video === source.video)).toBe(true);
      expect(measure).not.toHaveBeenCalled();
      expect(source.measure).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });

  it("暂停冻结已呈现光晕，布局移动与尺寸恢复仍重投射且不重启循环", async () => {
    const source = createVideo();
    const { container, measure } = createContainer();
    const { contexts } = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, container, active: true },
    });
    try {
      await nextTick();
      const near = wrapper.get(".motion-cover-ambient-near").element as HTMLCanvasElement;
      const context = contexts.get(near)!;
      source.present(1000);
      await wrapper.setProps({ active: false });
      expect(source.frames.size).toBe(0);
      expect(context.drawImage).toHaveBeenCalledTimes(8);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");

      measure.mockReturnValue(rect(70, 40, 1200, 600));
      source.measure.mockReturnValue(rect(370, 140, 300, 400));
      resize();
      await nextTick();
      expect(context.drawImage).toHaveBeenCalledTimes(16);
      expect(context.translate.mock.calls[11][0]).toBeCloseTo((462 * 384) / 1488);
      expect(near.style.maskPosition).toBe("396px 196px");
      expect(source.frames.size).toBe(0);

      measure.mockReturnValue(rect(70, 40, 0, 600));
      resize();
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      measure.mockReturnValue(rect(70, 40, 1200, 600));
      resize();
      await nextTick();
      expect(context.drawImage).toHaveBeenCalledTimes(24);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
      expect(source.frames.size).toBe(0);
      await wrapper.setProps({ active: true });
      expect(source.frames.size).toBe(1);
    } finally {
      wrapper.unmount();
    }
  });

  it("方形 video 外框中的竖视频按 contain 的真实画幅定位并排除 letterbox", async () => {
    const source = createVideo();
    source.measure.mockReturnValue(rect(270, 140, 400, 400));
    const { container } = createContainer();
    container.style.removeProperty("--cover-feather");
    const { contexts } = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, container, active: false },
    });
    try {
      await nextTick();
      source.present(1000);
      await nextTick();
      const near = wrapper.get(".motion-cover-ambient-near").element as HTMLCanvasElement;
      const context = contexts.get(near)!;
      expect(near.style.maskPosition).toBe("346px 196px");
      expect(near.style.maskSize).toBe("396px 496px");
      expect(context.translate.mock.calls[3][0]).toBeCloseTo((412 * 384) / 1088);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
    } finally {
      wrapper.unmount();
    }
  });

  it("切源和 emptied 清除旧光晕，metadata 本身不能冒充新源的真实呈现帧", async () => {
    const first = createVideo();
    const second = createVideo();
    const { container } = createContainer();
    const { contexts } = capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: first.video, container, active: true },
    });
    try {
      await nextTick();
      first.present(1000);
      await wrapper.setProps({ video: second.video });
      const context = contexts.get(
        wrapper.get(".motion-cover-ambient-near").element as HTMLCanvasElement,
      )!;
      expect(first.frames.size).toBe(0);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      expect(context.drawImage).toHaveBeenCalledTimes(8);
      second.video.dispatchEvent(new Event("loadedmetadata"));
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      second.present(2000);
      await nextTick();
      expect(
        context.drawImage.mock.calls.slice(-8).every(([video]) => video === second.video),
      ).toBe(true);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");

      await wrapper.setProps({ active: false });
      Object.defineProperty(second.video, "videoWidth", { value: 0 });
      second.video.dispatchEvent(new Event("emptied"));
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      expect(
        (wrapper.get(".motion-cover-ambient-near").element as HTMLElement).style.maskPosition,
      ).toBe("");
      Object.defineProperty(second.video, "videoWidth", { value: 480 });
      Object.defineProperty(second.video, "videoHeight", { value: 480 });
      second.video.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(context.drawImage).toHaveBeenCalledTimes(16);
      second.present(3000);
      await nextTick();
      expect(context.drawImage).toHaveBeenCalledTimes(24);
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
      expect(second.frames.size).toBe(0);
      for (const type of ["loadedmetadata", "resize", "emptied"]) {
        const listener = first.addListener.mock.calls.find(([name]) => name === type)![1];
        expect(first.removeListener).toHaveBeenCalledWith(type, listener);
      }
    } finally {
      wrapper.unmount();
    }
    expect(second.frames.size).toBe(0);
    for (const type of ["loadedmetadata", "resize", "emptied"]) {
      const listener = second.addListener.mock.calls.find(([name]) => name === type)![1];
      expect(second.removeListener).toHaveBeenCalledWith(type, listener);
    }
    expect(ManualResizeObserver.instances.every((observer) => observer.targets.size === 0)).toBe(
      true,
    );
    expect(
      ManualResizeObserver.instances.every((observer) => observer.disconnect.mock.calls.length > 0),
    ).toBe(true);
  });

  it.each(["near", "far"] as const)(
    "%s context 不可用时透明，恢复后重投射已有帧",
    async (layer) => {
      const source = createVideo();
      const { container } = createContainer();
      const { contexts, unavailable } = capturePaints();
      const wrapper = mount(MotionCoverAmbient, {
        props: { video: source.video, container, active: false },
      });
      try {
        await nextTick();
        const canvas = wrapper.get(`.motion-cover-ambient-${layer}`).element as HTMLCanvasElement;
        unavailable.add(canvas);
        resize();
        source.present(1000);
        await nextTick();
        expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
        expect(
          [...contexts.values()].every((context) => context.drawImage.mock.calls.length === 0),
        ).toBe(true);
        unavailable.clear();
        resize();
        await nextTick();
        expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
        expect(source.frames.size).toBe(0);
      } finally {
        wrapper.unmount();
      }
    },
  );

  it("无固有尺寸时不显示占位，尺寸就绪后仍等待真实帧；缺少源或容器时移除 ready", async () => {
    const source = createVideo();
    const { container } = createContainer();
    Object.defineProperty(source.video, "videoWidth", { value: 0 });
    Object.defineProperty(source.video, "readyState", { value: 0 });
    capturePaints();
    const wrapper = mount(MotionCoverAmbient, {
      props: { video: source.video, container, active: false },
    });
    try {
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      Object.defineProperty(source.video, "videoWidth", { value: 360 });
      Object.defineProperty(source.video, "readyState", { value: 2 });
      source.video.dispatchEvent(new Event("loadedmetadata"));
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      source.present(1000);
      await nextTick();
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBe("");
      await wrapper.setProps({ container: undefined });
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
      expect(source.frames.size).toBe(0);
      await wrapper.setProps({ container, video: undefined });
      expect(wrapper.attributes("data-motion-cover-ambient-ready")).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });
});
