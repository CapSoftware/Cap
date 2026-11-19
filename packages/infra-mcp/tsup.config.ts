import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: ["esm"],
	platform: "node",
	target: "node20",
	noExternal: [/.*/],
	splitting: false,
	minify: true,
	clean: true,
});
