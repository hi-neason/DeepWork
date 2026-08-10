import type { Settings } from "../../../shared/types";

/**
 * Apply the selected theme and font scale to <html>. Theme "auto" follows the
 * OS prefers-color-scheme; light/dark force a data-theme attribute.
 *
 * Font scaling changes the root `font-size` (the rem baseline). All
 * user-facing font sizes in the stylesheet are expressed in rem (relative to
 * a 16px baseline), so adjusting this value scales text without affecting
 * layout dimensions (padding/widths stay in px). The 0.9–1.3 slider maps to
 * 14.4px–20.8px root size.
 */
export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = settings.theme === "dark" || (settings.theme === "auto" && systemDark);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  const scale = Math.min(1.3, Math.max(0.9, settings.fontScale ?? 1));
  root.style.fontSize = `${Math.round(scale * 16 * 100) / 100}px`;
  root.lang = settings.language ?? "zh-CN";
}

/** Subscribe to OS appearance changes while in "auto" mode. */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
