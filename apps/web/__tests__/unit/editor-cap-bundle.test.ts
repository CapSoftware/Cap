import {
	CAP_BUNDLE_HEADER_BYTES,
	CAP_BUNDLE_MAGIC,
	createCapBundle,
	parseCapBundleManifest,
	readCapBundleManifestLength,
	validCapBundlePath,
} from "@cap/editor-cap-bundle";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();

function rawBundle(files: unknown[], dataBytes: number) {
	const manifest = encoder.encode(JSON.stringify({ version: 1, files }));
	return parseCapBundleManifest(
		manifest,
		CAP_BUNDLE_HEADER_BYTES + manifest.byteLength + dataBytes,
	);
}

describe("Cap editor project bundle", () => {
	it("keeps large media as Blob parts and records exact byte offsets", async () => {
		const metadata = new Blob([JSON.stringify({ version: 1 })]);
		const screen = new Blob([new Uint8Array(4 * 1024 * 1024)]);
		const camera = new Blob([new Uint8Array(2 * 1024 * 1024)]);
		const bundle = createCapBundle([
			{ path: "content/camera.mp4", file: camera },
			{ path: "recording-meta.json", file: metadata },
			{ path: "content/screen.mp4", file: screen },
		]);
		const header = new Uint8Array(await bundle.slice(0, 12).arrayBuffer());
		expect(new TextDecoder().decode(header.slice(0, 8))).toBe(CAP_BUNDLE_MAGIC);
		const manifestLength = readCapBundleManifestLength(header);
		expect(manifestLength).not.toBeNull();
		if (manifestLength === null) throw new Error("Invalid bundle header");
		const manifest = parseCapBundleManifest(
			new Uint8Array(await bundle.slice(12, 12 + manifestLength).arrayBuffer()),
			bundle.size,
		);
		expect(manifest?.files).toEqual([
			{ path: "content/camera.mp4", size: camera.size, offset: 0 },
			{
				path: "content/screen.mp4",
				size: screen.size,
				offset: camera.size,
			},
			{
				path: "recording-meta.json",
				size: metadata.size,
				offset: camera.size + screen.size,
			},
		]);
		expect(bundle.size).toBe(
			12 + manifestLength + camera.size + screen.size + metadata.size,
		);
	});

	it("rejects traversal, absolute paths, and unknown project roots", () => {
		for (const path of [
			"../recording-meta.json",
			"content/../../private",
			"content//screen.mp4",
			"/content/screen.mp4",
			"content\\screen.mp4",
			"output/../screen.mp4",
			"other/screen.mp4",
			"content/bad\nname",
		]) {
			expect(validCapBundlePath(path)).toBe(false);
			expect(() =>
				createCapBundle([
					{ path: "recording-meta.json", file: new Blob(["{}"]) },
					{ path, file: new Blob(["x"]) },
				]),
			).toThrow();
		}
	});

	it("preserves imported audio and project screenshots", () => {
		for (const path of [
			"assets/audio/import-example.mp3",
			"screenshots/preview.jpg",
		]) {
			expect(validCapBundlePath(path)).toBe(true);
		}
		for (const path of ["assets/video/example.mp4", "assets/audio/../private"])
			expect(validCapBundlePath(path)).toBe(false);
	});

	it("rejects duplicate, overlapping, truncated, and oversized manifests", () => {
		const meta = { path: "recording-meta.json", size: 2, offset: 0 };
		expect(rawBundle([meta, meta], 4)).toBeNull();
		expect(
			rawBundle([meta, { path: "content/screen.mp4", size: 3, offset: 1 }], 5),
		).toBeNull();
		expect(rawBundle([meta], 3)).toBeNull();
		expect(rawBundle([{ ...meta, size: -1 }], 0)).toBeNull();
		expect(
			rawBundle([{ ...meta, size: Number.MAX_SAFE_INTEGER }], 0),
		).toBeNull();
		expect(rawBundle([{ ...meta, size: "2" }], 2)).toBeNull();
		expect(
			rawBundle([{ path: "content/screen.mp4", size: 2, offset: 0 }], 2),
		).toBeNull();
		expect(readCapBundleManifestLength(new Uint8Array(12))).toBeNull();
	});
});
