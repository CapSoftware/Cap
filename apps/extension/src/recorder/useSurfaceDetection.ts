import { useCallback, useRef } from "react";
import type { RecordingMode } from "./RecordingModeSelector";
import type { DetectedDisplayRecordingMode } from "./web-recorder-constants";
import { DETECTION_RETRY_DELAYS } from "./web-recorder-constants";
import { detectRecordingModeFromTrack } from "./web-recorder-utils";

export const useSurfaceDetection = (
	onRecordingSurfaceDetected?: (mode: DetectedDisplayRecordingMode) => void,
	detectionTimeoutsRef?: React.MutableRefObject<number[]>,
	detectionCleanupRef?: React.MutableRefObject<Array<() => void>>,
) => {
	const recordingModeRef = useRef<RecordingMode>("camera");

	const clearDetectionTracking = useCallback(() => {
		if (detectionTimeoutsRef) {
			detectionTimeoutsRef.current.forEach((timeoutId) => {
				window.clearTimeout(timeoutId);
			});
			detectionTimeoutsRef.current = [];
		}
		if (detectionCleanupRef) {
			detectionCleanupRef.current.forEach((cleanup) => {
				try {
					cleanup();
				} catch (error) {
					console.error("Surface detection cleanup failed", error);
				}
			});
			detectionCleanupRef.current = [];
		}
	}, [detectionTimeoutsRef, detectionCleanupRef]);

	const notifyDetectedMode = useCallback(
		(detected: DetectedDisplayRecordingMode | null) => {
			if (!detected) return;
			if (detected === recordingModeRef.current) return;
			recordingModeRef.current = detected;
			onRecordingSurfaceDetected?.(detected);
		},
		[onRecordingSurfaceDetected],
	);

	const scheduleSurfaceDetection = useCallback(
		(track: MediaStreamTrack | null, initialSettings?: MediaTrackSettings) => {
			if (!track || !onRecordingSurfaceDetected) {
				return;
			}

			clearDetectionTracking();

			const attemptDetection = (settingsOverride?: MediaTrackSettings) => {
				notifyDetectedMode(
					detectRecordingModeFromTrack(track, settingsOverride),
				);
			};

			attemptDetection(initialSettings);

			if (detectionTimeoutsRef) {
				DETECTION_RETRY_DELAYS.forEach((delay) => {
					const timeoutId = window.setTimeout(() => {
						attemptDetection();
					}, delay);
					detectionTimeoutsRef.current.push(timeoutId);
				});
			}

			const handleTrackReady = () => {
				attemptDetection();
			};

			if (detectionCleanupRef) {
				track.addEventListener("unmute", handleTrackReady, { once: true });
				track.addEventListener("mute", handleTrackReady, { once: true });
				detectionCleanupRef.current.push(() => {
					track.removeEventListener("unmute", handleTrackReady);
					track.removeEventListener("mute", handleTrackReady);
				});
			}
		},
		[
			clearDetectionTracking,
			notifyDetectedMode,
			onRecordingSurfaceDetected,
			detectionTimeoutsRef,
			detectionCleanupRef,
		],
	);

	return {
		recordingModeRef,
		scheduleSurfaceDetection,
		clearDetectionTracking,
	};
};
