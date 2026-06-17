import { describe, expect, it } from "vitest";
import {
	reconcileRememberedDevices,
	rememberCameraSelection,
} from "./preferences";
import type { CameraDevice, ExtensionSettings } from "./types";

const camera: CameraDevice = {
	deviceId: "camera-1",
	groupId: "group-1",
	label: "Studio Camera",
};

const settings: ExtensionSettings = {
	apiBaseUrl: "https://cap.so",
	capture: {
		recordingMode: "fullscreen",
		camera: null,
		microphone: null,
	},
	webcam: {
		enabled: false,
		deviceId: null,
		position: "bottom-left",
		size: 230,
		shape: "round",
		mirror: false,
	},
	microphone: {
		enabled: false,
		deviceId: null,
	},
	systemAudio: {
		enabled: true,
	},
	sounds: {
		enabled: true,
	},
	countdown: {
		enabled: true,
		seconds: 3,
	},
	microphoneWarning: {
		enabled: true,
	},
};

describe("camera preferences", () => {
	it("clears the remembered camera when camera is explicitly disabled", () => {
		const selected = rememberCameraSelection(settings, camera.deviceId, [
			camera,
		]);

		expect(
			rememberCameraSelection(selected, null, [camera]).capture.camera,
		).toBeNull();
	});

	it("does not restore the remembered camera when webcam preview was disabled", () => {
		const selected = rememberCameraSelection(settings, camera.deviceId, [
			camera,
		]);
		const inactive = {
			...selected,
			webcam: {
				...selected.webcam,
				enabled: false,
				deviceId: null,
			},
		};

		const reconciled = reconcileRememberedDevices(inactive, [camera], []);

		expect(reconciled.webcam.enabled).toBe(false);
		expect(reconciled.webcam.deviceId).toBeNull();
	});

	it("restores the remembered camera when webcam preview is enabled without an active device", () => {
		const selected = rememberCameraSelection(settings, camera.deviceId, [
			camera,
		]);
		const missingDevice = {
			...selected,
			webcam: {
				...selected.webcam,
				enabled: true,
				deviceId: null,
			},
		};

		const reconciled = reconcileRememberedDevices(missingDevice, [camera], []);

		expect(reconciled.webcam.enabled).toBe(true);
		expect(reconciled.webcam.deviceId).toBe(camera.deviceId);
	});
});
