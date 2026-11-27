import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import AutoImport from "unplugin-auto-import/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import IconsResolver from "unplugin-icons/resolver";
import Icons from "unplugin-icons/vite";
import { defineConfig, type HtmlTagDescriptor } from "vite";
import solid from "vite-plugin-solid";

const packageRoot = import.meta.dirname;
const repositoryRoot = resolve(packageRoot, "../..");
const base = "/editor/";
const outputDir =
	process.env.CAP_WEB_EDITOR_OUT_DIR ??
	resolve(repositoryRoot, "apps/web/public/editor");
const wallpaperSource = resolve(
	repositoryRoot,
	"apps/desktop-gpui/assets/backgrounds",
);

export default defineConfig({
	base,
	worker: { format: "es" },
	plugins: [
		solid(),
		{
			// The renderer's wasm is the largest file the first frame needs, and
			// its fetch otherwise waits for the entry script and the renderer's
			// glue. Starting it with the page lets the two download together.
			// A script starts it rather than a preload, which Safari downloads a
			// second time when the renderer asks for the same file. It goes
			// first in the head because an inline script after the stylesheet
			// waits for the stylesheet to download.
			name: "cap-editor-preload-renderer",
			transformIndexHtml: {
				order: "post",
				handler(_html, context) {
					const tags: HtmlTagDescriptor[] = [];
					for (const output of Object.values(context.bundle ?? {})) {
						if (
							output.type === "asset" &&
							output.originalFileNames.some((name) =>
								name.includes("renderer/pkg/"),
							)
						) {
							const url = JSON.stringify(`${base}${output.fileName}`);
							tags.push({
								tag: "script",
								injectTo: "head-prepend",
								children: `window.__capRendererWasm=fetch(${url},{credentials:"same-origin"});window.__capRendererWasm.catch(function(){});`,
							});
						} else if (
							output.type === "chunk" &&
							output.facadeModuleId?.includes(
								"renderer/pkg/cap_editor_browser_renderer.js",
							)
						) {
							tags.push({
								tag: "link",
								injectTo: "head",
								attrs: {
									rel: "modulepreload",
									href: `${base}${output.fileName}`,
								},
							});
						}
					}
					return tags;
				},
			},
		},
		{
			// The entry imports the editor UI and the demuxer as soon as it runs,
			// and both are needed for the first frame. Preloading them from the
			// page starts those downloads alongside the entry script instead of
			// after it has downloaded and run, one round trip and one entry
			// download sooner on a slow link.
			name: "cap-editor-preload-startup",
			transformIndexHtml: {
				order: "post",
				handler(_html, context) {
					const bundle = context.bundle ?? {};
					const startupModules = [
						"/src/app/routes/editor/Editor.tsx",
						"/mediabunny/dist/modules/src/index.js",
						"/src/engine/browser-editor-metadata.ts",
					];
					const entry = Object.values(bundle).find(
						(output) => output.type === "chunk" && output.isEntry,
					);
					const files = new Set<string>();
					const styles = new Set<string>();
					const visit = (fileName: string) => {
						const chunk = bundle[fileName];
						if (
							!chunk ||
							chunk.type !== "chunk" ||
							chunk === entry ||
							files.has(fileName)
						)
							return;
						files.add(fileName);
						for (const css of chunk.viteMetadata?.importedCss ?? [])
							styles.add(css);
						for (const imported of chunk.imports) visit(imported);
					};
					for (const output of Object.values(bundle)) {
						if (
							output.type === "chunk" &&
							output.moduleIds.some((id) =>
								startupModules.some((module) => id.endsWith(module)),
							)
						)
							visit(output.fileName);
					}
					return [
						...[...files].map(
							(file): HtmlTagDescriptor => ({
								tag: "link",
								injectTo: "head",
								attrs: { rel: "modulepreload", href: `${base}${file}` },
							}),
						),
						...[...styles].map(
							(file): HtmlTagDescriptor => ({
								tag: "link",
								injectTo: "head",
								attrs: {
									rel: "preload",
									as: "style",
									crossorigin: "",
									href: `${base}${file}`,
								},
							}),
						),
					];
				},
			},
		},
		{
			name: "cap-editor-wallpapers",
			apply: "build",
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
				cap: FileSystemIconLoader(resolve(packageRoot, "icons")),
			},
		}),
	],
	resolve: {
		dedupe: ["solid-js", "@tanstack/solid-query"],
		alias: [
			{ find: /^~\//, replacement: `${resolve(packageRoot, "src/app")}/` },
		],
	},
	assetsInclude: ["**/*.riv"],
	define: {
		"import.meta.vitest": "undefined",
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
