import { appleMusicProxy } from "./proxyServer";

/**
 * 初始化 Apple Music 本地流媒体代理子系统
 */
export const initAppleMusicService = async (): Promise<void> => {
  await appleMusicProxy.start();
};

/**
 * 销毁并停止 Apple Music 本地流媒体代理子系统
 */
export const disposeAppleMusicService = (): void => {
  appleMusicProxy.stop();
};

export { appleMusicProxy } from "./proxyServer";
export { amDecryptor } from "./decryptor";
