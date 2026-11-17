import { readFileSync } from "node:fs";
import type { VideoId } from "@cap/recorder-core";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FailedRecording } from "../shared/storage";
import type { RecordingStatus } from "../shared/types";

type MessageListener = Parameters<
	typeof chrome.runtime.onMessage.addListener
>[0];
type StorageListener = Parameters<
	typeof chrome.storage.onChanged.addListener
>[0];
let listener: MessageListener;
let storageListener: StorageListener;
let dom: JSDOM;
let polledStatus: RecordingStatus;
const videoA = "video-a" as VideoId;
const videoB = "video-b" as VideoId;
const failed = {
	phase: "error",
	videoId: videoA,
	message: "Upload failed for A",
	recoverable: true,
} satisfies RecordingStatus;
const entry: FailedRecording = {
	sessionId: "session-a",
	videoId: videoA,
	mimeType: "video/webm",
	totalBytes: 100,
	createdAt: 1,
	shareUrl: null,
	subpath: "raw-upload.webm",
	durationMs: 1000,
	width: 320,
	height: 180,
	fps: 30,
	message: failed.message,
};

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	polledStatus = failed;
	dom = new JSDOM(
		readFileSync(new URL("../../uploading.html", import.meta.url), "utf8"),
		{ url: "https://extension.test/uploading.html?videoId=video-a" },
	);
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.window.document);
	dom.window.requestAnimationFrame = vi.fn(() => 1);
	vi.stubGlobal("chrome", {
		runtime: {
			onMessage: {
				addListener: (fn: MessageListener) => {
					listener = fn;
				},
			},
			sendMessage: (_message: unknown, callback: (response: unknown) => void) =>
				callback({ ok: true, status: polledStatus }),
		},
		storage: {
			onChanged: {
				addListener: (fn: StorageListener) => {
					storageListener = fn;
				},
			},
			local: {
				get: (_keys: unknown, callback: (items: unknown) => void) =>
					callback({ "cap-extension-failed-recordings": [entry] }),
			},
			session: {
				get: (_keys: unknown, callback: (items: unknown) => void) =>
					callback({
						"cap-extension-recording-state": {
							status: polledStatus,
							plan: null,
							updatedAt: 1,
						},
					}),
			},
		},
	});
	await import("./main");
	await Promise.resolve();
	await Promise.resolve();
});
afterEach(() => {
	dom.window.close();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const broadcast = (status: RecordingStatus) =>
	listener(
		{ target: "recording-status", type: "recording-status-changed", status },
		{},
		() => undefined,
	);

it.each(["broadcast", "storage"])(
	"preserves A's retry and download through B's lifecycle via %s",
	async (source) => {
		expect(document.getElementById("error-actions")?.hidden).toBe(false);
		const statuses: RecordingStatus[] = [
			{ phase: "creating" },
			{
				phase: "recording",
				videoId: videoB,
				startedAt: 0,
				durationMs: 0,
				updatedAt: 0,
			},
			{
				phase: "error",
				videoId: videoB,
				message: "B upload failed",
				recoverable: true,
			},
			{
				phase: "completed",
				videoId: videoB,
				shareUrl: "https://cap.test/s/video-b",
			},
		];
		for (const status of statuses) {
			polledStatus = status;
			if (source === "broadcast") broadcast(status);
			if (source === "storage") {
				storageListener(
					{ "cap-extension-recording-state": { newValue: { status } } },
					"session",
				);
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(document.getElementById("upload-detail")?.textContent).toBe(
				"Upload failed for A",
			);
			expect(document.getElementById("error-actions")?.hidden).toBe(false);
			expect(
				document.getElementById("share-link")?.getAttribute("href"),
			).not.toBe("https://cap.test/s/video-b");
		}
	},
);

it("still updates and completes the matching recording", () => {
	broadcast({
		phase: "uploading",
		videoId: videoA,
		startedAt: 0,
		durationMs: 1000,
		updatedAt: 0,
	});
	expect(document.getElementById("upload-title")?.textContent).toBe(
		"Uploading your Cap",
	);
	broadcast({
		phase: "completed",
		videoId: videoA,
		shareUrl: "https://cap.test/s/video-a",
	});
	expect(document.getElementById("upload-title")?.textContent).toBe(
		"Your Cap is ready",
	);
	expect(document.getElementById("share-link")?.getAttribute("href")).toBe(
		"https://cap.test/s/video-a",
	);
});

it("ignores a poll for B while the page is tracking A", async () => {
	broadcast({
		phase: "uploading",
		videoId: videoA,
		startedAt: 0,
		durationMs: 1000,
		updatedAt: 0,
	});
	polledStatus = {
		phase: "recording",
		videoId: videoB,
		startedAt: 1,
		durationMs: 0,
		updatedAt: 1,
	};
	await vi.advanceTimersByTimeAsync(2000);
	expect(document.getElementById("upload-title")?.textContent).toBe(
		"Uploading your Cap",
	);
});
