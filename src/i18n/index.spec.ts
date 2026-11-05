import { afterEach, describe, expect, it } from "vitest";
import { LOCALES } from "@shared/types/settings";
import i18n from "./index";

describe("应用语言", () => {
  afterEach(() => {
    i18n.global.locale.value = "zh-CN";
  });

  it("注册繁体中文选项并可切换界面文案", () => {
    expect(LOCALES).toContainEqual({ value: "zh-TW", label: "繁體中文" });
    expect(i18n.global.availableLocales).toContain("zh-TW");

    i18n.global.locale.value = "zh-TW";

    expect(i18n.global.t("onboarding.preferences.title")).toBe("語言與主題");
  });
});
