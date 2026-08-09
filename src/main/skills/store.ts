import path from "node:path";
import fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Skill, SkillFile } from "../../shared/types";
import { SKILLS_DIR } from "../config/paths";
import { logger } from "../log/logger";

const DISABLED_SUFFIX = ".disabled";

/** Subdirectories recognised as part of the Agent Skills spec. */
const SUBDIRS = ["scripts", "references", "assets"] as const;

/** Strict kebab-case: lowercase letters, digits, hyphens; must start/end alphanumeric. */
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Guard every externally-supplied skill name before it is used as a path
 * component. `isValidSlug` is the single source of truth for the on-disk
 * directory name; without this, an IPC caller (or a compromised renderer via
 * XSS) could pass `../../…` to delete/update/read outside SKILLS_DIR — path
 * traversal leading to arbitrary file read/delete/write.
 */
function assertValidName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !isValidSlug(name)) {
    throw new Error(`Invalid skill name: ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Skills directory (~/DeepWork/skills/). */
export function skillsDir(): string {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  return SKILLS_DIR;
}

/** POSIX-style root path handed to deepagents skills middleware. */
export function skillsSourcePath(): string {
  return skillsDir().split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

export function isValidSlug(name: string): boolean {
  return VALID_SLUG.test(name) && name.length <= 64;
}

/** Convert a human-readable name into a valid kebab-case slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || `skill-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Frontmatter (YAML)
// ---------------------------------------------------------------------------

interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowed_tools?: string | string[];
  allowedTools?: string | string[];
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function splitFrontmatter(raw: string): { fm: SkillFrontmatter; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (parseYaml(m[1]) as Record<string, unknown>) || {};
  } catch {
    parsed = {};
  }
  const body = raw.slice(m[0].length);
  return { fm: parsed as SkillFrontmatter, body };
}

function buildSkillMd(skill: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (!skill.enabled) fm.enabled = false;
  if (skill.license) fm.license = skill.license;
  if (skill.compatibility) fm.compatibility = skill.compatibility;
  if (skill.allowedTools?.length) fm.allowed_tools = skill.allowedTools;
  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    fm.metadata = skill.metadata;
  }
  const fmStr = stringifyYaml(fm).trimEnd();
  return `---\n${fmStr}\n---\n\n${skill.body.replace(/\s+$/, "")}\n`;
}

