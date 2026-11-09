import { build } from "esbuild";

const shared = {
	bundle: true,
	minify: true,
	sourcemap: true,
	target: ["es2020", "safari15"],
	legalComments: "eof",
	logLevel: "info",
};

await build({
	...shared,
	entryPoints: ["src/index.ts"],
	format: "esm",
	outfile: "dist/worm-feedback.mjs",
});
await build({
	...shared,
	entryPoints: ["src/script-tag.ts"],
	format: "iife",
	globalName: "WormFeedback",
	outfile: "dist/worm-feedback.js",
});
