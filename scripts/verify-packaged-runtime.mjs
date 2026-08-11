import { extractFile, listPackage } from "@electron/asar";
import { join } from "node:path";

const ASYNC_CALLER_PATH =
  "node_modules/@langchain/langgraph-sdk/dist/utils/async_caller.js";
const REQUIRED_RUNTIME_FILES = [
  ASYNC_CALLER_PATH,
  "node_modules/p-queue/dist/index.js",
  "node_modules/p-retry/index.js",
];

function resolveAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  return join(context.appOutDir, "resources", "app.asar");
}

/**
 * Guard against pnpm's hidden virtual-store paths leaking into published
 * packages. electron-builder intentionally omits those paths from app.asar,
 * so such an import would only fail after the packaged application launches.
 */
export default function verifyPackagedRuntime(context) {
  const asarPath = resolveAsarPath(context);
  const packagedFiles = new Set(
    listPackage(asarPath, {}).map((file) => file.replace(/^\//, "")),
  );

  for (const requiredFile of REQUIRED_RUNTIME_FILES) {
    if (!packagedFiles.has(requiredFile)) {
      throw new Error(`Packaged runtime dependency is missing: ${requiredFile}`);
    }
  }

  const asyncCallerSource = extractFile(asarPath, ASYNC_CALLER_PATH).toString(
    "utf8",
  );
  if (asyncCallerSource.includes("node_modules/.pnpm")) {
    throw new Error(
      "Packaged LangGraph SDK still references a pnpm virtual-store path",
    );
  }
}
