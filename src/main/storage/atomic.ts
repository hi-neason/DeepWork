import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Crash- and concurrency-safe file write (H-S3).
 *
 * A plain `writeFileSync(file + ".tmp")` + rename breaks in two ways:
 *  - two writers (two app instances, or a turn + a manual save) share the same
 *    ".tmp" name and clobber each other, so the rename can publish a
 *    half-written mix of both payloads;
 *  - without fsync the rename can land before the data does, leaving an empty
 *    or truncated file after a power loss.
 *
 * Here the temp name is unique per write and the content is flushed to disk
 * before the rename, which is atomic within a directory on POSIX and Windows.
 */
export function atomicWriteFileSync(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file may not exist */
    }
    throw err;
  }
}
