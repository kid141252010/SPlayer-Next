import type { JocControls } from "@shared/types/joc";
import type { View } from "@/components/player/SpatialScene/math";
import { gainsFor } from "@/components/player/SpatialScene/math";

export interface SpatialControls extends JocControls {
  solo: number[];
  mute: number[];
}
export interface SpatialView {
  view: View;
  tour: boolean;
  walk: boolean;
  look: boolean;
  locked: boolean;
  stickOn: boolean;
}

/** 空间场景控制跨曲目与弹窗保存，不写入持久化存储 */
export const useSpatialStore = defineStore("spatial", () => {
  const open = ref(false);
  const controls = reactive<SpatialControls>({
    yaw: 0,
    pitch: 0,
    roll: 0,
    x: 0,
    y: 0,
    z: 0,
    focus: 0,
    height: 1,
    gains: Array(16).fill(1),
    solo: [],
    mute: [],
  });
  const view = reactive<SpatialView>({
    view: "orbit",
    tour: false,
    walk: false,
    look: false,
    locked: false,
    stickOn: false,
  });
  const revision = ref(0);

  /** 更新交互参数并重算独奏或静音的通道增益 */
  function update(patch: Partial<SpatialControls>): void {
    Object.assign(controls, patch);
    if (patch.solo || patch.mute) controls.gains = gainsFor(controls.solo, controls.mute);
    revision.value++;
  }
  return { open, controls, view, revision, update };
});
