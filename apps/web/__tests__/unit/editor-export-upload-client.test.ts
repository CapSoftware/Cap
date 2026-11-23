import { afterEach, expect, test, vi } from "vitest";
import { uploadWebEditorFile } from "../../lib/editor-export-upload-client";

afterEach(() => vi.unstubAllGlobals());

test("a browser Save carries its id and reports when a newer Save replaced it", async () => {
	const bodies: unknown[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return Response.json(
			{ error: "A newer save replaced this one", code: "SAVE_SUPERSEDED" },
			{ status: 409 },
		);
	});
	await expect(
		uploadWebEditorFile(
			"video",
			"00000000-0000-4000-8000-00000000000a",
			new Blob([new Uint8Array(16)], { type: "video/mp4" }),
			{ duration: 12, width: 1920, height: 1080, fps: 30 },
			new AbortController().signal,
		),
	).rejects.toThrow(/^A newer save replaced this one$/);
	expect(bodies).toEqual([
		expect.objectContaining({
			videoId: "video",
			replaceExisting: true,
			browserSaveId: "00000000-0000-4000-8000-00000000000a",
		}),
	]);
});
