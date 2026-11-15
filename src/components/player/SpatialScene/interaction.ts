import { SceneDrawing } from "./drawing";
import { PITCH_LIMIT, WALK_LIMIT, LOOK_SPEED, TOUR_SPEED, TAU, clamp, headAxes } from "./math";
import type { View } from "./math";
import type { SpatialControls, SpatialView } from "@/stores/spatial";

export class SceneInteraction extends SceneDrawing {
  private readonly abort = new AbortController();
  pointers = new Map<number, { x: number; y: number }>();
  gesture: {
    camera: boolean;
    moved: boolean;
    x: number;
    y: number;
    alt: boolean;
    spread: number;
  } | null = null;
  /** 绑定可统一释放的交互监听器 */
  constructor(
    canvas: HTMLCanvasElement,
    state: SpatialControls,
    ui: SpatialView,
    t: (key: string, values?: Record<string, string | number>) => string,
    readonly update: (patch: Partial<SpatialControls>) => void,
    readonly onClose: () => void,
    root: HTMLElement,
  ) {
    super(canvas, state, ui, t);
    this.bindPointer();
    this.listen(root, "keydown", (event) => this.keyDown(event));
    this.listen(root, "keyup", (event) => this.keys.delete(event.code));
    this.listen(root, "focusout", () => {
      if (!root.contains(document.activeElement)) this.keys.clear();
    });
    document.addEventListener(
      "pointerlockchange",
      () => {
        this.ui.locked = document.pointerLockElement === canvas;
        if (this.locked) this.lockedAt = performance.now();
        else {
          this.unlockedAt = performance.now();
          this.hand.held = false;
          this.hover = -1;
        }
      },
      { signal: this.abort.signal },
    );
  }
  /** 注册随组件释放的类型化元素监听器 */
  private listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    name: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options: AddEventListenerOptions = {},
  ) {
    element.addEventListener(name, listener as EventListener, {
      ...options,
      signal: this.abort.signal,
    });
  }
  /** 巡游状态 */
  get tour() {
    return this.ui.tour;
  }
  /** 更新巡游状态 */
  set tour(value: boolean) {
    this.ui.tour = value;
  }
  /** 漫步状态 */
  get walk() {
    return this.ui.walk;
  }
  /** 切换视角，离开第一人称时释放指针锁 */
  setView(view: View) {
    this.ui.view = view;
    if (view !== "first") {
      this.ui.look = false;
      this.unlock();
    }
  }
  /** 开关鼠标视角并在用户操作内请求指针锁 */
  toggleLook() {
    this.ui.look = !this.ui.look;
    if (this.look) {
      this.ui.view = "first";
      this.lock();
    } else this.unlock();
  }
  /** 请求指针锁，被系统拒绝时保持可再次点击的提示状态 */
  lock() {
    this.tour = false;
    void this.canvas.requestPointerLock().catch(() => {});
  }
  /** 仅释放本场景拥有的指针锁 */
  unlock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.ui.locked = false;
  }
  /** 更新朝向与站位，由场景循环节流发送 */
  pose(patch: Partial<SpatialControls>) {
    this.update(patch);
  }
  /** 切换对象独奏或静音 */
  toggle(kind: "solo" | "mute", index: number) {
    const list = this.state[kind].slice(),
      at = list.indexOf(index);
    if (at >= 0) list.splice(at, 1);
    else list.push(index);
    this.update({ [kind]: list });
  }
  /** 回到原始朝向与站位，保留对象混音和音色设置 */
  resetPose() {
    this.tour = false;
    this.update({ yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 });
  }
  /** 暂停输入历史，防止恢复可见时继续走动或连挥 */
  suspend() {
    this.keys.clear();
    this.hand.held = false;
    for (const id of this.pointers.keys())
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.pointers.clear();
    this.gesture = null;
    this.unlock();
  }
  /** 释放全部监听器、指针锁和离屏缓存 */
  dispose() {
    this.suspend();
    this.abort.abort();
    this.floor = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
  bindPointer() {
    const canvas = this.canvas;
    this.listen(canvas, "contextmenu", (e) => e.preventDefault());
    this.listen(canvas, "pointerdown", (e) => {
      if (this.locked) {
        this.lockedClick(e);
        return;
      }
      // 鼠标视角开着但还没锁定（刚按过 Esc）：点画面重新锁定
      if (this.look && e.pointerType === "mouse" && e.button === 0) {
        e.preventDefault();
        this.lock();
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const camera = e.button === 2 || e.shiftKey || this.pointers.size > 1;
      this.gesture = {
        camera,
        moved: false,
        x: e.clientX,
        y: e.clientY,
        alt: e.altKey,
        spread: this.spread(),
      };
      this.tour = false;
    });
    this.listen(canvas, "pointermove", (e) => {
      if (this.locked) {
        // 锁定时光标不动，只有相对位移：向右移头向右转，向上移抬头
        const speed = LOOK_SPEED * this.camera.fov;
        this.pose({
          yaw: (this.state.yaw || 0) - e.movementX * speed,
          pitch: clamp((this.state.pitch || 0) - e.movementY * speed, -PITCH_LIMIT, PITCH_LIMIT),
        });
        return;
      }
      const point = this.pointers.get(e.pointerId);
      if (!point) {
        this.hover = this.pick(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - point.x;
      const dy = e.clientY - point.y;
      point.x = e.clientX;
      point.y = e.clientY;
      const g = this.gesture;
      if (!g) return;
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 4) g.moved = true;
      if (!g.moved) return;
      if (this.pointers.size > 1) {
        // 双指：平均位移转视角，张合缩放
        const spread = this.spread();
        if (g.spread && spread) this.zoom(g.spread / spread);
        g.spread = spread;
        this.orbit(dx / this.pointers.size, dy / this.pointers.size);
      } else if (g.camera) {
        this.orbit(dx, dy);
      } else if (this.walk) {
        this.drag(dx, dy);
      } else {
        // 向右拖头向右转（yaw 减小），向上拖抬头
        this.pose({
          yaw: (this.state.yaw || 0) - dx * 0.008,
          pitch: clamp((this.state.pitch || 0) - dy * 0.006, -PITCH_LIMIT, PITCH_LIMIT),
        });
      }
    });
    const end = (e: PointerEvent) => {
      this.hand.held = false;
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.gesture = null;
      if (!g || g.moved || e.type === "pointercancel" || g.camera) return;
      const index = this.pick(e.clientX, e.clientY);
      if (index >= 0) this.toggle(g.alt || e.altKey ? "mute" : "solo", index + 1);
      else if (this.stickOn && this.view === "first") this.wave();
    };
    this.listen(canvas, "pointerup", end);
    this.listen(canvas, "pointercancel", end);
    this.listen(canvas, "pointerleave", () => {
      if (!this.pointers.size) this.hover = -1;
    });
    this.listen(canvas, "dblclick", (e) => {
      // 连挥应援棒、鼠标视角里的连点都不算双击回正
      if (this.locked || this.look || (this.stickOn && this.view === "first")) return;
      if (this.pick(e.clientX, e.clientY) < 0) this.resetPose();
    });
    this.listen(
      canvas,
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
  }

  /**
   * 锁定鼠标时的点击，对准的是准星：有应援棒时左键挥动（按住连挥）、右键独奏（Alt+右键静音）；
   * 没有应援棒时左键独奏、右键静音
   */
  lockedClick(e: PointerEvent) {
    e.preventDefault();
    if (e.button === 0 && this.stickOn) {
      this.hand.held = true;
      this.wave();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (this.aim < 0) return;
    const mute = this.stickOn ? e.altKey : e.button === 2 || e.altKey;
    this.toggle(mute ? "mute" : "solo", this.aim + 1);
  }

  /** 计算双指间距 */
  spread() {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** 旋转俯瞰相机或第一人称头部 */
  orbit(dx: number, dy: number) {
    if (this.view === "first") {
      this.pose({
        yaw: (this.state.yaw || 0) - dx * 0.006,
        pitch: clamp((this.state.pitch || 0) - dy * 0.005, -PITCH_LIMIT, PITCH_LIMIT),
      });
      return;
    }
    this.camera.yaw -= dx * 0.008;
    this.camera.pitch = clamp(this.camera.pitch + dy * 0.006, -0.2, 1.45);
  }

  /** 调整相机距离或第一人称视野 */
  zoom(factor: number) {
    if (this.view === "first") this.camera.fov = clamp(this.camera.fov * factor, 0.6, 1.6);
    else this.camera.distance = clamp(this.camera.distance * factor, 3, 24);
  }

  /** 漫步：拖动方向按当前视角换算成地面上的位移 */
  drag(dx: number, dy: number) {
    const scale = this.view === "first" ? 0.01 : this.camera.distance * 0.0016;
    const yaw = this.view === "first" ? this.state.yaw || 0 : this.camera.yaw;
    const right = [Math.cos(yaw), Math.sin(yaw)];
    const ahead = [-Math.sin(yaw), Math.cos(yaw)];
    // 向上拖往（相机的）前方走，向右拖往右走
    this.step((right[0] * dx - ahead[0] * dy) * scale, (right[1] * dx - ahead[1] * dy) * scale);
  }

  /** 在原版漫步边界内移动监听者 */
  step(dx: number, dy: number) {
    this.pose({
      x: clamp((this.state.x || 0) + dx, -WALK_LIMIT, WALK_LIMIT),
      y: clamp((this.state.y || 0) + dy, -WALK_LIMIT, WALK_LIMIT),
    });
  }

  /** 处理声场内快捷键，保留播放器的空格键 */
  keyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // 锁定鼠标时 Esc 只释放鼠标（浏览器自己退出锁定，有的浏览器之后才送来这个按键），不关闭声场
      if (this.locked || performance.now() - this.unlockedAt < 300) {
        this.unlock();
        return;
      }
      this.onClose();
      return;
    }
    // 滑块自己用方向键
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const turn = 0.12;
    switch (e.key) {
      case "ArrowLeft":
        this.pose({ yaw: (this.state.yaw || 0) + turn });
        break;
      case "ArrowRight":
        this.pose({ yaw: (this.state.yaw || 0) - turn });
        break;
      case "ArrowUp":
        this.pose({ pitch: clamp((this.state.pitch || 0) + turn, -PITCH_LIMIT, PITCH_LIMIT) });
        break;
      case "ArrowDown":
        this.pose({ pitch: clamp((this.state.pitch || 0) - turn, -PITCH_LIMIT, PITCH_LIMIT) });
        break;
      case "r":
      case "R":
        this.resetPose();
        break;
      case "v":
      case "V":
        this.setView(this.view === "first" ? "orbit" : "first");
        break;
      default:
        if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
          this.keys.add(e.code);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  animate(dt: number) {
    if (this.tour) this.pose({ yaw: ((this.state.yaw || 0) + TOUR_SPEED * dt) % TAU });
    if (this.keys.size) {
      const speed = 2.2 * dt;
      const axes = headAxes(this.state.yaw || 0, 0);
      let forward = 0;
      let side = 0;
      if (this.keys.has("KeyW")) forward += speed;
      if (this.keys.has("KeyS")) forward -= speed;
      if (this.keys.has("KeyD")) side += speed;
      if (this.keys.has("KeyA")) side -= speed;
      this.step(
        axes.face[0] * forward + axes.right[0] * side,
        axes.face[1] * forward + axes.right[1] * side,
      );
    }
    this.animateHand(dt);
  }
}
