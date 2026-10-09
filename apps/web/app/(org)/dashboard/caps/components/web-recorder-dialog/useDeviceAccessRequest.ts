"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type AccessKinds = { video: boolean; audio: boolean };

/**
 * A grant that arrives after the recorder closed belongs to that earlier
 * visit and is ignored, so it can't start the camera behind a closed recorder.
 */
export const useDeviceAccessRequest = ({
	open,
	availableCameras,
	availableMics,
	refreshDevices,
	onCameraGranted,
	onMicGranted,
}: {
	open: boolean;
	availableCameras: MediaDeviceInfo[];
	availableMics: MediaDeviceInfo[];
	refreshDevices: () => Promise<unknown>;
	onCameraGranted: (deviceId: string) => void;
	onMicGranted: (deviceId: string) => void;
}) => {
	const [requesting, setRequesting] = useState(false);
	const visitRef = useRef(0);
	const wantedRef = useRef({ camera: false, mic: false });

	useEffect(() => {
		if (open) return;
		visitRef.current += 1;
		wantedRef.current = { camera: false, mic: false };
	}, [open]);

	useEffect(() => {
		const wanted = wantedRef.current;
		const camera = availableCameras[0];
		if (wanted.camera && camera) {
			wanted.camera = false;
			onCameraGranted(camera.deviceId);
		}
		const mic = availableMics[0];
		if (wanted.mic && mic) {
			wanted.mic = false;
			onMicGranted(mic.deviceId);
		}
	}, [availableCameras, availableMics, onCameraGranted, onMicGranted]);

	const requestAccess = useCallback(
		async (kinds: AccessKinds) => {
			const visit = visitRef.current;
			setRequesting(true);
			try {
				const stream = await navigator.mediaDevices.getUserMedia(kinds);
				for (const track of stream.getTracks()) track.stop();
				if (visit !== visitRef.current) return;
				wantedRef.current = { camera: kinds.video, mic: kinds.audio };
				await refreshDevices();
			} catch (error) {
				if (visit !== visitRef.current) return;
				toast.error(
					error instanceof DOMException && error.name === "NotFoundError"
						? kinds.video
							? "No camera was found. Check it's plugged in, then try again."
							: "No microphone was found. Check it's plugged in, then try again."
						: "Your browser blocked access. Allow the camera and microphone in the address bar, then try again.",
				);
			} finally {
				setRequesting(false);
			}
		},
		[refreshDevices],
	);

	return { requestAccess, requesting };
};
