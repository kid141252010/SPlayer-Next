import { powerMonitor } from "electron";
import { appleMusicProxy } from "./proxyServer";
import { amDecryptor } from "./decryptor";

let resumeListener: (() => void) | null = null;

/**
 * 初始化 Apple Music 本地流媒体代理子系统
 */
export const initAppleMusicService = async (): Promise<void> => {
  void amDecryptor.warmup();
  await appleMusicProxy.start();

  resumeListener = () => {
    appleMusicProxy.onSystemResume();
  };
  powerMonitor.on("resume", resumeListener);
};

/**
 * 销毁并停止 Apple Music 本地流媒体代理子系统
 */
export const disposeAppleMusicService = (): void => {
  if (resumeListener) {
    powerMonitor.removeListener("resume", resumeListener);
    resumeListener = null;
  }
  appleMusicProxy.stop();
};

export { appleMusicProxy } from "./proxyServer";
export { amDecryptor } from "./decryptor";
