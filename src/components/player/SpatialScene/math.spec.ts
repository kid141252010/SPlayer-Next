import { describe, expect, it } from "vitest";
import {
  MIX_RADIUS,
  FLOOR,
  createCamera,
  headAxes,
  headPoint,
  objectWorld,
  project,
  parseScene,
  gainsFor,
  floorCircle,
} from "./math";

const controls = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, focus: 0, height: 1 };
const options = { yaw: 0, pitch: 0.62, distance: 9.5, fov: 1 };

describe("Fantastic 坐标与投影", () => {
  it("遵循 ADM 右、前、上和左转为正的约定", () => {
    expect(headAxes(0, 0)).toEqual({ face: [-0, 1, 0], right: [1, 0, 0], up: [0, -0, 1] });
    expect(headAxes(Math.PI / 2, 0).face[0]).toBeCloseTo(-1);
    expect(headAxes(0, Math.PI / 2).face[2]).toBeCloseTo(1);
    expect(headPoint(headAxes(0, 0), [1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
  });
  it("沿用 mid 距离、高度裁剪与地面常量", () => {
    expect(objectWorld([1, -1, 0.8], 3)).toEqual([MIX_RADIUS, -MIX_RADIUS, MIX_RADIUS]);
    const circle = floorCircle(2);
    expect(circle).toHaveLength(73);
    expect(circle[0]).toEqual([2, 0, FLOOR]);
    expect(circle[72][0]).toBeCloseTo(circle[0][0]);
  });
  it("第一人称正前方在准星上，右侧在屏幕右侧", () => {
    const camera = createCamera("first", options, controls, 1000, 800);
    expect(project([0, 2, 0], camera)).toMatchObject({ x: 500, y: 360, depth: 2 });
    expect(project([1, 2, 0], camera)!.x).toBeGreaterThan(500);
    expect(project([0, 2, 1], camera)!.y).toBeLessThan(360);
    expect(project([0, -2, 0], camera)).toBeNull();
    expect(project([0, 0.1, 0], camera)).toBeNull();
  });
  it("跟随站位与头部朝向，俯瞰相机仍绕房间中心", () => {
    const state = { ...controls, x: 3, y: 4, yaw: Math.PI / 2 };
    const first = createCamera("first", options, state, 800, 600);
    expect(first.eye).toEqual([3, 4, 0]);
    expect(project([1, 4, 0], first)!.x).toBeCloseTo(400);
    const orbit = createCamera("orbit", options, state, 800, 600);
    expect(project([0, 0, 0.4], orbit)!.x).toBeCloseTo(400);
    expect(project([0, 0, 0.4], orbit)!.y).toBeCloseTo(252);
  });
});

describe("原生场景布局与对象混音", () => {
  it("解析 15×3 位置、16 通道电平及 3 个监听者坐标", () => {
    const scene = parseScene(Float32Array.from({ length: 64 }, (_, index) => index))!;
    expect(scene.positions).toHaveLength(15);
    expect(scene.positions[14]).toEqual([42, 43, 44]);
    expect(scene.levels).toEqual(Array.from({ length: 16 }, (_, index) => 45 + index));
    expect(scene.listener).toEqual([61, 62, 63]);
  });
  it("空场景保持未生效语义，拒绝截断或非有限值", () => {
    expect(parseScene(null)).toBeNull();
    for (const length of [0, 63, 65]) expect(() => parseScene(new Float32Array(length))).toThrow();
    const scene = new Float32Array(64);
    scene[3] = Number.NaN;
    expect(() => parseScene(scene)).toThrow();
    scene[3] = Infinity;
    expect(() => parseScene(scene)).toThrow();
  });
  it("包含 LFE 的独奏、多选、静音及恢复增益", () => {
    expect(gainsFor([], [])).toEqual(Array(16).fill(1));
    expect(gainsFor([0, 3], [3])).toEqual([1, ...Array(15).fill(0)]);
    expect(gainsFor([], [4])[4]).toBe(0);
    expect(gainsFor([2, 4], []).filter(Boolean)).toHaveLength(2);
  });
});
