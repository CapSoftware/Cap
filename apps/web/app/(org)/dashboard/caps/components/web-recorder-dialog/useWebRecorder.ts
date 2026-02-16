"use client";

import { Organisation } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { Cause, Exit, Option } from "effect";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	createVideoAndGetUploadUrl,
	deleteVideoResultFile,
} from "@/actions/video/upload";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { useUploadingContext } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import {
	InstantMp4Uploader,
	initiateMultipartUpload,
} from "./instant-mp4-uploader";
import type { RecordingMode } from "./RecordingModeSelector";
import { captureThumbnail, convertToMp4 } from "./recording-conversion";
import { uploadRecording } from "./recording-upload";
import { useMediaRecorderSetup } from "./useMediaRecorderSetup";
import { useRecordingTimer } from "./useRecordingTimer";
import { useStreamManagement } from "./useStreamManagement";
import { useSurfaceDetection } from "./useSurfaceDetection";
import {
	type DetectedDisplayRecordingMode,
	DISPLAY_MEDIA_VIDEO_CONSTRAINTS,
	DISPLAY_MODE_PREFERENCES,
	type DisplaySurfacePreference,
	type ExtendedDisplayMediaStreamOptions,
	FREE_PLAN_MAX_RECORDING_MS,
	MP4_MIME_TYPES,
	RECORDING_MODE_TO_DISPLAY_SURFACE,
	WEBM_MIME_TYPES,
} from "./web-recorder-constants";
import type {
	ChunkUploadState,
	PresignedPost,
	RecorderPhase,
	RecordingFailureDownload,
	VideoId,
} from "./web-recorder-types";
import {
	detectCapabilities,
	isUserCancellationError,
	pickSupportedMimeType,
	type RecorderCapabilities,
	shouldRetryDisplayMediaWithoutPreferences,
} from "./web-recorder-utils";

interface UseWebRecorderOptions {
	organisationId: string | undefined;
	selectedMicId: string | null;
	micEnabled: boolean;
	systemAudioEnabled: boolean;
	recordingMode: RecordingMode;
	selectedCameraId: string | null;
	isProUser: boolean;
	onPhaseChange?: (phase: RecorderPhase) => void;
	onRecordingSurfaceDetected?: (mode: RecordingMode) => void;
	onRecordingStart?: () => void;
	onRecordingStop?: () => void;
}

const INSTANT_UPLOAD_REQUEST_INTERVAL_MS = 1000;
const INSTANT_CHUNK_GUARD_DELAY_MS = INSTANT_UPLOAD_REQUEST_INTERVAL_MS * 3;

type InstantChunkingMode = "manual" | "timeslice";

const unwrapExitOrThrow = <T, E>(exit: Exit.Exit<T, E>) => {
	if (Exit.isFailure(exit)) {
		throw Cause.squash(exit.cause);
	}

	return exit.value;
};

const getFileExtensionFromMime = (mime?: string | null) => {
	if (!mime) return "mp4";
	const [, subtypeWithParams] = mime.split("/");
	if (!subtypeWithParams) return "mp4";
	const [subtypeWithSuffix] = subtypeWithParams.split(";");
	if (!subtypeWithSuffix) return "mp4";
	const [subtype = ""] = subtypeWithSuffix.split("+");
	const normalized = subtype.trim().toLowerCase();
	return normalized || "mp4";
};

