import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

let termSeq = 0;

/** Build an xterm theme from the app's CSS custom properties so the terminal
 * matches the current light/dark appearance. */
function readTheme(): import("@xterm/xterm").ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--bg", "#1e1e22"),
    foreground: v("--text", "#e6e6ea"),
    cursor: v("--text", "#e6e6ea"),
    cursorAccent: v("--bg", "#1e1e22"),
    selectionBackground: v("--accent", "#6c8cff"),
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: v("--accent", "#6c8cff"),
    magenta: "#bc3fbc",
    cyan: "#0aaeb3",
    white: "#e6e6ea",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  };
}

export function TerminalPanel({
  cwd,
  onClose,
}: {
  cwd?: string;
  onClose: () => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const id = `term-${++termSeq}`;
    let term: XTerm | null = null;
    let fit: FitAddon | null = null;
    let offData: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    const onResize = (): void => {
      if (!term || !fit) return;
      try {
        fit.fit();
        void window.deepwork.terminal.resize(id, term.cols, term.rows);
      } catch {
        // ignore — pty may not be ready or size is transient
      }
    };

    // Defer initialization one frame so the container is laid out (non-zero
    // size) before xterm measures it. xterm 6 throws synchronously on a
    // zero-sized / not-yet-rendered element, which would otherwise tear down
    // the whole React tree — so everything here is guarded.
    const raf = requestAnimationFrame(() => {
      try {
        const node = containerRef.current;
        if (!node) return;
        term = new XTerm({
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          theme: readTheme(),
          convertEol: true,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(node);
        try {
          fit.fit();
          void window.deepwork.terminal.resize(id, term.cols, term.rows);
        } catch {
          // fit is best-effort; default 80x24 is fine
        }
        offData = window.deepwork.terminal.onData((tid, data) => {
          if (tid === id && term) term.write(data);
        });
        term.onData((d) => void window.deepwork.terminal.input(id, d));
        void window.deepwork.terminal
          .spawn(id, cwd ?? "")
          .catch((e: unknown) =>
            setError(t("terminal.startFailed", { message: String((e as Error)?.message ?? e) })),
          );
        window.addEventListener("resize", onResize);
        // Refit when the container is resized (e.g. the right panel is dragged).
        ro = new ResizeObserver(() => onResize());
        ro.observe(node);
      } catch (e) {
        setError(t("terminal.initFailed", { message: String((e as Error)?.message ?? e) }));
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      offData?.();
      void window.deepwork.terminal.kill(id);
      term?.dispose();
    };
    // Re-spawn the terminal when the working directory changes (e.g. the user
    // switches sessions). The cleanup below kills the old pty before the new
    // one is created, so the shell always opens in the current session's root.
  }, [cwd]);

  if (error) {
    return (
      <div className="terminal-panel">
        <div className="terminal-bar">
          <span className="terminal-title">{t("terminal.title")}</span>
          {cwd && <span className="terminal-cwd">{cwd}</span>}
          <button className="icon-btn" onClick={onClose} title={t("terminal.close")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="terminal-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-bar">
        <span className="terminal-title">{t("terminal.title")}</span>
        {cwd && <span className="terminal-cwd">{cwd}</span>}
        <button className="icon-btn" onClick={onClose} title={t("terminal.close")}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}
