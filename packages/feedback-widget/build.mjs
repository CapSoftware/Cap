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
	outfile: "dist/feedback-widget.mjs",
});
await build({
	...shared,
	entryPoints: ["src/script-tag.ts"],
	format: "iife",
	globalName: "FeedbackWidget",
	outfile: "dist/feedback-widget.js",
});
