import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { notesFor } from "./scripts/changelog.ts";

const host = process.env.TAURI_DEV_HOST;

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// Only the running version's notes go into the app, for Settings > About. The full history stays in CHANGELOG.md.
const notes = notesFor(readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8"), version) ?? [];

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_RELEASE_NOTES__: JSON.stringify(notes) },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
