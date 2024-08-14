import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  ssr: false,
  server: { preset: "static" },
  // https://vitejs.dev/config
  vite: () => ({
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // 1. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      watch: {
        // 2. tell vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
    // 3. to make use of `TAURI_DEBUG` and other env variables
    // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
    envPrefix: ["VITE_", "TAURI_"],
  }),
});
