"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const REMEMBER_DEVICES_KEY = "cap-web-recorder-remember-devices";
export const PREFERRED_CAMERA_KEY = "cap-web-recorder-preferred-camera";
export const PREFERRED_MICROPHONE_KEY = "cap-web-recorder-preferred-microphone";
const MICROPHONE_OFF_KEY = "cap-web-recorder-microphone-off";
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
	const micExplicitlyOffRef = useRef(false);

	useEffect(() => {
		if (typeof window === "undefined") return;

		try {
			const storedRemember = window.localStorage.getItem(REMEMBER_DEVICES_KEY);
			if (storedRemember === "true") {
				setRememberDevices(true);
				micExplicitlyOffRef.current =
					window.localStorage.getItem(MICROPHONE_OFF_KEY) === "true";
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

	// Device IDs only enumerate once mic access is granted, so a first-run user
	// starts with no selection. Pick one as soon as mics appear unless the user
	// chose "No Microphone" this session; a remembered device still wins.
	useEffect(() => {
		if (!open || selectedMicId !== null || micExplicitlyOffRef.current) return;
		if (availableMics.length === 0) return;

		let storedMicId: string | null = null;
		if (rememberDevices && typeof window !== "undefined") {
			try {
				storedMicId = window.localStorage.getItem(PREFERRED_MICROPHONE_KEY);
			} catch {
				storedMicId = null;
			}
		}

		const nextMic =
			availableMics.find((mic) => mic.deviceId === storedMicId) ??
			availableMics.find((mic) => mic.deviceId === "default") ??
			availableMics[0];
		if (nextMic) {
			setSelectedMicId(nextMic.deviceId);
		}
	}, [open, rememberDevices, availableMics, selectedMicId]);

	const isMicExplicitlyOff = useCallback(() => micExplicitlyOffRef.current, []);

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
		micExplicitlyOffRef.current = micId === null;
		setSelectedMicId(micId);

		if (!rememberDevices || typeof window === "undefined") {
			return;
		}

		try {
			if (micId) {
				window.localStorage.setItem(PREFERRED_MICROPHONE_KEY, micId);
				window.localStorage.removeItem(MICROPHONE_OFF_KEY);
			} else {
				window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
				window.localStorage.setItem(MICROPHONE_OFF_KEY, "true");
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

				if (micExplicitlyOffRef.current) {
					window.localStorage.setItem(MICROPHONE_OFF_KEY, "true");
				} else {
					window.localStorage.removeItem(MICROPHONE_OFF_KEY);
				}
			} else {
				window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
				window.localStorage.removeItem(PREFERRED_MICROPHONE_KEY);
				window.localStorage.removeItem(MICROPHONE_OFF_KEY);
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
		isMicExplicitlyOff,
		handleCameraChange,
		handleMicChange,
		handleSystemAudioChange,
		handleRememberDevicesChange,
	};
};
