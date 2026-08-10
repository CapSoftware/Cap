import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { outDirFor, resolveTarget, targetDefine } from "./vite.shared";

const target = resolveTarget();

// The full overlay/recording-bar UI, lazily loaded by the bootstrap content
// script, self-contained and emitted at a stable hash-free path.
//
// Chrome: an ES module the bootstrap dynamic-imports from
// web_accessible_resources. Firefox: content scripts cannot dynamic-import
// extension modules (bugzilla 1536094), so the service worker executeScripts
// it into the bootstrap's isolated world instead — a classic IIFE that
// exposes its exports as the CapOverlay global.
export default defineConfig({
	plugins: [react()],
	define: targetDefine(target),
	build: {
		emptyOutDir: false,
		outDir: outDirFor(target),
		rollupOptions: {
			input: resolve(__dirname, "src/content/overlay.tsx"),
			// Keep the init() export the bootstrap calls after loading.
			preserveEntrySignatures: "exports-only",
			output:
				target === "firefox"
					? {
							format: "iife",
							name: "CapOverlay",
							entryFileNames: "content/overlay.js",
							inlineDynamicImports: true,
						}
					: {
							format: "es",
							entryFileNames: "content/overlay.js",
							inlineDynamicImports: true,
						},
		},
	},
});
