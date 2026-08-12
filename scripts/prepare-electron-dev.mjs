import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Create a cached, locally ad-hoc-signed Electron bundle with DeepWork's macOS
 * identity. Electron's app.setName() only changes its internal name; the Dock
 * reads CFBundleName / CFBundleDisplayName from the executable's app bundle.
 */
export async function prepareElectronDevExecutable(root) {
  const electronExecutable = require("electron");
  if (process.platform !== "darwin") return electronExecutable;

  const sourceApp = path.resolve(electronExecutable, "../../..");
  const iconPath = path.join(root, "build", "icon.icns");
  const [sourcePlist, icon, electronPackage] = await Promise.all([
    readFile(path.join(sourceApp, "Contents", "Info.plist")),
    readFile(iconPath),
    readFile(path.join(root, "node_modules", "electron", "package.json"), "utf8"),
  ]);
  const electronVersion = JSON.parse(electronPackage).version;
  const fingerprint = createHash("sha256")
    .update(sourcePlist)
    .update(icon)
    .digest("hex")
    .slice(0, 12);

  const cacheRoot = path.join(root, "node_modules", ".cache", "deepwork-electron");
  const cacheKey = `${electronVersion}-${fingerprint}`;
  const targetApp = path.join(cacheRoot, cacheKey, "DeepWork.app");
  const targetExecutable = path.join(targetApp, "Contents", "MacOS", "DeepWork");
  try {
    const executableStat = await stat(targetExecutable);
    if (executableStat.isFile()) return targetExecutable;
  } catch {
    // The branded bundle has not been prepared for this Electron/icon version.
  }

  await mkdir(cacheRoot, { recursive: true });
  const targetDir = path.dirname(targetApp);
  await mkdir(targetDir, { recursive: true });
  const stagingApp = path.join(targetDir, `.preparing-${process.pid}-${Date.now()}.app`);
  execFileSync("/usr/bin/ditto", [sourceApp, stagingApp], { stdio: "inherit" });

  const stagingContents = path.join(stagingApp, "Contents");
  const originalExecutable = path.join(stagingContents, "MacOS", "Electron");
  const brandedExecutable = path.join(stagingContents, "MacOS", "DeepWork");
  await rename(originalExecutable, brandedExecutable);
  await copyFile(iconPath, path.join(stagingContents, "Resources", "icon.icns"));

  const plistPath = path.join(stagingContents, "Info.plist");
  const replacePlistString = (key, value) => {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plistPath]);
  };
  replacePlistString("CFBundleDisplayName", "DeepWork");
  replacePlistString("CFBundleName", "DeepWork");
  replacePlistString("CFBundleExecutable", "DeepWork");
  replacePlistString("CFBundleIdentifier", "ai.deepwork.app.dev");
  replacePlistString("CFBundleIconFile", "icon.icns");

  // Modifying a bundle invalidates Electron's upstream signature. An ad-hoc
  // signature is appropriate for a local development-only executable.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagingApp], {
    stdio: "inherit",
  });
  await rename(stagingApp, targetApp);
  return targetExecutable;
}
