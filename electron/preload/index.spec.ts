import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      Object.defineProperty(window, name, { configurable: true, value });
    },
  },
  ipcRenderer: ipc,
  webUtils: { getPathForFile: vi.fn() },
}));
vi.mock("@electron-toolkit/preload", () => ({ electronAPI: {} }));

let events: EventEmitter;
let originalApi: PropertyDescriptor | undefined;
let originalElectron: PropertyDescriptor | undefined;
let originalContextIsolation: PropertyDescriptor | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  originalElectron = Object.getOwnPropertyDescriptor(window, "electron");
  originalContextIsolation = Object.getOwnPropertyDescriptor(process, "contextIsolated");
  Object.defineProperty(process, "contextIsolated", { configurable: true, value: true });
  events = new EventEmitter();
  ipc.on.mockImplementation((channel: string, handler: (...args: unknown[]) => void) =>
    events.on(channel, handler),
  );
  ipc.removeListener.mockImplementation((channel: string, handler: (...args: unknown[]) => void) =>
    events.removeListener(channel, handler),
  );
  ipc.removeAllListeners.mockImplementation((channel: string) =>
    events.removeAllListeners(channel),
  );
  await import("./index");
});

afterEach(() => {
  events.removeAllListeners();
  if (originalApi) Object.defineProperty(window, "api", originalApi);
  else Reflect.deleteProperty(window, "api");
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else Reflect.deleteProperty(window, "electron");
  if (originalContextIsolation) {
    Object.defineProperty(process, "contextIsolated", originalContextIsolation);
  } else {
    Reflect.deleteProperty(process, "contextIsolated");
  }
});

type TestCallback = (data: unknown) => void;
type TestApi = {
  automix: { onStatus: (callback: TestCallback) => () => void };
  player: { onEvent: (callback: TestCallback) => () => void };
  download: { onResolve: (callback: TestCallback) => () => void };
  streaming: {
    onFavoriteChanged: (callback: TestCallback) => () => void;
    onSyncState: (callback: TestCallback) => () => void;
    onLibraryUpdated: (callback: TestCallback) => () => void;
  };
  recognition: { onEvent: (callback: TestCallback) => () => void };
  externalApi: { onStatus: (callback: TestCallback) => () => void };
  mcp: { onStatus: (callback: TestCallback) => () => void };
};
// preload 测试通过 contextBridge 动态注入 api，TypeScript 不加载运行时声明。
const windowWithApi = window as unknown as { api: TestApi };
const testApi = (): TestApi => windowWithApi.api;

const subscriptions: Array<{
  channel: string;
  subscribe: (callback: TestCallback) => () => void;
}> = [
  {
    channel: "automix:componentStatus",
    subscribe: (callback) => testApi().automix.onStatus(callback),
  },
  { channel: "player:event", subscribe: (callback) => testApi().player.onEvent(callback) },
  {
    channel: "download:resolve",
    subscribe: (callback) => testApi().download.onResolve(callback),
  },
  {
    channel: "streaming:favoriteChanged",
    subscribe: (callback) => testApi().streaming.onFavoriteChanged(callback),
  },
  {
    channel: "streaming:syncState",
    subscribe: (callback) => testApi().streaming.onSyncState(callback),
  },
  {
    channel: "streaming:libraryUpdated",
    subscribe: (callback) => testApi().streaming.onLibraryUpdated(callback),
  },
  {
    channel: "recognition:event",
    subscribe: (callback) => testApi().recognition.onEvent(callback),
  },
  {
    channel: "externalApi:status",
    subscribe: (callback) => testApi().externalApi.onStatus(callback),
  },
  { channel: "mcp:status", subscribe: (callback) => testApi().mcp.onStatus(callback) },
];

describe("preload 订阅的消费者所有权", () => {
  it.each(subscriptions)(
    "$channel 的新增订阅与单方解绑不影响其他消费者",
    ({ channel, subscribe }) => {
      let firstUpdates = 0;
      let secondUpdates = 0;
      const unsubscribeFirst = subscribe(() => firstUpdates++);
      const unsubscribeSecond = subscribe(() => secondUpdates++);

      events.emit(channel, {}, {});
      expect([firstUpdates, secondUpdates]).toEqual([1, 1]);
      unsubscribeFirst();
      events.emit(channel, {}, {});
      expect([firstUpdates, secondUpdates]).toEqual([1, 2]);
      unsubscribeSecond();
      events.emit(channel, {}, {});
      expect([firstUpdates, secondUpdates]).toEqual([1, 2]);
      expect(events.listenerCount(channel)).toBe(0);
    },
  );
});
