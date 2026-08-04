import i18n from "i18next";
import {
  resources,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
} from "../shared/i18n";

/**
 * Main-process i18n instance (no React binding). Used for native UI such as
 * the tray menu and for translating agent error codes into the user's
 * selected language before they reach the renderer. The renderer keeps its own
 * react-i18next instance; both read the same shared resources.
 */
export const i18nReady = i18n.init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
