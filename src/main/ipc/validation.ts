import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MAX_ID_LENGTH = 200;
const MAX_TERMINAL_INPUT_LENGTH = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4096;

export const providerSchema = z.enum([
  "anthropic", "openai", "ollama", "deepseek", "qwen",
  "minimax", "kimi", "openrouter", "custom",
]);
const permissionModeSchema = z.enum(["manual", "auto", "auto-write", "auto-exec", "plan"]);
const interactivePermissionModeSchema = z.enum(["manual", "auto-write", "auto-exec", "plan"]);
const urlStringSchema = z.union([z.literal(""), z.string().url().max(4096)]);
const boundedString = (max: number) => z.string().max(max).refine(
  (value) => !value.includes("\0"),
  "String contains a null byte",
);

export const workspacePathSchema = boundedString(16 * 1024).refine((value) => {
  if (value.trim() === "") return true;
  if (!path.isAbsolute(value)) return false;
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}, "Workspace must be an existing absolute directory");

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine((value) => !value.includes("\0"), "Identifier contains a null byte");

export const artifactActionArgsSchema = z.tuple([
  identifierSchema,
  z.string().min(1).max(16 * 1024),
]);

export const terminalSpawnArgsSchema = z.tuple([
  identifierSchema,
  identifierSchema,
]);

export const terminalInputArgsSchema = z.tuple([
  identifierSchema,
  z.string().max(MAX_TERMINAL_INPUT_LENGTH),
]);

export const terminalResizeArgsSchema = z.tuple([
  identifierSchema,
  z.number().int().min(2).max(1000),
  z.number().int().min(1).max(1000),
]);

export const terminalIdArgsSchema = z.tuple([identifierSchema]);
export const twoIdentifierArgsSchema = z.tuple([identifierSchema, identifierSchema]);
export const identifierAndTextArgsSchema = z.tuple([
  identifierSchema,
  boundedString(16 * 1024),
]);
export const groupNameSchema = boundedString(500).trim().min(1);
export const groupNameArgsSchema = z.tuple([groupNameSchema]);
export const groupRenameArgsSchema = z.tuple([groupNameSchema, groupNameSchema]);

export const sessionCreateArgsSchema = z.tuple([
  boundedString(500).optional(),
  workspacePathSchema.optional(),
  boundedString(500).optional(),
  interactivePermissionModeSchema.optional(),
]);

export const sessionPermissionModeArgsSchema = z.tuple([
  identifierSchema,
  interactivePermissionModeSchema,
]);

export const sessionWorkspaceArgsSchema = z.tuple([
  identifierSchema,
  workspacePathSchema,
]);

export const projectMemoryArgsSchema = z.tuple([
  boundedString(255).trim().min(1),
]);

const attachmentSchema = z.object({
  id: identifierSchema,
  name: boundedString(1024).min(1),
  mimeType: boundedString(255).min(1),
  size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  dataUrl: z.string().min(1).max(MAX_DATA_URL_LENGTH).startsWith("data:"),
  kind: z.enum(["image", "pdf", "text"]),
  text: z.string().max(2 * 1024 * 1024).optional(),
}).strict().superRefine((attachment, ctx) => {
  const validMime = attachment.kind === "image"
    ? attachment.mimeType.startsWith("image/")
    : attachment.kind === "pdf"
      ? attachment.mimeType === "application/pdf"
      : !attachment.mimeType.startsWith("image/") && attachment.mimeType !== "application/pdf";
  if (!validMime) {
    ctx.addIssue({ code: "custom", path: ["mimeType"], message: "Attachment kind and MIME type do not match" });
  }
});

const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS).superRefine((items, ctx) => {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    ctx.addIssue({ code: "custom", message: "Attachments exceed the total size limit" });
  }
});

export const chatSendArgsSchema = z.tuple([
  identifierSchema,
  boundedString(2 * 1024 * 1024),
  attachmentsSchema.optional(),
  workspacePathSchema.optional(),
  boundedString(500).optional(),
  interactivePermissionModeSchema.optional(),
]);

export const configuredModelSchema = z.object({
  id: boundedString(500).min(1),
  provider: providerSchema,
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  baseUrl: urlStringSchema.optional(),
}).strict();

