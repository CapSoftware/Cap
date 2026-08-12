import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(desktopDir, ".electron-dist");

await rm(outputDir, { recursive: true, force: true });

const common = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	external: ["electron"],
	logLevel: "info",
	legalComments: "none",
	sourcemap: false,
};

await Promise.all([
	build({
		...common,
		entryPoints: [path.join(desktopDir, "electron", "main.cjs")],
		outfile: path.join(outputDir, "main.cjs"),
	}),
	build({
		...common,
		entryPoints: [path.join(desktopDir, "electron", "preload.cjs")],
		outfile: path.join(outputDir, "preload.cjs"),
	}),
]);
