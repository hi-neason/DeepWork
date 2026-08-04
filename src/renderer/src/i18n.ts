import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  resources,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
} from "../../shared/i18n";

// Renderer-side i18n instance (React-bound). Importing this module initializes
// it; change the active language via i18n.changeLanguage(locale).
i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
