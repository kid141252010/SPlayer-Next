import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import type { ExternalApiStatus } from "@shared/types/settings";
import zhCN from "@/i18n/locales/zh-CN.json";
import ExternalApiStatusCard from "./ExternalApiStatusCard.vue";
import McpStatusCard from "./McpStatusCard.vue";

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    system: {
      externalApi: { enabled: true, allowLan: false, port: 25600 },
      mcp: { enabled: true, port: 25601 },
    },
  }),
}));
vi.mock("@/composables/useCopyText", () => ({ useCopyText: () => ({ copy: vi.fn() }) }));
vi.mock("@/composables/useToast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const runningStatus = (port: number): ExternalApiStatus => ({
  listening: true,
  allowLan: false,
  host: "127.0.0.1",
  port,
  error: null,
});

const createService = () => {
  const snapshot = Promise.withResolvers<ExternalApiStatus>();
  const listeners = new Set<(status: ExternalApiStatus) => void>();
  const onStatus = vi.fn((listener: (status: ExternalApiStatus) => void) => {
    listeners.add(listener);
    return vi.fn(() => listeners.delete(listener));
  });
  return {
    snapshot,
    listeners,
    getStatus: vi.fn(() => snapshot.promise),
    onStatus,
    restart: vi.fn(async () => runningStatus(3000)),
    emit: (status: ExternalApiStatus) => {
      for (const listener of listeners) listener(status);
    },
  };
};

// 已卸载组件没有渲染副作用，直接读取真实 setup 状态以检查迟到快照是否仍写入。
interface StatusCardInstance {
  status: ExternalApiStatus;
}

// script setup 的内部状态未列入公开实例类型，测试代理仍保留该访问入口。
const statusOf = (wrapper: VueWrapper): ExternalApiStatus => {
  const instance = wrapper.vm as unknown as StatusCardInstance;
  return instance.status;
};

for (const { key, component } of [
  { key: "externalApi", component: ExternalApiStatusCard },
  { key: "mcp", component: McpStatusCard },
] as const) {
  describe(`${key} 状态卡片订阅生命周期`, () => {
    let service = createService();
    const mounted = new Set<VueWrapper>();

    const render = () => {
      const wrapper = mount(component, {
        global: {
          plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
          stubs: { SButton: true },
        },
      });
      mounted.add(wrapper);
      return wrapper;
    };

    const unmount = (wrapper: VueWrapper) => {
      wrapper.unmount();
      mounted.delete(wrapper);
    };

    beforeEach(() => {
      service = createService();
      vi.stubGlobal("api", { externalApi: service, mcp: service });
    });

    afterEach(() => {
      for (const wrapper of mounted) wrapper.unmount();
      mounted.clear();
      vi.unstubAllGlobals();
    });

    it("初始 IPC 未完成时已订阅，先卸载再返回快照不会写状态或重新绑定", async () => {
      const wrapper = render();
      expect(service.getStatus).toHaveBeenCalledOnce();
      expect(service.onStatus).toHaveBeenCalledOnce();
      expect(service.listeners.size).toBe(1);
      expect(wrapper.text()).toContain(zhCN.settings[key].stopped);

      unmount(wrapper);
      expect(service.listeners.size).toBe(0);
      expect(service.onStatus.mock.results[0].value).toHaveBeenCalledOnce();
      service.snapshot.resolve(runningStatus(3001));
      await flushPromises();

      expect(service.onStatus).toHaveBeenCalledOnce();
      expect(service.listeners.size).toBe(0);
      expect(statusOf(wrapper)).toMatchObject({ listening: false, port: null });
    });

    it("快照正常返回后展示真实状态，卸载只调用自己的取消订阅", async () => {
      const wrapper = render();
      service.snapshot.resolve(runningStatus(3002));
      await flushPromises();
      expect(wrapper.text()).toContain(zhCN.settings[key].running);
      expect(wrapper.text()).toContain("http://127.0.0.1:3002");

      unmount(wrapper);
      expect(service.onStatus.mock.results[0].value).toHaveBeenCalledOnce();
      expect(service.listeners.size).toBe(0);
      service.emit(runningStatus(3003));
      await flushPromises();
      expect(statusOf(wrapper).port).toBe(3002);
    });

    it("两个同时挂载的消费者独立更新，卸载一个不影响另一个", async () => {
      const first = render();
      const second = render();
      service.snapshot.resolve(runningStatus(3004));
      await flushPromises();
      expect(service.listeners.size).toBe(2);
      service.emit(runningStatus(3005));
      await flushPromises();
      expect(first.text()).toContain("http://127.0.0.1:3005");
      expect(second.text()).toContain("http://127.0.0.1:3005");

      unmount(first);
      expect(service.listeners.size).toBe(1);
      expect(service.onStatus.mock.results[0].value).toHaveBeenCalledOnce();
      expect(service.onStatus.mock.results[1].value).not.toHaveBeenCalled();
      service.emit(runningStatus(3006));
      await flushPromises();

      expect(second.text()).toContain("http://127.0.0.1:3006");
      expect(statusOf(first).port).toBe(3005);
      unmount(second);
      expect(service.listeners.size).toBe(0);
      expect(service.onStatus.mock.results[1].value).toHaveBeenCalledOnce();
    });

    it("等待初始快照时已经收到的 push 不被迟到的旧快照覆盖", async () => {
      const wrapper = render();
      service.emit(runningStatus(3007));
      await flushPromises();
      expect(wrapper.text()).toContain(zhCN.settings[key].running);
      expect(wrapper.text()).toContain("http://127.0.0.1:3007");

      service.snapshot.resolve({ ...runningStatus(3008), listening: false });
      await flushPromises();

      expect(wrapper.text()).toContain(zhCN.settings[key].running);
      expect(wrapper.text()).toContain("http://127.0.0.1:3007");
      expect(wrapper.text()).not.toContain("3008");
      expect(service.listeners.size).toBe(1);
    });
  });
}
