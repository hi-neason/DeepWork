import type { RiskLevel } from "../../../shared/types";

interface Props {
  name: string;
  risk: RiskLevel;
  argsPreview: string;
  isGuiTool: boolean;
  onAllow: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
}

export function ApprovalModal({
  name,
  risk,
  argsPreview,
  isGuiTool,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: Props): React.ReactElement {
  return (
    <div className="overlay">
      <div className="modal">
        <h3>
          Approval required <span className="risk">{risk}</span>
        </h3>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          The agent wants to run <strong style={{ color: "var(--text)" }}>{name}</strong>
          {isGuiTool ? " (a GUI action that will control your screen)" : ""}.
        </p>
        <pre>{argsPreview}</pre>
        <div className="actions">
          <button className="btn danger" onClick={onDeny}>
            Deny
          </button>
          {!isGuiTool && (
            <button className="btn" onClick={onAlwaysAllow}>
              Always allow this tool
            </button>
          )}
          <button className="btn primary" onClick={onAllow}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
