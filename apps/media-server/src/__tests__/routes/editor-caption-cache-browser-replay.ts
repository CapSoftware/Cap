import assert from "node:assert/strict";
import {
	lstat,
	mkdtemp,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";

const root = resolve(import.meta.dir, "../../../../..");
const cachePath = resolve(
	root,
	"packages/editor-solid-web/src/caption-cache-memo.ts",
);
const transportPath = resolve(root, "apps/web/lib/editor-caption-transport.ts");
const temporary = await mkdtemp(join(tmpdir(), "cap-caption-cache-browser-"));
const entrypoint = join(temporary, "entry.ts");
const dependencies = join(temporary, "node_modules");

const entrySource = `
import { createStore, produce } from "solid-js/store";
import { EditorCaptionCacheMemo } from ${JSON.stringify(cachePath)};
import { createEditorCaptionCache } from ${JSON.stringify(transportPath)};

export async function replay() {
	const segments = Array.from({ length: 3_000 }, (_, index) => ({
		id: "segment-" + index,
		text: "A useful recording process for everyone",
		start: index * 2.4,
		end: index * 2.4 + 2.2,
		words: Array.from({ length: 6 }, (_, wordIndex) => ({
			text: "recording",
			start: index * 2.4 + wordIndex * 0.4,
			end: index * 2.4 + wordIndex * 0.4 + 0.3,
		})),
	}));
	const [project, setProject] = createStore({
		captions: { segments },
		timeline: { captionSegments: segments },
		camera: { mirror: false },
	});
	const cache = new EditorCaptionCacheMemo();
	try {
		const initialTask = cache.get(project);
		const initial = await initialTask;
		if (!initial) throw new Error("Long caption cache was unavailable");
		const cachedDurations = [];
		for (let index = 0; index < 25; index++) {
			setProject("camera", "mirror", index % 2 === 0);
			const config = {
				...project,
				timeline: { ...project.timeline },
				camera: { ...project.camera },
			};
			const start = performance.now();
			const task = cache.get(config);
			if (task !== initialTask || (await task)?.ref !== initial.ref)
				throw new Error("Camera edit rehashed unchanged captions");
			cachedDurations.push(performance.now() - start);
		}
		setProject("captions", "segments", 0, "words", 0, "text", "changed");
		const sourceTask = cache.get(project);
		const source = await sourceTask;
		if (!source || sourceTask === initialTask || source.ref === initial.ref)
			throw new Error("Caption word edit reused stale payload");
		setProject("timeline", "captionSegments", 0, "words", 0, "text", "edited");
		const trackTask = cache.get(project);
		const track = await trackTask;
		if (!track || trackTask === sourceTask || track.ref === source.ref)
			throw new Error("Caption track edit reused stale payload");
		setProject(produce((draft) => {
			draft.captions.segments.push({ ...segments[0], id: "added-caption" });
		}));
		const addedTask = cache.get(project);
		const added = await addedTask;
		if (!added || addedTask === trackTask || added.ref === track.ref)
			throw new Error("Added caption reused stale payload");
		const baselineDurations = [];
		for (let index = 0; index < 5; index++) {
			const start = performance.now();
			const result = await createEditorCaptionCache(project);
			if (result?.ref !== added.ref)
				throw new Error("Fresh caption hash disagreed with the cache");
			baselineDurations.push(performance.now() - start);
		}
		cachedDurations.sort((left, right) => left - right);
		const cachedAverageMs =
			cachedDurations.reduce((sum, duration) => sum + duration, 0) /
			cachedDurations.length;
		const baselineAverageMs =
			baselineDurations.reduce((sum, duration) => sum + duration, 0) /
			baselineDurations.length;
		return {
			captionBytes: new TextEncoder().encode(JSON.stringify({
				sourceSegments: segments,
				trackSegments: segments,
			})).byteLength,
			cameraEdits: cachedDurations.length,
			cachedAverageMs,
			cachedP95Ms: cachedDurations[23],
			baselineAverageMs,
		};
	} finally {
		cache.dispose();
	}
}
`;

let linked = false;
try {
	await symlink(join(root, "node_modules"), dependencies, "dir");
	linked = true;
	await writeFile(entrypoint, entrySource);
	const bundle = await Bun.build({
		entrypoints: [entrypoint],
		target: "browser",
		format: "esm",
	});
	assert.ok(bundle.success, bundle.logs.map((log) => log.message).join("\n"));
	assert.equal(bundle.outputs.length, 1);
	const source = await bundle.outputs[0]?.text();
	assert.ok(source);
	for (const [name, engine] of [
		["Chromium", chromium],
		["WebKit", webkit],
	] as const) {
		const browser = await engine.launch({ headless: true });
		try {
			const page = await browser.newPage();
			try {
				const url = "https://editor.cap.so/caption-cache-replay";
				await page.route(url, (route) =>
					route.fulfill({
						status: 200,
						contentType: "text/html",
						body: "<!doctype html><html><body></body></html>",
					}),
				);
				await page.goto(url);
				const result = await page.evaluate(async (code) => {
					const moduleUrl = URL.createObjectURL(
						new Blob([code], { type: "text/javascript" }),
					);
					try {
						const module = await import(moduleUrl);
						return module.replay();
					} finally {
						URL.revokeObjectURL(moduleUrl);
					}
				}, source);
				assert.ok(result.captionBytes > 128 * 1024);
				assert.equal(result.cameraEdits, 25);
				assert.ok(
					result.cachedAverageMs < Math.max(5, result.baselineAverageMs / 10),
					`${name} repeated caption cache work during camera edits`,
				);
				console.log(JSON.stringify({ browser: name, ...result }));
			} finally {
				await page.close();
			}
		} finally {
			await browser.close();
		}
	}
} finally {
	if (await Bun.file(entrypoint).exists()) await unlink(entrypoint);
	if (linked) {
		assert.ok((await lstat(dependencies)).isSymbolicLink());
		await unlink(dependencies);
	}
	await rmdir(temporary);
}
