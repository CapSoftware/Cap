import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { outDirFor, resolveTarget, targetDefine } from "./vite.shared";

const target = resolveTarget();

// The manifests live outside public/ because public/ is copied verbatim into
// every outDir, which would ship the Chrome manifest into the Firefox build.
// This config is only one piece of the bundle (the background script and
// content scripts come from the vite.*.config.ts builds the package.json
// scripts chain BEFORE this one), so before stamping the manifest — the last
// step of a build — verify the background artifact it references exists.
const copyManifest = (watchMode: boolean): Plugin => ({
	name: "cap-copy-manifest",
	closeBundle() {
		const backgroundScript = resolve(
			__dirname,
			outDirFor(target),
			"assets/service-worker.js",
		);
		if (!watchMode && !existsSync(backgroundScript)) {
			throw new Error(
				"assets/service-worker.js is missing — the extension must be built " +
					"with the package.json build scripts (build:chrome / build:firefox), " +
					"not a bare `vite build`.",
			);
		}
		copyFileSync(
			resolve(__dirname, `manifests/manifest.${target}.json`),
			resolve(__dirname, outDirFor(target), "manifest.json"),
		);
	},
});

export default defineConfig(({ command, mode }) => ({
	plugins: [
		react(),
		copyManifest(command === "serve" || mode === "development"),
	],
	define: targetDefine(target),
	build: {
		emptyOutDir: false,
		outDir: outDirFor(target),
		rollupOptions: {
			input: {
				popup: resolve(__dirname, "popup.html"),
				"popup-window": resolve(__dirname, "popup-window.html"),
				options: resolve(__dirname, "options.html"),
				welcome: resolve(__dirname, "welcome.html"),
				"how-it-works": resolve(__dirname, "how-it-works.html"),
				uploading: resolve(__dirname, "uploading.html"),
				recorder: resolve(__dirname, "recorder.html"),
				"camera-preview": resolve(__dirname, "camera-preview.html"),
				"camera-permission": resolve(__dirname, "camera-permission.html"),
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
}));
