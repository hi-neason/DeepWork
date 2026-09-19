import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        // Emit CJS with a .cjs extension (same as preload). With "type":
        // "module" in package.json an ESM .js output would be loaded as an ES
        // module by Electron, breaking named imports from "electron" (e.g.
        // BrowserWindow). better-sqlite3 / nut.js stay external.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // .cjs so the package.json "type": "module" doesn't make Electron treat
        // the CommonJS preload as an ES module (which breaks `require`).
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: { "@renderer": resolve("src/renderer/src") },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
