import { useCallback, useRef } from "react";

export const useStreamManagement = () => {
	const displayStreamRef = useRef<MediaStream | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const mixedStreamRef = useRef<MediaStream | null>(null);
	const audioContextRef = useRef<AudioContext | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const detectionTimeoutsRef = useRef<number[]>([]);
	const detectionCleanupRef = useRef<Array<() => void>>([]);

	const clearDetectionTracking = useCallback(() => {
		detectionTimeoutsRef.current.forEach((timeoutId) => {
			window.clearTimeout(timeoutId);
		});
		detectionTimeoutsRef.current = [];
		detectionCleanupRef.current.forEach((cleanup) => {
			try {
				cleanup();
			} catch {
				/* ignore */
			}
		});
		detectionCleanupRef.current = [];
	}, []);

	const cleanupStreams = useCallback(() => {
		clearDetectionTracking();
		const stopTracks = (stream: MediaStream | null) => {
			stream?.getTracks().forEach((track) => {
				track.stop();
			});
		};
		stopTracks(displayStreamRef.current);
		stopTracks(cameraStreamRef.current);
		stopTracks(micStreamRef.current);
		stopTracks(mixedStreamRef.current);
		displayStreamRef.current = null;
		cameraStreamRef.current = null;
		micStreamRef.current = null;
		mixedStreamRef.current = null;

		if (audioContextRef.current) {
			audioContextRef.current.close().catch(() => {});
			audioContextRef.current = null;
		}

		if (videoRef.current) {
			videoRef.current.srcObject = null;
		}
	}, [clearDetectionTracking]);

	return {
		displayStreamRef,
		cameraStreamRef,
		micStreamRef,
		mixedStreamRef,
		audioContextRef,
		videoRef,
		detectionTimeoutsRef,
		detectionCleanupRef,
		clearDetectionTracking,
		cleanupStreams,
	};
};
