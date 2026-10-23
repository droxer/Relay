import i18n from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";
import publicEn from "./locales/en/public.json";

/* Only the public surfaces' English is bundled with the page: the landing
   page, sign-in, waitlist, password reset, and the auth gate — every string
   a visitor can see before the app's chunk arrives (locales/en/public.json,
   kept equal to those namespaces in translation.json by
   tests/i18nPublicBundle.test.ts). English is the default and the fallback,
   so it must be there before the first paint; the rest of the catalogue
   (~35 KB gzipped) rides the app chunk instead (./app.ts), where it is
   registered before any signed-in surface renders. The Chinese catalogue
   loads when a user switches to it — callers already await changeLanguage,
   which resolves once the catalogue arrives. */
const LAZY_CATALOGUES: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  "zh-CN": () => import("./locales/zh-CN/translation.json"),
};

void i18n
  .use(resourcesToBackend(async (language: string) => {
    const load = LAZY_CATALOGUES[language];
    // English has nothing to fetch: the public part is bundled and the app
    // part is added by the app chunk.
    return load ? (await load()).default : {};
  }))
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN"],
    resources: { en: { translation: publicEn } },
    // Keep the bundled English while still loading other languages lazily.
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
  });

export default i18n;