export const useWebRecorder = ({
	organisationId,
	selectedMicId,
	micEnabled,
	systemAudioEnabled,
	recordingMode,
	selectedCameraId,
	isProUser,
	onPhaseChange,
	onRecordingSurfaceDetected,
	onRecordingStart,
	onRecordingStop,
}: UseWebRecorderOptions) => {
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [videoId, setVideoId] = useState<VideoId | null>(null);
	const [hasAudioTrack, setHasAudioTrack] = useState(false);
	const [isSettingUp, setIsSettingUp] = useState(false);
	const [isRestarting, setIsRestarting] = useState(false);
	const [chunkUploads, setChunkUploads] = useState<ChunkUploadState[]>([]);
	const [errorDownload, setErrorDownload] =
		useState<RecordingFailureDownload | null>(null);
	const [capabilities, setCapabilities] = useState<RecorderCapabilities>(() =>
		detectCapabilities(),
	);

	const {
		displayStreamRef,
		cameraStreamRef,
		micStreamRef,
		mixedStreamRef,
		audioContextRef,
		detectionTimeoutsRef,
		detectionCleanupRef,
		cleanupStreams,
	} = useStreamManagement();

	const {
		durationMs,
		clearTimer,
		startTimer,
		resetTimer,
		pauseTimer,
		resumeTimer,
		commitPausedDuration,
		syncDurationFromClock,
	} = useRecordingTimer();

	const {
		mediaRecorderRef,
		recordedChunksRef,
		totalRecordedBytesRef,
		onRecorderDataAvailable,
		onRecorderStop,
		onRecorderError,
		stopRecordingInternal,
		resetRecorder,
	} = useMediaRecorderSetup();

	const { scheduleSurfaceDetection } = useSurfaceDetection(
		onRecordingSurfaceDetected,
		detectionTimeoutsRef,
		detectionCleanupRef,
	);

	const supportCheckCompleted = capabilities.assessed;
	const rawCanRecordCamera =
		capabilities.hasMediaRecorder && capabilities.hasUserMedia;
	const rawCanRecordDisplay =
		rawCanRecordCamera && capabilities.hasDisplayMedia;
	const supportsCameraRecording = supportCheckCompleted
		? rawCanRecordCamera
		: true;
	const supportsDisplayRecording = supportCheckCompleted
		? rawCanRecordDisplay
		: true;
	const requiresDisplayMedia = recordingMode !== "camera";
	const isBrowserSupported = requiresDisplayMedia
		? supportsDisplayRecording
		: supportsCameraRecording;
	const screenCaptureWarning =
		supportCheckCompleted && rawCanRecordCamera && !capabilities.hasDisplayMedia
			? "Screen sharing isn't supported in this browser. We'll switch to camera-only recording. Try Chrome, Edge, or our desktop app for screen capture."
			: null;
	const unsupportedReason = supportCheckCompleted
		? !capabilities.hasMediaRecorder
			? "This browser doesn't support in-browser recording. Try the latest Chrome, Edge, or Safari, or use the desktop app."
			: !capabilities.hasUserMedia
				? "Camera and microphone access are unavailable in this browser. Check permissions or switch browsers."
				: requiresDisplayMedia && !capabilities.hasDisplayMedia
					? "Screen capture isn't supported in this browser. Switch to Camera only or use Chrome, Edge, or Safari."
					: null
		: null;

	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
	const startRecordingRef = useRef<
		((options?: { reuseInstantVideo?: boolean }) => Promise<void>) | null
	>(null);
	const instantUploaderRef = useRef<InstantMp4Uploader | null>(null);
	const videoCreationRef = useRef<{
		id: VideoId;
		upload: PresignedPost;
		shareUrl: string;
	} | null>(null);
	const instantMp4ActiveRef = useRef(false);
	const pendingInstantVideoIdRef = useRef<VideoId | null>(null);
	const dataRequestIntervalRef = useRef<number | null>(null);
	const instantChunkModeRef = useRef<InstantChunkingMode | null>(null);
	const chunkStartGuardTimeoutRef = useRef<number | null>(null);
	const lastInstantChunkAtRef = useRef<number | null>(null);
	const freePlanAutoStopTriggeredRef = useRef(false);
	const shareUrlOpenedRef = useRef(false);
	const errorDownloadUrlRef = useRef<string | null>(null);
	const requestInstantRecorderData = useCallback(() => {
		if (instantChunkModeRef.current !== "manual") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
		try {
			recorder.requestData();
		} catch (error) {
			console.warn("Failed to request recorder data", error);
		}
	}, [mediaRecorderRef]);

	const rpc = useRpcClient();
	type RpcClient = typeof rpc;
	type VideoInstantCreateVariables = Parameters<
		RpcClient["VideoInstantCreate"]
	>[0];
	const router = useRouter();
	const { setUploadStatus } = useUploadingContext();

	const replaceErrorDownload = useCallback((blob: Blob | null) => {
		if (errorDownloadUrlRef.current) {
			URL.revokeObjectURL(errorDownloadUrlRef.current);
			errorDownloadUrlRef.current = null;
		}

		if (!blob || typeof window === "undefined") {
			setErrorDownload(null);
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const extension = getFileExtensionFromMime(blob.type);
		const url = URL.createObjectURL(blob);
		errorDownloadUrlRef.current = url;
		setErrorDownload({
			url,
			fileName: `cap-recording-${timestamp}.${extension}`,
		});
	}, []);

	useEffect(() => {
		return () => {
			if (errorDownloadUrlRef.current) {
				URL.revokeObjectURL(errorDownloadUrlRef.current);
				errorDownloadUrlRef.current = null;
			}
		};
	}, []);

	const openShareUrl = useCallback((shareUrl?: string | null) => {
		if (!shareUrl || shareUrlOpenedRef.current) return;
		if (typeof window === "undefined") return;
		shareUrlOpenedRef.current = true;
		window.open(shareUrl, "_blank", "noopener,noreferrer");
	}, []);
	const queryClient = useQueryClient();
	const deleteVideo = useEffectMutation({
		mutationFn: (id: VideoId) => rpc.VideoDelete(id),
	});
	const videoInstantCreate = useEffectMutation({
		mutationFn: (variables: VideoInstantCreateVariables) =>
			rpc.VideoInstantCreate(variables),
	});

	const isFreePlan = !isProUser;

	const stopInstantChunkInterval = useCallback(() => {
		if (!dataRequestIntervalRef.current) return;
		clearInterval(dataRequestIntervalRef.current);
		dataRequestIntervalRef.current = null;
	}, []);

	const startInstantChunkInterval = useCallback(() => {
		if (instantChunkModeRef.current !== "manual") return;
		if (typeof window === "undefined") return;
		requestInstantRecorderData();
		if (dataRequestIntervalRef.current) return;
		dataRequestIntervalRef.current = window.setInterval(
			requestInstantRecorderData,
			INSTANT_UPLOAD_REQUEST_INTERVAL_MS,
		);
	}, [requestInstantRecorderData]);

	const clearInstantChunkGuard = useCallback(() => {
		if (!chunkStartGuardTimeoutRef.current) return;
		if (typeof window !== "undefined") {
			window.clearTimeout(chunkStartGuardTimeoutRef.current);
		} else {
			clearTimeout(chunkStartGuardTimeoutRef.current);
		}
		chunkStartGuardTimeoutRef.current = null;
	}, []);

	const beginManualInstantChunking = useCallback(() => {
		instantChunkModeRef.current = "manual";
		lastInstantChunkAtRef.current = null;
		clearInstantChunkGuard();
		startInstantChunkInterval();
	}, [clearInstantChunkGuard, startInstantChunkInterval]);

	const scheduleInstantChunkGuard = useCallback(() => {
		clearInstantChunkGuard();
		if (typeof window === "undefined") return;
		chunkStartGuardTimeoutRef.current = window.setTimeout(() => {
			if (instantChunkModeRef.current !== "timeslice") return;
			if (lastInstantChunkAtRef.current !== null) return;
			console.warn(
				"Instant recorder did not emit data after start; falling back to manual chunk requests",
			);
			beginManualInstantChunking();
		}, INSTANT_CHUNK_GUARD_DELAY_MS);
	}, [beginManualInstantChunking, clearInstantChunkGuard]);

	const updatePhase = useCallback(
		(newPhase: RecorderPhase) => {
			setPhase(newPhase);
			onPhaseChange?.(newPhase);
		},
		[onPhaseChange],
	);

	const cleanupRecordingState = useCallback(
		(options?: { preserveInstantVideo?: boolean }) => {
			cleanupStreams();
			clearTimer();
			resetRecorder();
			resetTimer();
			stopInstantChunkInterval();
			clearInstantChunkGuard();
			instantChunkModeRef.current = null;
			lastInstantChunkAtRef.current = null;
			instantMp4ActiveRef.current = false;
			if (instantUploaderRef.current) {
				void instantUploaderRef.current.cancel();
			}
			instantUploaderRef.current = null;
			setUploadStatus(undefined);
			setChunkUploads([]);
			setHasAudioTrack(false);
			replaceErrorDownload(null);
			shareUrlOpenedRef.current = false;

			if (!options?.preserveInstantVideo) {
				const pendingInstantVideoId = pendingInstantVideoIdRef.current;
				pendingInstantVideoIdRef.current = null;
				videoCreationRef.current = null;
				setVideoId(null);
				if (pendingInstantVideoId) {
					void deleteVideo.mutateAsync(pendingInstantVideoId);
				}
			}
		},
		[
			cleanupStreams,
			clearTimer,
			resetRecorder,
			resetTimer,
			stopInstantChunkInterval,
			clearInstantChunkGuard,
			deleteVideo,
			setUploadStatus,
			replaceErrorDownload,
		],
	);

	const resetState = useCallback(() => {
		cleanupRecordingState();
		updatePhase("idle");
	}, [cleanupRecordingState, updatePhase]);

	const resetStateRef = useRef(resetState);

	useEffect(() => {
		resetStateRef.current = resetState;
	}, [resetState]);

	useEffect(() => {
		setCapabilities(detectCapabilities());
	}, []);

	useEffect(() => {
		return () => {
			resetStateRef.current();
		};
	}, []);

	const handleRecorderDataAvailable = useCallback(
		(event: BlobEvent) => {
			onRecorderDataAvailable(event, (chunk: Blob, totalBytes: number) => {
				if (instantMp4ActiveRef.current && chunk.size > 0) {
					lastInstantChunkAtRef.current =
						typeof performance !== "undefined" ? performance.now() : Date.now();
					if (instantChunkModeRef.current === "timeslice") {
						clearInstantChunkGuard();
					}
				}
				instantUploaderRef.current?.handleChunk(chunk, totalBytes);
			});
		},
		[onRecorderDataAvailable, clearInstantChunkGuard],
	);

	const stopRecordingInternalWrapper = useCallback(async () => {
		return stopRecordingInternal(cleanupStreams, clearTimer);
	}, [stopRecordingInternal, cleanupStreams, clearTimer]);

	const startRecording = async (options?: { reuseInstantVideo?: boolean }) => {
		if (!organisationId) {
			toast.error("Select an organization before recording.");
			return;
		}

		if (recordingMode === "camera" && !selectedCameraId) {
			toast.error("Select a camera before recording.");
			return;
		}

		if (!isBrowserSupported) {
			const fallbackMessage =
				unsupportedReason ??
				"Recording isn't supported in this browser. Try another browser or use the desktop app.";
			toast.error(fallbackMessage);
			return;
		}

		replaceErrorDownload(null);
		shareUrlOpenedRef.current = false;

		setChunkUploads([]);
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

				const displayAudioConfig: boolean | MediaTrackConstraints =
					systemAudioEnabled
						? {
								echoCancellation: false,
								autoGainControl: false,
								noiseSuppression: false,
							}
						: false;

				const baseDisplayRequest: ExtendedDisplayMediaStreamOptions = {
					video: videoConstraints,
					audio: displayAudioConfig,
					preferCurrentTab: recordingMode === "tab",
					...(systemAudioEnabled ? { systemAudio: "include" } : {}),
				};

				const noAudioDisplayRequest: ExtendedDisplayMediaStreamOptions = {
					video: videoConstraints,
					audio: false,
					preferCurrentTab: recordingMode === "tab",
				};

				const preferredOptions = DISPLAY_MODE_PREFERENCES[recordingMode];

				if (preferredOptions) {
					const preferredDisplayRequest: ExtendedDisplayMediaStreamOptions = {
						...baseDisplayRequest,
						...preferredOptions,
						video: videoConstraints,
						audio: displayAudioConfig,
						...(systemAudioEnabled ? { systemAudio: "include" } : {}),
					};

					try {
						videoStream = await navigator.mediaDevices.getDisplayMedia(
							preferredDisplayRequest as DisplayMediaStreamOptions,
						);
					} catch (displayError) {
						if (isUserCancellationError(displayError)) {
							throw displayError;
						}
						if (shouldRetryDisplayMediaWithoutPreferences(displayError)) {
							console.warn(
								"Display media preferences not supported, retrying without them",
								displayError,
							);
							try {
								videoStream = await navigator.mediaDevices.getDisplayMedia(
									baseDisplayRequest as DisplayMediaStreamOptions,
								);
							} catch (audioRetryError) {
								if (
									systemAudioEnabled &&
									shouldRetryDisplayMediaWithoutPreferences(audioRetryError)
								) {
									console.warn(
										"System audio not supported, retrying without audio",
										audioRetryError,
									);
									toast.warning(
										"System audio isn't supported in this browser. Recording without it.",
									);
									videoStream = await navigator.mediaDevices.getDisplayMedia(
										noAudioDisplayRequest as DisplayMediaStreamOptions,
									);
								} else {
									throw audioRetryError;
								}
							}
						} else if (systemAudioEnabled) {
							console.warn(
								"Display media with audio failed, retrying without system audio",
								displayError,
							);
							toast.warning(
								"System audio isn't supported in this browser. Recording without it.",
							);
							const noAudioPreferred: ExtendedDisplayMediaStreamOptions = {
								...noAudioDisplayRequest,
								...preferredOptions,
								video: videoConstraints,
								audio: false,
							};
							try {
								videoStream = await navigator.mediaDevices.getDisplayMedia(
									noAudioPreferred as DisplayMediaStreamOptions,
								);
							} catch {
								throw displayError;
							}
						} else {
							throw displayError;
						}
					}
				}

				if (!videoStream) {
					try {
						videoStream = await navigator.mediaDevices.getDisplayMedia(
							baseDisplayRequest as DisplayMediaStreamOptions,
						);
					} catch (fallbackError) {
						if (
							systemAudioEnabled &&
							shouldRetryDisplayMediaWithoutPreferences(fallbackError)
						) {
							console.warn(
								"System audio not supported, retrying without audio",
								fallbackError,
							);
							toast.warning(
								"System audio isn't supported in this browser. Recording without it.",
							);
							videoStream = await navigator.mediaDevices.getDisplayMedia(
								noAudioDisplayRequest as DisplayMediaStreamOptions,
							);
						} else {
							throw fallbackError;
						}
					}
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

			const systemAudioTracks =
				recordingMode !== "camera" && systemAudioEnabled
					? (videoStream?.getAudioTracks() ?? [])
					: [];

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

			let audioTracks: MediaStreamTrack[] = [];
			const hasSystemAudio = systemAudioTracks.length > 0;
			const hasMicAudio = micStream !== null;

			if (hasSystemAudio && hasMicAudio) {
				const audioCtx = new AudioContext();
				audioContextRef.current = audioCtx;

				if (audioCtx.state !== "running") {
					await audioCtx.resume();
				}

				const systemSource = audioCtx.createMediaStreamSource(
					new MediaStream(systemAudioTracks),
				);
				const micSource = audioCtx.createMediaStreamSource(micStream);
				const destination = audioCtx.createMediaStreamDestination();

				systemSource.connect(destination);
				micSource.connect(destination);

				audioTracks = destination.stream.getAudioTracks();
			} else if (hasSystemAudio) {
				audioTracks = systemAudioTracks;
			} else if (hasMicAudio) {
				audioTracks = micStream.getAudioTracks();
			}

			const mixedStream = new MediaStream([
				...videoStream.getVideoTracks(),
				...audioTracks,
			]);

			mixedStreamRef.current = mixedStream;
			const hasAudio = mixedStream.getAudioTracks().length > 0;
			setHasAudioTrack(hasAudio);

			recordedChunksRef.current = [];
			totalRecordedBytesRef.current = 0;
			instantUploaderRef.current = null;
			instantMp4ActiveRef.current = false;

			const mp4Candidates = hasAudio
				? [...MP4_MIME_TYPES.withAudio, ...MP4_MIME_TYPES.videoOnly]
				: [...MP4_MIME_TYPES.videoOnly, ...MP4_MIME_TYPES.withAudio];
			const supportedMp4MimeType = pickSupportedMimeType(mp4Candidates);
			const webmCandidates = hasAudio
				? [...WEBM_MIME_TYPES.withAudio, ...WEBM_MIME_TYPES.videoOnly]
				: [...WEBM_MIME_TYPES.videoOnly, ...WEBM_MIME_TYPES.withAudio];
			const fallbackMimeType = pickSupportedMimeType(webmCandidates);
			const mimeType = supportedMp4MimeType ?? fallbackMimeType;
			const useInstantMp4 = Boolean(supportedMp4MimeType);
			instantMp4ActiveRef.current = useInstantMp4;
			const shouldReuseInstantVideo = Boolean(
				options?.reuseInstantVideo && videoCreationRef.current,
			);

			if (useInstantMp4) {
				let creationResult = videoCreationRef.current;
				const width = dimensionsRef.current.width;
				const height = dimensionsRef.current.height;
				const resolution = width && height ? `${width}x${height}` : undefined;
				if (!shouldReuseInstantVideo || !creationResult) {
					const creation = unwrapExitOrThrow(
						await videoInstantCreate.mutateAsync({
							orgId: Organisation.OrganisationId.make(organisationId),
							folderId: Option.none(),
							resolution,
							width,
							height,
							videoCodec: "h264",
							audioCodec: hasAudio ? "aac" : undefined,
							supportsUploadProgress: true,
						}),
					);
					creationResult = {
						id: creation.id,
						upload: creation.upload,
						shareUrl: creation.shareUrl,
					};
					videoCreationRef.current = creationResult;
				}
				if (creationResult) {
					setVideoId(creationResult.id);
					pendingInstantVideoIdRef.current = creationResult.id;
				}

				let uploadId: string | null = null;
				try {
					if (!creationResult)
						throw new Error("Missing instant recording context");
					uploadId = await initiateMultipartUpload(creationResult.id);
				} catch (initError) {
					const orphanId = creationResult?.id;
					if (orphanId) {
						await deleteVideo.mutateAsync(orphanId);
					}
					pendingInstantVideoIdRef.current = null;
					videoCreationRef.current = null;
					throw initError;
				}

				if (!creationResult) {
					throw new Error("Instant recording metadata missing");
				}
				instantUploaderRef.current = new InstantMp4Uploader({
					videoId: creationResult.id,
					uploadId,
					mimeType: supportedMp4MimeType ?? "",
					setUploadStatus,
					sendProgressUpdate: (uploaded, total) =>
						sendProgressUpdate(creationResult.id, uploaded, total),
					onChunkStateChange: setChunkUploads,
				});
			} else {
				if (!shouldReuseInstantVideo) {
					videoCreationRef.current = null;
					pendingInstantVideoIdRef.current = null;
				}
			}

			const recorder = new MediaRecorder(
				mixedStream,
				mimeType ? { mimeType } : undefined,
			);
			recorder.ondataavailable = handleRecorderDataAvailable;
			recorder.onstop = onRecorderStop;
			recorder.onerror = onRecorderError;

			const handleVideoEnded = () => {
				stopRecordingRef.current?.().catch(() => {
					/* ignore */
				});
			};

			firstTrack?.addEventListener("ended", handleVideoEnded, { once: true });

			mediaRecorderRef.current = recorder;
			instantChunkModeRef.current = null;
			lastInstantChunkAtRef.current = null;
			clearInstantChunkGuard();
			stopInstantChunkInterval();
			if (useInstantMp4) {
				let startedWithTimeslice = false;
				try {
					recorder.start(INSTANT_UPLOAD_REQUEST_INTERVAL_MS);
					instantChunkModeRef.current = "timeslice";
					startedWithTimeslice = true;
				} catch (startError) {
					console.warn(
						"Failed to start recorder with timeslice chunks, falling back to manual flush",
						startError,
					);
				}

				if (startedWithTimeslice) {
					scheduleInstantChunkGuard();
				} else {
					recorder.start();
					beginManualInstantChunking();
				}
			} else {
				recorder.start(200);
			}
			onRecordingStart?.();

			startTimer();
			updatePhase("recording");
		} catch (err) {
			const orphanVideoId =
				instantMp4ActiveRef.current && videoCreationRef.current?.id
					? videoCreationRef.current.id
					: null;
			if (orphanVideoId) {
				instantUploaderRef.current = null;
				instantMp4ActiveRef.current = false;
				videoCreationRef.current = null;
				pendingInstantVideoIdRef.current = null;
				await deleteVideo.mutateAsync(orphanVideoId);
			}

			console.error("Failed to start recording", err);
			toast.error("Could not start recording.");
			resetState();
		} finally {
			setIsSettingUp(false);
		}
	};

	startRecordingRef.current = startRecording;

	const pauseRecording = useCallback(() => {
		if (phase !== "recording") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "recording") return;

		try {
			const timestamp = performance.now();
			recorder.pause();
			pauseTimer(timestamp);
			updatePhase("paused");
		} catch (error) {
			console.error("Failed to pause recording", error);
			toast.error("Could not pause recording.");
		}
	}, [phase, pauseTimer, updatePhase, mediaRecorderRef]);

	const resumeRecording = useCallback(() => {
		if (phase !== "paused") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "paused") return;

		try {
			const timestamp = performance.now();
			resumeTimer(timestamp);
			recorder.resume();
			if (instantMp4ActiveRef.current) {
				startInstantChunkInterval();
			}
			updatePhase("recording");
		} catch (error) {
			console.error("Failed to resume recording", error);
			toast.error("Could not resume recording.");
		}
	}, [
		phase,
		resumeTimer,
		updatePhase,
		mediaRecorderRef,
		startInstantChunkInterval,
	]);

	const stopRecording = useCallback(async () => {
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		replaceErrorDownload(null);
		if (phase !== "recording" && phase !== "paused") return;

		const orgId = organisationId;
		if (!orgId) {
			updatePhase("error");
			return;
		}

		const timestamp = performance.now();
		commitPausedDuration(timestamp);
		const recordedDurationMs = syncDurationFromClock(timestamp);

		const brandedOrgId = Organisation.OrganisationId.make(orgId);
		let thumbnailBlob: Blob | null = null;
		let thumbnailPreviewUrl: string | undefined;
		let createdVideoId: VideoId | null = videoCreationRef.current?.id ?? null;
		let rawRecordingBlob: Blob | null = null;
		let processedRecordingBlob: Blob | null = null;
		const instantUploader = instantUploaderRef.current;
		const useInstantMp4 = Boolean(instantUploader);

		try {
			onRecordingStop?.();
			updatePhase("creating");

			rawRecordingBlob = await stopRecordingInternalWrapper();
			if (!rawRecordingBlob) throw new Error("No recording available");

			const durationSeconds = Math.max(
				1,
				Math.round(recordedDurationMs / 1000),
			);
			const width = dimensionsRef.current.width;
			const height = dimensionsRef.current.height;
			const resolution = width && height ? `${width}x${height}` : undefined;

			setUploadStatus({ status: "creating" });

			let creationResult = videoCreationRef.current;
			if (!creationResult) {
				const result = unwrapExitOrThrow(
					await videoInstantCreate.mutateAsync({
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
				creationResult = {
					id: result.id,
					upload: result.upload,
					shareUrl: result.shareUrl,
				};
				videoCreationRef.current = creationResult;
				setVideoId(result.id);
			}

			createdVideoId = creationResult.id;

			if (creationResult.shareUrl) {
				openShareUrl(creationResult.shareUrl);
			}

			if (useInstantMp4) {
				processedRecordingBlob =
					rawRecordingBlob.type === "video/mp4"
						? rawRecordingBlob
						: new File([rawRecordingBlob], "result.mp4", {
								type: "video/mp4",
							});
			} else {
				processedRecordingBlob = await convertToMp4(
					rawRecordingBlob,
					hasAudioTrack,
					creationResult.id,
					setUploadStatus,
					updatePhase,
				);
			}

			if (!processedRecordingBlob) {
				throw new Error("Failed to prepare recording for upload");
			}

			thumbnailBlob = await captureThumbnail(
				processedRecordingBlob,
				dimensionsRef.current,
			);
			thumbnailPreviewUrl = thumbnailBlob
				? URL.createObjectURL(thumbnailBlob)
				: undefined;

			updatePhase("uploading");
			setUploadStatus({
				status: "uploadingVideo",
				capId: creationResult.id,
				progress: 0,
				thumbnailUrl: thumbnailPreviewUrl,
			});

			if (useInstantMp4 && instantUploader) {
				instantUploader.setThumbnailUrl(thumbnailPreviewUrl);
				await instantUploader.finalize({
					finalBlob: processedRecordingBlob,
					durationSeconds,
					width,
					height,
					thumbnailUrl: thumbnailPreviewUrl,
				});
				instantUploaderRef.current = null;
				instantMp4ActiveRef.current = false;
			} else {
				await uploadRecording(
					processedRecordingBlob,
					creationResult.upload,
					creationResult.id,
					thumbnailPreviewUrl,
					setUploadStatus,
				);
			}

			pendingInstantVideoIdRef.current = null;

			if (thumbnailBlob) {
				try {
					const screenshotData = await createVideoAndGetUploadUrl({
						videoId: creationResult.id,
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
						capId: creationResult.id,
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
									capId: creationResult.id,
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
						queryKey: ThumbnailRequest.queryKey(creationResult.id),
					});
				} catch (thumbnailError) {
					console.error("Failed to upload thumbnail", thumbnailError);
					toast.warning("Recording uploaded, but thumbnail failed to upload.");
				}
			}

			setUploadStatus(undefined);
			updatePhase("completed");
			toast.success("Recording uploaded");
			openShareUrl(creationResult.shareUrl);
			router.refresh();
		} catch (err) {
			console.error("Failed to process recording", err);
			setUploadStatus(undefined);
			updatePhase("error");
			replaceErrorDownload(processedRecordingBlob ?? rawRecordingBlob);

			const idToDelete = createdVideoId ?? videoId;
			if (idToDelete) {
				await deleteVideo.mutateAsync(idToDelete);
				if (pendingInstantVideoIdRef.current === idToDelete) {
					pendingInstantVideoIdRef.current = null;
				}
			}
		} finally {
			if (thumbnailPreviewUrl) {
				URL.revokeObjectURL(thumbnailPreviewUrl);
			}
		}
	}, [
		stopInstantChunkInterval,
		phase,
		organisationId,
		hasAudioTrack,
		videoId,
		updatePhase,
		setUploadStatus,
		deleteVideo,
		videoInstantCreate,
		router,
		stopRecordingInternalWrapper,
		queryClient,
		onRecordingStop,
		commitPausedDuration,
		syncDurationFromClock,
		openShareUrl,
		replaceErrorDownload,
		clearInstantChunkGuard,
	]);

	useEffect(() => {
		stopRecordingRef.current = stopRecording;
	}, [stopRecording]);

	useEffect(() => {
		if (!isFreePlan) {
			freePlanAutoStopTriggeredRef.current = false;
			return;
		}

		const isRecordingPhase = phase === "recording" || phase === "paused";
		if (!isRecordingPhase) {
			freePlanAutoStopTriggeredRef.current = false;
			return;
		}

		if (
			durationMs >= FREE_PLAN_MAX_RECORDING_MS &&
			!freePlanAutoStopTriggeredRef.current
		) {
			freePlanAutoStopTriggeredRef.current = true;
			toast.info(
				"Free plan recordings are limited to 5 minutes. Recording stopped automatically.",
			);
			stopRecording().catch((error) => {
				console.error("Failed to stop recording at free plan limit", error);
			});
		}
	}, [durationMs, isFreePlan, phase, stopRecording]);

	const restartRecording = useCallback(async () => {
		if (isRestarting) return;
		if (phase !== "recording" && phase !== "paused") return;

		const creationToReuse = videoCreationRef.current;
		const shouldReuseInstantVideo = Boolean(creationToReuse);
		setIsRestarting(true);

		try {
			try {
				await stopRecordingInternalWrapper();
			} catch (error) {
				console.warn("Failed to stop recorder before restart", error);
			}

			cleanupRecordingState({ preserveInstantVideo: shouldReuseInstantVideo });
			updatePhase("idle");

			if (shouldReuseInstantVideo && creationToReuse) {
				await deleteVideoResultFile({ videoId: creationToReuse.id });
			}

			const latestStartRecording = startRecordingRef.current;
			if (!latestStartRecording) {
				throw new Error("Recorder not ready to start");
			}
			await latestStartRecording({
				reuseInstantVideo: shouldReuseInstantVideo,
			});
		} catch (error) {
			console.error("Failed to restart recording", error);
			toast.error("Could not restart recording. Please try again.");
			cleanupRecordingState();
			updatePhase("idle");
		} finally {
			setIsRestarting(false);
		}
	}, [
		cleanupRecordingState,
		isRestarting,
		phase,
		stopRecordingInternalWrapper,
		updatePhase,
	]);

	const canStartRecording =
		Boolean(organisationId) &&
		!isSettingUp &&
		!isRestarting &&
		isBrowserSupported;
	const isPaused = phase === "paused";
	const isRecordingActive = phase === "recording" || isPaused;
	const isBusyPhase =
		phase === "recording" ||
		phase === "paused" ||
		phase === "creating" ||
		phase === "converting" ||
		phase === "uploading";
	const isBusyState = isBusyPhase || isRestarting;

	return {
		phase,
		durationMs,
		videoId,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		isSettingUp,
		isRecording: isRecordingActive,
		isPaused,
		isBusy: isBusyState,
		canStartRecording,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		restartRecording,
		resetState,
		isRestarting,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
	};
};
