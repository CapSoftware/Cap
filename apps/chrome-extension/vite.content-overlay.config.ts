import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The full overlay/recording-bar UI, lazily import()ed by the bootstrap
// content script. It must be an ES module (the bootstrap dynamic-imports
// it), self-contained, and emitted at a stable hash-free path so the
// manifest's web_accessible_resources entry can list it.
export default defineConfig({
	plugins: [react()],
	build: {
		emptyOutDir: false,
		outDir: "dist",
		rollupOptions: {
			input: resolve(__dirname, "src/content/overlay.tsx"),
			// Keep the init() export the bootstrap calls after import().
			preserveEntrySignatures: "exports-only",
			output: {
				format: "es",
				entryFileNames: "content/overlay.js",
				inlineDynamicImports: true,
			},
		},
	},
});
