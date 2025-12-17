import capUIPlugin from "@cap/ui-solid/vite";
import { defineConfig } from "@solidjs/start/config";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	ssr: false,
	server: { preset: "static" },
	// https://vitejs.dev/config
	vite: () => ({
		// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
		// 1. tauri expects a fixed port, fail if that port is not available
		server: {
			port: 3001,
			strictPort: true,
			watch: {
				ignored: ["**/src-tauri/**"],
			},
			headers: {
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp",
			},
		},
		// 3. to make use of `TAURI_DEBUG` and other env variables
		// https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
		envPrefix: ["VITE_", "TAURI_"],
		assetsInclude: ["**/*.riv"],
		plugins: [
			wasm(),
			topLevelAwait(),
			capUIPlugin,
			tsconfigPaths({
				root: ".",
			}),
		],
		define: {
			"import.meta.vitest": "undefined",
		},
		optimizeDeps: {
			include: [
				"@tauri-apps/plugin-os",
				"@tanstack/solid-query",
				"@tauri-apps/api/webviewWindow",
				"@tauri-apps/plugin-dialog",
				"@tauri-apps/plugin-store",
				"posthog-js",
				"uuid",
				"@tauri-apps/plugin-clipboard-manager",
				"@tauri-apps/api/window",
				"@tauri-apps/api/core",
				"@tauri-apps/api/event",
				"cva",
			],
		},
	}),
});
