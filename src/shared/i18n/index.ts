import zhCN from "./zh-CN";
import enUS from "./en-US";

/**
 * Translation resources shared by the renderer (react-i18next) and the main
 * process (plain i18next). Add a new locale by appending it here and to
 * SUPPORTED_LOCALES.
 */
export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
} as const;

export type AppLocale = keyof typeof resources;
export const SUPPORTED_LOCALES: AppLocale[] = ["zh-CN", "en-US"];
export const DEFAULT_LOCALE: AppLocale = "zh-CN";
export const FALLBACK_LOCALE: AppLocale = "zh-CN";