function toStringArray(v: string | string[] | undefined): string[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v.map(String);
  return v.split(/[,\s]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

function classifyFile(relPath: string): SkillFile["kind"] {
  const parts = relPath.split(path.sep);
  const top = parts[0];
  if (top === "scripts") return "script";
  if (top === "references") return "reference";
  if (top === "assets") return "asset";
  return "other";
}

function scanSkillFiles(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  for (const sub of SUBDIRS) {
    const subDir = path.join(dir, sub);
    if (!fs.existsSync(subDir)) continue;
    const walk = (d: string, base: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(d, e.name);
        const rel = path.join(base, e.name);
        if (e.isDirectory()) {
          walk(full, rel);
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            out.push({ path: rel, size: st.size, kind: classifyFile(rel) });
          } catch {
            // skip
          }
        }
      }
    };
    walk(subDir, sub);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse a single skill
// ---------------------------------------------------------------------------

function parseSkill(name: string): Skill | null {
  const dir = path.join(skillsDir(), name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  const enabledPath = path.join(dir, "SKILL.md");
  const disabledPath = path.join(dir, `SKILL.md${DISABLED_SUFFIX}`);
  let file = enabledPath;
  let fileEnabled = true;

  if (!fs.existsSync(enabledPath)) {
    if (fs.existsSync(disabledPath)) {
      file = disabledPath;
      fileEnabled = false;
    } else {
      return null;
    }
  }

  const raw = fs.readFileSync(file, "utf8");
  const { fm, body } = splitFrontmatter(raw);
  const stat = fs.statSync(file);

  // enabled can be toggled via frontmatter OR file suffix
  const fmEnabled = fm.enabled !== false;
  const enabled = fileEnabled && fmEnabled;

  const metadata: Record<string, string> = {};
  if (fm.metadata && typeof fm.metadata === "object") {
    for (const [k, v] of Object.entries(fm.metadata)) {
      metadata[k] = String(v ?? "");
    }
  }

  const allowedTools = toStringArray(fm.allowed_tools ?? fm.allowedTools);

  logger.debug("skills", "parsed", { name, enabled });

  return {
    name,
    description: fm.description || "",
    body,
    enabled,
    updatedAt: stat.mtimeMs,
    ...(fm.license ? { license: String(fm.license) } : {}),
    ...(fm.compatibility ? { compatibility: String(fm.compatibility) } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(allowedTools?.length ? { allowedTools } : {}),
    files: scanSkillFiles(dir),
  };
}

// ---------------------------------------------------------------------------
// List / CRUD
// ---------------------------------------------------------------------------

export function listSkills(): Skill[] {
  const dir = skillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const s = parseSkill(e.name);
    if (s) skills.push(s);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  body?: string;
}

export function createSkill(input: CreateSkillInput): Skill {
  const name = slugify(input.name);
  if (!isValidSlug(name)) {
    throw new Error(`Invalid skill name: "${name}". Use lowercase letters, digits, and hyphens.`);
  }
  const dir = path.join(skillsDir(), name);
  if (fs.existsSync(dir)) {
    throw new Error(`A skill named "${name}" already exists.`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const content = buildSkillMd({
    name,
    description: input.description ?? "",
    body: input.body ?? "",
    enabled: true,
  });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  logger.info("skills", "created", { name });

  return {
    name,
    description: input.description ?? "",
    body: input.body ?? "",
    enabled: true,
    updatedAt: Date.now(),
    files: [],
  };
}

export type SkillPatch = Partial<Pick<
  Skill,
  "description" | "body" | "enabled" | "license" | "compatibility" | "metadata" | "allowedTools"
>>;

export function updateSkill(name: string, patch: SkillPatch): Skill | null {
  assertValidName(name);
  const current = parseSkill(name);
  if (!current) return null;

  const dir = path.join(skillsDir(), name);
  const next: Skill = {
    ...current,
    description: patch.description ?? current.description,
    body: patch.body ?? current.body,
    enabled: patch.enabled ?? current.enabled,
    license: patch.license ?? current.license,
    compatibility: patch.compatibility ?? current.compatibility,
    metadata: patch.metadata ?? current.metadata,
    allowedTools: patch.allowedTools ?? current.allowedTools,
    updatedAt: Date.now(),
  };

  // Remove both possible file variants before writing
  for (const f of ["SKILL.md", `SKILL.md${DISABLED_SUFFIX}`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  const file = path.join(dir, `SKILL.md${next.enabled ? "" : DISABLED_SUFFIX}`);
  fs.writeFileSync(
    file,
    buildSkillMd({
      name: next.name,
      description: next.description,
      body: next.body,
      enabled: next.enabled,
      license: next.license,
      compatibility: next.compatibility,
      metadata: next.metadata,
      allowedTools: next.allowedTools,
    }),
    "utf8",
  );
  logger.info("skills", "updated", { name, enabled: next.enabled });
  return { ...next, files: scanSkillFiles(dir) };
}

export function deleteSkill(name: string): void {
  assertValidName(name);
  const dir = path.join(skillsDir(), name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info("skills", "deleted", { name });
  }
}

export function renameSkill(oldName: string, newName: string): Skill | null {
  assertValidName(oldName);
  const slug = slugify(newName);
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid skill name: "${slug}".`);
  }
  const oldDir = path.join(skillsDir(), oldName);
  if (!fs.existsSync(oldDir)) return null;
  const newDir = path.join(skillsDir(), slug);
  if (fs.existsSync(newDir)) {
    throw new Error(`A skill named "${slug}" already exists.`);
  }
  fs.renameSync(oldDir, newDir);
  // Update name inside SKILL.md frontmatter
  const enabledPath = path.join(newDir, "SKILL.md");
  const disabledPath = path.join(newDir, `SKILL.md${DISABLED_SUFFIX}`);
  const file = fs.existsSync(enabledPath) ? enabledPath
    : fs.existsSync(disabledPath) ? disabledPath : null;
  if (file) {
    const raw = fs.readFileSync(file, "utf8");
    const { fm, body } = splitFrontmatter(raw);
    const updated = buildSkillMd({
      name: slug,
      description: fm.description || "",
      body,
      enabled: fm.enabled !== false,
      license: fm.license ? String(fm.license) : undefined,
      compatibility: fm.compatibility ? String(fm.compatibility) : undefined,
      allowedTools: toStringArray(fm.allowed_tools ?? fm.allowedTools),
    });
    fs.writeFileSync(file, updated, "utf8");
  }
  logger.info("skills", "renamed", { oldName, newName: slug });
  return parseSkill(slug);
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/**
 * Import a skill from an external directory containing SKILL.md.
 * Copies the entire directory into ~/DeepWork/skills/.
 */
export function importSkill(sourceDir: string, newName?: string): Skill {
  const skillMd = path.join(sourceDir, "SKILL.md");
  const disabledMd = path.join(sourceDir, `SKILL.md${DISABLED_SUFFIX}`);
  if (!fs.existsSync(skillMd) && !fs.existsSync(disabledMd)) {
    throw new Error("No SKILL.md found in the selected folder.");
  }
  const raw = fs.readFileSync(
    fs.existsSync(skillMd) ? skillMd : disabledMd,
    "utf8",
  );
  const { fm } = splitFrontmatter(raw);
  const name = newName || slugify(fm.name || path.basename(sourceDir));
  if (!isValidSlug(name)) throw new Error(`Invalid skill name: "${name}".`);

  const destDir = path.join(skillsDir(), name);
  if (fs.existsSync(destDir)) {
    throw new Error(`A skill named "${name}" already exists.`);
  }
  fs.cpSync(sourceDir, destDir, { recursive: true });
  logger.info("skills", "imported", { name, from: sourceDir });

  const created = parseSkill(name);
  if (!created) throw new Error("Import failed: could not parse imported skill.");
  return created;
}

/**
 * Export a skill to a target directory (copies the entire skill folder).
 * Creates <targetDir>/<skill-name>/.
 */
export function exportSkill(name: string, targetDir: string): string {
  assertValidName(name);
  const srcDir = path.join(skillsDir(), name);
  if (!fs.existsSync(srcDir)) throw new Error(`Skill "${name}" not found.`);
  const dest = path.join(targetDir, name);
  if (fs.existsSync(dest)) {
    throw new Error(`"${name}" already exists in the target folder.`);
  }
  fs.cpSync(srcDir, dest, { recursive: true });
  logger.info("skills", "exported", { name, to: dest });
  return dest;
}
