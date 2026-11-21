import { describe, expect, it } from "vitest";
import {
  createMotionCoverEdgeProjection,
  type MotionCoverEdgePatch,
  type MotionCoverProjectionInput,
} from "./motionCoverEdgeProjection";

const input: MotionCoverProjectionInput = {
  sourceWidth: 360,
  sourceHeight: 480,
  viewportWidth: 800,
  viewportHeight: 600,
  content: { left: 200, top: 100, width: 300, height: 400 },
  feather: 18,
};

const sourceAt = (patch: MotionCoverEdgePatch, x: number, y: number) => {
  const [sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY] = patch;
  const u = (x - dx) / dw;
  const v = (y - dy) / dh;
  return [sx + (flipX ? 1 - u : u) * sw, sy + (flipY ? 1 - v : v) * sh];
};

const expectPerimeter = (value: MotionCoverProjectionInput) => {
  const projection = createMotionCoverEdgeProjection(value)!;
  expect(projection.patches).toHaveLength(8);
  for (const [sx, sy, sw, sh, , , dw, dh] of projection.patches) {
    expect(Math.min(sw, sh, dw, dh)).toBeGreaterThan(0);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sx + sw).toBeLessThanOrEqual(value.sourceWidth);
    expect(sy + sh).toBeLessThanOrEqual(value.sourceHeight);
    const overlapWidth =
      Math.min(sx + sw, value.sourceWidth * 0.92) - Math.max(sx, value.sourceWidth * 0.08);
    const overlapHeight =
      Math.min(sy + sh, value.sourceHeight * 0.92) - Math.max(sy, value.sourceHeight * 0.08);
    expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
  }
  return projection;
};

describe("动态封面外围投射", () => {
  it("按逻辑背景比例生成八格，源中心完全不被取样", () => {
    const projection = expectPerimeter(input);
    expect([projection.canvasWidth, projection.canvasHeight]).toEqual([384, 313]);
    expect(projection.nearBounds).toEqual({ left: 296, top: 196, width: 396, height: 496 });
  });

  it("边条和角块与实际封面边界对齐，法线镜像后接缝取源最外沿", () => {
    const projection = createMotionCoverEdgeProjection(input)!;
    const scaleX = projection.canvasWidth / 1088;
    const scaleY = projection.canvasHeight / 888;
    const targetX = [0, 362, 626, 1088];
    const targetY = [0, 262, 626, 888];
    let index = 0;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (x === 1 && y === 1) continue;
        const patch = projection.patches[index++];
        expect(patch[4]).toBeCloseTo(targetX[x] * scaleX);
        expect(patch[5]).toBeCloseTo(targetY[y] * scaleY);
        expect(patch[6]).toBeCloseTo((targetX[x + 1] - targetX[x]) * scaleX);
        expect(patch[7]).toBeCloseTo((targetY[y + 1] - targetY[y]) * scaleY);
        expect(patch.slice(8)).toEqual([x !== 1, y !== 1]);
        const nearX = patch[4] + patch[6] * (x === 0 ? 1 : x === 2 ? 0 : 0.5);
        const nearY = patch[5] + patch[7] * (y === 0 ? 1 : y === 2 ? 0 : 0.5);
        const [sourceX, sourceY] = sourceAt(patch, nearX, nearY);
        expect(sourceX).toBeCloseTo(x === 0 ? 0 : x === 2 ? 360 : 180);
        expect(sourceY).toBeCloseTo(y === 0 ? 0 : y === 2 ? 480 : 240);
      }
    }
  });

  it("容器变宽和封面右移只改变投射位置，不改变源边条", () => {
    const before = createMotionCoverEdgeProjection(input)!;
    const after = createMotionCoverEdgeProjection({
      ...input,
      viewportWidth: 1200,
      content: { ...input.content, left: 300 },
    })!;
    expect(after.patches.map((patch) => patch.slice(0, 4))).toEqual(
      before.patches.map((patch) => patch.slice(0, 4)),
    );
    const beforeLeft = before.patches[3];
    const afterLeft = after.patches[3];
    expect((beforeLeft[4] + beforeLeft[6]) * (1088 / before.canvasWidth)).toBeCloseTo(362);
    expect((afterLeft[4] + afterLeft[6]) * (1488 / after.canvasWidth)).toBeCloseTo(462);
    expect(after.nearBounds.left - before.nearBounds.left).toBe(100);
  });

  it("方形源与极小前景仍保留比例和透明中心", () => {
    expectPerimeter({
      ...input,
      sourceWidth: 480,
      sourceHeight: 480,
      content: { left: 200, top: 100, width: 300, height: 300 },
    });
    const tiny = expectPerimeter({
      ...input,
      content: { ...input.content, width: 20, height: 12 },
    });
    const centerTop = tiny.patches[1];
    expect(centerTop[4] * (1088 / tiny.canvasWidth)).toBeCloseTo(349);
    expect(centerTop[6] * (1088 / tiny.canvasWidth)).toBeCloseTo(10);
  });

  it.each(["sourceWidth", "sourceHeight", "viewportWidth", "viewportHeight"] as const)(
    "%s 为零时不生成投射",
    (dimension) => {
      expect(createMotionCoverEdgeProjection({ ...input, [dimension]: 0 })).toBeNull();
    },
  );

  it.each(["width", "height"] as const)("前景 %s 非正时不生成投射", (dimension) => {
    expect(
      createMotionCoverEdgeProjection({
        ...input,
        content: { ...input.content, [dimension]: -1 },
      }),
    ).toBeNull();
  });
});
