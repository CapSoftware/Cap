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
		server: {
			port: 3001,
			strictPort: true,
			watch: {
				ignored: ["**/electron/**", "**/src-backend/**"],
			},
			headers: {
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp",
			},
		},
		envPrefix: ["VITE_", "CAP_"],
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
			include: ["@tanstack/solid-query", "@openpanel/web", "uuid", "cva"],
		},
	}),
});
