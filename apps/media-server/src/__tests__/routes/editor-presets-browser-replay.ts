import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import sharp from "sharp";

const sourcePath = "content/images/22222222-2222-4222-8222-222222222222.png";
const targetPath = "content/images/33333333-3333-4333-8333-333333333333.png";
const source = await sharp({
	create: {
		width: 32,
		height: 32,
		channels: 4,
		background: { r: 255, g: 0, b: 255, alpha: 1 },
	},
})
	.png()
	.toBuffer();
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const root = resolve(import.meta.dir, "../../../../../");
const temporary = await mkdtemp(join(tmpdir(), "cap-editor-presets-"));
const browserEntry = join(temporary, "browser-entry.ts");
const browserSource = `
import { Store, setEditorStoreNamespace } from ${JSON.stringify(join(root, "packages/editor-solid-web/src/tauri-store.ts"))};
import { setEditorPresetAssetBase, prepareEditorPresetBackground } from ${JSON.stringify(join(root, "packages/editor-solid-web/src/preset-backgrounds.ts"))};
import { mapEditorImportedImages, resolveEditorImportedImage } from ${JSON.stringify(join(root, "packages/editor-solid-web/src/editor-file-mapping.ts"))};
const sourcePath = ${JSON.stringify(sourcePath)};
const targetPath = ${JSON.stringify(targetPath)};
const scope = "preset-browser-replay";
setEditorStoreNamespace(scope);
const store = await Store.load("store");
let importCount = 0;
window.capPresetReplay = {
	save: async () => {
		setEditorPresetAssetBase("/api/editor/sessions/session-one/file?videoId=recording-one");
		await store.set("presets", new Proxy({
			presets: [{ name: "Magenta", config: { background: { source: { type: "image", path: sourcePath } } } }],
			default: null,
		}, {}));
		return (await store.get("presets"))?.presets?.length;
	},
	apply: async () => {
		setEditorPresetAssetBase("/api/editor/sessions/session-two/file?videoId=recording-two");
		const presets = await store.get("presets");
		if (!presets?.presets?.[0]) throw new Error("Saved preset was lost after reload");
		let bytes = null;
		await prepareEditorPresetBackground(scope, "store", presets.presets[0].config, async (file) => {
			importCount += 1;
			bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
			return { path: targetPath };
		});
		const mapped = mapEditorImportedImages(presets.presets[0].config);
		return { bytes, importCount, mappedPath: mapped.background.source.path, resolvedPath: resolveEditorImportedImage(sourcePath) };
	},
	delete: async () => {
		await store.delete("presets");
		await store.reload();
		return await store.get("presets");
	},
};
`;

type ReplayApi = {
	save: () => Promise<number>;
	apply: () => Promise<{
		bytes: number[] | null;
		importCount: number;
		mappedPath: string;
		resolvedPath: string;
	}>;
	delete: () => Promise<unknown>;
};

declare global {
	interface Window {
		capPresetReplay?: ReplayApi;
	}
}

let server: ReturnType<typeof Bun.serve> | null = null;

try {
	await writeFile(browserEntry, browserSource);
	const built = await Bun.build({
		entrypoints: [browserEntry],
		target: "browser",
		format: "esm",
	});
	assert.ok(built.success, JSON.stringify(built.logs));
	const script = await built.outputs[0]?.text();
	assert.ok(script);
	let sourceAvailable = true;
	let rawRequests = 0;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/") {
				return new Response(
					"<!doctype html><html><body><script type='module' src='/browser-entry.js'></script></body></html>",
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
			}
			if (url.pathname === "/browser-entry.js") {
				return new Response(script, {
					headers: { "Content-Type": "text/javascript; charset=utf-8" },
				});
			}
			if (url.pathname === "/favicon.ico")
				return new Response(null, { status: 204 });
			if (
				url.pathname === "/api/editor/sessions/session-one/file" &&
				url.searchParams.get("videoId") === "recording-one" &&
				url.searchParams.get("path") === sourcePath &&
				url.searchParams.get("raw") === "1"
			) {
				rawRequests += 1;
				return sourceAvailable
					? new Response(source, {
							headers: {
								"Content-Type": "image/png",
								"Content-Length": String(source.length),
							},
						})
					: new Response("Source recording was deleted", { status: 404 });
			}
			return new Response("Missing replay resource", { status: 404 });
		},
	});
	for (const [name, engine] of [
		["chromium", chromium],
		["webkit", webkit],
	] as const) {
		sourceAvailable = true;
		rawRequests = 0;
		const browser = await engine.launch({ headless: true });
		try {
			const page = await browser.newPage();
			const pageErrors: string[] = [];
			const failedResponses: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			page.on("response", (response) => {
				if (response.status() >= 400) failedResponses.push(response.url());
			});
			await page.goto(server.url.toString());
			await page.waitForFunction(() => Boolean(window.capPresetReplay));
			assert.equal(
				await page.evaluate(() => window.capPresetReplay?.save()),
				1,
			);
			assert.equal(rawRequests, 1);
			sourceAvailable = false;
			await page.reload();
			await page.waitForFunction(() => Boolean(window.capPresetReplay));
			const restored = await page.evaluate(() =>
				window.capPresetReplay?.apply(),
			);
			assert.ok(restored);
			assert.equal(
				createHash("sha256")
					.update(Buffer.from(restored.bytes ?? []))
					.digest("hex"),
				sourceSha256,
			);
			assert.equal(restored.importCount, 1);
			assert.equal(restored.mappedPath, targetPath);
			assert.equal(restored.resolvedPath, targetPath);
			const again = await page.evaluate(() => window.capPresetReplay?.apply());
			assert.equal(again?.importCount, 1);
			assert.equal(rawRequests, 1);
			assert.equal(
				await page.evaluate(() => window.capPresetReplay?.delete()),
				undefined,
			);
			assert.deepEqual(pageErrors, []);
			assert.deepEqual(failedResponses, []);
			process.stdout.write(
				`${JSON.stringify({ browser: name, sourceSha256, rawRequests, importCount: again?.importCount, pageErrors, failedResponses })}\n`,
			);
		} finally {
			await browser.close();
		}
	}
} finally {
	server?.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
