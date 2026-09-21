import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import AutoImport from "unplugin-auto-import/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import IconsResolver from "unplugin-icons/resolver";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const desktopSource = resolve(repositoryRoot, "apps/desktop/src");
const defaultOutput = resolve(repositoryRoot, "apps/web/public/editor-solid");
const outputDir = process.env.CAP_EDITOR_SOLID_OUT_DIR ?? defaultOutput;
const wallpaperSource = resolve(
	repositoryRoot,
	"apps/desktop/src-tauri/assets/backgrounds",
);
const tauriBridge = resolve(import.meta.dirname, "src/tauri-bridge.ts");
const tauriOs = resolve(import.meta.dirname, "src/tauri-os.ts");
const tauriWindow = resolve(import.meta.dirname, "src/tauri-window.ts");
const tauriStore = resolve(import.meta.dirname, "src/tauri-store.ts");
const tauriCore = resolve(import.meta.dirname, "src/tauri-core.ts");
const tauriEvent = resolve(import.meta.dirname, "src/tauri-event.ts");
const tauriDialog = resolve(import.meta.dirname, "src/tauri-dialog.ts");
const tauriPath = resolve(import.meta.dirname, "src/tauri-path.ts");
const tauriMenu = resolve(import.meta.dirname, "src/tauri-menu.ts");
const tauriFs = resolve(import.meta.dirname, "src/tauri-fs.ts");
const tauriOpener = resolve(import.meta.dirname, "src/tauri-opener.ts");
const tauriClipboard = resolve(import.meta.dirname, "src/tauri-clipboard.ts");
const websocket = resolve(import.meta.dirname, "src/websocket.ts");
const browserFrameSocket = resolve(
	import.meta.dirname,
	"src/browser-frame-socket.ts",
);

export default defineConfig({
	base: "/editor-solid/",
	plugins: [
		solid(),
		{
			name: "cap-editor-wallpapers",
			async closeBundle() {
				await cp(wallpaperSource, resolve(outputDir, "assets/backgrounds"), {
					recursive: true,
				});
			},
		},
		AutoImport({
			exclude: [/[\\/]node_modules[\\/]/],
			resolvers: [
				IconsResolver({
					prefix: "Icon",
					extension: "jsx",
					customCollections: ["cap"],
				}),
			],
			dts: false,
		}),
		Icons({
			compiler: "solid",
			customCollections: {
				cap: FileSystemIconLoader(
					resolve(repositoryRoot, "packages/ui-solid/icons"),
				),
			},
		}),
	],
	resolve: {
		dedupe: ["solid-js", "@tanstack/solid-query"],
		alias: [
			{ find: "@solid-primitives/websocket", replacement: websocket },
			{ find: "@tauri-apps/api/core", replacement: tauriCore },
			{ find: "@tauri-apps/api/path", replacement: tauriPath },
			{ find: "@tauri-apps/api/menu", replacement: tauriMenu },
			{ find: "@tauri-apps/plugin-fs", replacement: tauriFs },
			{ find: "@tauri-apps/plugin-opener", replacement: tauriOpener },
			{
				find: "@tauri-apps/plugin-clipboard-manager",
				replacement: tauriClipboard,
			},
			{ find: "@tauri-apps/api/event", replacement: tauriEvent },
			{ find: "@tauri-apps/plugin-dialog", replacement: tauriDialog },
			{ find: "@tauri-apps/plugin-store", replacement: tauriStore },
			{ find: "@tauri-apps/api/window", replacement: tauriWindow },
			{ find: "@tauri-apps/api/webviewWindow", replacement: tauriWindow },
			{ find: "@tauri-apps/plugin-os", replacement: tauriOs },
			{ find: /^~\/utils\/tauri$/, replacement: tauriBridge },
			{ find: /^~\/utils\/socket$/, replacement: browserFrameSocket },
			{ find: /^\.\/tauri$/, replacement: tauriBridge },
			{ find: /^~\//, replacement: `${desktopSource}/` },
		],
	},
	assetsInclude: ["**/*.riv"],
	define: {
		"import.meta.vitest": "undefined",
		"import.meta.env.VITE_CAP_WEB_EDITOR": JSON.stringify("true"),
	},
	build: {
		outDir: outputDir,
		emptyOutDir: true,
		assetsInlineLimit: 0,
		target: "es2022",
		cssCodeSplit: true,
		chunkSizeWarningLimit: 1200,
	},
});
