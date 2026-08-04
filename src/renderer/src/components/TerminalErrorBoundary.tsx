import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClose: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Isolates the terminal panel from the rest of the app. If xterm.js throws
 * during mount/update (e.g. on a layout edge case in a new major version),
 * we show a small error box instead of letting the error unmount the whole
 * React root — which would blank the entire window.
 */
export class TerminalErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[Terminal] panel crashed:", error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="terminal-panel">
          <div className="terminal-bar">
            <span className="terminal-title">终端</span>
            <button className="icon-btn" onClick={this.props.onClose} title="关闭终端">
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
          <div className="terminal-error">终端组件出错：{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
