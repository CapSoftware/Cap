"use client";

import { Organisation } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { Option } from "effect";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { EffectRuntime, useRpcClient } from "@/lib/EffectRuntime";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { useUploadingContext } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { RecordingMode } from "./RecordingModeSelector";
import type {
	PresignedPost,
	RecorderErrorEvent,
	RecorderPhase,
	VideoId,
} from "./web-recorder-types";

interface UseWebRecorderOptions {
	organisationId: string | undefined;
	selectedMicId: string | null;
	micEnabled: boolean;
	recordingMode: RecordingMode;
	selectedCameraId: string | null;
	onPhaseChange?: (phase: RecorderPhase) => void;
	onRecordingSurfaceDetected?: (mode: RecordingMode) => void;
}

const DISPLAY_MEDIA_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
	frameRate: { ideal: 30 },
	width: { ideal: 1920 },
	height: { ideal: 1080 },
};

type ExtendedDisplayMediaStreamOptions = DisplayMediaStreamOptions & {
	monitorTypeSurfaces?: "include" | "exclude";
	surfaceSwitching?: "include" | "exclude";
	selfBrowserSurface?: "include" | "exclude";
	preferCurrentTab?: boolean;
};

const DISPLAY_MODE_PREFERENCES: Record<
	Exclude<RecordingMode, "camera">,
	Partial<ExtendedDisplayMediaStreamOptions>
> = {
	fullscreen: {
		monitorTypeSurfaces: "include",
		selfBrowserSurface: "exclude",
		surfaceSwitching: "exclude",
		preferCurrentTab: false,
	},
	window: {
		monitorTypeSurfaces: "exclude",
		selfBrowserSurface: "exclude",
		surfaceSwitching: "exclude",
		preferCurrentTab: false,
	},
	tab: {
		monitorTypeSurfaces: "exclude",
		selfBrowserSurface: "include",
		surfaceSwitching: "exclude",
		preferCurrentTab: true,
	},
};

type DetectedDisplayRecordingMode = Exclude<RecordingMode, "camera">;

const DISPLAY_SURFACE_TO_RECORDING_MODE: Record<
	string,
	DetectedDisplayRecordingMode
> = {
	monitor: "fullscreen",
	screen: "fullscreen",
	window: "window",
	application: "window",
	browser: "tab",
	tab: "tab",
};

const RECORDING_MODE_TO_DISPLAY_SURFACE: Record<
	DetectedDisplayRecordingMode,
	DisplaySurfacePreference
> = {
	fullscreen: "monitor",
	window: "window",
	tab: "browser",
};

type DisplaySurfacePreference =
	| "monitor"
	| "window"
	| "browser"
	| "application";

const detectRecordingModeFromTrack = (
	track: MediaStreamTrack | null,
	settings?: MediaTrackSettings,
): DetectedDisplayRecordingMode | null => {
	if (!track) return null;

	const trackSettings = settings ?? track.getSettings();
	const maybeDisplaySurface = (
		trackSettings as Partial<{ displaySurface?: unknown }>
	).displaySurface;
	const rawSurface =
		typeof maybeDisplaySurface === "string" ? maybeDisplaySurface : "";
	const normalizedSurface = rawSurface.toLowerCase();

	if (normalizedSurface) {
		const mapped = DISPLAY_SURFACE_TO_RECORDING_MODE[normalizedSurface];
		if (mapped) {
			return mapped;
		}
	}

	const label = track.label?.toLowerCase() ?? "";

	if (
		label.includes("screen") ||
		label.includes("display") ||
		label.includes("monitor")
	) {
		return "fullscreen";
	}

	if (label.includes("window") || label.includes("application")) {
		return "window";
	}

	if (label.includes("tab") || label.includes("browser")) {
		return "tab";
	}

	return null;
};

const detectionRetryDelays = [120, 450, 1000];

const shouldRetryDisplayMediaWithoutPreferences = (error: unknown) => {
	if (error instanceof DOMException) {
		return (
			error.name === "OverconstrainedError" ||
			error.name === "NotSupportedError"
		);
	}

	return error instanceof TypeError;
};

