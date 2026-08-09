import zhCN from "./zh-CN";
import enUS from "./en-US";

/**
 * Translation resources shared by the renderer (react-i18next) and the main
 * process (plain i18next). English (en-US) is the source/canonical locale;
 * add or change keys there first, then mirror them in zh-CN. Add a new locale
 * by appending it here and to SUPPORTED_LOCALES.
 */
export const resources = {
  "en-US": { translation: enUS },
  "zh-CN": { translation: zhCN },
} as const;

export type AppLocale = keyof typeof resources;
export const SUPPORTED_LOCALES: AppLocale[] = ["en-US", "zh-CN"];
export const DEFAULT_LOCALE: AppLocale = "en-US";
export const FALLBACK_LOCALE: AppLocale = "en-US";
