import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadThumbnail } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-upload";
import type {
	UploadTarget,
	VideoId,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-types";
import type { UploadStatus } from "@/app/(org)/dashboard/caps/UploadingContext";

describe("recording thumbnail upload", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the server proxy for Safari thumbnail uploads", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ success: true }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const statuses: Array<UploadStatus | undefined> = [];
		const target = {
			type: "s3Put",
			url: "https://storage.example/screen-capture.jpg",
			headers: {},
		} as unknown as UploadTarget;
		const blob = new Blob(["thumbnail"], { type: "image/jpeg" });

		await uploadThumbnail({
			blob,
			target,
			currentVideoId: "video-1" as VideoId,
			setUploadStatus: (status) => statuses.push(status),
			useServerProxy: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe(
			"/api/upload/signed/proxy?videoId=video-1&subpath=screenshot%2Fscreen-capture.jpg",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "image/jpeg" },
			body: blob,
		});
		expect(
			statuses.map((status) =>
				status && "progress" in status ? status.progress : undefined,
			),
		).toEqual([90, 100]);
	});
});