export const useWebRecorder = ({
	organisationId,
	selectedMicId,
	micEnabled,
	recordingMode,
	selectedCameraId,
	onPhaseChange,
	onRecordingSurfaceDetected,
}: UseWebRecorderOptions) => {
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [durationMs, setDurationMs] = useState(0);
	const [videoId, setVideoId] = useState<VideoId | null>(null);
	const [hasAudioTrack, setHasAudioTrack] = useState(false);
	const [isSettingUp, setIsSettingUp] = useState(false);

	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);
	const displayStreamRef = useRef<MediaStream | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const mixedStreamRef = useRef<MediaStream | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const timerRef = useRef<number | null>(null);
	const startTimeRef = useRef<number | null>(null);
	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const stopPromiseResolverRef = useRef<((blob: Blob) => void) | null>(null);
	const stopPromiseRejectRef = useRef<((reason?: unknown) => void) | null>(
		null,
	);
	const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
	const recordingModeRef = useRef(recordingMode);
	const detectionTimeoutsRef = useRef<number[]>([]);
	const detectionCleanupRef = useRef<Array<() => void>>([]);

	const rpc = useRpcClient();
	const router = useRouter();
	const { setUploadStatus } = useUploadingContext();
	const queryClient = useQueryClient();

	const updatePhase = useCallback(
		(newPhase: RecorderPhase) => {
			setPhase(newPhase);
			onPhaseChange?.(newPhase);
		},
		[onPhaseChange],
	);

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

		if (videoRef.current) {
			videoRef.current.srcObject = null;
		}
	}, [clearDetectionTracking]);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearInterval(timerRef.current);
			timerRef.current = null;
		}
	}, []);

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

			detectionRetryDelays.forEach((delay) => {
				const timeoutId = window.setTimeout(() => {
					attemptDetection();
				}, delay);
				detectionTimeoutsRef.current.push(timeoutId);
			});

			const handleTrackReady = () => {
				attemptDetection();
			};

			track.addEventListener("unmute", handleTrackReady, { once: true });
			track.addEventListener("mute", handleTrackReady, { once: true });
			detectionCleanupRef.current.push(() => {
				track.removeEventListener("unmute", handleTrackReady);
				track.removeEventListener("mute", handleTrackReady);
			});
		},
		[clearDetectionTracking, notifyDetectedMode, onRecordingSurfaceDetected],
	);

	const resetState = useCallback(() => {
		cleanupStreams();
		clearTimer();
		mediaRecorderRef.current = null;
		recordedChunksRef.current = [];
		setDurationMs(0);
		updatePhase("idle");
		setVideoId(null);
		setHasAudioTrack(false);
		setUploadStatus(undefined);
	}, [cleanupStreams, clearTimer, setUploadStatus, updatePhase]);

	useEffect(() => {
		recordingModeRef.current = recordingMode;
	}, [recordingMode]);

	useEffect(() => {
		return () => {
			resetState();
		};
	}, [resetState]);

	const stopRecordingInternal = useCallback(async () => {
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === "inactive") return null;

		const stopPromise = new Promise<Blob>((resolve, reject) => {
			stopPromiseResolverRef.current = resolve;
			stopPromiseRejectRef.current = reject;
		});

		recorder.stop();
		cleanupStreams();
		clearTimer();

		return stopPromise;
	}, [cleanupStreams, clearTimer]);

	const onRecorderDataAvailable = useCallback((event: BlobEvent) => {
		if (event.data && event.data.size > 0) {
			recordedChunksRef.current.push(event.data);
		}
	}, []);

	const onRecorderStop = useCallback(() => {
		if (recordedChunksRef.current.length === 0) {
			stopPromiseRejectRef.current?.(new Error("No recorded data"));
			stopPromiseResolverRef.current = null;
			stopPromiseRejectRef.current = null;
			return;
		}

		const blob = new Blob(recordedChunksRef.current, {
			type: recordedChunksRef.current[0]?.type ?? "video/webm;codecs=vp8,opus",
		});
		recordedChunksRef.current = [];
		stopPromiseResolverRef.current?.(blob);
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
	}, []);

	const onRecorderError = useCallback((event: RecorderErrorEvent) => {
		const error = event.error ?? new DOMException("Recording error");
		stopPromiseRejectRef.current?.(error);
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
	}, []);

	const captureThumbnail = useCallback(
		(source: Blob) =>
			new Promise<Blob | null>((resolve) => {
				const video = document.createElement("video");
				const objectUrl = URL.createObjectURL(source);
				video.src = objectUrl;
				video.muted = true;
				video.playsInline = true;

				let timeoutId: number;

				const cleanup = () => {
					video.pause();
					video.removeAttribute("src");
					video.load();
					URL.revokeObjectURL(objectUrl);
				};

				const finalize = (result: Blob | null) => {
					window.clearTimeout(timeoutId);
					cleanup();
					resolve(result);
				};

				timeoutId = window.setTimeout(() => finalize(null), 10000);

				video.addEventListener(
					"error",
					() => {
						finalize(null);
					},
					{ once: true },
				);

				video.addEventListener(
					"loadedmetadata",
					() => {
						try {
							const duration = Number.isFinite(video.duration)
								? video.duration
								: 0;
							const targetTime = duration > 0 ? Math.min(1, duration / 4) : 0;
							video.currentTime = targetTime;
						} catch {
							finalize(null);
						}
					},
					{ once: true },
				);

				video.addEventListener(
					"seeked",
					() => {
						try {
							const canvas = document.createElement("canvas");
							const width =
								video.videoWidth || dimensionsRef.current.width || 640;
							const height =
								video.videoHeight || dimensionsRef.current.height || 360;
							canvas.width = width;
							canvas.height = height;
							const ctx = canvas.getContext("2d");
							if (!ctx) {
								finalize(null);
								return;
							}
							ctx.drawImage(video, 0, 0, width, height);
							canvas.toBlob(
								(blob) => {
									finalize(blob ?? null);
								},
								"image/jpeg",
								0.8,
							);
						} catch {
							finalize(null);
						}
					},
					{ once: true },
				);
			}),
		[],
	);

	const convertToMp4 = useCallback(
		async (blob: Blob, hasAudio: boolean, currentVideoId: string) => {
			updatePhase("converting");
			setUploadStatus({
				status: "converting",
				capId: currentVideoId,
				progress: 0,
			});

			const file = new File([blob], "recording.webm", { type: blob.type });
			const { convertMedia } = await import("@remotion/webcodecs");

			const result = await convertMedia({
				src: file,
				container: "mp4",
				videoCodec: "h264",
				...(hasAudio ? { audioCodec: "aac" as const } : {}),
				onProgress: ({ overallProgress }) => {
					if (overallProgress !== null) {
						const percent = Math.min(100, Math.max(0, overallProgress * 100));
						setUploadStatus({
							status: "converting",
							capId: currentVideoId,
							progress: percent,
						});
					}
				},
			});

			const savedFile = await result.save();
			if (savedFile.size === 0) {
				throw new Error("Conversion produced empty file");
			}
			if (savedFile.type !== "video/mp4") {
				return new File([savedFile], "result.mp4", { type: "video/mp4" });
			}
			return savedFile;
		},
		[updatePhase, setUploadStatus],
	);

	const uploadRecording = useCallback(
		async (
			blob: Blob,
			upload: PresignedPost,
			currentVideoId: VideoId,
			thumbnailPreviewUrl: string | undefined,
		) =>
			new Promise<void>((resolve, reject) => {
				if (blob.size === 0) {
					reject(new Error("Cannot upload empty file"));
					return;
				}

				const fileBlob =
					blob instanceof File && blob.type === "video/mp4"
						? blob
						: new File([blob], "result.mp4", { type: "video/mp4" });

				console.log("Uploading file:", {
					size: fileBlob.size,
					type: fileBlob.type,
					name: fileBlob.name,
					uploadUrl: upload.url,
					uploadFields: upload.fields,
				});

				const formData = new FormData();
				Object.entries(upload.fields).forEach(([key, value]) => {
					formData.append(key, value);
				});
				formData.append("file", fileBlob, "result.mp4");

				const xhr = new XMLHttpRequest();
				xhr.open("POST", upload.url);

				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						const percent = (event.loaded / event.total) * 100;
						setUploadStatus({
							status: "uploadingVideo",
							capId: currentVideoId,
							progress: percent,
							thumbnailUrl: thumbnailPreviewUrl,
						});
						sendProgressUpdate(currentVideoId, event.loaded, event.total);
					}
				};

				xhr.onload = async () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						await sendProgressUpdate(currentVideoId, blob.size, blob.size);
						resolve();
					} else {
						const errorText =
							xhr.responseText || xhr.statusText || "Unknown error";
						console.error("Upload failed:", {
							status: xhr.status,
							statusText: xhr.statusText,
							responseText: errorText,
						});
						reject(
							new Error(
								`Upload failed with status ${xhr.status}: ${errorText}`,
							),
						);
					}
				};

				xhr.onerror = () => {
					reject(new Error("Upload failed due to network error"));
				};

				xhr.send(formData);
			}),
		[setUploadStatus],
	);

	const startRecording = async () => {
		if (!organisationId) {
			toast.error("Select an organization before recording.");
			return;
		}

		if (recordingMode === "camera" && !selectedCameraId) {
			toast.error("Select a camera before recording.");
			return;
		}

		setIsSettingUp(true);

		try {
			let videoStream: MediaStream | null = null;
			let firstTrack: MediaStreamTrack | null = null;

			if (recordingMode === "camera") {
				if (!selectedCameraId) {
					throw new Error("Camera ID is required for camera-only mode");
				}
				videoStream = await navigator.mediaDevices.getUserMedia({
					video: {
						deviceId: { exact: selectedCameraId },
						frameRate: { ideal: 30 },
						width: { ideal: 1920 },
						height: { ideal: 1080 },
					},
				});
				cameraStreamRef.current = videoStream;
				firstTrack = videoStream.getVideoTracks()[0] ?? null;
			} else {
				const desiredSurface =
					RECORDING_MODE_TO_DISPLAY_SURFACE[
						recordingMode as DetectedDisplayRecordingMode
					];
				const videoConstraints: MediaTrackConstraints & {
					displaySurface?: DisplaySurfacePreference;
				} = {
					...DISPLAY_MEDIA_VIDEO_CONSTRAINTS,
					displaySurface: desiredSurface,
				};

				const baseDisplayRequest: ExtendedDisplayMediaStreamOptions = {
					video: videoConstraints,
					audio: false,
					preferCurrentTab: recordingMode === "tab",
				};

				const preferredOptions = DISPLAY_MODE_PREFERENCES[recordingMode];

				if (preferredOptions) {
					const preferredDisplayRequest: DisplayMediaStreamOptions = {
						...baseDisplayRequest,
						...preferredOptions,
						video: videoConstraints,
					};

					try {
						videoStream = await navigator.mediaDevices.getDisplayMedia(
							preferredDisplayRequest,
						);
					} catch (displayError) {
						if (shouldRetryDisplayMediaWithoutPreferences(displayError)) {
							console.warn(
								"Display media preferences not supported, retrying without them",
								displayError,
							);
							videoStream =
								await navigator.mediaDevices.getDisplayMedia(
									baseDisplayRequest,
								);
						} else {
							throw displayError;
						}
					}
				}

				if (!videoStream) {
					videoStream =
						await navigator.mediaDevices.getDisplayMedia(baseDisplayRequest);
				}
				displayStreamRef.current = videoStream;
				firstTrack = videoStream.getVideoTracks()[0] ?? null;
			}

			const settings = firstTrack?.getSettings();

			if (recordingMode !== "camera") {
				scheduleSurfaceDetection(firstTrack, settings);
			}

			dimensionsRef.current = {
				width: settings?.width || undefined,
				height: settings?.height || undefined,
			};

			let micStream: MediaStream | null = null;
			if (micEnabled && selectedMicId) {
				try {
					micStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							deviceId: { exact: selectedMicId },
							echoCancellation: true,
							autoGainControl: true,
							noiseSuppression: true,
						},
					});
				} catch (micError) {
					console.warn("Microphone permission denied", micError);
					toast.warning("Microphone unavailable. Recording without audio.");
					micStream = null;
				}
			}

			if (micStream) {
				micStreamRef.current = micStream;
			}

			const mixedStream = new MediaStream([
				...videoStream.getVideoTracks(),
				...(micStream ? micStream.getAudioTracks() : []),
			]);

			mixedStreamRef.current = mixedStream;
			setHasAudioTrack(mixedStream.getAudioTracks().length > 0);

			recordedChunksRef.current = [];

			const mimeTypeCandidates = [
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/webm",
			];
			const mimeType = mimeTypeCandidates.find((candidate) =>
				MediaRecorder.isTypeSupported(candidate),
			);

			const recorder = new MediaRecorder(
				mixedStream,
				mimeType ? { mimeType } : undefined,
			);
			recorder.ondataavailable = onRecorderDataAvailable;
			recorder.onstop = onRecorderStop;
			recorder.onerror = onRecorderError;

			const handleVideoEnded = () => {
				stopRecordingRef.current?.().catch(() => {
					/* ignore */
				});
			};

			firstTrack?.addEventListener("ended", handleVideoEnded, { once: true });

			mediaRecorderRef.current = recorder;
			recorder.start(200);

			startTimeRef.current = performance.now();
			setDurationMs(0);
			updatePhase("recording");

			timerRef.current = window.setInterval(() => {
				if (startTimeRef.current !== null)
					setDurationMs(performance.now() - startTimeRef.current);
			}, 250);
		} catch (err) {
			console.error("Failed to start recording", err);
			toast.error("Could not start recording.");
			resetState();
		} finally {
			setIsSettingUp(false);
		}
	};

	const stopRecording = useCallback(async () => {
		if (phase !== "recording") return;

		let createdVideoId: VideoId | null = null;
		const orgId = organisationId;
		if (!orgId) {
			updatePhase("error");
			return;
		}

		const brandedOrgId = Organisation.OrganisationId.make(orgId);

		let thumbnailBlob: Blob | null = null;
		let thumbnailPreviewUrl: string | undefined;

		try {
			updatePhase("creating");

			const blob = await stopRecordingInternal();
			if (!blob) {
				throw new Error("No recording available");
			}

			const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
			const width = dimensionsRef.current.width;
			const height = dimensionsRef.current.height;
			const resolution = width && height ? `${width}x${height}` : undefined;

			setUploadStatus({ status: "creating" });

			const result = await EffectRuntime.runPromise(
				rpc.VideoInstantCreate({
					orgId: brandedOrgId,
					folderId: Option.none(),
					resolution,
					durationSeconds,
					width,
					height,
					videoCodec: "h264",
					audioCodec: hasAudioTrack ? "aac" : undefined,
					supportsUploadProgress: true,
				}),
			);

			createdVideoId = result.id;
			setVideoId(result.id);

			const mp4Blob = await convertToMp4(blob, hasAudioTrack, result.id);

			thumbnailBlob = await captureThumbnail(mp4Blob);
			thumbnailPreviewUrl = thumbnailBlob
				? URL.createObjectURL(thumbnailBlob)
				: undefined;

			updatePhase("uploading");
			setUploadStatus({
				status: "uploadingVideo",
				capId: result.id,
				progress: 0,
				thumbnailUrl: thumbnailPreviewUrl,
			});

			await uploadRecording(
				mp4Blob,
				result.upload,
				result.id,
				thumbnailPreviewUrl,
			);

			if (thumbnailBlob) {
				try {
					const screenshotData = await createVideoAndGetUploadUrl({
						videoId: result.id,
						isScreenshot: true,
						orgId: brandedOrgId,
					});

					const screenshotFormData = new FormData();
					Object.entries(screenshotData.presignedPostData.fields).forEach(
						([key, value]) => {
							screenshotFormData.append(key, value as string);
						},
					);
					screenshotFormData.append(
						"file",
						thumbnailBlob,
						"screen-capture.jpg",
					);

					setUploadStatus({
						status: "uploadingThumbnail",
						capId: result.id,
						progress: 90,
					});

					await new Promise<void>((resolve, reject) => {
						const xhr = new XMLHttpRequest();
						xhr.open("POST", screenshotData.presignedPostData.url);

						xhr.upload.onprogress = (event) => {
							if (event.lengthComputable) {
								const percent = 90 + (event.loaded / event.total) * 10;
								setUploadStatus({
									status: "uploadingThumbnail",
									capId: result.id,
									progress: percent,
								});
							}
						};

						xhr.onload = () => {
							if (xhr.status >= 200 && xhr.status < 300) {
								resolve();
							} else {
								reject(
									new Error(
										`Screenshot upload failed with status ${xhr.status}`,
									),
								);
							}
						};

						xhr.onerror = () => {
							reject(new Error("Screenshot upload failed"));
						};

						xhr.send(screenshotFormData);
					});

					queryClient.refetchQueries({
						queryKey: ThumbnailRequest.queryKey(result.id),
					});
				} catch (thumbnailError) {
					console.error("Failed to upload thumbnail", thumbnailError);
					toast.warning("Recording uploaded, but thumbnail failed to upload.");
				}
			}

			setUploadStatus(undefined);
			updatePhase("completed");
			toast.success("Recording uploaded");
			router.refresh();
		} catch (err) {
			console.error("Failed to process recording", err);
			setUploadStatus(undefined);
			updatePhase("error");

			const idToDelete = createdVideoId ?? videoId;
			if (idToDelete) {
				EffectRuntime.runPromise(rpc.VideoDelete(idToDelete)).catch(() => {
					/* ignore */
				});
			}
		} finally {
			if (thumbnailPreviewUrl) {
				URL.revokeObjectURL(thumbnailPreviewUrl);
			}
		}
	}, [
		phase,
		organisationId,
		durationMs,
		hasAudioTrack,
		videoId,
		updatePhase,
		setUploadStatus,
		rpc,
		router,
		convertToMp4,
		uploadRecording,
		stopRecordingInternal,
		captureThumbnail,
		queryClient,
	]);

	useEffect(() => {
		stopRecordingRef.current = stopRecording;
	}, [stopRecording]);

	return {
		phase,
		durationMs,
		videoId,
		hasAudioTrack,
		isSettingUp,
		isRecording: phase === "recording",
		isBusy:
			phase === "recording" ||
			phase === "creating" ||
			phase === "converting" ||
			phase === "uploading",
		canStartRecording: Boolean(organisationId) && !isSettingUp,
		startRecording,
		stopRecording,
		resetState,
	};
};
