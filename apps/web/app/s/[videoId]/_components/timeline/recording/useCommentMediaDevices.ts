"use client";

import { useCallback, useState } from "react";
import { useCameraDevices } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useCameraDevices";
import {
	PREFERRED_CAMERA_KEY,
	PREFERRED_MICROPHONE_KEY,
	REMEMBER_DEVICES_KEY,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useDevicePreferences";
import { useMicrophoneDevices } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMicrophoneDevices";

// The recorder surface unmounts after every reply, so hook state alone would
// forget the picked devices between two comments. These module vars carry the
// last explicit choice for the rest of the page visit; the dashboard
// recorder's remembered preferences (same localStorage keys) seed the first
// mount, and picks made here write back through the same "remember devices"
// gate — one preference system across both recorders.
let sessionCameraId: string | null = null;
let sessionMicId: string | null = null;

const rememberEnabled = () => {
	try {
		return window.localStorage.getItem(REMEMBER_DEVICES_KEY) === "true";
	} catch {
		return false;
	}
};

const readStoredPreference = (key: string) => {
	if (typeof window === "undefined") return null;
	try {
		if (!rememberEnabled()) return null;
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
};

const writeStoredPreference = (key: string, value: string | null) => {
	if (typeof window === "undefined") return;
	try {
		if (!rememberEnabled()) return;
		if (value) window.localStorage.setItem(key, value);
		else window.localStorage.removeItem(key);
	} catch {
		/* private mode */
	}
};

/**
 * Device enumeration + selection for the comment recorders. Selection is
 * available synchronously on first render (session pick, then remembered
 * dashboard preference) so the one-gesture flows can acquire the right device
 * immediately; `adopt*` reconciles the selection with whatever device an
 * acquisition actually landed on.
 */
export function useCommentMediaDevices() {
	const { devices: cameras, refresh: refreshCameras } = useCameraDevices(true);
	const { devices: mics, refresh: refreshMics } = useMicrophoneDevices(true);

	const [selectedCameraId, setSelectedCameraId] = useState<string | null>(
		() => sessionCameraId ?? readStoredPreference(PREFERRED_CAMERA_KEY),
	);
	const [selectedMicId, setSelectedMicId] = useState<string | null>(
		() => sessionMicId ?? readStoredPreference(PREFERRED_MICROPHONE_KEY),
	);

	const selectCamera = useCallback((deviceId: string | null) => {
		sessionCameraId = deviceId;
		setSelectedCameraId(deviceId);
		writeStoredPreference(PREFERRED_CAMERA_KEY, deviceId);
	}, []);

	const selectMic = useCallback((deviceId: string | null) => {
		sessionMicId = deviceId;
		setSelectedMicId(deviceId);
		writeStoredPreference(PREFERRED_MICROPHONE_KEY, deviceId);
	}, []);

	// Acquisition landed on a device (possibly a fallback after an exact
	// constraint failed) — reflect reality without treating it as an explicit
	// preference.
	const adoptCamera = useCallback((deviceId: string | null) => {
		if (!deviceId) return;
		sessionCameraId = deviceId;
		setSelectedCameraId(deviceId);
	}, []);

	const adoptMic = useCallback((deviceId: string | null) => {
		if (!deviceId) return;
		sessionMicId = deviceId;
		setSelectedMicId(deviceId);
	}, []);

	// Labels (and often the devices themselves) only enumerate after the first
	// grant, so acquisitions call this once a stream is live.
	const refreshDevices = useCallback(() => {
		void refreshCameras();
		void refreshMics();
	}, [refreshCameras, refreshMics]);

	return {
		cameras,
		mics,
		selectedCameraId,
		selectedMicId,
		selectCamera,
		selectMic,
		adoptCamera,
		adoptMic,
		refreshDevices,
	};
}
