import i18n from "./index";
import en from "./locales/en/translation.json";

/* The whole English catalogue, registered the moment the app chunk
   evaluates — before any signed-in surface renders — so no component ever
   reads a key the page's bundled public subset lacks. Imported for its side
   effect by App.tsx; the page itself never loads this module. */
i18n.addResourceBundle("en", "translation", en, true, true);

/** Whether the app catalogue is registered (true once this module ran). */
export function hasAppCatalogue(): boolean {
  return i18n.hasResourceBundle("en", "translation") && typeof i18n.getResource("en", "translation", "nav") === "object";
}
