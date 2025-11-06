"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const useMicrophoneDevices = (open: boolean) => {
	const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
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
			const audioInputs = devices.filter(
				(device) => device.kind === "audioinput",
			);
			if (isMountedRef.current) {
				setAvailableMics(audioInputs);
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
		devices: availableMics,
		refresh: enumerateDevices,
	};
};
