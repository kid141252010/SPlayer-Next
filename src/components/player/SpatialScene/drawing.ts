import type { SpatialControls, SpatialView } from "@/stores/spatial";
import {
  MIX_RADIUS,
  OBJECTS,
  TRAIL,
  TRAIL_BANDS,
  HEAD_RADIUS,
  FLOOR,
  MAX_ORB,
  SWING_TIME,
  SWING_DELAY,
  STICK_HUE,
  SPARKS,
  TAU,
  FONT,
  clamp,
  hue,
  headAxes,
  headPoint,
  floorCircle,
  createCamera,
  project,
} from "./math";
import type { Vector, Camera, ScreenPoint, SceneData } from "./math";

interface SceneObject {
  pos: Vector | null;
  target: Vector | null;
  level: number;
  rms: number;
  cheer: number;
  trail: Vector[];
}
interface HandPoint {
  x: number;
  y: number;
  k: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

/** 两端粗细不同的胶囊路径，用于光管、握柄与袖子 */
function capsule(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  ra: number,
  rb: number,
) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(a.x + Math.cos(angle) * ra, a.y + Math.sin(angle) * ra);
  ctx.lineTo(b.x + Math.cos(angle) * rb, b.y + Math.sin(angle) * rb);
  ctx.arc(b.x, b.y, rb, angle, angle + Math.PI, true);
  ctx.lineTo(a.x - Math.cos(angle) * ra, a.y - Math.sin(angle) * ra);
  ctx.arc(a.x, a.y, ra, angle + Math.PI, angle, true);
  ctx.closePath();
}

