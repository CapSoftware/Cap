import { describe, expect, it } from "vitest";
import {
	type StartRecordingPreferences,
	buildStartRecordingDeepLink,
	buildStartRecordingPayload,
	buildStopRecordingDeepLink,
	extractShareableCapUrl,
	resolveDashboardUrl,
} from "./deeplink";

describe("Cap Raycast deep-link builders", () => {
	it("constructs start_recording payloads preserving mode, screen, devices, and audio", () => {
		const prefs: StartRecordingPreferences = {
			defaultMode: "studio",
			defaultScreen: "Built-in Retina Display",
			cameraDeviceId: "cam-01",
			micLabel: "Studio Mic",
			captureSystemAudio: false,
		};
		const payload = buildStartRecordingPayload(prefs);

		expect(payload).toEqual({
			start_recording: {
				capture_mode: { screen: "Built-in Retina Display" },
				camera: { DeviceID: "cam-01" },
				mic_label: "Studio Mic",
				capture_system_audio: false,
				mode: "studio",
			},
		});

		const url = new URL(buildStartRecordingDeepLink(prefs));
		expect(url.protocol).toBe("cap-desktop:");
		expect(url.host).toBe("action");
		const decoded = JSON.parse(url.searchParams.get("value") || "{}");
		expect(decoded).toEqual(payload);
	});

	it("falls back to detected macOS display name or throws when none is available", () => {
		const payload = buildStartRecordingPayload({}, () => "Studio Display");
		expect(payload.start_recording.capture_mode).toEqual({
			screen: "Studio Display",
		});
		expect(() => buildStartRecordingPayload({}, () => null)).toThrow(
			/No target screen name/,
		);
	});

	it("encodes stop_recording and resolves dashboard and share URLs", () => {
		const stopUrl = new URL(buildStopRecordingDeepLink());
		expect(stopUrl.searchParams.get("value")).toBe('"stop_recording"');

		expect(resolveDashboardUrl()).toBe("https://cap.so/dashboard");
		expect(resolveDashboardUrl("https://cap.internal.local/dashboard/")).toBe(
			"https://cap.internal.local/dashboard",
		);

		expect(extractShareableCapUrl("https://cap.so/s/abc123xyz")).toBe(
			"https://cap.so/s/abc123xyz",
		);
		expect(extractShareableCapUrl("not a link")).toBeNull();
	});
});
