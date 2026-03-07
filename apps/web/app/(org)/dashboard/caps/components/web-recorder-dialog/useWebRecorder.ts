"use client";

import { Organisation } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { Cause, Exit, Option } from "effect";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { useUploadingContext } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	MultipartCompletionUncertainError,
	ProcessingStartError,
} from "./instant-mp4-uploader";
import type { RecordingMode } from "./RecordingModeSelector";
import { captureThumbnail, convertToMp4 } from "./recording-conversion";
import {
	canUseRecordingSpool,
	deleteRecoveredRecordingSpool,
	RecordingSpool,
} from "./recording-spool";
import { moveRecordingSpoolToInMemoryBackup } from "./recording-spool-fallback";
import { uploadRecording } from "./recording-upload";
import {
	loadRecoveredRecordingSpools,
	removeRecoveredRecordingSpoolFromCache,
} from "./recovered-recording-cache";
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
	RECORDING_MODE_TO_DISPLAY_SURFACE,
} from "./web-recorder-constants";
import type {
	ChunkUploadState,
	PresignedPost,
	RecorderPhase,
	RecordingFailureDownload,
	RecoveredRecordingDownload,
	VideoId,
} from "./web-recorder-types";
import {
	detectCapabilities,
	isUserCancellationError,
	type RecorderCapabilities,
	type RecordingPipeline,
	selectRecordingPipeline,
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
type InstantVideoCreation = {
	id: VideoId;
	shareUrl: string;
	upload: PresignedPost;
};

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

const createRecordingDownloadName = (
	createdAt: number,
	mime?: string | null,
) => {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	const extension = getFileExtensionFromMime(mime);
	return `cap-recording-${timestamp}.${extension}`;
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
	const [recoveredDownloads, setRecoveredDownloads] = useState<
		RecoveredRecordingDownload[]
	>([]);
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
		setLocalRecordingStrategy,
		replaceLocalRecording,
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

	const dimensionsRef = useRef<{
		width?: number;
		height?: number;
		fps?: number;
	}>({});
	const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
	const startRecordingRef = useRef<(() => Promise<void>) | null>(null);
	const instantUploaderRef = useRef<InstantRecordingUploader | null>(null);
	const recordingPipelineRef = useRef<RecordingPipeline | null>(null);
	const videoCreationRef = useRef<{
		id: VideoId;
		shareUrl: string;
		upload: PresignedPost;
	} | null>(null);
	const pendingInstantVideoIdRef = useRef<VideoId | null>(null);
	const dataRequestIntervalRef = useRef<number | null>(null);
	const instantChunkModeRef = useRef<InstantChunkingMode | null>(null);
	const chunkStartGuardTimeoutRef = useRef<number | null>(null);
	const lastInstantChunkAtRef = useRef<number | null>(null);
	const freePlanAutoStopTriggeredRef = useRef(false);
	const shareUrlOpenedRef = useRef(false);
	const errorDownloadUrlRef = useRef<string | null>(null);
	const stopInFlightRef = useRef(false);
	const recordingSpoolRef = useRef<RecordingSpool | null>(null);
	const recordingSpoolDegradingRef = useRef(false);
	const recordingSpoolWarningShownRef = useRef(false);
	const recoveredDownloadUrlsRef = useRef(new Map<string, string>());

	const isStreamingPipelineActive = useCallback(
		() => recordingPipelineRef.current?.mode === "streaming-webm",
		[],
	);

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

		const url = URL.createObjectURL(blob);
		errorDownloadUrlRef.current = url;
		setErrorDownload({
			url,
			fileName: createRecordingDownloadName(Date.now(), blob.type),
		});
	}, []);

	const dismissRecoveredDownload = useCallback((id: string) => {
		const url = recoveredDownloadUrlsRef.current.get(id);
		if (url) {
			URL.revokeObjectURL(url);
			recoveredDownloadUrlsRef.current.delete(id);
		}
		removeRecoveredRecordingSpoolFromCache(id);
		void deleteRecoveredRecordingSpool(id).catch((error) => {
			console.error("Failed to delete recovered recording spool", error);
		});
		setRecoveredDownloads((current) =>
			current.filter((download) => download.id !== id),
		);
	}, []);

	useEffect(() => {
		return () => {
			if (errorDownloadUrlRef.current) {
				URL.revokeObjectURL(errorDownloadUrlRef.current);
				errorDownloadUrlRef.current = null;
			}
			recoveredDownloadUrlsRef.current.forEach((url) => {
				URL.revokeObjectURL(url);
			});
			recoveredDownloadUrlsRef.current.clear();
		};
	}, []);

	useEffect(() => {
		if (!canUseRecordingSpool()) {
			return;
		}

		let cancelled = false;

		void loadRecoveredRecordingSpools()
			.then((recovered) => {
				if (
					cancelled ||
					recovered.length === 0 ||
					typeof window === "undefined"
				) {
					return;
				}

				const nextDownloads = recovered.map((item) => {
					const url = URL.createObjectURL(item.blob);
					recoveredDownloadUrlsRef.current.set(item.sessionId, url);
					return {
						id: item.sessionId,
						url,
						fileName: createRecordingDownloadName(
							item.createdAt,
							item.blob.type || item.mimeType,
						),
						createdAt: item.createdAt,
					} satisfies RecoveredRecordingDownload;
				});

				setRecoveredDownloads(nextDownloads);
				toast.info(
					nextDownloads.length === 1
						? "Recovered an unfinished local recording."
						: `Recovered ${nextDownloads.length} unfinished local recordings.`,
				);
			})
			.catch((error) => {
				console.error("Failed to recover orphaned recording spools", error);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	const disposeRecordingSpool = useCallback(async () => {
		const spool = recordingSpoolRef.current;
		recordingSpoolRef.current = null;
		recordingSpoolDegradingRef.current = false;
		recordingSpoolWarningShownRef.current = false;
		if (!spool) return;

		try {
			await spool.dispose();
		} catch (error) {
			console.error("Failed to dispose recording spool", error);
		}
	}, []);

	const createRecordingSpool = useCallback(async (mimeType: string) => {
		if (!canUseRecordingSpool()) {
			return null;
		}

		try {
			const spool = await RecordingSpool.create({ mimeType });
			recordingSpoolDegradingRef.current = false;
			recordingSpoolWarningShownRef.current = false;
			recordingSpoolRef.current = spool;
			return spool;
		} catch (error) {
			console.error("Failed to initialize recording spool", error);
			return null;
		}
	}, []);

	const persistChunkToRecordingSpool = useCallback(
		(chunk: Blob) => {
			if (recordingSpoolDegradingRef.current) return;

			const spool = recordingSpoolRef.current;
			if (!spool) return;

			void spool.appendChunk(chunk).catch(async (error) => {
				console.error("Failed to persist recording chunk locally", error);
				if (recordingSpoolRef.current !== spool) {
					return;
				}

				recordingSpoolDegradingRef.current = true;
				recordingSpoolRef.current = null;
				await moveRecordingSpoolToInMemoryBackup({
					spool,
					setLocalRecordingStrategy,
					getRetainedChunks: () => [...recordedChunksRef.current],
					replaceLocalRecording,
				});
				recordingSpoolDegradingRef.current = false;

				try {
					await spool.dispose();
				} catch (disposeError) {
					console.error(
						"Failed to dispose degraded recording spool",
						disposeError,
					);
				}

				if (recordingSpoolWarningShownRef.current) {
					return;
				}

				recordingSpoolWarningShownRef.current = true;
				toast.warning(
					"Local recovery switched to in-memory backup. Upload will continue, but large recordings may use more memory.",
				);
			});
		},
		[recordedChunksRef, replaceLocalRecording, setLocalRecordingStrategy],
	);

	const resolveFailureBlob = useCallback(async (blob: Blob | null) => {
		if (blob) {
			return blob;
		}

		const spool = recordingSpoolRef.current;
		if (!spool) {
			return null;
		}

		try {
			return await spool.recoverBlob();
		} catch (error) {
			console.error("Failed to reconstruct recording from local spool", error);
			return null;
		}
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
	const deletePendingVideoSafely = useCallback(
		async (id: VideoId) => {
			try {
				await deleteVideo.mutateAsync(id);
				return true;
			} catch (error) {
				console.error("Failed to delete pending instant video", error);
				return false;
			}
		},
		[deleteVideo],
	);

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

	const cleanupRecordingState = useCallback(async () => {
		cleanupStreams();
		clearTimer();
		resetRecorder();
		resetTimer();
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		recordingPipelineRef.current = null;
		await disposeRecordingSpool();
		const instantUploader = instantUploaderRef.current;
		instantUploaderRef.current = null;
		if (instantUploader) {
			try {
				await instantUploader.cancel();
			} catch (error) {
				console.error(
					"Failed to cancel multipart upload during cleanup",
					error,
				);
			}
		}
		setUploadStatus(undefined);
		setChunkUploads([]);
		setHasAudioTrack(false);
		replaceErrorDownload(null);
		shareUrlOpenedRef.current = false;

		const pendingInstantVideoId = pendingInstantVideoIdRef.current;
		pendingInstantVideoIdRef.current = null;
		videoCreationRef.current = null;
		setVideoId(null);
		if (pendingInstantVideoId) {
			await deletePendingVideoSafely(pendingInstantVideoId);
		}
	}, [
		cleanupStreams,
		clearTimer,
		resetRecorder,
		resetTimer,
		stopInstantChunkInterval,
		clearInstantChunkGuard,
		disposeRecordingSpool,
		deletePendingVideoSafely,
		setUploadStatus,
		replaceErrorDownload,
	]);

	const resetState = useCallback(async () => {
		await cleanupRecordingState();
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
			void resetStateRef.current();
		};
	}, []);

	const handleRecorderDataAvailable = useCallback(
		(event: BlobEvent) => {
			onRecorderDataAvailable(event, (chunk: Blob, totalBytes: number) => {
				if (isStreamingPipelineActive() && chunk.size > 0) {
					lastInstantChunkAtRef.current =
						typeof performance !== "undefined" ? performance.now() : Date.now();
					if (instantChunkModeRef.current === "timeslice") {
						clearInstantChunkGuard();
					}
				}
				persistChunkToRecordingSpool(chunk);
				try {
					instantUploaderRef.current?.handleChunk(chunk, totalBytes);
				} catch (error) {
					console.error("Failed to upload recording chunk", error);
					toast.error(
						"Upload could not keep up with recording. Stopping to protect the recording.",
					);
					void stopRecordingRef.current?.();
				}
			});
		},
		[
			onRecorderDataAvailable,
			clearInstantChunkGuard,
			isStreamingPipelineActive,
			persistChunkToRecordingSpool,
		],
	);

	const stopRecordingInternalWrapper = useCallback(async () => {
		return stopRecordingInternal(cleanupStreams, clearTimer);
	}, [stopRecordingInternal, cleanupStreams, clearTimer]);

	const startRecording = async () => {
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
				fps:
					typeof settings?.frameRate === "number"
						? Math.round(settings.frameRate)
						: undefined,
			};

			const systemAudioTracks =
				recordingMode !== "camera" && systemAudioEnabled
					? (videoStream?.getAudioTracks() ?? [])
					: [];

			if (
				systemAudioEnabled &&
				recordingMode !== "camera" &&
				systemAudioTracks.length === 0
			) {
				toast.warning(
					recordingMode === "tab"
						? 'System audio wasn\'t captured. Make sure "Share tab audio" is checked in the browser picker.'
						: "System audio wasn't captured. Your browser or OS may not support it for screen sharing. Try sharing a browser tab instead.",
				);
			}

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
				const micSource = micStream
					? audioCtx.createMediaStreamSource(micStream)
					: null;
				const destination = audioCtx.createMediaStreamDestination();

				const limiter = audioCtx.createDynamicsCompressor();
				limiter.threshold.value = -3;
				limiter.knee.value = 2;
				limiter.ratio.value = 20;
				limiter.attack.value = 0.002;
				limiter.release.value = 0.05;

				systemSource.connect(limiter);
				micSource?.connect(limiter);
				limiter.connect(destination);

				audioTracks = destination.stream.getAudioTracks();
			} else if (hasSystemAudio) {
				audioTracks = systemAudioTracks;
			} else if (hasMicAudio) {
				audioTracks = micStream?.getAudioTracks() ?? [];
			}

			const mixedStream = new MediaStream([
				...videoStream.getVideoTracks(),
				...audioTracks,
			]);

			mixedStreamRef.current = mixedStream;
			const hasAudio = mixedStream.getAudioTracks().length > 0;
			setHasAudioTrack(hasAudio);

			const pipeline = selectRecordingPipeline(hasAudio);
			if (!pipeline) {
				throw new Error("No supported recording pipeline available");
			}

			recordedChunksRef.current = [];
			totalRecordedBytesRef.current = 0;
			await disposeRecordingSpool();
			if (pipeline.mode === "streaming-webm") {
				const spool = await createRecordingSpool(pipeline.mimeType);
				if (spool) {
					setLocalRecordingStrategy({ mode: "off" });
				} else {
					setLocalRecordingStrategy({ mode: "full" });
					toast.warning(
						"Durable local backup is unavailable. This recording will use in-memory recovery.",
					);
				}
			} else {
				setLocalRecordingStrategy({ mode: "full" });
			}
			instantUploaderRef.current = null;
			recordingPipelineRef.current = pipeline;

			if (pipeline.mode === "streaming-webm") {
				const width = dimensionsRef.current.width;
				const height = dimensionsRef.current.height;
				const resolution = width && height ? `${width}x${height}` : undefined;
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
				) as InstantVideoCreation;
				const creationResult = {
					id: creation.id,
					shareUrl: creation.shareUrl,
					upload: creation.upload,
				};
				videoCreationRef.current = creationResult;
				setVideoId(creation.id);
				pendingInstantVideoIdRef.current = creation.id;

				const rawSubpath = `raw-upload.${pipeline.fileExtension}`;
				const uploadId = await initiateMultipartUpload({
					videoId: creationResult.id,
					contentType: pipeline.mimeType,
					subpath: rawSubpath,
				});
				instantUploaderRef.current = new InstantRecordingUploader({
					videoId: creationResult.id,
					uploadId,
					mimeType: pipeline.mimeType,
					subpath: rawSubpath,
					setUploadStatus,
					sendProgressUpdate: (uploaded, total) =>
						sendProgressUpdate(creationResult.id, uploaded, total),
					onChunkStateChange: setChunkUploads,
					onFatalError: () => {
						void stopRecordingRef.current?.();
					},
				});
			}

			const recorder = new MediaRecorder(mixedStream, {
				mimeType: pipeline.mimeType,
			});
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
			if (pipeline.mode === "streaming-webm") {
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
			const orphanVideoId = videoCreationRef.current?.id ?? null;
			if (instantUploaderRef.current) {
				await instantUploaderRef.current.cancel();
			}
			await disposeRecordingSpool();
			if (orphanVideoId) {
				instantUploaderRef.current = null;
				recordingPipelineRef.current = null;
				videoCreationRef.current = null;
				pendingInstantVideoIdRef.current = null;
				await deletePendingVideoSafely(orphanVideoId);
			}

			console.error("Failed to start recording", err);
			toast.error("Could not start recording.");
			await resetState();
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
			if (isStreamingPipelineActive()) {
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
		isStreamingPipelineActive,
		startInstantChunkInterval,
	]);

	const stopRecording = useCallback(async () => {
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		replaceErrorDownload(null);
		if (phase !== "recording" && phase !== "paused") return;
		if (stopInFlightRef.current) return;
		stopInFlightRef.current = true;
		let createdVideoId: VideoId | null = videoCreationRef.current?.id ?? null;
		let rawRecordingBlob: Blob | null = null;

		try {
			const orgId = organisationId;
			if (!orgId) {
				updatePhase("error");
				return;
			}

			const timestamp = performance.now();
			commitPausedDuration(timestamp);
			const recordedDurationMs = syncDurationFromClock(timestamp);

			const pipeline = recordingPipelineRef.current;
			if (!pipeline) {
				updatePhase("error");
				return;
			}

			const instantUploader = instantUploaderRef.current;

			onRecordingStop?.();
			updatePhase("creating");

			rawRecordingBlob = await stopRecordingInternalWrapper();
			if (pipeline.mode === "buffered-raw" && !rawRecordingBlob) {
				throw new Error("No recording available");
			}

			const durationSeconds = Math.max(
				1,
				Math.round(recordedDurationMs / 1000),
			);
			const width = dimensionsRef.current.width;
			const height = dimensionsRef.current.height;
			const fps = dimensionsRef.current.fps;
			const resolution = width && height ? `${width}x${height}` : undefined;

			setUploadStatus({ status: "creating" });

			let creationResult = videoCreationRef.current;
			if (!creationResult) {
				const result = unwrapExitOrThrow(
					await videoInstantCreate.mutateAsync({
						orgId: Organisation.OrganisationId.make(orgId),
						folderId: Option.none(),
						resolution,
						durationSeconds,
						width,
						height,
						videoCodec: "h264",
						audioCodec: hasAudioTrack ? "aac" : undefined,
						supportsUploadProgress: true,
					}),
				) as InstantVideoCreation;
				creationResult = {
					id: result.id,
					shareUrl: result.shareUrl,
					upload: result.upload,
				};
				videoCreationRef.current = creationResult;
				setVideoId(result.id);
				pendingInstantVideoIdRef.current = result.id;
			}

			createdVideoId = creationResult.id;

			if (pipeline.mode === "streaming-webm" && creationResult.shareUrl) {
				openShareUrl(creationResult.shareUrl);
			}

			updatePhase("uploading");
			setUploadStatus({
				status: "uploadingVideo",
				capId: creationResult.id,
				progress: 0,
				thumbnailUrl: undefined,
			});

			if (pipeline.mode === "streaming-webm") {
				let uploader = instantUploader;
				const rawSubpath = `raw-upload.${pipeline.fileExtension}`;

				if (!uploader) {
					const uploadId = await initiateMultipartUpload({
						videoId: creationResult.id,
						contentType: pipeline.mimeType,
						subpath: rawSubpath,
					});
					uploader = new InstantRecordingUploader({
						videoId: creationResult.id,
						uploadId,
						mimeType: pipeline.mimeType,
						subpath: rawSubpath,
						setUploadStatus,
						sendProgressUpdate: (uploaded, total) =>
							sendProgressUpdate(creationResult.id, uploaded, total),
						onChunkStateChange: setChunkUploads,
						onFatalError: () => {
							void stopRecordingRef.current?.();
						},
					});
					instantUploaderRef.current = uploader;
				}

				await uploader.finalize({
					finalBlob: rawRecordingBlob,
					durationSeconds,
					width,
					height,
					fps,
					subpath: rawSubpath,
				});
			} else {
				const processedRecordingBlob =
					pipeline.fileExtension === "mp4"
						? rawRecordingBlob
						: await convertToMp4(
								rawRecordingBlob as Blob,
								hasAudioTrack,
								creationResult.id,
								setUploadStatus,
								() => updatePhase("converting"),
							);

				if (!processedRecordingBlob) {
					throw new Error("Failed to prepare recording for upload");
				}

				const thumbnailBlob = await captureThumbnail(processedRecordingBlob, {
					width,
					height,
				});
				const thumbnailPreviewUrl = thumbnailBlob
					? URL.createObjectURL(thumbnailBlob)
					: undefined;

				try {
					setUploadStatus({
						status: "uploadingVideo",
						capId: creationResult.id,
						progress: 0,
						thumbnailUrl: thumbnailPreviewUrl,
					});

					await uploadRecording(
						processedRecordingBlob,
						creationResult.upload,
						creationResult.id,
						thumbnailPreviewUrl,
						setUploadStatus,
					);

					if (thumbnailBlob) {
						try {
							const screenshotData = await createVideoAndGetUploadUrl({
								videoId: creationResult.id,
								isScreenshot: true,
								orgId: Organisation.OrganisationId.make(orgId),
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
							toast.warning(
								"Recording uploaded, but thumbnail failed to upload.",
							);
						}
					}
				} finally {
					if (thumbnailPreviewUrl) {
						URL.revokeObjectURL(thumbnailPreviewUrl);
					}
				}
			}

			instantUploaderRef.current = null;
			recordingPipelineRef.current = null;
			pendingInstantVideoIdRef.current = null;
			await disposeRecordingSpool();

			setUploadStatus(undefined);
			updatePhase("completed");
			toast.success(
				pipeline.mode === "streaming-webm"
					? "Recording uploaded. Processing will continue shortly."
					: "Recording uploaded.",
			);
			openShareUrl(creationResult.shareUrl);
			router.refresh();
		} catch (err) {
			console.error("Failed to process recording", err);
			setUploadStatus(undefined);
			const failureBlob = await resolveFailureBlob(rawRecordingBlob);
			if (err instanceof ProcessingStartError) {
				instantUploaderRef.current = null;
				recordingPipelineRef.current = null;
				pendingInstantVideoIdRef.current = null;
				videoCreationRef.current = null;
				replaceErrorDownload(failureBlob);
				await disposeRecordingSpool();
				updatePhase("error");
				toast.error(
					"Recording uploaded, but processing could not start. Open the video to retry processing.",
				);
				router.refresh();
				return;
			}
			if (err instanceof MultipartCompletionUncertainError) {
				instantUploaderRef.current = null;
				recordingPipelineRef.current = null;
				pendingInstantVideoIdRef.current = null;
				replaceErrorDownload(failureBlob);
				await disposeRecordingSpool();
				updatePhase("error");
				toast.error(
					"Upload confirmation was interrupted. Open the video to verify processing before retrying.",
				);
				openShareUrl(videoCreationRef.current?.shareUrl ?? null);
				router.refresh();
				return;
			}
			updatePhase("error");
			replaceErrorDownload(failureBlob);
			if (instantUploaderRef.current) {
				await instantUploaderRef.current.cancel();
				instantUploaderRef.current = null;
			}
			await disposeRecordingSpool();

			const idToDelete = createdVideoId ?? videoId;
			if (idToDelete) {
				await deletePendingVideoSafely(idToDelete);
				if (pendingInstantVideoIdRef.current === idToDelete) {
					pendingInstantVideoIdRef.current = null;
				}
			}
		} finally {
			stopInFlightRef.current = false;
		}
	}, [
		stopInstantChunkInterval,
		phase,
		organisationId,
		hasAudioTrack,
		videoId,
		updatePhase,
		setUploadStatus,
		deletePendingVideoSafely,
		videoInstantCreate,
		queryClient,
		router,
		stopRecordingInternalWrapper,
		onRecordingStop,
		commitPausedDuration,
		syncDurationFromClock,
		openShareUrl,
		replaceErrorDownload,
		resolveFailureBlob,
		disposeRecordingSpool,
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

		setIsRestarting(true);

		try {
			try {
				await stopRecordingInternalWrapper();
			} catch (error) {
				console.warn("Failed to stop recorder before restart", error);
			}

			await cleanupRecordingState();
			updatePhase("idle");

			const latestStartRecording = startRecordingRef.current;
			if (!latestStartRecording) {
				throw new Error("Recorder not ready to start");
			}
			await latestStartRecording();
		} catch (error) {
			console.error("Failed to restart recording", error);
			toast.error("Could not restart recording. Please try again.");
			await cleanupRecordingState();
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
		recoveredDownloads,
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
		dismissRecoveredDownload,
		isRestarting,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
	};
};
