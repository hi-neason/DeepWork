import type { Settings } from "../../../shared/types";

/**
 * Apply the selected theme and font scale to <html>. Theme "auto" follows the
 * OS prefers-color-scheme; light/dark force a data-theme attribute.
 *
 * Font scaling uses CSS `zoom` rather than overriding the root `font-size`
 * (rem baseline): the app's stylesheet sets font sizes in px everywhere, so
 * changing the rem baseline had no visible effect. `zoom` scales px values
 * too, so the 0.9–1.3 slider actually resizes the UI. It is well-supported in
 * Chromium/Electron. We still set the root font-size as a rem baseline for
 * any future rem-based sizing.
 */
export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = settings.theme === "dark" || (settings.theme === "auto" && systemDark);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  const scale = Math.min(1.3, Math.max(0.9, settings.fontScale ?? 1));
  root.style.fontSize = `${Math.round(scale * 16)}px`;
  root.style.zoom = String(scale);
  root.lang = settings.language ?? "zh-CN";
}

/** Subscribe to OS appearance changes while in "auto" mode. */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
