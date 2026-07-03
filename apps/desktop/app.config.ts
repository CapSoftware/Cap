import capUIPlugin from "@cap/ui-solid/vite";
import { defineConfig } from "@solidjs/start/config";
import devtools from "solid-devtools/vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import tsconfigPaths from "vite-tsconfig-paths";

const enableSolidDevtools = !!process.env.VITE_SOLID_DEVTOOLS;

// Bundled fonts load from local assets near-instantly, so `block` is safe and
// avoids the fallback-font flash (FOUT) that `swap` causes on every window
// open. Desktop-only: web keeps `swap` for slow networks.
// No `enforce`: must run after vite:css has inlined the virtual module's
// @import statements (a `pre` transform only sees the un-inlined imports).
const fontDisplayBlock = {
	name: "cap:font-display-block",
	transform(code: string, id: string) {
		// unplugin-fonts inlines the @fontsource CSS into its virtual
		// "unfonts.css" module, so match that as well as direct imports.
		const [file] = id.split("?");
		const isFontCss =
			file.endsWith("unfonts.css") ||
			(file.includes("@fontsource") && file.endsWith(".css"));
		if (!isFontCss) return;
		return {
			code: code.replace(/font-display:\s*swap;/g, "font-display: block;"),
			map: null,
		};
	},
};

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
			...(enableSolidDevtools ? [devtools({ autoname: true })] : []),
			fontDisplayBlock,
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
