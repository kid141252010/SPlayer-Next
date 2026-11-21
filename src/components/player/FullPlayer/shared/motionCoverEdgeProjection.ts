export interface MotionCoverBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MotionCoverProjectionInput {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  content: MotionCoverBounds;
  feather: number;
}

export type MotionCoverEdgePatch = readonly [
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  flipX: boolean,
  flipY: boolean,
];

export interface MotionCoverEdgeProjection {
  canvasWidth: number;
  canvasHeight: number;
  patches: readonly MotionCoverEdgePatch[];
  nearBounds: MotionCoverBounds;
}

export const MOTION_COVER_EDGE_OVERSCAN = 144;
export const MOTION_COVER_NEAR_RADIUS = 48;

/** 仅将视频外围八格沿各自法线镜像投射，中心保持透明。 */
export function createMotionCoverEdgeProjection({
  sourceWidth,
  sourceHeight,
  viewportWidth,
  viewportHeight,
  content,
  feather,
}: MotionCoverProjectionInput): MotionCoverEdgeProjection | null {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    content.width <= 0 ||
    content.height <= 0
  ) {
    return null;
  }

  const logicalWidth = viewportWidth + MOTION_COVER_EDGE_OVERSCAN * 2;
  const logicalHeight = viewportHeight + MOTION_COVER_EDGE_OVERSCAN * 2;
  const backingScale = 384 / Math.max(logicalWidth, logicalHeight);
  const canvasWidth = Math.max(1, Math.round(logicalWidth * backingScale));
  const canvasHeight = Math.max(1, Math.round(logicalHeight * backingScale));
  const scaleX = canvasWidth / logicalWidth;
  const scaleY = canvasHeight / logicalHeight;
  const left = content.left + MOTION_COVER_EDGE_OVERSCAN;
  const top = content.top + MOTION_COVER_EDGE_OVERSCAN;
  const fx = Math.min(feather, content.width / 4);
  const fy = Math.min(feather, content.height / 4);
  const sourceX = [0, sourceWidth * 0.08, sourceWidth * 0.92, sourceWidth];
  const sourceY = [0, sourceHeight * 0.08, sourceHeight * 0.92, sourceHeight];
  const targetX = [0, left + fx, left + content.width - fx, logicalWidth];
  const targetY = [0, top + fy, top + content.height - fy, logicalHeight];
  const patches: MotionCoverEdgePatch[] = [];

  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      if (x === 1 && y === 1) continue;
      patches.push([
        sourceX[x],
        sourceY[y],
        sourceX[x + 1] - sourceX[x],
        sourceY[y + 1] - sourceY[y],
        targetX[x] * scaleX,
        targetY[y] * scaleY,
        (targetX[x + 1] - targetX[x]) * scaleX,
        (targetY[y + 1] - targetY[y]) * scaleY,
        x !== 1,
        y !== 1,
      ]);
    }
  }

  return {
    canvasWidth,
    canvasHeight,
    patches,
    nearBounds: {
      left: left - MOTION_COVER_NEAR_RADIUS,
      top: top - MOTION_COVER_NEAR_RADIUS,
      width: content.width + MOTION_COVER_NEAR_RADIUS * 2,
      height: content.height + MOTION_COVER_NEAR_RADIUS * 2,
    },
  };
}
