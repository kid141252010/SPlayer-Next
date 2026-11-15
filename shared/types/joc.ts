import type { JsJocControls, JsJocStatus } from "../../native/audio-engine";

/** 杜比全景声对象渲染模式 */
export type JocMode = "off" | "speaker" | "binaural";

/** 随应用打包的 HRTF 标识 */
export const JOC_HRTFS = [
  "D1",
  "D2",
  "H3",
  "H4",
  "H5",
  "H6",
  "H7",
  "H8",
  "H9",
  "H10",
  "H11",
  "H12",
  "H13",
  "H14",
  "H15",
  "H16",
  "H17",
  "H18",
  "H19",
  "H20",
] as const;

/** 持久化对象渲染配置 */
export interface JocSettings {
  mode: JocMode;
  hrtf: (typeof JOC_HRTFS)[number];
  gainDb: number;
}

/** 原生交互参数，角度单位为弧度、位移单位为米 */
export type JocControls = JsJocControls;

/** 原生渲染状态 */
export type JocStatus = JsJocStatus;
