"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const useCameraDevices = (open: boolean) => {
	const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>(
		[],
	);
	const isMountedRef = useRef(false);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const enumerateDevices = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const videoInputs = devices.filter((device) => {
				if (device.kind !== "videoinput") {
					return false;
				}
				return device.deviceId.trim().length > 0;
			});
			if (isMountedRef.current) {
				setAvailableCameras(videoInputs);
			}
		} catch (err) {
			console.error("Failed to enumerate devices", err);
		}
	}, []);

	useEffect(() => {
		if (!open) return;

		enumerateDevices();

		const handleDeviceChange = () => {
			enumerateDevices();
		};

		navigator.mediaDevices?.addEventListener(
			"devicechange",
			handleDeviceChange,
		);

		return () => {
			navigator.mediaDevices?.removeEventListener(
				"devicechange",
				handleDeviceChange,
			);
		};
	}, [open, enumerateDevices]);

	return {
		devices: availableCameras,
		refresh: enumerateDevices,
	};
};