export const modelConfigSchema = z.object({
  provider: providerSchema,
  model: boundedString(500).min(1),
  baseUrl: urlStringSchema.optional(),
  workspaceDir: workspacePathSchema,
}).strict();

export const modelVerifyArgsSchema = z.tuple([modelConfigSchema]);
export const providerArgsSchema = z.tuple([providerSchema]);
export const providerKeyArgsSchema = z.tuple([
  providerSchema,
  boundedString(64 * 1024),
]);
export const booleanArgsSchema = z.tuple([z.boolean()]);

const mcpServerSchema = z.object({
  id: identifierSchema,
  label: boundedString(500).min(1),
  transport: z.enum(["stdio", "sse"]),
  command: boundedString(4096).optional(),
  args: z.array(boundedString(4096)).max(100).optional(),
  env: z.record(boundedString(256), boundedString(16 * 1024)).optional(),
  url: urlStringSchema.optional(),
  enabled: z.boolean(),
}).strict().superRefine((server, ctx) => {
  if (server.transport === "stdio" && !server.command?.trim()) {
    ctx.addIssue({ code: "custom", path: ["command"], message: "stdio MCP requires a command" });
  }
  if (server.transport === "sse" && !server.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "SSE MCP requires a URL" });
  }
});

export const settingsSchema = z.object({
  model: z.object({
    provider: providerSchema,
    model: boundedString(500).min(1),
    baseUrl: urlStringSchema.optional(),
    workspaceDir: workspacePathSchema,
  }).strict(),
  configuredModels: z.array(configuredModelSchema).max(100),
  mcpServers: z.array(mcpServerSchema).max(50),
  permissionMode: permissionModeSchema,
  alwaysAllowTools: z.array(boundedString(255)).max(200),
  onboarded: z.boolean(),
  trayEnabled: z.boolean(),
  autoUpdate: z.boolean(),
  openAtLogin: z.boolean(),
  keepAwake: z.boolean(),
  theme: z.enum(["light", "dark", "auto"]),
  language: z.enum(["zh-CN", "en-US"]),
  fontScale: z.number().min(0.9).max(1.3),
  telemetry: z.boolean(),
  showReasoning: z.boolean(),
  funMode: z.boolean(),
  logEnabled: z.boolean(),
  memory: z.object({
    autoExtract: z.boolean(),
    embedding: z.object({
      provider: z.enum(["ollama", "openai", "none"]),
      model: boundedString(500),
      baseUrl: urlStringSchema.optional(),
    }).strict(),
    topK: z.number().int().min(1).max(100),
    threshold: z.number().min(0).max(1),
  }).strict(),
  memories: z.array(z.object({
    id: identifierSchema,
    content: boundedString(2 * 1024 * 1024),
    scope: z.enum(["global", "workspace", "session"]),
    createdAt: z.number().finite(),
    type: z.enum(["preference", "fact", "event"]).optional(),
    importance: z.number().min(0).max(1).optional(),
    status: z.enum(["active", "invalid"]).optional(),
    source: boundedString(2000).optional(),
  }).strict()).max(10_000),
  includeAgentsMd: z.boolean(),
  includeClaudeMd: z.boolean(),
}).strict();
export const settingsArgsSchema = z.tuple([settingsSchema]);

const scheduleConfigSchema = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  cron: boundedString(200).optional(),
  datetime: z.string().datetime({ offset: true }).optional(),
  timezone: boundedString(255).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone").optional(),
}).strict();

const automationMutableShape = {
  title: boundedString(500).min(1),
  instructions: boundedString(200_000).min(1),
  workspaceDir: workspacePathSchema.optional(),
  scheduleType: z.enum(["daily", "weekly", "cron", "once"]),
  scheduleConfig: scheduleConfigSchema,
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  enabled: z.boolean(),
  permissionMode: permissionModeSchema.optional(),
  skills: z.array(identifierSchema).max(100).optional(),
  mcpServerIds: z.array(identifierSchema).max(100).optional(),
  model: boundedString(500).optional(),
};

