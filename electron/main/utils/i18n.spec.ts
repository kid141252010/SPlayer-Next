import { afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "./i18n";

describe("主进程语言文案", () => {
  afterEach(() => {
    setLocale("zh-CN");
  });

  it("提供繁体中文托盘菜单文案", () => {
    expect(setLocale("zh-TW")).toBe(true);
    expect(getLocale()).toBe("zh-TW");
    expect(t("loginNetease")).toBe("登入 NCM");
    expect(t("openTaskbarLyric")).toBe("開啟工作列歌詞");
  });
});
