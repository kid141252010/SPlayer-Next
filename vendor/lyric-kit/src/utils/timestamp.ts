/**
 * 时间戳解析与格式化工具
 * 支持 LRC / TTML / SRT 等多种时间戳格式
 */

/** 最大时间戳（999:59.999） */
export const MAX_TIME = 60039999;

/**
 * 匹配方括号时间戳 [mm:ss] 及带 1~3 位小数的点号、冒号格式
 */
export const BRACKET_TIME_RE = /\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/g;

/**
 * 匹配尖括号时间戳 <mm:ss> 及带 1~3 位小数的点号、冒号格式
 */
export const ANGLE_TIME_RE = /<(\d+):(\d+)(?:[.:](\d{1,3}))?>([^<]*)/g;

/**
 * 将分、秒、毫秒字符串解析为毫秒数
 * @param min - 分钟字符串
 * @param sec - 秒字符串
 * @param ms - 毫秒字符串（1~3 位），省略时按零处理
 * @param padEndMs - 是否自动归一化毫秒位数，默认 true
 * @returns 毫秒数，不超过 MAX_TIME
 */
export const parseTime = (
  min: string,
  sec: string,
  ms: string = "0",
  padEndMs: boolean = true,
): number => {
  const minutes = parseInt(min, 10);
  const seconds = parseInt(sec, 10);
  let millis = parseInt(ms, 10) || 0;

  if (padEndMs) {
    if (ms.length === 1) millis *= 100;
    else if (ms.length === 2) millis *= 10;
  }

  return Math.min(minutes * 60_000 + seconds * 1000 + millis, MAX_TIME);
};

/**
 * 解析方括号时间戳字符串为毫秒数
 * @param tag - 完整的时间戳字符串，如 "[01:23.456]"
 * @returns 毫秒数，解析失败返回 -1
 */
export const parseBracketTag = (tag: string): number => {
  const match = /^\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]$/.exec(tag);
  if (!match) return -1;
  return parseTime(match[1], match[2], match[3]);
};

/**
 * 解析 TTML 时间戳为毫秒数
 * @param value - TTML 时间戳字符串（支持时分秒及 h / m / s / ms 单位）
 * @returns 毫秒数
 */
export const parseTTMLTime = (value: string): number => {
  const text = value.trim();
  if (!text) return 0;

  const offset = /^(\d+(?:\.\d+)?)(ms|h|m|s)$/.exec(text);
  if (offset) {
    const unit = offset[2];
    const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
    return Math.round(Number(offset[1]) * scale);
  }

  // 纯秒数不带冒号格式
  if (!text.includes(":")) {
    const num = Number(text);
    return Number.isNaN(num) ? 0 : Math.round(num * 1000);
  }

  // 冒号分隔的时分秒格式
  const parts = text.split(":");
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (Number.isNaN(min) || Number.isNaN(sec)) return 0;
    return Math.round((min * 60 + sec) * 1000);
  }
  if (parts.length === 3) {
    const hr = Number(parts[0]);
    const min = Number(parts[1]);
    const sec = Number(parts[2]);
    if (Number.isNaN(hr) || Number.isNaN(min) || Number.isNaN(sec)) return 0;
    return Math.round(((hr * 60 + min) * 60 + sec) * 1000);
  }
  if (parts.length >= 4) {
    const hr = Number(parts[0]);
    const min = Number(parts[1]);
    const sec = Number(parts[2]);
    const frames = Number(parts[3]);
    if (Number.isNaN(hr) || Number.isNaN(min) || Number.isNaN(sec)) return 0;
    // 兼容 TTML SMPTE 4 段式时间戳（HH:MM:SS:FF），未指定帧率时按 30fps 估算
    const frameMs = Number.isNaN(frames) ? 0 : Math.round((frames / 30) * 1000);
    return Math.round(((hr * 60 + min) * 60 + sec) * 1000) + frameMs;
  }

  return 0;
};

/**
 * 将数字左侧补零至 2 位
 * @param value - 原始数值
 * @returns 补零后的 2 位字符串
 */
const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * 将数字左侧补零至 3 位
 * @param value - 原始数值
 * @returns 补零后的 3 位字符串
 */
const pad3 = (value: number): string => String(value).padStart(3, "0");

/**
 * 将毫秒时间格式化为标准 LRC 时间戳字符串
 * @param ms - 毫秒数值
 * @returns 格式化后的 mm:ss.xx 字符串
 */
export const formatLrcTime = (ms: number): string => {
  const totalCs = Math.round(Math.max(0, ms) / 10);
  const cs = totalCs % 100;
  const totalSec = (totalCs - cs) / 100;
  const sec = totalSec % 60;
  const min = (totalSec - sec) / 60;
  return `${pad2(min)}:${pad2(sec)}.${pad2(cs)}`;
};

/**
 * 将毫秒时间格式化为 TTML 分秒毫秒时间戳字符串
 * @param ms - 毫秒数值
 * @returns 格式化后的 mm:ss.mmm 字符串
 */
export const formatTtmlTime = (ms: number): string => {
  const total = Math.max(0, Math.round(ms));
  const msPart = total % 1000;
  const totalSec = (total - msPart) / 1000;
  const sec = totalSec % 60;
  const min = (totalSec - sec) / 60;
  return `${pad2(min)}:${pad2(sec)}.${pad3(msPart)}`;
};

/**
 * 将毫秒时间格式化为 SRT 字幕时间戳字符串
 * @param ms - 毫秒数值
 * @returns 格式化后的 hh:mm:ss,mmm 字符串
 */
export const formatSrtTime = (ms: number): string => {
  const total = Math.max(0, Math.round(ms));
  const msPart = total % 1000;
  const totalSec = Math.floor(total / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hour = Math.floor(totalSec / 3600);
  return `${pad2(hour)}:${pad2(min)}:${pad2(sec)},${pad3(msPart)}`;
};
