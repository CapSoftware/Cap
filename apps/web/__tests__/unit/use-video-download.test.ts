// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getVideoDownloadInfo: vi.fn(),
	toastPromise: vi.fn(),
}));

vi.mock("@/actions/videos/download", () => ({
	getVideoDownloadInfo: mocks.getVideoDownloadInfo,
}));
vi.mock("sonner", () => ({ toast: { promise: mocks.toastPromise } }));

import { useVideoDownload } from "@/app/s/[videoId]/_components/use-video-download";

const signedUrl =
	"https://bucket.example/owner/video/result.mp4?response-content-disposition=attachment&X-Amz-Signature=sig";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let download: ReturnType<typeof useVideoDownload>["download"] | null = null;

function Harness() {
	download = useVideoDownload(Video.VideoId.make("video")).download;
	return null;
}

beforeEach(async () => {
	(
		globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	mocks.getVideoDownloadInfo.mockResolvedValue({
		success: true,
		downloadUrl: signedUrl,
		filename: "Two hour recording.mp4",
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(Harness)));
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	for (const frame of document.querySelectorAll("body > iframe"))
		frame.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	mocks.getVideoDownloadInfo.mockReset();
	mocks.toastPromise.mockReset();
});

const downloadFrames = () =>
	Array.from(document.querySelectorAll<HTMLIFrameElement>("body > iframe"));

it("hands the signed URL to the browser instead of buffering the file", async () => {
	const fetchSpy = vi.fn();
	vi.stubGlobal("fetch", fetchSpy);
	const createObjectURL = vi.fn();
	URL.createObjectURL = createObjectURL;
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => undefined);

	await act(async () => {
		download?.("current");
		await mocks.toastPromise.mock.calls[0]?.[0];
	});

	expect(mocks.getVideoDownloadInfo).toHaveBeenCalledWith("video", "current");
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(createObjectURL).not.toHaveBeenCalled();
	expect(click).not.toHaveBeenCalled();
	expect(downloadFrames().map((frame) => frame.src)).toEqual([signedUrl]);
	expect(downloadFrames()[0]?.hidden).toBe(true);
	vi.unstubAllGlobals();
});

it("keeps an earlier download alive when another one starts", async () => {
	vi.useFakeTimers();
	const nextUrl = `${signedUrl}&next=1`;
	await act(async () => {
		download?.("current");
		await mocks.toastPromise.mock.calls[0]?.[0];
	});
	mocks.getVideoDownloadInfo.mockResolvedValue({
		success: true,
		downloadUrl: nextUrl,
		filename: "Two hour recording (original).mp4",
	});
	await act(async () => {
		download?.("original");
		await mocks.toastPromise.mock.calls[1]?.[0];
	});

	expect(downloadFrames().map((frame) => frame.src)).toEqual([
		signedUrl,
		nextUrl,
	]);

	vi.advanceTimersByTime(5 * 60 * 1000);
	expect(downloadFrames()).toHaveLength(0);
	vi.useRealTimers();
});

it("reports the server error without starting a download", async () => {
	mocks.getVideoDownloadInfo.mockResolvedValue({
		success: false,
		error: "Video is still processing. Try again once it has finished.",
	});
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => undefined);

	await act(async () => {
		download?.("current");
		await mocks.toastPromise.mock.calls[0]?.[0].catch(() => undefined);
	});

	await expect(mocks.toastPromise.mock.calls[0]?.[0]).rejects.toThrow(
		"Video is still processing",
	);
	expect(click).not.toHaveBeenCalled();
	expect(downloadFrames()).toHaveLength(0);
});
