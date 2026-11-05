import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import enUS from "./locales/en-US.json";

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "en-US",
  messages: {
    "zh-CN": zhCN,
    "zh-TW": zhTW,
    "en-US": enUS,
  },
});

export default i18n;
