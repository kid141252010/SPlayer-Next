import type { JocControls } from "@shared/types/joc";

export const MIX_RADIUS = 2.19327927;
export const OBJECTS = 15;
export const TRAIL = 40;
export const TRAIL_BANDS = 8;
export const HEAD_RADIUS = 0.32;
export const FLOOR = -1.3;
export const MAX_ORB = 64;
export const PITCH_LIMIT = 1.3;
export const WALK_LIMIT = 6;
export const TOUR_SPEED = 0.4;
export const LOOK_SPEED = 0.0024;
export const SWING_TIME = 0.36;
export const SWING_DELAY = 0.12;
export const STICK_HUE = 352;
export const SPARKS = 160;
export const TAU = Math.PI * 2;
export const FRAME_INTERVAL = 1000 / 30;
export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

export type Vector = number[];
export type View = "orbit" | "first";
export interface Axes {
  face: Vector;
  right: Vector;
  up: Vector;
}
export interface Camera extends Axes {
  eye: Vector;
  focal: number;
  cx: number;
  cy: number;
}
export interface CameraOptions {
  yaw: number;
  pitch: number;
  distance: number;
  fov: number;
}
export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
}
export interface SceneData {
  positions: Vector[];
  levels: number[];
  listener: Vector;
}

/** 限定数值边界 */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** 按原版色环映射通道颜色，0 为暖白色 LFE */
export function hue(index: number): number {
  return index === 0 ? 40 : ((index - 1) * 24 + 200) % 360;
}

/** 计算 ADM 坐标系中头部的前、右、上方向，yaw 左转为正 */
export function headAxes(yaw: number, pitch: number): Axes {
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  return { face: [-sy * cp, cy * cp, sp], right: [cy, sy, 0], up: [sy * sp, -cy * sp, cp] };
}

/** 将头部局部的右、前、上坐标转换为世界坐标 */
export function headPoint(axes: Axes, origin: Vector, local: Vector): Vector {
  return origin.map(
    (value, k) =>
      value + axes.right[k] * local[0] + axes.face[k] * local[1] + axes.up[k] * local[2],
  );
}

/** 生成原版地面同心圆的 72 段折线 */
export function floorCircle(radius: number): Vector[] {
  return Array.from({ length: 73 }, (_, k) => [
    Math.cos((k / 72) * TAU) * radius,
    Math.sin((k / 72) * TAU) * radius,
    FLOOR,
  ]);
}

/** 按 mid 档渲染距离和高度倍率转换 OAMD 坐标 */
export function objectWorld(adm: Vector, height: number): Vector {
  return [adm[0] * MIX_RADIUS, adm[1] * MIX_RADIUS, clamp(adm[2] * height, -1, 1) * MIX_RADIUS];
}

/** 建立俯瞰或第一人称投影，沿用 Fantastic 的视野与屏幕锚点 */
export function createCamera(
  view: View,
  options: CameraOptions,
  state: JocControls,
  width: number,
  height: number,
): Camera {
  const { yaw, pitch, distance } = options;
  const face =
    view === "first"
      ? headAxes(state.yaw, state.pitch).face
      : [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch)];
  const eye =
    view === "first"
      ? [state.x, state.y, state.z]
      : [0, 0, 0.4].map((value, k) => value - face[k] * distance);
  const length = Math.hypot(face[1], face[0]) || 1e-9;
  const right = [face[1] / length, -face[0] / length, 0];
  const up = [
    right[1] * face[2] - right[2] * face[1],
    right[2] * face[0] - right[0] * face[2],
    right[0] * face[1] - right[1] * face[0],
  ];
  const fov = view === "first" ? 1.25 * options.fov : 0.9;
  return {
    eye,
    face,
    right,
    up,
    focal: Math.min(width, height) / 2 / Math.tan(fov / 2),
    cx: width / 2,
    cy: height * (view === "first" ? 0.45 : 0.42),
  };
}

/** 世界坐标透视投影；相机背后或近裁剪面内的点不可见 */
export function project(point: Vector, camera: Camera): ScreenPoint | null {
  const { eye, face, right, up, focal, cx, cy } = camera;
  const d = point.map((value, k) => value - eye[k]);
  const dot = (axis: Vector): number => d.reduce((sum, value, k) => sum + value * axis[k], 0);
  const depth = dot(face);
  if (depth < 0.15) return null;
  const scale = focal / depth;
  return { x: cx + dot(right) * scale, y: cy - dot(up) * scale, depth, scale };
}

/** 验证原生场景的 64 浮点布局；空场景表示尚未生效 */
export function parseScene(data: Float32Array | null): SceneData | null {
  if (data === null) return null;
  if (data.length !== 64 || !data.every(Number.isFinite)) throw new Error("无效的 JOC 场景数组");
  return {
    positions: Array.from({ length: OBJECTS }, (_, i) => Array.from(data.slice(i * 3, i * 3 + 3))),
    levels: Array.from(data.slice(45, 61)),
    listener: Array.from(data.slice(61, 64)),
  };
}

/** 将独奏和静音集合转换为原生的 16 通道线性增益 */
export function gainsFor(solo: number[], mute: number[]): number[] {
  return Array.from({ length: 16 }, (_, index) =>
    (solo.length && !solo.includes(index)) || mute.includes(index) ? 0 : 1,
  );
}
