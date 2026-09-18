import { describe, expect, it } from "bun:test";
import {
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";
import { bundleEditorCapDirectory } from "./tauri-dialog";

function sourceFile(path: string, value: string) {
	const file = new File([value], path.split("/").at(-1) ?? "", {
		type: "text/plain",
	});
	Object.defineProperty(file, "webkitRelativePath", { value: path });
	return file;
}

describe("browser Cap recording picker", () => {
	it("keeps separate camera and screen files with recording metadata", async () => {
		const bundle = bundleEditorCapDirectory([
			sourceFile("demo.cap/content/segments/segment-0/camera.mp4", "camera"),
			sourceFile("demo.cap/recording-meta.json", "{}"),
			sourceFile("demo.cap/content/segments/segment-0/display.mp4", "screen"),
			sourceFile("demo.cap/content/segments/segment-0/mic.wav", "mic"),
			sourceFile("demo.cap/content/segments/segment-0/cursor.json", "cursor"),
			sourceFile(
				"demo.cap/content/segments/segment-0/keyboard.json",
				"keyboard",
			),
			sourceFile("demo.cap/.DS_Store", "ignored"),
		]);
		expect(bundle.name).toBe("demo.capbundle");
		const header = new Uint8Array(await bundle.slice(0, 12).arrayBuffer());
		const manifestLength = readCapBundleManifestLength(header);
		expect(manifestLength).not.toBeNull();
		if (manifestLength === null) throw new Error("Invalid bundle header");
		const manifest = parseCapBundleManifest(
			new Uint8Array(await bundle.slice(12, 12 + manifestLength).arrayBuffer()),
			bundle.size,
		);
		expect(manifest?.files.map((file) => file.path)).toEqual([
			"content/segments/segment-0/camera.mp4",
			"content/segments/segment-0/cursor.json",
			"content/segments/segment-0/display.mp4",
			"content/segments/segment-0/keyboard.json",
			"content/segments/segment-0/mic.wav",
			"recording-meta.json",
		]);
		if (!manifest) throw new Error("Invalid bundle manifest");
		const bytes = new Uint8Array(await bundle.arrayBuffer());
		const payloadStart = 12 + manifestLength;
		const expected = new Map([
			["content/segments/segment-0/camera.mp4", "camera"],
			["content/segments/segment-0/cursor.json", "cursor"],
			["content/segments/segment-0/display.mp4", "screen"],
			["content/segments/segment-0/keyboard.json", "keyboard"],
			["content/segments/segment-0/mic.wav", "mic"],
			["recording-meta.json", "{}"],
		]);
		for (const file of manifest.files) {
			const expectedValue = expected.get(file.path);
			if (expectedValue === undefined) throw new Error("Unexpected Cap file");
			expect(
				new TextDecoder().decode(
					bytes.subarray(
						payloadStart + file.offset,
						payloadStart + file.offset + file.size,
					),
				),
			).toBe(expectedValue);
		}
	});

	it("rejects non-Cap, incomplete, and mixed-folder selections", () => {
		expect(() =>
			bundleEditorCapDirectory([
				sourceFile("other/recording-meta.json", "{}"),
				sourceFile("other/content/display.mp4", "screen"),
			]),
		).toThrow(".cap");
		expect(() =>
			bundleEditorCapDirectory([
				sourceFile("demo.cap/recording-meta.json", "{}"),
				sourceFile("demo.cap/other/notes.txt", "notes"),
			]),
		).toThrow("media");
		expect(() =>
			bundleEditorCapDirectory([
				sourceFile("demo.cap/recording-meta.json", "{}"),
				sourceFile("other.cap/content/display.mp4", "screen"),
			]),
		).toThrow("another folder");
	});
});
