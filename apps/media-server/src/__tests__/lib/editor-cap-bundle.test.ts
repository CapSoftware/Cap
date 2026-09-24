import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapBundle } from "@cap/editor-cap-bundle";
import { extractEditorCapBundle } from "../../lib/editor-cap-bundle";

test("extracts separate screen, camera, audio, cursor, and keyboard files", async () => {
	const content = [
		["recording-meta.json", JSON.stringify({ version: 1 })],
		["content/display.mp4", "screen"],
		["content/camera.mp4", "camera"],
		["content/mic.wav", "microphone"],
		["content/system.wav", "system"],
		["content/cursor.json", "cursor"],
		["content/keyboard.json", "keyboard"],
	] as const;
	const root = await mkdtemp(join(tmpdir(), "cap-bundle-test-"));
	try {
		const bundle = createCapBundle(
			content.map(([path, value]) => ({ path, file: new Blob([value]) })),
		);
		const path = join(root, "recording.capbundle");
		await writeFile(path, new Uint8Array(await bundle.arrayBuffer()));
		const extracted = await extractEditorCapBundle(path);
		try {
			for (const [file, value] of content) {
				expect(await readFile(join(extracted.path, file), "utf8")).toBe(value);
			}
		} finally {
			await extracted.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects truncated or tampered bundles before creating project files", async () => {
	const root = await mkdtemp(join(tmpdir(), "cap-bundle-test-"));
	try {
		const bundle = createCapBundle([
			{ path: "recording-meta.json", file: new Blob(["{}"]) },
			{ path: "content/display.mp4", file: new Blob(["screen"]) },
		]);
		const bytes = new Uint8Array(await bundle.arrayBuffer());
		const path = join(root, "recording.capbundle");
		await writeFile(path, bytes.slice(0, -1));
		await expect(extractEditorCapBundle(path)).rejects.toThrow("manifest");
		bytes[0] = 0;
		await writeFile(path, bytes);
		await expect(extractEditorCapBundle(path)).rejects.toThrow("header");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stops an import when its session is canceled", async () => {
	const root = await mkdtemp(join(tmpdir(), "cap-bundle-test-"));
	try {
		const bundle = createCapBundle([
			{ path: "recording-meta.json", file: new Blob(["{}"]) },
		]);
		const path = join(root, "recording.capbundle");
		await writeFile(path, new Uint8Array(await bundle.arrayBuffer()));
		const controller = new AbortController();
		controller.abort();
		await expect(
			extractEditorCapBundle(path, controller.signal),
		).rejects.toThrow("canceled");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
