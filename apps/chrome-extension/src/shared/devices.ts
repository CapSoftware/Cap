import type { CameraDevice, MicrophoneDevice } from "./types";

// enumerateDevices() returns placeholder entries with an empty deviceId for
// device kinds the current document is not allowed to read (no permission, or a
// cross-origin iframe that Chrome withholds labels from). Dropping those leaves
// only the real, addressable devices.
export const toCameraDevices = (devices: MediaDeviceInfo[]): CameraDevice[] =>
	devices
		.filter(
			(device) =>
				device.kind === "videoinput" && device.deviceId.trim().length > 0,
		)
		.map((device, index) => ({
			deviceId: device.deviceId,
			groupId: device.groupId,
			label: device.label?.trim() || `Camera ${index + 1}`,
		}));

export const toMicrophoneDevices = (
	devices: MediaDeviceInfo[],
): MicrophoneDevice[] =>
	devices
		.filter(
			(device) =>
				device.kind === "audioinput" && device.deviceId.trim().length > 0,
		)
		.map((device, index) => ({
			deviceId: device.deviceId,
			groupId: device.groupId,
			label: device.label?.trim() || `Microphone ${index + 1}`,
		}));
