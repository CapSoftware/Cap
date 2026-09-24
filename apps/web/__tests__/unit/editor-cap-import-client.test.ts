import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { afterEach, expect, test, vi } from "vitest";
import { importWebEditorCap } from "../../lib/editor-cap-import-client";

const uploader = vi.hoisted(() => ({
	finalize: vi.fn(async () => {}),
	cancel: vi.fn(async () => {}),
}));

vi.mock("@cap/recorder-core", () => ({
	InstantRecordingUploader: class {
		finalize = uploader.finalize;
		cancel = uploader.cancel;
	},
	MultipartCompletionUncertainError: class extends Error {},
}));

afterEach(() => {
	vi.unstubAllGlobals();
	uploader.finalize.mockClear();
	uploader.cancel.mockClear();
});

test("aborting an uploaded Cap import stops its worker job", async () => {
	const videoId = "video";
	const ownerId = "owner";
	const sessionId = "session";
	const fileId = "9a2aa734-d076-42c0-8a8a-68db1d2d2a1e";
	const path = `content/imports/${fileId}.capbundle`;
	const key = `${ownerId}/${videoId}/editor-assets/recordings/${fileId}.capbundle`;
	const jobId = "afe747f6-4c9d-47d4-9ca0-99ffad1c0050";
	const controller = new AbortController();
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST") {
				return Response.json({
					key,
					path,
					uploadId: "upload",
					provider: "s3",
				});
			}
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (url.includes(jobId)) {
				controller.abort();
				return Response.json({
					id: jobId,
					status: "staging",
					result: null,
					error: null,
				});
			}
			return Response.json({ id: jobId, status: "staging" });
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const file = new File([new Uint8Array([1])], "recording.capbundle", {
		type: CAP_BUNDLE_CONTENT_TYPE,
	});

	await expect(
		importWebEditorCap(file, videoId, ownerId, sessionId, controller.signal),
	).rejects.toThrow("canceled");
	expect(uploader.finalize).toHaveBeenCalledOnce();
	expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
		"POST",
		undefined,
		undefined,
		"DELETE",
	]);
	expect(fetchMock.mock.calls[3]?.[0]).toBe(
		`/api/editor/sessions/${sessionId}/video-assets/${jobId}?videoId=${videoId}&key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`,
	);
});
