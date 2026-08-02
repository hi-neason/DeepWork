import { useEffect, useState } from "react";
import type { MemoryItem } from "../../../../shared/types";

export function MemoryTab(): React.ReactElement {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [text, setText] = useState("");

  const refresh = async (): Promise<void> => {
    setMemories(await window.deepwork.memories.list());
  };
  useEffect(() => {
    void refresh();
  }, []);

  const add = async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;
    await window.deepwork.memories.add(content);
    setText("");
    await refresh();
  };

  const remove = async (id: string): Promise<void> => {
    await window.deepwork.memories.remove(id);
    await refresh();
  };

  return (
    <div className="settings-section">
      <h2>记忆</h2>
      <p className="section-desc">
        跨会话长期记住的事实和偏好。每次对话开始时会注入到系统提示中。
      </p>

      <div className="setting-card">
        <div className="field">
          <label>添加一条记忆</label>
          <div className="row">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder="例如：用户习惯用中文回答，偏好简洁的结论。"
            />
            <button className="btn primary" onClick={add}>
              添加
            </button>
          </div>
        </div>

        <div className="memory-list">
          {memories.length === 0 && (
            <p className="setting-hint">还没有记忆。agent 在对话中也可以使用 remember 工具自动保存。</p>
          )}
          {memories.map((m) => (
            <div key={m.id} className="memory-item">
              <span>{m.content}</span>
              <button className="icon-btn" onClick={() => remove(m.id)} title="忘记">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
