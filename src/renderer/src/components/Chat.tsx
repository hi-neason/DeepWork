import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "../App";
import type { ApprovalMode, McpServerConfig } from "../../../shared/types";
import { Markdown } from "./Markdown";

interface Props {
  sessionId: string | null;
  chat: ChatState;
  mcpServers: McpServerConfig[];
  approvalMode: ApprovalMode;
  onSend: (text: string) => void;
  onRegenerate: () => void;
  onToggleMode: () => void;
  onNewSession: () => void;
}

export function Chat({
  sessionId,
  chat,
  mcpServers,
  approvalMode,
  onSend,
  onRegenerate,
  onToggleMode,
  onNewSession,
}: Props): React.ReactElement {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  const submit = (): void => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    setInput("");
    void onSend(text);
  };

  const copy = (content: string): void => {
    void navigator.clipboard?.writeText(content);
  };

  const enabledMcp = useMemo(() => mcpServers.filter((m) => m.enabled), [mcpServers]);
  const canRegenerate = !chat.streaming && chat.timeline.some((t) => t.kind === "msg" && t.role === "assistant");

  const placeholder = sessionId
    ? "Message DeepWork…  (Enter to send, Shift+Enter for newline)"
    : "Ask anything — a new chat starts automatically";

  return (
    <>
      <div className="topbar">
        <span className="title">{sessionId ? "Chat" : "DeepWork"}</span>
      </div>
      <div className="chat" ref={scrollRef}>
        {!sessionId ? (
          <div className="empty">
            <h2>DeepWork</h2>
            <p>Your local desktop AI agent.</p>
            <button className="new-chat" style={{ marginTop: 12 }} onClick={onNewSession}>
              Start a chat
            </button>
          </div>
        ) : (
          chat.timeline.map((item, i) => {
            if (item.kind === "msg") {
              const isAssistant = item.role === "assistant";
              return (
                <div key={i} className={`msg ${item.role}`}>
                  <div className="role">{item.role}</div>
                  <div className="bubble">
                    {isAssistant ? <Markdown content={item.content} /> : item.content}
                  </div>
                  {isAssistant && (
                    <div className="msg-actions">
                      <button title="Copy" onClick={() => copy(item.content)}>
                        ⧉
                      </button>
                      <button title="Regenerate" onClick={onRegenerate} disabled={!canRegenerate}>
                        ↻
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            const t = chat.tools[item.id];
            if (!t) return null;
            return (
              <div key={i} className={`tool-card ${t.isError ? "error" : ""}`}>
                <div className="inner">
                  <div>
                    {t.status === "running" ? "⏳ " : t.isError ? "✕ " : "✓ "}
                    <span className="tname">{t.name}</span>
                  </div>
                  <div className="targs">{t.argsPreview}</div>
                  {t.outputPreview && (
                    <div className="targs" style={{ marginTop: 4 }}>
                      → {t.outputPreview}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        {chat.error && (
          <div className="msg">
            <div className="bubble" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              {chat.error}
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        <div className="composer-box">
          <textarea
            value={input}
            placeholder={placeholder}
            autoFocus
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-left">
              <button className="icon-btn" title="Commands and skills (/)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M3 12h18"/></svg>
              </button>
              <button className="icon-btn" title="Attach file">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              <span className="cap-chip" title="Screen capture & GUI control">🖥</span>
              {enabledMcp.length > 0 && (
                <span className="cap-chip" title={`${enabledMcp.length} MCP plugins enabled`}>
                  🧩 <span className="cap-count">+{enabledMcp.length}</span>
                </span>
              )}
            </div>
            <div className="composer-right">
              <button
                className={`mode-toggle ${approvalMode === "auto" ? "auto" : ""}`}
                onClick={onToggleMode}
                title="Toggle approval mode"
              >
                <span className="dot" />
                {approvalMode === "auto" ? "Auto Mode" : "Manual Mode"}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <button className="send-btn" onClick={submit} disabled={chat.streaming || !input.trim()} title="Send">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
