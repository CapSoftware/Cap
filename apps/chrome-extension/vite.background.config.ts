import { resolve } from "node:path";
import { defineConfig } from "vite";
import { outDirFor, resolveTarget, targetDefine } from "./vite.shared";

const target = resolveTarget();

// The background ships as a single self-contained classic script. Firefox
// event pages terminate and restart constantly, and module backgrounds fail
// to come back up (the page starts once at install, then never wakes); a
// classic IIFE with no imports restarts reliably on both browsers.
export default defineConfig({
	define: targetDefine(target),
	build: {
		emptyOutDir: false,
		outDir: outDirFor(target),
		rollupOptions: {
			input: resolve(__dirname, "src/background/service-worker.ts"),
			output: {
				format: "iife",
				entryFileNames: "assets/service-worker.js",
			},
		},
	},
});
