import { describe, expect, it } from "vitest";
import {
	isOffscreenRequest,
	isOverlayMessage,
	isRecordingStatusBroadcast,
	isServiceWorkerRequest,
} from "./messages";

describe("extension message contracts", () => {
	it("routes popup requests only to the service worker", () => {
		const message = { target: "service-worker", type: "bootstrap" };
		expect(isServiceWorkerRequest(message)).toBe(true);
		expect(isOffscreenRequest(message)).toBe(false);
	});

	it("routes recording requests only to the offscreen document", () => {
		const message = { target: "offscreen", type: "get-recording-status" };
		expect(isOffscreenRequest(message)).toBe(true);
		expect(isServiceWorkerRequest(message)).toBe(false);
	});

	it("accepts overlay messages without runtime targets", () => {
		expect(isOverlayMessage({ type: "overlay-hide" })).toBe(true);
		expect(isOverlayMessage({ type: "overlay-enter-auto-pip" })).toBe(true);
		expect(isOverlayMessage({ type: "overlay-exit-auto-pip" })).toBe(true);
		expect(
			isOverlayMessage({ target: "offscreen", type: "overlay-hide" }),
		).toBe(true);
		expect(isOverlayMessage({ type: "bootstrap" })).toBe(false);
	});

	it("routes recording status broadcasts separately from requests", () => {
		const message = {
			target: "recording-status",
			type: "recording-status-changed",
			status: { phase: "completed", videoId: "v", shareUrl: "https://cap.so" },
		};
		expect(isRecordingStatusBroadcast(message)).toBe(true);
		expect(isServiceWorkerRequest(message)).toBe(false);
		expect(isOffscreenRequest(message)).toBe(false);
		expect(
			isRecordingStatusBroadcast({
				target: "recording-status",
				type: "bootstrap",
			}),
		).toBe(false);
	});
});
