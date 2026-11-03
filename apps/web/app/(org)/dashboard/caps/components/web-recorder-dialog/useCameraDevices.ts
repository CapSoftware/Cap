"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const useCameraDevices = (open: boolean) => {
	const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>(
		[],
	);
	const isMountedRef = useRef(false);
	const requestRef = useRef(0);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			requestRef.current += 1;
		};
	}, []);

	const enumerateDevices = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

		const requestId = ++requestRef.current;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const videoInputs = devices.filter((device) => {
				if (device.kind !== "videoinput") {
					return false;
				}
				return device.deviceId.trim().length > 0;
			});
			if (isMountedRef.current && requestRef.current === requestId) {
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
			requestRef.current += 1;
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
