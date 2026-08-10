import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MAX_ID_LENGTH = 200;
const MAX_TERMINAL_INPUT_LENGTH = 64 * 1024;

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
