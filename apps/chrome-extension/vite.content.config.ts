import { resolve } from "node:path";
import { defineConfig } from "vite";

// Chrome runs manifest content scripts as classic scripts, so this entry
// must be a single self-contained IIFE with no ES module imports. Only the
// tiny dependency-free bootstrap ships this way; it lazily import()s the
// real overlay UI (built by vite.content-overlay.config.ts) from
// web_accessible_resources when a tab actually needs it.
export default defineConfig({
	build: {
		emptyOutDir: false,
		outDir: "dist",
		rollupOptions: {
			input: resolve(__dirname, "src/content/bootstrap.ts"),
			output: {
				format: "iife",
				entryFileNames: "assets/content-bootstrap.js",
			},
		},
	},
});
