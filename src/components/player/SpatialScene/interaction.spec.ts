import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSpatialStore } from "@/stores/spatial";
import { SceneInteraction } from "./interaction";
import { WALK_LIMIT, PITCH_LIMIT } from "./math";

/** 建立不绘图的真实交互控制器 */
function fixture() {
  const canvas = document.createElement("canvas"),
    root = document.createElement("div");
  vi.spyOn(canvas, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  const store = useSpatialStore(),
    close = vi.fn();
  const scene = new SceneInteraction(
    canvas,
    store.controls,
    store.view,
    (key) => key,
    store.update,
    close,
    root,
  );
  return { scene, store, close, root };
}

describe("空间交互", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("拖头、漫步、回正与混音保留原版约定和边界", () => {
    const { scene, store } = fixture();
    scene.setView("first");
    scene.orbit(10, -1000);
    expect(store.controls.yaw).toBeLessThan(0);
    expect(store.controls.pitch).toBe(PITCH_LIMIT);
    scene.step(100, -100);
    expect(store.controls.x).toBe(WALK_LIMIT);
    expect(store.controls.y).toBe(-WALK_LIMIT);
    scene.toggle("solo", 2);
    scene.resetPose();
    expect(store.controls.yaw).toBe(0);
    expect(store.controls.x).toBe(0);
    expect(store.controls.solo).toEqual([2]);
    scene.dispose();
  });
  it("WASD、巡游和暂停后不继续走动，释放全部监听器", () => {
    const { scene, store, close, root } = fixture();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW" }));
    scene.animate(0.1);
    expect(store.controls.y).toBeCloseTo(0.22);
    store.view.tour = true;
    scene.animate(0.1);
    expect(store.controls.yaw).toBeCloseTo(0.04);
    scene.suspend();
    expect(scene.keys.size).toBe(0);
    expect(store.view.locked).toBe(false);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledTimes(1);
    scene.dispose();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("模式选择控件的方向键和字母键不转头或漫步", () => {
    const { scene, store, root } = fixture();
    const trigger = document.createElement("button");
    trigger.setAttribute("role", "combobox");
    const label = document.createElement("span");
    trigger.append(label);
    root.append(trigger);
    for (const [key, code] of [
      ["ArrowLeft", "ArrowLeft"],
      ["w", "KeyW"],
    ]) {
      const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
      label.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    scene.animate(0.1);
    expect(store.controls.yaw).toBe(0);
    expect(store.controls.y).toBe(0);
    scene.dispose();
  });
  it("应援棒切换后的锁定点击可挥动、独奏和静音", () => {
    const { scene, store } = fixture();
    store.view.stickOn = true;
    scene.aim = 3;
    scene.lockedClick(new PointerEvent("pointerdown", { button: 0 }));
    expect(scene.hand.swing).toBe(0);
    expect(scene.hand.held).toBe(true);
    expect(scene.objects[3].cheer).toBe(1);
    scene.lockedClick(new PointerEvent("pointerdown", { button: 2 }));
    expect(store.controls.solo).toEqual([4]);
    scene.lockedClick(new PointerEvent("pointerdown", { button: 2, altKey: true }));
    expect(store.controls.mute).toEqual([4]);
    expect(store.controls.gains![4]).toBe(0);
    scene.dispose();
  });
});
