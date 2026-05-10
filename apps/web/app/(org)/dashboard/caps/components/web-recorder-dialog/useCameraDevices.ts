"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const useCameraDevices = (open: boolean) => {
	const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>(
		[],
	);
	const isMountedRef = useRef(false);
	const unlockingRef = useRef(false);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const unlockDevices = useCallback(async () => {
		if (
			unlockingRef.current ||
			typeof navigator === "undefined" ||
			!navigator.mediaDevices?.getUserMedia
		) {
			return;
		}

		unlockingRef.current = true;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: true,
				audio: false,
			});
			stream.getTracks().forEach((track) => {
				track.stop();
			});
		} catch (err) {
			console.error("Failed to unlock camera devices", err);
		} finally {
			unlockingRef.current = false;
		}
	}, []);

	const enumerateDevices = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

		try {
			const readVideoInputs = async () => {
				const devices = await navigator.mediaDevices.enumerateDevices();
				return devices.filter((device) => {
					if (device.kind !== "videoinput") {
						return false;
					}
					return device.deviceId.trim().length > 0;
				});
			};
			let videoInputs = await readVideoInputs();
			if (videoInputs.length === 0) {
				await unlockDevices();
				videoInputs = await readVideoInputs();
			}
			const namedVideoInputs = videoInputs.filter((device) => {
				if (device.kind !== "videoinput") {
					return false;
				}
				return device.deviceId.trim().length > 0;
			});
			if (isMountedRef.current) {
				setAvailableCameras(namedVideoInputs);
			}
		} catch (err) {
			console.error("Failed to enumerate devices", err);
		}
	}, [unlockDevices]);

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
