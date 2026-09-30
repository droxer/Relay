import i18n from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";

/* English is bundled: it is the default and the fallback, so it must be there
   before the first paint. The Chinese catalogue is ~24 KB gzipped and was
   bundled too, so every user downloaded and parsed a language they might not
   be reading. It now loads when a user switches to it — callers already await
   changeLanguage, which resolves once the catalogue arrives. */
const LAZY_CATALOGUES: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  "zh-CN": () => import("./locales/zh-CN/translation.json"),
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
    supportedLngs: ["en", "zh-CN"],
    resources: { en: { translation: en } },
    // Keep the bundled English without asking the backend for it again.
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
  });

export default i18n;
