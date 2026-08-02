import type { ArtifactFile } from "../../../shared/types";

interface Props {
  artifacts: ArtifactFile[];
  onClose: () => void;
  onRefresh: () => void;
}

const ICONS: Record<string, string> = {
  md: "📝",
  txt: "📄",
  pdf: "📕",
  doc: "📘",
  docx: "📘",
  xls: "📊",
  xlsx: "📊",
  csv: "📊",
  png: "🖼",
  jpg: "🖼",
  jpeg: "🖼",
  gif: "🖼",
  svg: "🖼",
  html: "🌐",
  htm: "🌐",
  json: "⚙️",
  js: "⚙️",
  ts: "⚙️",
  py: "⚙️",
  zip: "🗜",
};

export function ArtifactsPanel({ artifacts, onClose }: Props): React.ReactElement {
  return (
    <aside className="artifacts">
      <div className="artifacts-head">
        <span>Artifacts</span>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      {artifacts.length === 0 ? (
        <p className="artifacts-empty">Files produced in this session appear here.</p>
      ) : (
        <ul className="artifact-list">
          {artifacts.map((a) => (
            <li key={a.absolutePath} className="artifact-item">
              <div className="artifact-main">
                <span className="artifact-icon">{ICONS[a.ext] ?? "📄"}</span>
                <div className="artifact-meta">
                  <div className="artifact-name" title={a.relativePath}>
                    {a.relativePath}
                  </div>
                  <div className="artifact-sub">{formatSize(a.size)}</div>
                </div>
              </div>
              <div className="artifact-actions">
                <button
                  className="icon-btn"
                  title="Open"
                  onClick={() => window.deepwork.artifacts.open(a.absolutePath)}
                >
                  ↗
                </button>
                <button
                  className="icon-btn"
                  title="Reveal in Finder"
                  onClick={() => window.deepwork.artifacts.reveal(a.absolutePath)}
                >
                  ⌕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
