import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, webkit } from "@playwright/test";

type DialogModule =
	typeof import("../../../../../packages/editor-solid-web/src/tauri-dialog");
type DialogWindow = Window & {
	editorDialog?: DialogModule;
	editorOpenPromise?: Promise<string | null>;
};

const entrypoint = resolve(
	import.meta.dir,
	"../../../../../packages/editor-solid-web/src/tauri-dialog.ts",
);
const bundle = await Bun.build({
	entrypoints: [entrypoint],
	target: "browser",
	format: "esm",
});
assert.ok(bundle.success, bundle.logs.map((log) => log.message).join("\n"));
assert.equal(bundle.outputs.length, 1);
const source = await bundle.outputs[0]?.text();
assert.ok(source);

const temporary = await mkdtemp(
	join(tmpdir(), "cap-editor-browser-directory-"),
);
const good = join(temporary, "sample.cap");
const missingMedia = join(temporary, "missing-media.cap");
const wrongRoot = join(temporary, "ordinary-folder");
const expected = new Map([
	[
		"recording-meta.json",
		JSON.stringify({
			segments: [
				{ display: { path: "content/segments/segment-0/display.mp4" } },
			],
		}),
	],
	["content/segments/segment-0/display.mp4", "screen-bytes-01"],
	["content/segments/segment-0/camera.mp4", "camera-bytes-02"],
	["content/segments/segment-0/mic.wav", "microphone-bytes-03"],
]);

async function writeFixture(folder: string, files: Map<string, string>) {
	for (const [relative, content] of files) {
		const path = join(folder, relative);
		await mkdir(resolve(path, ".."), { recursive: true });
		await writeFile(path, content);
	}
}

async function createPage(browser: Browser) {
	const page = await browser.newPage();
	const url = "https://editor.cap.so/browser-directory-replay";
	await page.route(url, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body></body></html>",
		}),
	);
	await page.goto(url);
	await page.evaluate(async (code) => {
		const moduleUrl = URL.createObjectURL(
			new Blob([code], { type: "text/javascript" }),
		);
		try {
			(window as DialogWindow).editorDialog = (await import(
				moduleUrl
			)) as DialogModule;
		} finally {
			URL.revokeObjectURL(moduleUrl);
		}
	}, source);
	return page;
}

async function selectFolder(
	page: Awaited<ReturnType<typeof createPage>>,
	folder: string,
) {
	const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
	await page.evaluate(() => {
		const dialog = (window as DialogWindow).editorDialog;
		if (!dialog) throw new Error("Editor browser dialog did not load");
		(window as DialogWindow).editorOpenPromise = dialog.open({
			directory: true,
		});
	});
	const chooser = await chooserPromise;
	await chooser.setFiles(folder);
	return page.evaluate(async () => {
		const pending = (window as DialogWindow).editorOpenPromise;
		if (!pending) throw new Error("Editor browser picker did not open");
		return pending;
	});
}

async function replay(browser: Browser, name: string) {
	const page = await createPage(browser);
	const alerts: string[] = [];
	const dialogAccepts: Promise<void>[] = [];
	page.on("dialog", (dialog) => {
		alerts.push(dialog.message());
		dialogAccepts.push(dialog.accept());
	});
	try {
		const token = await selectFolder(page, good);
		assert.ok(token);
		assert.match(token, /^cap-web-editor:\/\/import\/[0-9a-f-]{36}$/);
		const result = await page.evaluate(async (selection) => {
			const dialog = (window as DialogWindow).editorDialog;
			if (!dialog) throw new Error("Editor browser dialog is unavailable");
			const file = dialog.takeEditorSelectedFile(selection);
			if (!file) throw new Error("Selected recording bundle is unavailable");
			const bytes = new Uint8Array(await file.arrayBuffer());
			const magic = new TextDecoder().decode(bytes.subarray(0, 8));
			const length = new DataView(bytes.buffer).getUint32(8, true);
			const manifest = JSON.parse(
				new TextDecoder().decode(bytes.subarray(12, 12 + length)),
			) as {
				version: number;
				files: Array<{ path: string; size: number; offset: number }>;
			};
			const entries = manifest.files.map((entry) => ({
				path: entry.path,
				content: new TextDecoder().decode(
					bytes.subarray(
						12 + length + entry.offset,
						12 + length + entry.offset + entry.size,
					),
				),
			}));
			return {
				name: file.name,
				type: file.type,
				magic,
				version: manifest.version,
				entries,
				secondTakeMissing: dialog.takeEditorSelectedFile(selection) === null,
			};
		}, token);
		assert.equal(result.name, "sample.capbundle");
		assert.equal(result.type, "application/vnd.cap.project-bundle");
		assert.equal(result.magic, "CAPBND01");
		assert.equal(result.version, 1);
		assert.equal(result.secondTakeMissing, true);
		assert.deepEqual(
			new Map(result.entries.map((entry) => [entry.path, entry.content])),
			expected,
		);
		assert.equal(alerts.length, 0);
		const missingDialog = page.waitForEvent("dialog", { timeout: 10_000 });
		const missingToken = await selectFolder(page, missingMedia);
		await missingDialog;
		assert.equal(missingToken, null);
		assert.match(alerts.at(-1) ?? "", /missing Cap recording media/);
		const wrongRootDialog = page.waitForEvent("dialog", { timeout: 10_000 });
		const wrongRootToken = await selectFolder(page, wrongRoot);
		await wrongRootDialog;
		assert.equal(wrongRootToken, null);
		assert.match(alerts.at(-1) ?? "", /Select a \.cap recording folder/);
		console.log(
			JSON.stringify({ name, entries: result.entries.length, alerts }),
		);
	} finally {
		await Promise.all(dialogAccepts);
		await page.close();
	}
}

try {
	await writeFixture(good, new Map([...expected, ["notes.txt", "ignored"]]));
	await writeFixture(
		missingMedia,
		new Map([
			["recording-meta.json", "{}"],
			["notes.txt", "ignored"],
		]),
	);
	await writeFixture(wrongRoot, expected);
	for (const [name, engine] of [
		["Chromium", chromium],
		["WebKit", webkit],
	] as const) {
		const browser = await engine.launch({ headless: true });
		try {
			await replay(browser, name);
		} finally {
			await browser.close();
		}
	}
} finally {
	await rm(temporary, { recursive: true, force: true });
}
