import { defineConfig } from "tsup";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/react/index.ts",
		"src/vanilla/cap-embed-loader.ts",
	],
	format: ["esm"],
	dts: true,
	splitting: true,
	clean: true,
	external: ["react"],
});
