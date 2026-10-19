/**
 * QM API 通用常量
 */

/** 统一接口入口（移动端 musicu） */
export const QM_API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

/** 模拟移动端的默认 headers */
export const QM_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Accept-Encoding": "gzip",
  "User-Agent": "QQMusic 14090508(android 12)",
  Referer: "https://y.qq.com",
};

/** 请求体 comm 字段（伪装 Android 客户端） */
export const getCommonParams = (): Record<string, string | number> => ({
  ct: "11",
  cv: "14090508",
  v: "14090508",
  tmeAppID: "qqmusic",
  phonetype: "EBG-AN10",
  deviceScore: "553.47",
  devicelevel: "50",
  newdevicelevel: "20",
  rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
  os_ver: "12",
  OpenUDID: "0",
  OpenUDID2: "0",
  QIMEI36: "0",
  udid: "0",
  chid: "0",
  aid: "0",
  oaid: "0",
  taid: "0",
  tid: "0",
  wid: "0",
  uid: "0",
  sid: "0",
  modeSwitch: "6",
  teenMode: "0",
  ui_mode: "2",
  nettype: "1020",
  v4ip: "",
  uin: "0",
});

/** Session 缓存时长（毫秒） */
export const SESSION_TTL = 60 * 60 * 1000;

/** 歌手数组格式化工具：`[{name:'A'},{name:'B'}]` → `A / B` */
export const formatSingerName = (
  singers: Array<{ name?: string; title?: string }> | undefined,
  key: "name" | "title" = "name",
  join = " / ",
): string => {
  if (!singers?.length) return "";
  return singers
    .map((item) => item[key])
    .filter((item): item is string => !!item)
    .join(join);
};
