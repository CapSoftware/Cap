import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/recorder-core", () => ({
	InstantRecordingUploader: class {},
	MultipartCompletionUncertainError: class extends Error {},
}));

import {
	CAP_BUNDLE_UNSUPPORTED,
	importWebEditorVideo,
	isCapBundleFile,
	uploadFileName,
	validVideoProbe,
} from "@/lib/editor-video-import-client";

const start = (file: File) =>
	importWebEditorVideo(file, "video", new AbortController().signal);

describe("importWebEditorVideo", () => {
	it("shortens a long file name to what the upload accepts", () => {
		const name = `${"Quarterly review 🎬 ".repeat(8)}final.MP4`;
		const fileName = uploadFileName(name, "mp4");
		expect(fileName.length).toBeLessThanOrEqual(100);
		expect(fileName).toMatch(/^Quarterly review 🎬 .*\.mp4$/);
		expect(fileName).not.toMatch(/�|[\uD800-\uDBFF]\.mp4$/);
	});

	it("keeps short names as they are", () => {
		expect(uploadFileName("Démo 视频.webm", "webm")).toBe("Démo 视频.webm");
		expect(uploadFileName(".mp4", "mp4")).toBe("Video.mp4");
	});

	it("says why a file can't be imported", async () => {
		await expect(start(new File(["x"], "notes.txt"))).rejects.toThrow(
			"Import an MP4 or WebM video",
		);
		await expect(start(new File(["x"], "clip.mov"))).rejects.toThrow(
			"Import an MP4 or WebM video",
		);
		await expect(start(new File([], "empty.mp4"))).rejects.toThrow(
			"This video file is empty",
		);
	});

	it("turns away Cap recordings, which only a desktop editor can unpack", async () => {
		const bundle = new File(["x"], "Recording.capbundle");
		expect(isCapBundleFile(bundle)).toBe(true);
		await expect(start(bundle)).rejects.toThrow(CAP_BUNDLE_UNSUPPORTED);
	});

	it("rounds frame rates into what a clip can store and rejects oversized video", () => {
		const probe = {
			duration: 4.5,
			fps: 29.97,
			width: 1920,
			height: 1080,
			hasAudio: true,
		};
		expect(validVideoProbe(probe)?.fps).toBe(30);
		expect(validVideoProbe({ ...probe, fps: 240 })?.fps).toBe(120);
		expect(validVideoProbe({ ...probe, width: 16_384, height: 16_384 })).toBe(
			null,
		);
		expect(validVideoProbe({ ...probe, duration: 0 })).toBe(null);
		expect(validVideoProbe({ ...probe, duration: 90_000 })).toBe(null);
	});
});
