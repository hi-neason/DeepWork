import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../App";

interface Props {
  sessionId: string | null;
  chat: ChatState;
  onSend: (text: string) => void;
  onNewSession: () => void;
}

export function Chat({ sessionId, chat, onSend, onNewSession }: Props): React.ReactElement {
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
              return (
                <div key={i} className={`msg ${item.role}`}>
                  <div className="role">{item.role}</div>
                  <div className="bubble">{item.content}</div>
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
        <div className="composer-inner">
          <textarea
            value={input}
            placeholder={sessionId ? "Message DeepWork…" : "Start a chat first"}
            disabled={!sessionId}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button onClick={submit} disabled={!sessionId || chat.streaming || !input.trim()}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}
