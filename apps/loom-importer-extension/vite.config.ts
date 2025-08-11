import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import hotReloadExtension from "hot-reload-extension-vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Use automatic runtime in all modes so JSX doesn't require React in scope
    // across all files (prevents 'React is not defined' in popup and content scripts).
    react({ jsxRuntime: "automatic" }),
    tsconfigPaths(),
    hotReloadExtension({
      log: true,
      backgroundPath: resolve(__dirname, "src/background.ts"),
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        // Main entry and extension scripts
        main: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "src/background.ts"),
        popup: resolve(__dirname, "popup.html"),
      },
      output: {
        entryFileNames: `react/[name].js`,
        chunkFileNames: `react/[name].js`,
        assetFileNames: `react/[name].[ext]`,
      },
    },
    // Enable watch mode when running with --watch flag
    watch: {
      include: ["src/**", "public/**"],
    },
  },
});
