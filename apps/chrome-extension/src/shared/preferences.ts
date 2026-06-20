import {
	type CameraDevice,
	DEFAULT_CAMERA_DEVICE_ID,
	DEFAULT_MICROPHONE_DEVICE_ID,
	type DevicePreference,
	type ExtensionSettings,
	type MicrophoneDevice,
	type RecordingMode,
} from "./types";

type DeviceWithIdentity = CameraDevice | MicrophoneDevice;

const cleanText = (value: string | null | undefined) => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
};

const rememberDevice = (
	deviceId: string,
	devices: DeviceWithIdentity[],
): DevicePreference => {
	const device = devices.find((item) => item.deviceId === deviceId);
	return {
		deviceId,
		label: cleanText(device?.label),
		groupId: cleanText(device?.groupId),
		updatedAt: Date.now(),
	};
};

const findRememberedDevice = (
	preference: DevicePreference | null,
	devices: DeviceWithIdentity[],
) => {
	if (!preference) return null;

	const exactMatch = devices.find(
		(device) => device.deviceId === preference.deviceId,
	);
	if (exactMatch) return exactMatch;

	const groupMatch = preference.groupId
		? devices.find((device) => cleanText(device.groupId) === preference.groupId)
		: null;
	if (groupMatch) return groupMatch;

	return preference.label
		? (devices.find((device) => cleanText(device.label) === preference.label) ??
				null)
		: null;
};

const resolveDeviceId = ({
	currentDeviceId,
	preference,
	devices,
	defaultDeviceId,
}: {
	currentDeviceId: string | null;
	preference: DevicePreference | null;
	devices: DeviceWithIdentity[];
	defaultDeviceId: string;
}) => {
	if (!currentDeviceId || currentDeviceId === defaultDeviceId) {
		return currentDeviceId;
	}

	if (devices.some((device) => device.deviceId === currentDeviceId)) {
		return currentDeviceId;
	}

	return (
		findRememberedDevice(preference, devices)?.deviceId ??
		devices[0]?.deviceId ??
		currentDeviceId
	);
};

export const rememberRecordingMode = (
	settings: ExtensionSettings,
	recordingMode: RecordingMode,
): ExtensionSettings => ({
	...settings,
	capture: {
		...settings.capture,
		recordingMode,
	},
});

export const rememberCameraSelection = (
	settings: ExtensionSettings,
	cameraId: string | null,
	devices: CameraDevice[],
): ExtensionSettings => ({
	...settings,
	capture: {
		...settings.capture,
		camera: cameraId ? rememberDevice(cameraId, devices) : null,
	},
	webcam: {
		...settings.webcam,
		enabled: Boolean(cameraId),
		deviceId: cameraId,
	},
});

export const rememberMicrophoneSelection = (
	settings: ExtensionSettings,
	microphoneId: string | null,
	devices: MicrophoneDevice[],
): ExtensionSettings => ({
	...settings,
	capture: {
		...settings.capture,
		microphone: microphoneId
			? rememberDevice(microphoneId, devices)
			: settings.capture.microphone,
	},
	microphone: {
		enabled: microphoneId !== null,
		deviceId:
			microphoneId === null || microphoneId === DEFAULT_MICROPHONE_DEVICE_ID
				? null
				: microphoneId,
	},
});

export const reconcileRememberedDevices = (
	settings: ExtensionSettings,
	cameras: CameraDevice[],
	microphones: MicrophoneDevice[],
) => {
	const restoredCameraId =
		settings.webcam.enabled && !settings.webcam.deviceId
			? (findRememberedDevice(settings.capture.camera, cameras)?.deviceId ??
				null)
			: null;
	const cameraId =
		restoredCameraId ??
		resolveDeviceId({
			currentDeviceId: settings.webcam.deviceId,
			preference: settings.capture.camera,
			devices: cameras,
			defaultDeviceId: DEFAULT_CAMERA_DEVICE_ID,
		});
	const activeMicrophoneId =
		settings.microphone.enabled &&
		settings.microphone.deviceId !== null &&
		settings.microphone.deviceId !== DEFAULT_MICROPHONE_DEVICE_ID
			? settings.microphone.deviceId
			: null;
	const microphoneId = resolveDeviceId({
		currentDeviceId: activeMicrophoneId,
		preference: settings.capture.microphone,
		devices: microphones,
		defaultDeviceId: DEFAULT_MICROPHONE_DEVICE_ID,
	});

	if (
		cameraId === settings.webcam.deviceId &&
		microphoneId === activeMicrophoneId
	) {
		return settings;
	}

	return {
		...settings,
		webcam: {
			...settings.webcam,
			deviceId: cameraId,
			enabled: restoredCameraId
				? true
				: settings.webcam.enabled && Boolean(cameraId),
		},
		microphone: {
			...settings.microphone,
			deviceId: microphoneId,
		},
	};
};