export class SceneDrawing {
  readonly objects: SceneObject[] = Array.from({ length: OBJECTS }, () => ({
    pos: null,
    target: null,
    level: 0,
    rms: 0,
    cheer: 0,
    trail: [],
  }));
  camera = { yaw: 0, pitch: 0.62, distance: window.innerWidth < 600 ? 7.5 : 9.5, fov: 1 };
  cam!: Camera;
  width = 0;
  height = 0;
  ratio = 1;
  bottomHeight = 0;
  lfe = 0;
  lfeRms = 0;
  frameDt = 0;
  aim = -1;
  hover = -1;
  lockedAt = 0;
  unlockedAt = 0;
  keys = new Set<string>();
  floor: HTMLCanvasElement | null = null;
  floorKey = "";
  lastScene: SceneData | null = null;
  hand = {
    swing: -1,
    held: false,
    hue: STICK_HUE,
    swayX: 0,
    swayY: 0,
    lastYaw: null as number | null,
    lastPitch: 0,
    bob: 0,
    walk: 0,
    lift: 0,
    sparks: [] as Spark[],
    sides: [
      { ghosts: [] as [HandPoint, HandPoint][], lastTip: null as HandPoint | null },
      { ghosts: [] as [HandPoint, HandPoint][], lastTip: null as HandPoint | null },
    ],
  };
  ctx: CanvasRenderingContext2D;
  /** 持有画布、共享控制与译文函数，不持有原生引擎 */
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly state: SpatialControls,
    readonly ui: SpatialView,
    readonly t: (key: string, values?: Record<string, string | number>) => string,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }
  /** 当前视角 */
  get view() {
    return this.ui.view;
  }
  /** 鼠标是否锁定 */
  get locked() {
    return this.ui.locked;
  }
  /** 鼠标视角是否开启 */
  get look() {
    return this.ui.look;
  }
  /** 应援棒是否开启 */
  get stickOn() {
    return this.ui.stickOn;
  }
  /** 获取通道线性增益 */
  gainOf(index: number) {
    return this.state.gains![index];
  }
  /** 挥动双手应援棒并点亮准星对象 */
  wave() {
    this.hand.swing = 0;
    if (this.aim >= 0) this.objects[this.aim].cheer = 1;
  }
  /** 按实际 DPR 调整画布和离屏缓存 */
  fit(bottomHeight: number) {
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = width;
    this.height = height;
    this.ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(width * this.ratio));
    this.canvas.height = Math.max(1, Math.round(height * this.ratio));
    this.bottomHeight = bottomHeight;
    this.floorKey = "";
  }
  /** 更新 OAMD 目标、平滑电平和有界轨迹 */
  ingest(scene: SceneData | null, dt: number) {
    if (scene && scene !== this.lastScene) {
      this.lastScene = scene;
      this.objects.forEach((object, index) => {
        object.target = scene.positions[index];
        if (!object.pos) object.pos = object.target.slice();
        object.rms = scene.levels[index + 1];
      });
      this.lfeRms = scene.levels[0];
    }
    if (!scene) {
      this.lfeRms = 0;
      this.objects.forEach((object) => {
        object.rms = 0;
      });
    }
    const follow = 1 - Math.exp(-dt * 18);
    for (const object of this.objects) {
      if (!object.target || !object.pos) continue;
      for (let k = 0; k < 3; k++) object.pos[k] += (object.target[k] - object.pos[k]) * follow;
      object.level = this.smoothLevel(object.level, object.rms, dt);
      object.cheer = Math.max(0, object.cheer - dt * 1.8);
      object.trail.push(object.pos.slice());
      if (object.trail.length > TRAIL) object.trail.shift();
    }
    this.lfe = this.smoothLevel(this.lfe, this.lfeRms, dt);
  }
  animateHand(dt: number) {
    const hand = this.hand;
    const yaw = this.state.yaw || 0;
    const pitch = this.state.pitch || 0;
    if (hand.lastYaw != null) {
      // 左转时画面往右移，手跟不上也往右；抬头时手往下
      hand.swayX = clamp(hand.swayX + (yaw - hand.lastYaw) * 180, -60, 60);
      hand.swayY = clamp(hand.swayY + (pitch - hand.lastPitch) * 180, -45, 45);
    }
    hand.lastYaw = yaw;
    hand.lastPitch = pitch;
    const settle = Math.exp(-dt * 7);
    hand.swayX *= settle;
    hand.swayY *= settle;
    hand.walk += ((this.keys.size ? 1 : 0) - hand.walk) * (1 - Math.exp(-dt * 8));
    hand.bob += dt * 10 * hand.walk;
    if (hand.swing >= 0) {
      hand.swing += dt / SWING_TIME;
      if (hand.swing >= 1 + SWING_DELAY) {
        if (hand.held) this.wave();
        else hand.swing = -1;
      }
    }
    let target = this.aim >= 0 ? hue(this.aim + 1) : STICK_HUE;
    const solo = this.state.solo || [];
    if (this.aim < 0 && solo.length === 1 && solo[0] > 0) target = hue(solo[0]);
    // 沿色环的近路过渡
    const delta = ((target - hand.hue + 540) % 360) - 180;
    hand.hue = (hand.hue + delta * (1 - Math.exp(-dt * 6)) + 360) % 360;
    for (const spark of hand.sparks) {
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vy += 240 * dt;
      spark.vx *= Math.exp(-dt * 2);
      spark.life -= dt;
    }
    hand.sparks = hand.sparks.filter((spark) => spark.life > 0);
  }

  /** RMS → 0..1（-60..0 dBFS），起得快落得慢 */
  smoothLevel(previous: number, rms: number, dt: number) {
    const level = rms > 0 ? clamp((20 * Math.log10(rms) + 60) / 60, 0, 1) : 0;
    const rate = level > previous ? 30 : 4;
    return previous + (level - previous) * (1 - Math.exp(-dt * rate));
  }

  /** 世界坐标里的对象位置（高度倍率与渲染器一致） */
  objectWorld(adm: Vector) {
    const height = this.state.height || 1;
    return [adm[0] * MIX_RADIUS, adm[1] * MIX_RADIUS, clamp(adm[2] * height, -1, 1) * MIX_RADIUS];
  }

  /** 获取监听者世界坐标 */
  listener() {
    return [this.state.x || 0, this.state.y || 0, this.state.z || 0];
  }

  /** 相机：俯瞰时绕房间中心，第一人称时在头部 */
  /** 更新当前视角的投影相机 */
  setupCamera() {
    this.cam = createCamera(this.view, this.camera, this.state, this.width, this.height);
  }

  /** 世界坐标 → 屏幕（x, y, 深度, 缩放）；在相机后面时为 null */
  /** 将世界坐标投影到屏幕 */
  project(point: Vector): ScreenPoint | null {
    return project(point, this.cam);
  }

  /** 屏幕坐标下最靠前的光球（对象编号 0..14），没有为 -1 */
  pick(clientX: number, clientY: number) {
    if (!this.cam) return -1;
    const rect = this.canvas.getBoundingClientRect();
    return this.pickAt(clientX - rect.left, clientY - rect.top);
  }

  /** 画布坐标下最靠前的光球 */
  /** 按屏幕坐标选取最近光球 */
  pickAt(x: number, y: number) {
    let best = -1;
    let bestDepth = Infinity;
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (!object.pos) continue;
      const p = this.project(this.objectWorld(object.pos));
      if (!p) continue;
      const radius = Math.max(10, clamp(this.orbRadius(object) * p.scale, 2.5, MAX_ORB) + 6);
      if (Math.hypot(p.x - x, p.y - y) <= radius && p.depth < bestDepth) {
        best = i;
        bestDepth = p.depth;
      }
    }
    return best;
  }

  /** 按平滑电平计算原版光球半径 */
  orbRadius(object: SceneObject) {
    return 0.1 + 0.32 * object.level;
  }

  /** 按深度绘制完整声场 */
  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.setupCamera();
    this.aim = this.view === "first" ? this.pickAt(this.cam.cx, this.cam.cy) : -1;
    if (this.locked) this.hover = this.aim;
    this.drawFloor();
    this.drawShadows();
    const items: { depth: number; draw: () => void }[] = [];
    const solo = this.state.solo || [];
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (!object.pos) continue;
      const world = this.objectWorld(object.pos);
      const p = this.project(world);
      if (p) items.push({ depth: p.depth, draw: () => this.drawObject(i, object, world, p, solo) });
    }
    if (this.view !== "first") {
      const p = this.project(this.listener());
      if (p) items.push({ depth: p.depth, draw: () => this.drawHead() });
    }
    items.sort((a, b) => b.depth - a.depth);
    for (const item of items) item.draw();
    if (this.view === "first") {
      this.drawCompass();
      if (this.stickOn) this.drawHand();
      if (this.look) this.drawLookHint();
    }
  }

  /** 世界坐标的折线（在相机后面的点断开） */
  strokeWorld(
    ctx: CanvasRenderingContext2D,
    points: Vector[],
    style: string,
    width = 1,
    dash: number[] | null = null,
  ) {
    ctx.beginPath();
    let pen = false;
    for (const point of points) {
      const p = this.project(point);
      if (!p) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      pen = true;
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke();
  }

  /**
   * 耳朵高度的地面与脚下的 LFE 光环。地面只随相机、画布大小与语言变化，画在离屏画布上缓存，每帧贴一次：
   * 铺满画面的大圆每次描边都要算整片覆盖，高分屏上很费 GPU（俯瞰时相机不动就不必重画）
   */
  drawFloor() {
    const { eye, face, focal, cx, cy } = this.cam;
    const key = [
      ...eye,
      ...face,
      focal,
      cx,
      cy,
      this.canvas.width,
      this.canvas.height,
      this.t("scene.front"),
    ].join();
    if (key !== this.floorKey) {
      this.floorKey = key;
      if (!this.floor) this.floor = document.createElement("canvas");
      const floor = this.floor;
      if (floor.width !== this.canvas.width || floor.height !== this.canvas.height) {
        floor.width = this.canvas.width;
        floor.height = this.canvas.height;
      }
      const ctx = floor.getContext("2d")!;
      ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this.paintFloor(ctx);
    }
    this.ctx.drawImage(this.floor!, 0, 0, this.width, this.height);
    // LFE：脚下随低频电平起伏的光环
    if (this.lfe > 0.02 && this.gainOf(0) > 0) {
      const ring = floorCircle(0.55 + this.lfe * 0.9).map(([x, y]) => [
        x + (this.state.x || 0),
        y + (this.state.y || 0),
        FLOOR,
      ]);
      this.strokeWorld(
        this.ctx,
        ring,
        `hsla(${hue(0)}, 90%, 70%, ${0.15 + this.lfe * 0.5})`,
        1 + this.lfe * 3,
      );
    }
  }

  /** 地面：同心圆、方位线、ADM 房间的轮廓与「前 / 后 / 左 / 右」 */
  paintFloor(ctx: CanvasRenderingContext2D) {
    const line = (...args: [Vector[], string, number?, (number[] | null)?]) =>
      this.strokeWorld(ctx, ...args);
    for (const radius of [1, 2, 3, 4, 5])
      line(floorCircle(radius), radius === 2 ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.06)");
    for (let k = 0; k < 12; k++) {
      const angle = (k / 12) * TAU;
      line(
        [
          [Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, FLOOR],
          [Math.cos(angle) * 5, Math.sin(angle) * 5, FLOOR],
        ],
        "rgba(255,255,255,.05)",
      );
    }
    // ADM 的立方体：x / y ∈ ±1、z ∈ 0..1（Atmos 房间，底面在耳朵高度），乘以渲染距离
    const r = MIX_RADIUS;
    const square = (z: number) => [
      [-r, -r, z],
      [r, -r, z],
      [r, r, z],
      [-r, r, z],
      [-r, -r, z],
    ];
    line(square(0), "rgba(255,255,255,.12)");
    line(square(r), "rgba(255,255,255,.08)", 1, [4, 6]);
    for (const [x, y] of [
      [-r, -r],
      [r, -r],
      [r, r],
      [-r, r],
    ])
      line(
        [
          [x, y, FLOOR],
          [x, y, r],
        ],
        "rgba(255,255,255,.06)",
        1,
        [4, 6],
      );
    ctx.setLineDash([]);
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [key, point] of [
      ["scene.front", [0, 5.6, FLOOR]],
      ["scene.back", [0, -5.6, FLOOR]],
      ["scene.left", [-5.6, 0, FLOOR]],
      ["scene.right", [5.6, 0, FLOOR]],
    ] as [string, Vector][]) {
      const p = this.project(point);
      if (!p) continue;
      ctx.fillStyle = key === "scene.front" ? "rgba(250,45,72,.9)" : "rgba(255,255,255,.45)";
      ctx.fillText(this.t(key), p.x, p.y);
    }
  }

  /** 对象落到地面的竖线与投影（看得出高度），俯瞰时还有听者的身体与脚下的位置；都画在光球之前 */
  drawShadows() {
    const ctx = this.ctx;
    const drop = (world: Vector, color: number, alpha: number) => {
      const top = this.project(world);
      const ground = this.project([world[0], world[1], FLOOR]);
      if (!top || !ground) return;
      ctx.beginPath();
      ctx.moveTo(ground.x, ground.y);
      ctx.lineTo(top.x, top.y);
      ctx.strokeStyle = `hsla(${color}, 60%, 75%, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y, 0.14 * ground.scale + 1, 0.05 * ground.scale + 1, 0, 0, TAU);
      ctx.fillStyle = `hsla(${color}, 60%, 65%, ${alpha})`;
      ctx.fill();
    };
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (object.pos)
        drop(this.objectWorld(object.pos), hue(i + 1), this.gainOf(i + 1) === 0 ? 0.06 : 0.2);
    }
    if (this.view !== "first") drop(this.listener(), 0, 0.3);
  }

  drawObject(index: number, object: SceneObject, _world: Vector, p: ScreenPoint, solo: number[]) {
    const ctx = this.ctx;
    const silent = this.gainOf(index + 1) === 0;
    const soloed = solo.includes(index + 1);
    const color = hue(index + 1);
    const active = object.level > 0.05;
    // 轨迹
    if (object.trail.length > 2 && !silent) {
      const count = object.trail.length;
      const points = object.trail.map((point) => this.project(this.objectWorld(point)));
      ctx.lineWidth = 2;
      // 第 k 段（points[k - 1] → points[k]）越新越不透明；同一段落里的线段取中间那段的透明度
      for (let band = 0; band < TRAIL_BANDS; band++) {
        const from = Math.max(1, Math.ceil((band * count) / TRAIL_BANDS));
        const to = Math.ceil(((band + 1) * count) / TRAIL_BANDS);
        if (from >= to) continue;
        ctx.beginPath();
        for (let k = from; k < to; k++) {
          const previous = points[k - 1];
          const q = points[k];
          if (!previous || !q) continue;
          ctx.moveTo(previous.x, previous.y);
          ctx.lineTo(q.x, q.y);
        }
        ctx.strokeStyle = `hsla(${color}, 85%, 65%, ${((from + to - 1) / 2 / count) * 0.35})`;
        ctx.stroke();
      }
    }
    const radius = clamp(this.orbRadius(object) * p.scale, 2.5, MAX_ORB);
    if (silent) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.strokeStyle = "rgba(255,255,255,.25)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.6);
      glow.addColorStop(0, `hsla(${color}, 95%, 70%, ${active ? 0.55 : 0.15})`);
      glow.addColorStop(1, `hsla(${color}, 95%, 60%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();
      const body = ctx.createRadialGradient(
        p.x - radius * 0.35,
        p.y - radius * 0.35,
        radius * 0.1,
        p.x,
        p.y,
        radius,
      );
      body.addColorStop(0, `hsla(${color}, 100%, ${active ? 88 : 60}%, 1)`);
      body.addColorStop(1, `hsla(${color}, 80%, ${active ? 52 : 30}%, 1)`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.fill();
    }
    if (object.cheer > 0) {
      // 被应援棒挥到：向外扩散的光圈
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 6 + (1 - object.cheer) * 40, 0, TAU);
      ctx.strokeStyle = `hsla(${color}, 100%, 78%, ${object.cheer * 0.9})`;
      ctx.lineWidth = 1 + object.cheer * 3;
      ctx.stroke();
    }
    if (soloed || this.hover === index) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 4, 0, TAU);
      ctx.strokeStyle = soloed ? "#fff" : "rgba(255,255,255,.6)";
      ctx.lineWidth = soloed ? 2 : 1.5;
      ctx.stroke();
    }
    if (this.hover === index || soloed) {
      const db = object.rms > 0 ? `${Math.round(20 * Math.log10(object.rms))} dB` : "-∞ dB";
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(`${this.t("scene.object", { n: index + 1 })} · ${db}`, p.x, p.y - radius - 8);
    } else if (radius > 9) {
      ctx.font = `600 ${Math.min(13, radius * 0.8)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillText(String(index + 1), p.x, p.y + 0.5);
    }
  }

  /** 俯瞰视角的头部：球形的头、鼻子指向面朝的方向，两只耳朵（左青右红），聚焦时前方有一束光 */
  drawHead() {
    const ctx = this.ctx;
    const origin = this.listener();
    const axes = headAxes(this.state.yaw || 0, this.state.pitch || 0);
    const center = this.project(origin);
    if (!center) return;
    const radius = HEAD_RADIUS * center.scale;
    // 面朝方向的光束（聚焦越强越亮）与视线
    const focus = this.state.focus || 0;
    const reach = 1.8 + focus * 1.5;
    const spread = 0.55 - focus * 0.25;
    const beam = [0, 1, 2].map((k) => {
      const angle = (k - 1) * spread;
      return headPoint(axes, origin, [Math.sin(angle) * reach, Math.cos(angle) * reach, 0]);
    });
    const tip = beam.map((point) => this.project(point));
    if (tip[0] && tip[1] && tip[2]) {
      const gradient = ctx.createLinearGradient(center.x, center.y, tip[1].x, tip[1].y);
      gradient.addColorStop(0, `rgba(250,45,72,${0.18 + focus * 0.35})`);
      gradient.addColorStop(1, "rgba(250,45,72,0)");
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(tip[0].x, tip[0].y);
      ctx.lineTo(tip[2].x, tip[2].y);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    // 耳朵与鼻子按深度排在头的前后
    const parts = [
      { local: [-HEAD_RADIUS * 1.02, 0, 0], kind: "ear", color: "#5ad1ff", label: "L" },
      { local: [HEAD_RADIUS * 1.02, 0, 0], kind: "ear", color: "#ff5a73", label: "R" },
      { local: [0, HEAD_RADIUS * 1.08, -0.02], kind: "nose" },
    ]
      .map((part) => ({ ...part, p: this.project(headPoint(axes, origin, part.local))! }))
      .filter((part) => part.p);
    const drawPart = (part: { kind: string; p: ScreenPoint; color?: string; label?: string }) => {
      if (part.kind === "ear") {
        ctx.beginPath();
        ctx.ellipse(part.p.x, part.p.y, radius * 0.22, radius * 0.34, 0, 0, TAU);
        ctx.fillStyle = part.color!;
        ctx.fill();
        ctx.font = `700 ${Math.max(9, radius * 0.28)}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(0,0,0,.7)";
        ctx.fillText(part.label!, part.p.x, part.p.y + 0.5);
      } else {
        ctx.beginPath();
        ctx.arc(part.p.x, part.p.y, radius * 0.16, 0, TAU);
        ctx.fillStyle = "#f2d4c4";
        ctx.fill();
      }
    };
    for (const part of parts) if (part.p.depth > center.depth) drawPart(part);
    const skin = ctx.createRadialGradient(
      center.x - radius * 0.35,
      center.y - radius * 0.4,
      radius * 0.1,
      center.x,
      center.y,
      radius,
    );
    skin.addColorStop(0, "#f6e3d8");
    skin.addColorStop(1, "#b98f7d");
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, TAU);
    ctx.fillStyle = skin;
    ctx.fill();
    // 头顶的发旋：看得出头部的俯仰
    const crown = this.project(
      headPoint(axes, origin, [0, -HEAD_RADIUS * 0.25, HEAD_RADIUS * 0.85]),
    );
    if (crown) {
      ctx.beginPath();
      ctx.arc(crown.x, crown.y, radius * 0.5, 0, TAU);
      ctx.fillStyle = "rgba(60,40,32,.55)";
      ctx.fill();
    }
    for (const part of parts) if (part.p.depth <= center.depth) drawPart(part);
  }

  /** 第一人称：顶部的方位刻度与中心准星 */
  drawCompass() {
    const ctx = this.ctx;
    const yaw = this.state.yaw || 0;
    const width = Math.min(this.width - 32, 420);
    const left = (this.width - width) / 2;
    const top = 64;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // 世界方位（0 = 前，90 = 左，与 yaw 同向）相对面朝方向的角度，显示视野内的 ±90°，左边的方位在左
    const labels: Record<number, string> = {
      0: "scene.front",
      90: "scene.left",
      180: "scene.back",
      270: "scene.right",
    };
    for (let deg = 0; deg < 360; deg += 15) {
      let relative = ((deg * Math.PI) / 180 - yaw) % TAU;
      if (relative > Math.PI) relative -= TAU;
      if (relative <= -Math.PI) relative += TAU;
      if (Math.abs(relative) > Math.PI / 2) continue;
      const x = left + width / 2 - (relative / (Math.PI / 2)) * (width / 2);
      const label = labels[deg];
      ctx.fillStyle = label === "scene.front" ? "rgba(250,45,72,.95)" : "rgba(255,255,255,.55)";
      if (label) ctx.fillText(this.t(label), x, top);
      else ctx.fillRect(x - 0.5, top - (deg % 45 ? 3 : 6), 1, deg % 45 ? 6 : 12);
    }
    // 准星对准光球时染上它的颜色、张开一点
    const { cx, cy } = this.cam;
    const aimed = this.aim >= 0;
    const ring = aimed ? 13 : 10;
    ctx.strokeStyle = aimed ? `hsla(${hue(this.aim + 1)}, 100%, 78%, .95)` : "rgba(255,255,255,.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, 0, TAU);
    ctx.moveTo(cx - ring - 8, cy);
    ctx.lineTo(cx - ring - 3, cy);
    ctx.moveTo(cx + ring + 3, cy);
    ctx.lineTo(cx + ring + 8, cy);
    ctx.stroke();
    if (this.locked) {
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, TAU);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
  }

  /** 鼠标视角：没锁定时提示点击画面，刚锁定时在底部提示几秒操作方式 */
  drawLookHint() {
    const ctx = this.ctx;
    let text;
    let y;
    let alpha;
    if (this.locked) {
      alpha = clamp(5 - (performance.now() - this.lockedAt) / 1000, 0, 1);
      if (!alpha) return;
      text = this.t(this.stickOn ? "scene.lockHintStick" : "scene.lockHint");
      y = this.height - 32;
    } else {
      text = this.t("scene.lockPrompt");
      y = this.cam.cy + 56;
      alpha = 1;
    }
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = Math.min(ctx.measureText(text).width + 28, this.width - 24);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(this.width / 2 - width / 2, y - 15, width, 30, 15);
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.fillText(text, this.width / 2, y, width - 20);
    ctx.globalAlpha = 1;
  }

  /**
   * 第一人称下方双手举着的应援棒：小圆球一样的手（不画手指），一只手一支。
   * 按相机空间（右、上、前）的位置透视画出来，往前挥时棒尖朝远处倒、看上去变短；左手比右手晚一点。
   * 光管随低频电平呼吸发光；挥动时留下残影、甩出火花。
   */
  drawHand() {
    const ctx = this.ctx;
    const hand = this.hand;
    const dt = this.frameDt;
    // 底部控制项显示时把手抬到它们上面，锁定鼠标时（控制项隐藏）落回屏幕底部
    const lift = this.locked ? 0 : Math.max(0, (this.bottomHeight || 0) - 30);
    hand.lift += (lift - hand.lift) * (1 - Math.exp(-dt * 8));
    // 只在控制项上方的可见区域里布置双手（手机上控制项很高）
    const visible = Math.max(this.height * 0.4, this.height - hand.lift);
    const focal = Math.min(this.width, visible) * 0.9;
    const cx = this.width / 2 + hand.swayX;
    const cy = visible * 0.5 + hand.swayY;
    const project = ([x, y, z]: Vector) => ({
      x: cx + (x * focal) / z,
      y: cy - (y * focal) / z,
      k: focal / z,
    });
    // 两手的间距随屏幕宽高比收拢，竖屏时不至于出画
    const spread = clamp((this.width / focal) * 0.2, 0.14, 0.3);
    const beat = this.gainOf(0) > 0 ? this.lfe : 0;
    const swinging = hand.swing >= 0;
    const h = Math.round(hand.hue);
    const length = 0.3;

    if (hand.sparks.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const spark of hand.sparks) {
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, spark.size, 0, TAU);
        ctx.fillStyle = `hsla(${h}, 100%, 75%, ${Math.min(1, spark.life * 2)})`;
        ctx.fill();
      }
      ctx.restore();
    }

    for (const side of [-1, 1]) {
      const state = hand.sides[side < 0 ? 0 : 1];
      // 快出慢回：前 30% 往前挥出去，其余时间收回来
      const p = swinging ? clamp(hand.swing - (side < 0 ? SWING_DELAY : 0), 0, 1) : 0;
      const arc =
        p < 0.3
          ? Math.sin((p / 0.3) * (Math.PI / 2))
          : Math.cos(((p - 0.3) / 0.7) * (Math.PI / 2)) ** 2;
      const bob = Math.sin(hand.bob + (side < 0 ? Math.PI : 0)) * 0.012 * hand.walk;
      // 挥动是小臂绕手肘往前转、手腕不动：拳头沿以手肘为圆心的弧往前下方走，棒子跟小臂转同样的角度
      const turn = arc * 0.7;
      const rotate = ([x, y, z]: Vector) => [
        x,
        y * Math.cos(turn) - z * Math.sin(turn),
        y * Math.sin(turn) + z * Math.cos(turn),
      ];
      const elbow = [side * (spread + 0.05), -0.48 + bob + beat * 0.006, 0.53];
      const forearm = rotate([-side * 0.05, 0.24, 0.07]);
      const base = elbow.map((value, k) => value + forearm[k]);
      // 棒子向内斜一点，往前转时稍微摆正（否则看上去像往里倒）
      const lean = -0.26 * side * (1 - arc * 0.5);
      const dir = rotate([
        Math.sin(lean),
        Math.cos(lean) * Math.cos(0.12),
        Math.cos(lean) * Math.sin(0.12),
      ]);
      const fist = project(base);
      // 棒子本身不做透视汇聚（否则朝前的棒子都指向画面中心，像往里倒），只按深度变细
      const at = (t: number) => ({
        x: fist.x + dir[0] * t * fist.k,
        y: fist.y - dir[1] * t * fist.k,
        k: focal / (base[2] + dir[2] * t),
      });
      const from = at(0.01);
      const tip = at(length);
      const grip = at(-0.05);
      const glow = 0.55 + beat * 0.45 + arc * 0.3;
      const ball = 0.042 * fist.k;

      // 小臂（袖子）：从拳头朝手肘方向伸出画面，渐隐；挥动时跟着转
      const joint = project(elbow);
      const end = { x: fist.x + (joint.x - fist.x) * 1.6, y: fist.y + (joint.y - fist.y) * 1.6 };
      const sleeve = ctx.createLinearGradient(fist.x, fist.y, end.x, end.y);
      sleeve.addColorStop(0, "#34303f");
      sleeve.addColorStop(0.6, "rgba(26,24,33,.85)");
      sleeve.addColorStop(1, "rgba(22,20,28,0)");
      capsule(ctx, fist, end, ball * 0.8, ball * 1.5);
      ctx.fillStyle = sleeve;
      ctx.fill();

      // 残影：挥动时最近几帧的光管
      state.ghosts.push([from, tip]);
      if (state.ghosts.length > 6) state.ghosts.shift();
      if (swinging) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        state.ghosts.forEach(([a, b], k) => {
          capsule(ctx, a, b, 0.011 * a.k, 0.011 * b.k);
          ctx.fillStyle = `hsla(${h}, 100%, 65%, ${0.04 + k * 0.022})`;
          ctx.fill();
        });
        ctx.restore();
      }
      // 火花：从棒子上半段顺着棒尖的速度甩出去
      if (state.lastTip && dt > 0 && swinging && hand.sparks.length < SPARKS) {
        const vx = (tip.x - state.lastTip.x) / dt;
        const vy = (tip.y - state.lastTip.y) / dt;
        if (Math.hypot(vx, vy) > 300) {
          for (let k = 0; k < 2; k++) {
            const u = 0.55 + Math.random() * 0.45;
            hand.sparks.push({
              x: from.x + (tip.x - from.x) * u,
              y: from.y + (tip.y - from.y) * u,
              vx: vx * 0.35 * u + (Math.random() - 0.5) * 80,
              vy: vy * 0.35 * u - Math.random() * 80,
              life: 0.4 + Math.random() * 0.4,
              size: (1.2 + Math.random() * 1.8) * (fist.k / 1000),
            });
          }
        }
      }
      state.lastTip = tip;

      // 光照到周围的一大团柔光
      const mid = { x: (from.x + tip.x) / 2, y: (from.y + tip.y) / 2 };
      const reach = 0.16 * fist.k;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, reach);
      halo.addColorStop(0, `hsla(${h}, 100%, 60%, ${0.1 + glow * 0.14})`);
      halo.addColorStop(1, `hsla(${h}, 100%, 60%, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(mid.x - reach, mid.y - reach, reach * 2, reach * 2);
      ctx.restore();
      // 握柄（露在拳头下面一点）
      capsule(ctx, grip, fist, 0.01 * grip.k, 0.01 * fist.k);
      ctx.fillStyle = "#25252e";
      ctx.fill();
      // 光管：边缘是颜色，中间近白，随电平呼吸
      const nx = -(tip.y - from.y);
      const ny = tip.x - from.x;
      const norm = Math.hypot(nx, ny) || 1;
      const r = 0.011 * from.k;
      const tube = ctx.createLinearGradient(
        mid.x - (nx / norm) * r,
        mid.y - (ny / norm) * r,
        mid.x + (nx / norm) * r,
        mid.y + (ny / norm) * r,
      );
      tube.addColorStop(0, `hsla(${h}, 95%, ${42 + glow * 14}%, 1)`);
      tube.addColorStop(0.5, `hsla(${h}, 100%, ${78 + glow * 16}%, 1)`);
      tube.addColorStop(1, `hsla(${h}, 95%, ${42 + glow * 14}%, 1)`);
      ctx.save();
      ctx.shadowColor = `hsla(${h}, 100%, 60%, .9)`;
      ctx.shadowBlur = (0.02 + glow * 0.028) * fist.k;
      capsule(ctx, from, tip, r, 0.011 * tip.k);
      ctx.fillStyle = tube;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 0.006 * tip.k, 0, TAU);
      ctx.fillStyle = `hsla(${h}, 100%, 96%, ${0.5 + glow * 0.4})`;
      ctx.fill();
      // 圆球拳头：盖住握柄与光管的根部，上沿被光管照亮
      const skin = ctx.createRadialGradient(
        fist.x - ball * 0.35,
        fist.y - ball * 0.4,
        ball * 0.1,
        fist.x,
        fist.y,
        ball,
      );
      skin.addColorStop(0, "#f6e3d8");
      skin.addColorStop(1, "#b98f7d");
      ctx.beginPath();
      ctx.arc(fist.x, fist.y, ball, 0, TAU);
      ctx.fillStyle = skin;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(fist.x, fist.y, ball - 1, Math.PI * 1.1, Math.PI * 1.9);
      ctx.strokeStyle = `hsla(${h}, 100%, 75%, ${0.25 + glow * 0.3})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