function validateSchedule(
  value: { scheduleType?: string; scheduleConfig?: z.infer<typeof scheduleConfigSchema> },
  ctx: z.RefinementCtx,
): void {
  const config = value.scheduleConfig;
  if (!value.scheduleType || !config) return;
  const required = value.scheduleType === "cron" ? "cron"
    : value.scheduleType === "once" ? "datetime" : "time";
  if (!config[required]) {
    ctx.addIssue({ code: "custom", path: ["scheduleConfig", required], message: `${required} is required` });
  }
  if (value.scheduleType === "weekly" && !config.days?.length) {
    ctx.addIssue({ code: "custom", path: ["scheduleConfig", "days"], message: "Weekly schedule requires days" });
  }
}

export const automationCreateSchema = z.object(automationMutableShape).strict().superRefine(validateSchedule);
export const automationUpdateSchema = z.object(automationMutableShape).partial().strict().superRefine(validateSchedule);
export const automationCreateArgsSchema = z.tuple([automationCreateSchema]);
export const automationUpdateArgsSchema = z.tuple([identifierSchema, automationUpdateSchema]);

const skillNameSchema = boundedString(255)
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name must be a kebab-case slug");
const skillPatchSchema = z.object({
  description: boundedString(16 * 1024).optional(),
  body: boundedString(2 * 1024 * 1024).optional(),
  enabled: z.boolean().optional(),
  license: boundedString(1024).optional(),
  compatibility: boundedString(16 * 1024).optional(),
  metadata: z.record(boundedString(255), boundedString(16 * 1024)).optional(),
  allowedTools: z.array(boundedString(255)).max(500).optional(),
}).strict();
export const skillCreateArgsSchema = z.tuple([z.object({
  name: skillNameSchema,
  description: boundedString(16 * 1024).optional(),
  body: boundedString(2 * 1024 * 1024).optional(),
}).strict()]);
export const skillUpdateArgsSchema = z.tuple([skillNameSchema, skillPatchSchema]);
export const skillNameArgsSchema = z.tuple([skillNameSchema]);
export const skillRenameArgsSchema = z.tuple([skillNameSchema, skillNameSchema]);
export const skillImportArgsSchema = z.tuple([
  workspacePathSchema,
  skillNameSchema.optional(),
]);
export const skillExportArgsSchema = z.tuple([skillNameSchema, workspacePathSchema]);

export const approvalResponseArgsSchema = z.tuple([
  identifierSchema,
  z.enum(["allow", "always_allow", "deny"]),
]);

export const memoryTypeSchema = z.enum(["preference", "fact", "event"]);
export const memoriesListArgsSchema = z.tuple([z.boolean().optional()]);
export const memoriesByScopeArgsSchema = z.tuple([
  boundedString(16 * 1024),
  memoryTypeSchema.optional(),
]);
export const memoriesSearchArgsSchema = z.tuple([
  boundedString(16 * 1024),
  boundedString(2 * 1024 * 1024),
  z.number().int().min(1).max(100).optional(),
]);
export const memoryAddArgsSchema = z.tuple([
  boundedString(2 * 1024 * 1024).min(1),
  memoryTypeSchema.optional(),
  boundedString(16 * 1024).optional(),
]);
export const memoryEditArgsSchema = z.tuple([
  identifierSchema,
  boundedString(2 * 1024 * 1024).min(1),
]);

export const userMemorySectionsArgsSchema = z.tuple([
  z.record(boundedString(255), boundedString(2 * 1024 * 1024)),
]);
export const userMemoryAppendArgsSchema = z.tuple([
  boundedString(2 * 1024 * 1024).min(1),
  boundedString(2000).optional(),
]);
export const markdownArgsSchema = z.tuple([boundedString(8 * 1024 * 1024)]);
export const timelineDateArgsSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
]);

/** Return whether candidate is contained by root, including root itself. */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve an existing file without following a symlink outside the allowed
 * root. Both paths are canonicalized with realpath so lexical containment is
 * not enough to bypass the boundary.
 */
export function assertExistingFileWithin(
  allowedRoot: string,
  candidate: string,
): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error("Artifact path must be absolute");
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(allowedRoot);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new Error("Artifact path does not exist");
  }
  if (!isPathWithin(realRoot, realCandidate)) {
    throw new Error("Artifact path is outside the session workspace");
  }
  if (!fs.statSync(realCandidate).isFile()) {
    throw new Error("Artifact path is not a file");
  }
  return realCandidate;
}
