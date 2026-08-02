import path from "node:path";
import fs from "node:fs";
import type { Skill } from "../../shared/types";
import { SKILLS_DIR } from "../config/paths";

const DISABLED_SUFFIX = ".disabled";

/** Directory holding all skills as `<skillsDir>/<skill-name>/SKILL.md`. */
export function skillsDir(): string {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  return SKILLS_DIR;
}

function frontmatter(body: string): Record<string, string> {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function buildSkillMd(skill: Pick<Skill, "name" | "description" | "body">): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body.replace(/\s+$/, "")}\n`;
}

function parseSkill(dir: string, name: string): Skill | null {
  const enabledPath = path.join(dir, name, "SKILL.md");
  const disabledPath = path.join(dir, name, "SKILL.md" + DISABLED_SUFFIX);
  let file = enabledPath;
  let enabled = true;
  if (!fs.existsSync(enabledPath)) {
    if (fs.existsSync(disabledPath)) {
      file = disabledPath;
      enabled = false;
    } else {
      return null;
    }
  }
  const raw = fs.readFileSync(file, "utf8");
  const fm = frontmatter(raw);
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const stat = fs.statSync(file);
  return {
    name,
    description: fm.description || "",
    body,
    enabled,
    updatedAt: stat.mtimeMs,
  };
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const s = parseSkill(dir, e.name);
    if (s) skills.push(s);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9一-龥-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || `skill-${Date.now()}`;
}

export function createSkill(input: { name: string; description?: string; body?: string }): Skill {
  const name = slugify(input.name);
  const dir = path.join(skillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  const content = buildSkillMd({
    name,
    description: input.description ?? "",
    body: input.body ?? "",
  });
  fs.writeFileSync(filePath, content, "utf8");
  return {
    name,
    description: input.description ?? "",
    body: input.body ?? "",
    enabled: true,
    updatedAt: Date.now(),
  };
}

export function updateSkill(
  name: string,
  patch: Partial<Pick<Skill, "description" | "body" | "enabled">>,
): Skill | null {
  const dir = path.join(skillsDir(), name);
  if (!fs.existsSync(dir)) return null;
  const current = parseSkill(skillsDir(), name);
  const next: Skill = {
    name,
    description: patch.description ?? current?.description ?? "",
    body: patch.body ?? current?.body ?? "",
    enabled: patch.enabled ?? current?.enabled ?? true,
    updatedAt: Date.now(),
  };
  // Remove both possible files before writing.
  for (const f of ["SKILL.md", "SKILL.md" + DISABLED_SUFFIX]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  const file = path.join(dir, "SKILL.md" + (next.enabled ? "" : DISABLED_SUFFIX));
  fs.writeFileSync(file, buildSkillMd(next), "utf8");
  return next;
}

export function deleteSkill(name: string): void {
  const dir = path.join(skillsDir(), name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Posix-style source path handed to deepagents skills middleware. */
export function skillsSourcePath(): string {
  // deepagents expects POSIX-style absolute paths; on macOS/Linux the path is
  // already forward-slash separated, but normalize defensively.
  return skillsDir().split(path.sep).join("/");
}
