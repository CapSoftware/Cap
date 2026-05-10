"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const useMicrophoneDevices = (open: boolean) => {
	const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
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
				audio: true,
				video: false,
			});
			stream.getTracks().forEach((track) => {
				track.stop();
			});
		} catch (err) {
			console.error("Failed to unlock microphone devices", err);
		} finally {
			unlockingRef.current = false;
		}
	}, []);

	const enumerateDevices = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

		try {
			const readAudioInputs = async () => {
				const devices = await navigator.mediaDevices.enumerateDevices();
				return devices.filter((device) => {
					if (device.kind !== "audioinput") {
						return false;
					}
					return device.deviceId.trim().length > 0;
				});
			};
			let audioInputs = await readAudioInputs();
			if (audioInputs.length === 0) {
				await unlockDevices();
				audioInputs = await readAudioInputs();
			}
			const namedAudioInputs = audioInputs.filter((device) => {
				if (device.kind !== "audioinput") {
					return false;
				}
				return device.deviceId.trim().length > 0;
			});
			if (isMountedRef.current) {
				setAvailableMics(namedAudioInputs);
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
		devices: availableMics,
		refresh: enumerateDevices,
	};
};
