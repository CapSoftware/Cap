import { Organisation, Video } from "@cap/web-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	trigger: vi.fn(),
	progress: vi.fn(),
}));

vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: mocks.create,
}));
vi.mock("@/actions/video/trigger-processing", () => ({
	triggerVideoProcessing: mocks.trigger,
}));
vi.mock("@/actions/video/upload", () => ({
	createVideoAndGetUploadUrl: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: mocks.progress,
}));
vi.mock("@remotion/media-parser", () => ({
	parseMedia: async () => ({ durationInSeconds: 60, dimensions: null }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { importMediaFile } from "@/app/(org)/dashboard/import/import-media";

class MockXMLHttpRequest {
	static current: MockXMLHttpRequest | undefined;
	upload = {
		onprogress: null as
			| ((event: {
					lengthComputable: boolean;
					loaded: number;
					total: number;
			  }) => void)
			| null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	status = 0;

	constructor() {
		MockXMLHttpRequest.current = this;
	}

	open() {}
	setRequestHeader() {}
	send() {}

	progress(loaded: number, total: number) {
		this.upload.onprogress?.({ lengthComputable: true, loaded, total });
	}
}

const videoId = Video.VideoId.make("video-123");
const total = 8 * 1024 ** 3;

describe("dashboard video import progress", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
		MockXMLHttpRequest.current = undefined;
		mocks.create.mockResolvedValue({
			id: videoId,
			rawFileKey: "user-123/video-123/raw-upload.mp4",
			bucketId: null,
			uploadTarget: {
				type: "put",
				url: "https://storage.example/upload",
				headers: {},
			},
		});
		mocks.progress.mockResolvedValue(undefined);
		mocks.trigger.mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each(["success", "failure"] as const)(
		"reports steady uploads periodically and cleans up after %s",
		async (outcome) => {
			const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
			Object.defineProperty(file, "size", { value: total });
			const importing = importMediaFile({
				file,
				orgId: Organisation.OrganisationId.make("org-123"),
				setUploadStatus: vi.fn(),
			});
			const request = await vi.waitFor(() => {
				if (!MockXMLHttpRequest.current) throw new Error("Upload not started");
				return MockXMLHttpRequest.current;
			});

			request.progress(total / 16, total);
			for (let tick = 1; tick <= 8; tick++) {
				await vi.advanceTimersByTimeAsync(500);
				request.progress(((tick + 1) * total) / 16, total);
			}

			expect(mocks.progress.mock.calls).toEqual([
				[videoId, total / 4, total],
				[videoId, total / 2, total],
			]);
			expect(mocks.trigger).not.toHaveBeenCalled();

			if (outcome === "success") {
				request.progress(total, total);
				await vi.advanceTimersByTimeAsync(2000);
				expect(mocks.progress).toHaveBeenCalledTimes(2);
				expect(mocks.trigger).not.toHaveBeenCalled();
				request.status = 200;
				request.onload?.();
			} else {
				vi.spyOn(console, "error").mockImplementation(() => {});
				request.onerror?.();
			}

			expect(await importing).toBe(outcome === "success");
			expect(mocks.trigger).toHaveBeenCalledTimes(
				outcome === "success" ? 1 : 0,
			);
			if (outcome === "success") {
				expect(mocks.progress).toHaveBeenLastCalledWith(videoId, total, total);
			}
			const updates = mocks.progress.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(mocks.progress).toHaveBeenCalledTimes(updates);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
