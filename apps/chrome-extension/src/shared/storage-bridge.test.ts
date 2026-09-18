import { beforeEach, describe, expect, it } from "vitest";
import {
	loadLiveRecordingManifests,
	saveLiveRecordingManifest,
} from "./storage";
import {
	executeStorageBridgeRequest,
	isStorageBridgeRequest,
	isTrustedOffscreenStorageSender,
	requestStorage,
	type StorageBridgeRequest,
} from "./storage-bridge";

beforeEach(() => {
	delete (globalThis as { chrome?: unknown }).chrome;
});

describe("offscreen storage bridge", () => {
	it("persists recording recovery metadata when the offscreen document has runtime only", async () => {
		const data = new Map<string, unknown>();
		const requests: StorageBridgeRequest[] = [];
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				sendMessage: (
					message: unknown,
					callback: (response: unknown) => void,
				) => {
					if (!isStorageBridgeRequest(message)) {
						callback({ ok: false, error: "Invalid request" });
						return;
					}
					requests.push(message);
					if (message.type === "get") {
						callback({
							ok: true,
							items: Object.fromEntries(
								message.keys
									.filter((key) => data.has(key))
									.map((key) => [key, data.get(key)]),
							),
						});
						return;
					}
					if (message.type === "set") {
						for (const [key, value] of Object.entries(message.items)) {
							data.set(key, value);
						}
					} else {
						for (const key of Array.isArray(message.keys)
							? message.keys
							: [message.keys]) {
							data.delete(key);
						}
					}
					callback({ ok: true });
				},
			},
		};

		await saveLiveRecordingManifest({
			sessionId: "screen-session",
			cameraSessionId: "camera-session",
			videoId: "video-test",
			shareUrl: "https://cap.so/s/video-test",
			mimeType: "video/webm",
			cameraMimeType: "video/webm",
			subpath: "raw-upload.webm",
			cameraSubpath: "camera-upload.webm",
			cameraOffsetMs: 37,
			width: 1920,
			height: 1080,
			fps: 30,
			startedAt: 1_000,
		});

		expect(await loadLiveRecordingManifests()).toMatchObject([
			{
				sessionId: "screen-session",
				cameraSessionId: "camera-session",
				cameraOffsetMs: 37,
			},
		]);
		expect(requests.map((request) => request.type)).toEqual([
			"get",
			"set",
			"get",
		]);
	});

	it("rejects a storage proxy request from a content script or another extension page", () => {
		const extensionId = "cap-test";
		const offscreenUrl = "chrome-extension://cap-test/offscreen.html";
		expect(
			isTrustedOffscreenStorageSender(
				{ id: extensionId, url: offscreenUrl },
				extensionId,
				offscreenUrl,
			),
		).toBe(true);
		expect(
			isTrustedOffscreenStorageSender(
				{
					id: extensionId,
					url: "https://example.com",
					tab: { id: 1 } as chrome.tabs.Tab,
				},
				extensionId,
				offscreenUrl,
			),
		).toBe(false);
		expect(
			isTrustedOffscreenStorageSender(
				{
					id: extensionId,
					url: "chrome-extension://cap-test/popup.html",
				},
				extensionId,
				offscreenUrl,
			),
		).toBe(false);
	});

	it("reports a failed bridge write to the caller", async () => {
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				sendMessage: (
					_message: unknown,
					callback: (response: unknown) => void,
				) => callback({ ok: false, error: "Storage full" }),
			},
		};
		await expect(
			requestStorage({
				target: "storage-bridge",
				type: "set",
				area: "local",
				items: { key: "value" },
			}),
		).rejects.toThrow("Storage full");
	});

	it("reports a failed direct storage write", async () => {
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: { lastError: { message: "Storage full" } },
			storage: {
				local: {
					set: (_items: unknown, callback: () => void) => callback(),
				},
			},
		};
		await expect(
			executeStorageBridgeRequest({
				target: "storage-bridge",
				type: "set",
				area: "local",
				items: { key: "value" },
			}),
		).rejects.toThrow("Storage full");
	});
});
