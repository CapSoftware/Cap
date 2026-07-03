import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { outDirFor, resolveTarget, targetDefine } from "./vite.shared";

const target = resolveTarget();

// The manifests live outside public/ because public/ is copied verbatim into
// every outDir, which would ship the Chrome manifest into the Firefox build.
const copyManifest = (): Plugin => ({
	name: "cap-copy-manifest",
	closeBundle() {
		copyFileSync(
			resolve(__dirname, `manifests/manifest.${target}.json`),
			resolve(__dirname, outDirFor(target), "manifest.json"),
		);
	},
});

export default defineConfig({
	plugins: [react(), copyManifest()],
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
				"service-worker": resolve(
					__dirname,
					"src/background/service-worker.ts",
				),
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
