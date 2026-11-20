/**
 * 动态封面 IPC
 */

import { ipcMain } from "electron";
import { resolveMotionCover } from "@main/services/motionCover";
import type { MotionCoverSource, MotionCoverVariant, Track } from "@shared/types/player";

export const registerMotionCoverIpc = (): void => {
  ipcMain.handle(
    "motionCover:resolve",
    (_evt, track: Track, source: MotionCoverSource, variant?: MotionCoverVariant) =>
      resolveMotionCover(track, source, variant),
  );
};
