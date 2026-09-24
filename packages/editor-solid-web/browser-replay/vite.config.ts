import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	base: "/browser-replay/",
	worker: { format: "es" },
	build: {
		outDir: resolve(import.meta.dirname, "out"),
		emptyOutDir: true,
		assetsInlineLimit: 0,
		target: "es2022",
		rollupOptions: {
			input: resolve(import.meta.dirname, "index.html"),
		},
	},
});
