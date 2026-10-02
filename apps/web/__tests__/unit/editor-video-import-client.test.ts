import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/recorder-core", () => ({
	InstantRecordingUploader: class {},
	MultipartCompletionUncertainError: class extends Error {},
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));

import { importWebEditorVideo } from "@/lib/editor-video-import-client";

const start = (file: File) =>
	importWebEditorVideo(
		file,
		"video",
		"owner",
		"session",
		new AbortController().signal,
	);

describe("importWebEditorVideo", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("shortens a long file name to what the upload accepts", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 500 }));
		vi.stubGlobal("fetch", fetch);
		const name = `${"Quarterly review 🎬 ".repeat(8)}final.MP4`;

		await expect(start(new File(["x"], name))).rejects.toThrow(
			"Video upload could not start in the editor",
		);

		const body = JSON.parse(
			(fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.fileName.length).toBeLessThanOrEqual(100);
		expect(body.fileName).toMatch(/^Quarterly review 🎬 .*\.mp4$/);
		expect(body.fileName).not.toMatch(/�|[\uD800-\uDBFF]\.mp4$/);
	});

	it("keeps short names as they are", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 500 }));
		vi.stubGlobal("fetch", fetch);

		await expect(start(new File(["x"], "Démo 视频.mov"))).rejects.toThrow();

		const body = JSON.parse(
			(fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.fileName).toBe("Démo 视频.mov");
	});

	it("says why a file can't be imported", async () => {
		await expect(start(new File(["x"], "notes.txt"))).rejects.toThrow(
			"This video format isn't supported",
		);
		await expect(start(new File([], "empty.mp4"))).rejects.toThrow(
			"This video file is empty",
		);
	});
});
