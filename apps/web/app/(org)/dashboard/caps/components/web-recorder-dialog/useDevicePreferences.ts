"use client";

import { useEffect, useState } from "react";

const REMEMBER_DEVICES_KEY = "cap-web-recorder-remember-devices";
const PREFERRED_CAMERA_KEY = "cap-web-recorder-preferred-camera";
const PREFERRED_MICROPHONE_KEY = "cap-web-recorder-preferred-microphone";
const SYSTEM_AUDIO_ENABLED_KEY = "cap-web-recorder-system-audio";

interface DevicePreferencesOptions {
	open: boolean;
	availableCameras: Array<{ deviceId: string }>;
	availableMics: Array<{ deviceId: string }>;
}

export const useDevicePreferences = ({
	open,
	availableCameras,
	availableMics,
}: DevicePreferencesOptions) => {
	const [rememberDevices, setRememberDevices] = useState(false);
	const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
	const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined") return;

		try {
			const storedRemember = window.localStorage.getItem(REMEMBER_DEVICES_KEY);
			if (storedRemember === "true") {
				setRememberDevices(true);
			}
			const storedSystemAudio = window.localStorage.getItem(
				SYSTEM_AUDIO_ENABLED_KEY,
			);
			if (storedSystemAudio === "true") {
				setSystemAudioEnabled(true);
			}
		} catch (error) {
			console.error("Failed to load recorder preferences", error);
		}
	}, []);

	useEffect(() => {
		if (!open || !rememberDevices) return;
		if (typeof window === "undefined") return;

		try {
			const storedCameraId = window.localStorage.getItem(PREFERRED_CAMERA_KEY);
			if (storedCameraId) {
				const hasCamera = availableCameras.some(
					(camera) => camera.deviceId === storedCameraId,
				);
				if (hasCamera && storedCameraId !== selectedCameraId) {
					setSelectedCameraId(storedCameraId);
				}
			}

			const storedMicId = window.localStorage.getItem(PREFERRED_MICROPHONE_KEY);
			if (storedMicId) {
				const hasMic = availableMics.some(
					(microphone) => microphone.deviceId === storedMicId,
				);
				if (hasMic && storedMicId !== selectedMicId) {
					setSelectedMicId(storedMicId);
				}
			}
		} catch (error) {
			console.error("Failed to restore recorder device selection", error);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- effect restores saved device IDs and intentionally updates them
	}, [
		open,
		rememberDevices,
		availableCameras,
		availableMics,
		selectedCameraId,
		selectedMicId,
	]);

	const handleCameraChange = (cameraId: string | null) => {
		setSelectedCameraId(cameraId);

		if (!rememberDevices || typeof window === "undefined") {
			return;
		}

		try {
			if (cameraId) {
				window.localStorage.setItem(PREFERRED_CAMERA_KEY, cameraId);
			} else {
				window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
			}
		} catch (error) {
			console.error("Failed to persist preferred camera", error);
		}
	};

	const handleMicChange = (micId: string | null) => {
		setSelectedMicId(micId);

		if (!rememberDevices || typeof window === "undefined") {
			return;
		}

		try {
			if (micId) {
				window.localStorage.setItem(PREFERRED_MICROPHONE_KEY, micId);
			} else {
				window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
			}
		} catch (error) {
			console.error("Failed to persist preferred microphone", error);
		}
	};

	const handleSystemAudioChange = (enabled: boolean) => {
		setSystemAudioEnabled(enabled);

		if (typeof window === "undefined") {
			return;
		}

		try {
			window.localStorage.setItem(
				SYSTEM_AUDIO_ENABLED_KEY,
				enabled ? "true" : "false",
			);
		} catch (error) {
			console.error("Failed to persist system audio preference", error);
		}
	};

	const handleRememberDevicesChange = (next: boolean) => {
		setRememberDevices(next);

		if (typeof window === "undefined") {
			return;
		}

		try {
			window.localStorage.setItem(
				REMEMBER_DEVICES_KEY,
				next ? "true" : "false",
			);

			if (next) {
				if (selectedCameraId) {
					window.localStorage.setItem(PREFERRED_CAMERA_KEY, selectedCameraId);
				} else {
					window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
				}

				if (selectedMicId) {
					window.localStorage.setItem(PREFERRED_MICROPHONE_KEY, selectedMicId);
				} else {
					window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
				}
			} else {
				window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
				window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
			}
		} catch (error) {
			console.error("Failed to update recorder preferences", error);
		}
	};

	return {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		systemAudioEnabled,
		setSelectedCameraId,
		setSelectedMicId,
		handleCameraChange,
		handleMicChange,
		handleSystemAudioChange,
		handleRememberDevicesChange,
	};
};
