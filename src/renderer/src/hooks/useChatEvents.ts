import { useEffect } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { DeepWorkEvent, TodoItem, ArtifactFile } from "../../../shared/types";
import type { ChatAction } from "../state/chatState";

interface Options {
  sessionIdRef: MutableRefObject<string | null>;
  dispatch: Dispatch<ChatAction>;
  poke: () => void;
  refreshSessions: () => Promise<void>;
  setApproval: (event: DeepWorkEvent | null) => void;
  setTodos: (todos: TodoItem[]) => void;
  setArtifacts: (artifacts: ArtifactFile[]) => void;
}

export function useChatEvents(options: Options): void {
  const { sessionIdRef, dispatch, poke, refreshSessions, setApproval, setTodos, setArtifacts } = options;
  useEffect(() => window.deepwork.chat.onAnyEvent((sessionId, event) => {
    if (sessionId !== sessionIdRef.current) return;
    poke();
    if (event.type === "approval_requested") setApproval(event);
    if (event.type === "turn_state" && !["running", "waiting_approval", "cancelling"].includes(event.status.state)) setApproval(null);
    if (event.type === "session_renamed") void refreshSessions();
    if (event.type === "todos_updated") setTodos(event.todos);
    if (event.type === "artifacts_updated") setArtifacts(event.artifacts);
    dispatch({ type: "event", event });
  }), [dispatch, poke, refreshSessions, sessionIdRef, setApproval, setArtifacts, setTodos]);
}
