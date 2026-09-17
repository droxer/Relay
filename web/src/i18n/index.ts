import i18n from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";

/* English is bundled: it is the default and the fallback, so it must be there
   before the first paint. The Chinese catalogues are ~24 KB gzipped each and
   were bundled too, so every user downloaded and parsed two languages they
   were not reading. They now load when a user switches to one — callers
   already await changeLanguage, which resolves once the catalogue arrives. */
const LAZY_CATALOGUES: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  "zh-CN": () => import("./locales/zh-CN/translation.json"),
  "zh-TW": () => import("./locales/zh-TW/translation.json"),
};

void i18n
  .use(resourcesToBackend(async (language: string) => {
    const load = LAZY_CATALOGUES[language];
    return load ? (await load()).default : en;
  }))
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN", "zh-TW"],
    resources: { en: { translation: en } },
    // Keep the bundled English without asking the backend for it again.
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
  });

export default i18n;
