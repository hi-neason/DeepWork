import fs from "node:fs";
import path from "node:path";
import type { ArtifactFile } from "../../shared/types";
import { sessionArtifactsDir, hasPickedWorkspace, DEFAULT_WORKSPACE_DIR } from "../config/paths";
import { getSession } from "../storage/sessions";
import { loadSettings } from "../storage/settings";

/** List safe, user-facing files produced within one session's workspace. */
export function listSessionArtifacts(sessionId: string): ArtifactFile[] {
  const session = getSession(sessionId);
  if (session && hasPickedWorkspace(session.workspaceDir)) {
    return scanArtifacts(path.resolve(session.workspaceDir!), true);
  }
  const root = sessionArtifactsDir(sessionId, session?.workspaceDir);
  if (root) return scanArtifacts(root, false);
  const fallback = loadSettings().model.workspaceDir || DEFAULT_WORKSPACE_DIR;
  return fallback ? scanArtifacts(fallback, false) : [];
}

/**
 * Scan a bounded portion of a workspace for deliverables. Project scans omit
 * source and build trees, while isolated session workspaces expose user files.
 */
export function scanArtifacts(root: string, isProjectRoot = false): ArtifactFile[] {
  const out: ArtifactFile[] = [];
  const skipDirs = new Set([
    "node_modules", ".git", ".venv", "dist", "build", "out",
    "__pycache__", ".next", ".nuxt", ".angular", "target", ".deepwork",
    ...(isProjectRoot
      ? ["src", "lib", "app", "components", "hooks", "utils", "types",
          "pages", "views", "routes", "store", "tests", "__tests__",
          "test", "spec", "docs", ".idea", ".vscode", ".DS_Store"]
      : []),
  ]);
  const skipFiles = new Set([
    "deepwork.log", "package.json", "tsconfig.json", "vite.config.*",
    "tailwind.config*", "postcss.config*", "next.config*",
    ".gitignore", ".eslintrc*", ".prettierrc*", "README*", "LICENSE*",
    "go.mod", "go.sum", "Cargo.toml", "pom.xml", "build.gradle",
  ]);
  const skipExt = new Set(["log", ...(isProjectRoot
    ? ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "vue",
       "svelte", "css", "scss", "less", "json", "yaml", "yml", "toml",
       "lock", "mod", "sum"]
    : [])]);
  const isInternal = (name: string): boolean =>
    skipFiles.has(name) || (name.startsWith("call_") && name.endsWith(".txt"));
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.length > 300) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && !isInternal(entry.name) && !skipExt.has(path.extname(entry.name).slice(1))) {
        try {
          const stat = fs.statSync(full);
          out.push({
            name: entry.name,
            relativePath: path.relative(root, full),
            absolutePath: full,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            ext: path.extname(entry.name).slice(1).toLowerCase(),
          });
        } catch {
          // The file can disappear while the directory is being scanned.
        }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 100);
}
