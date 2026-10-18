"use client";

import {
	acquireCameraStream,
	acquireDisplayStream,
	acquireMicStream,
	createAudioMixer,
	getCaptureErrorMessage,
} from "@cap/recorder-core/capture-streams";
import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core/instant-mp4-uploader";
import type {
	ChunkUploadState,
	RecorderPhase,
	RecordingFailureDownload,
	RecoveredRecordingDownload,
	UploadTarget,
	VideoId,
} from "@cap/recorder-core/recorder-types";
import {
	detectCapabilities,
	getMediaRecorderOptions,
	openShareUrlInNewTab,
	type RecorderCapabilities,
	type RecordingPipeline,
	selectRecordingPipeline,
} from "@cap/recorder-core/recorder-utils";
import {
	canUseRecordingSpool,
	deleteRecoveredRecordingSpool,
	RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS,
	RecordingSpool,
} from "@cap/recorder-core/recording-spool";
import { moveRecordingSpoolToInMemoryBackup } from "@cap/recorder-core/recording-spool-fallback";
import { Organisation } from "@cap/web-domain";
import { Cause, Exit, Option } from "effect";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useUploadingContext } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { RecordingMode } from "./RecordingModeSelector";
import {
	loadRecoveredRecordingSpools,
	removeRecoveredRecordingSpoolFromCache,
	resetRecoveredRecordingSpoolsCache,
} from "./recovered-recording-cache";
import { useMediaRecorderSetup } from "./useMediaRecorderSetup";
import { useRecordingTimer } from "./useRecordingTimer";
import { useStreamManagement } from "./useStreamManagement";
import { useSurfaceDetection } from "./useSurfaceDetection";
import {
	type DetectedDisplayRecordingMode,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";

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
	upload: UploadTarget;
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

const triggerBrowserDownload = (url: string, fileName: string) => {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
};

const recoveredToastId = (id: string) => `recovered-${id}`;

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
	const phaseRef = useRef<RecorderPhase>("idle");
	const [videoId, setVideoId] = useState<VideoId | null>(null);
	const [hasAudioTrack, setHasAudioTrack] = useState(false);
	const [isSettingUp, setIsSettingUp] = useState(false);
	const [isMicrophoneUnavailable, setIsMicrophoneUnavailable] = useState(false);
	const microphoneDecisionRef = useRef<((proceed: boolean) => void) | null>(
		null,
	);
	const [isRestarting, setIsRestarting] = useState(false);
	const [chunkUploads, setChunkUploads] = useState<ChunkUploadState[]>([]);
	const [canRetryUpload, setCanRetryUpload] = useState(false);
	const [errorDownload, setErrorDownload] =
		useState<RecordingFailureDownload | null>(null);
	const [completedShareUrl, setCompletedShareUrl] = useState<string | null>(
		null,
	);
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
		recorderError,
		getRecoveryBlob,
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
	const startInFlightRef = useRef(false);
	const startRecordingRef = useRef<(() => Promise<void>) | null>(null);
	const instantUploaderRef = useRef<InstantRecordingUploader | null>(null);
	const recordingPipelineRef = useRef<RecordingPipeline | null>(null);
	const videoCreationRef = useRef<{
		id: VideoId;
		shareUrl: string;
		upload: UploadTarget;
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
	const stoppedRecordingRef = useRef<{
		blob: Blob | null;
		totalBytes: number;
		durationSeconds: number;
		captureFailed: boolean;
		completionUncertain: boolean;
	} | null>(null);
	const uploadCancellationRef = useRef<Promise<void> | null>(null);
	const automaticUploadRetriesRef = useRef(0);
	const spoolFallbackRef = useRef<Promise<boolean> | null>(null);
	const setupGenerationRef = useRef(0);
	const recordingSpoolRef = useRef<RecordingSpool | null>(null);
	const recordingSpoolDegradingRef = useRef(false);
	const recordingSpoolWarningShownRef = useRef(false);
	const recordingSpoolHeartbeatRef = useRef<number | null>(null);
	const recoveredDownloadUrlsRef = useRef(new Map<string, string>());
	const memoryRecoveredRecordingsRef = useRef(new Set<string>());
	const dismissedRecoveredIdsRef = useRef(new Set<string>());

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
		toast.dismiss(recoveredToastId(id));
		memoryRecoveredRecordingsRef.current.delete(id);
		dismissedRecoveredIdsRef.current.add(id);
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

		const refreshRecoveredRecordings = () =>
			void loadRecoveredRecordingSpools()
				.then((recovered) => {
					if (
						cancelled ||
						recovered.length === 0 ||
						typeof window === "undefined"
					) {
						return;
					}

					const previousIds = new Set(recoveredDownloadUrlsRef.current.keys());
					const nextDownloads = recovered
						.filter(
							(item) => !dismissedRecoveredIdsRef.current.has(item.sessionId),
						)
						.map((item) => {
							const url =
								recoveredDownloadUrlsRef.current.get(item.sessionId) ??
								URL.createObjectURL(item.blob);
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

					setRecoveredDownloads((current) => [
						...current.filter(
							(download) =>
								!nextDownloads.some((next) => next.id === download.id),
						),
						...nextDownloads,
					]);
					for (const download of nextDownloads) {
						if (previousIds.has(download.id)) continue;
						toast.info("Recovered an unfinished recording", {
							id: recoveredToastId(download.id),
							duration: Infinity,
							description: new Date(download.createdAt).toLocaleString(),
							action: {
								label: "Download",
								onClick: () => {
									triggerBrowserDownload(download.url, download.fileName);
								},
							},
							cancel: {
								label: "Dismiss",
								onClick: () => {
									dismissRecoveredDownload(download.id);
								},
							},
						});
					}
				})
				.catch((error) => {
					console.error("Failed to recover orphaned recording spools", error);
				});
		refreshRecoveredRecordings();
		const interval = window.setInterval(refreshRecoveredRecordings, 60_000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [dismissRecoveredDownload]);

	const stopRecordingSpoolHeartbeat = useCallback(() => {
		if (recordingSpoolHeartbeatRef.current === null) return;
		window.clearInterval(recordingSpoolHeartbeatRef.current);
		recordingSpoolHeartbeatRef.current = null;
	}, []);

	// Chunk writes alone are not a liveness signal — a paused MediaRecorder
	// produces no chunks, so without the heartbeat another dashboard tab's
	// recovery sweep would offer a >RECORDING_SPOOL_LIVE_MIN_IDLE_MS pause as
	// "recovered" and let the user delete the live session's backup (for the
	// buffered pipeline, its upload source).
	const startRecordingSpoolHeartbeat = useCallback(
		(spool: RecordingSpool) => {
			stopRecordingSpoolHeartbeat();
			recordingSpoolHeartbeatRef.current = window.setInterval(() => {
				if (recordingSpoolRef.current !== spool) {
					stopRecordingSpoolHeartbeat();
					return;
				}
				void spool.touch();
			}, RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS);
		},
		[stopRecordingSpoolHeartbeat],
	);

	useEffect(() => stopRecordingSpoolHeartbeat, [stopRecordingSpoolHeartbeat]);

	const disposeRecordingSpool = useCallback(async () => {
		const spool = recordingSpoolRef.current;
		recordingSpoolRef.current = null;
		recordingSpoolDegradingRef.current = false;
		recordingSpoolWarningShownRef.current = false;
		stopRecordingSpoolHeartbeat();
		if (!spool) return;

		try {
			await spool.dispose();
		} catch (error) {
			console.error("Failed to dispose recording spool", error);
		}
	}, [stopRecordingSpoolHeartbeat]);

	const createRecordingSpool = useCallback(
		async (mimeType: string) => {
			if (!canUseRecordingSpool()) {
				return null;
			}

			try {
				const spool = await RecordingSpool.create({ mimeType });
				recordingSpoolDegradingRef.current = false;
				recordingSpoolWarningShownRef.current = false;
				recordingSpoolRef.current = spool;
				startRecordingSpoolHeartbeat(spool);
				return spool;
			} catch (error) {
				console.error("Failed to initialize recording spool", error);
				return null;
			}
		},
		[startRecordingSpoolHeartbeat],
	);

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
				stopRecordingSpoolHeartbeat();
				const fallback = moveRecordingSpoolToInMemoryBackup({
					spool,
					setLocalRecordingStrategy,
					getRetainedChunks: () => [...recordedChunksRef.current],
					replaceLocalRecording,
				});
				spoolFallbackRef.current = fallback;
				const recovered = await fallback;
				spoolFallbackRef.current = null;
				recordingSpoolDegradingRef.current = false;
				if (!recovered) {
					toast.error(
						"Local storage became unavailable. Stopping to protect the available recording.",
					);
					void stopRecordingRef.current?.();
					return;
				}

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
				if (!instantUploaderRef.current && isStreamingPipelineActive()) {
					void stopRecordingRef.current?.();
				}
			});
		},
		[
			recordedChunksRef,
			replaceLocalRecording,
			setLocalRecordingStrategy,
			stopRecordingSpoolHeartbeat,
			isStreamingPipelineActive,
		],
	);

	const resolveFailureBlob = useCallback(
		async (blob: Blob | null) => {
			if (blob) {
				return blob;
			}

			const spool = recordingSpoolRef.current;
			if (!spool) {
				return getRecoveryBlob();
			}

			try {
				return await spool.recoverBlob();
			} catch (error) {
				console.error(
					"Failed to reconstruct recording from local spool",
					error,
				);
				return getRecoveryBlob();
			}
		},
		[getRecoveryBlob],
	);

	const openShareUrl = useCallback((shareUrl?: string | null) => {
		if (!shareUrl || shareUrlOpenedRef.current) return;
		if (!openShareUrlInNewTab(shareUrl)) return;
		shareUrlOpenedRef.current = true;
	}, []);
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
			phaseRef.current = newPhase;
			setPhase(newPhase);
			onPhaseChange?.(newPhase);
		},
		[onPhaseChange],
	);

	const stopRecordingInternalWrapper = useCallback(async () => {
		let blob: Blob | null;
		try {
			blob = await stopRecordingInternal(cleanupStreams, clearTimer);
		} finally {
			await spoolFallbackRef.current;
			await recordingSpoolRef.current?.flush();
		}
		return getRecoveryBlob() ?? blob;
	}, [stopRecordingInternal, cleanupStreams, clearTimer, getRecoveryBlob]);

	const respondToMicrophoneFailure = useCallback((proceed: boolean) => {
		microphoneDecisionRef.current?.(proceed);
	}, []);

	const cleanupRecordingState = useCallback(
		async (preserveRecording = false) => {
			setupGenerationRef.current += 1;
			respondToMicrophoneFailure(false);
			if (preserveRecording) {
				await stopRecordingInternalWrapper().catch(() => {});
			}
			cleanupStreams();
			clearTimer();
			resetRecorder();
			resetTimer();
			stopInstantChunkInterval();
			clearInstantChunkGuard();
			instantChunkModeRef.current = null;
			lastInstantChunkAtRef.current = null;
			recordingPipelineRef.current = null;
			if (preserveRecording) {
				const spool = recordingSpoolRef.current;
				recordingSpoolRef.current = null;
				stopRecordingSpoolHeartbeat();
				await spool?.flush().catch(() => {});
				resetRecoveredRecordingSpoolsCache();
			} else {
				await disposeRecordingSpool();
			}
			stoppedRecordingRef.current = null;
			automaticUploadRetriesRef.current = 0;
			setCanRetryUpload(false);
			const instantUploader = instantUploaderRef.current;
			instantUploaderRef.current = null;
			if (instantUploader) {
				try {
					if (preserveRecording) instantUploader.suspend();
					else await instantUploader.cancel();
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
			setCompletedShareUrl(null);
			shareUrlOpenedRef.current = false;

			const pendingInstantVideoId = pendingInstantVideoIdRef.current;
			pendingInstantVideoIdRef.current = null;
			videoCreationRef.current = null;
			setVideoId(null);
			if (pendingInstantVideoId && !preserveRecording) {
				await deletePendingVideoSafely(pendingInstantVideoId);
			}
		},
		[
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
			stopRecordingSpoolHeartbeat,
			stopRecordingInternalWrapper,
			respondToMicrophoneFailure,
		],
	);

	const resetState = useCallback(async () => {
		if (stoppedRecordingRef.current !== null) return;
		await cleanupRecordingState();
		updatePhase("idle");
	}, [cleanupRecordingState, updatePhase]);

	const prepareNewRecording = useCallback(async () => {
		if (phaseRef.current !== "error" || stopInFlightRef.current) return false;
		const recording = stoppedRecordingRef.current;
		if (!recording) return false;
		stopInFlightRef.current = true;
		const generation = setupGenerationRef.current;
		try {
			await stopRecordingInternalWrapper().catch(() => {});
			if (generation !== setupGenerationRef.current) return false;
			const recovered = await resolveFailureBlob(null);
			const blob =
				recording.blob && (!recovered || recording.blob.size > recovered.size)
					? recording.blob
					: recovered;
			if (generation !== setupGenerationRef.current) return false;
			if (blob?.size) {
				const id = recordingSpoolRef.current?.sessionId ?? crypto.randomUUID();
				const url =
					recoveredDownloadUrlsRef.current.get(id) ?? URL.createObjectURL(blob);
				recoveredDownloadUrlsRef.current.set(id, url);
				if (!recordingSpoolRef.current || blob !== recovered)
					memoryRecoveredRecordingsRef.current.add(id);
				const createdAt = Date.now();
				setRecoveredDownloads((current) => [
					...current.filter((download) => download.id !== id),
					{
						id,
						url,
						createdAt,
						fileName: createRecordingDownloadName(createdAt, blob.type),
					},
				]);
			}
			await cleanupRecordingState(true);
			updatePhase("idle");
			return true;
		} catch (error) {
			console.error("Failed to preserve the previous recording", error);
			toast.error(
				"Could not prepare a new recording. Your previous recording is still available.",
			);
			return false;
		} finally {
			stopInFlightRef.current = false;
		}
	}, [
		cleanupRecordingState,
		resolveFailureBlob,
		stopRecordingInternalWrapper,
		updatePhase,
	]);

	const unmountCleanupRef = useRef(cleanupRecordingState);

	useEffect(() => {
		unmountCleanupRef.current = cleanupRecordingState;
	}, [cleanupRecordingState]);

	useEffect(() => {
		setCapabilities(detectCapabilities());
	}, []);

	useEffect(() => {
		return () => {
			void unmountCleanupRef.current(true);
		};
	}, []);

	const handleLiveUploadFailure = useCallback(() => {
		if (stopInFlightRef.current) return;
		const spool = recordingSpoolRef.current;
		const uploader = instantUploaderRef.current;
		if (spool) {
			if (uploader) {
				instantUploaderRef.current = null;
				uploadCancellationRef.current = uploader.cancel();
				toast.info(
					"Recording continues. We'll retry the upload when you stop.",
				);
			}
			return;
		}
		void stopRecordingRef.current?.();
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
					handleLiveUploadFailure();
				}
			});
		},
		[
			onRecorderDataAvailable,
			clearInstantChunkGuard,
			isStreamingPipelineActive,
			persistChunkToRecordingSpool,
			handleLiveUploadFailure,
		],
	);

	const startRecording = async () => {
		if (
			(phaseRef.current !== "idle" && phaseRef.current !== "completed") ||
			startInFlightRef.current ||
			stopInFlightRef.current ||
			(mediaRecorderRef.current &&
				mediaRecorderRef.current.state !== "inactive")
		)
			return;
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
		setCompletedShareUrl(null);
		startInFlightRef.current = true;
		shareUrlOpenedRef.current = false;

		setChunkUploads([]);
		setIsSettingUp(true);
		const generation = ++setupGenerationRef.current;
		const assertSetupActive = () => {
			if (generation !== setupGenerationRef.current) {
				throw new DOMException("Recording setup was cancelled", "AbortError");
			}
		};

		try {
			let videoStream: MediaStream | null = null;
			let firstTrack: MediaStreamTrack | null = null;

			if (recordingMode === "camera") {
				if (!selectedCameraId) {
					throw new Error("Camera ID is required for camera-only mode");
				}
				videoStream = await acquireCameraStream(selectedCameraId);
				cameraStreamRef.current = videoStream;
				firstTrack = videoStream.getVideoTracks()[0] ?? null;
			} else {
				videoStream = await acquireDisplayStream({
					mode: recordingMode as DetectedDisplayRecordingMode,
					systemAudioEnabled,
					onSystemAudioFallback: () => {
						toast.warning(
							"System audio isn't supported in this browser. Recording without it.",
						);
					},
				});
				displayStreamRef.current = videoStream;
				firstTrack = videoStream.getVideoTracks()[0] ?? null;
			}

			assertSetupActive();
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
					micStream = await acquireMicStream(selectedMicId);
				} catch (micError) {
					assertSetupActive();
					const captureTrack = firstTrack;
					if (!captureTrack || captureTrack.readyState === "ended") {
						throw micError;
					}
					const proceed = await new Promise<boolean>((resolve) => {
						const handleCaptureEnded = () => respondToMicrophoneFailure(false);
						microphoneDecisionRef.current = (decision) => {
							microphoneDecisionRef.current = null;
							captureTrack.removeEventListener("ended", handleCaptureEnded);
							setIsMicrophoneUnavailable(false);
							resolve(decision);
						};
						captureTrack.addEventListener("ended", handleCaptureEnded, {
							once: true,
						});
						setIsMicrophoneUnavailable(true);
					});
					if (!proceed) {
						await resetState();
						return;
					}
				}
			}

			if (micStream) {
				micStreamRef.current = micStream;
			}

			assertSetupActive();
			let audioTracks: MediaStreamTrack[] = [];
			const hasSystemAudio = systemAudioTracks.length > 0;
			const hasMicAudio = micStream !== null;

			if (hasSystemAudio && hasMicAudio) {
				const mixer = await createAudioMixer({ systemAudioTracks, micStream });
				audioContextRef.current = mixer.context;
				audioTracks = mixer.stream.getAudioTracks();
			} else if (hasSystemAudio) {
				audioTracks = systemAudioTracks;
			} else if (hasMicAudio) {
				audioTracks = micStream?.getAudioTracks() ?? [];
			}

			assertSetupActive();
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
			const spool = await createRecordingSpool(pipeline.mimeType);
			assertSetupActive();
			setLocalRecordingStrategy({ mode: spool ? "off" : "full" });
			automaticUploadRetriesRef.current = 0;
			stoppedRecordingRef.current = null;
			setCanRetryUpload(false);
			instantUploaderRef.current = null;
			recordingPipelineRef.current = pipeline;

			{
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
				assertSetupActive();
			}

			if (pipeline.mode === "streaming-webm") {
				const creationResult = videoCreationRef.current;
				if (!creationResult) throw new Error("Recording link is unavailable");
				const rawSubpath = `raw-upload.${pipeline.fileExtension}`;
				const uploadSession = await initiateMultipartUpload({
					videoId: creationResult.id,
					contentType: pipeline.mimeType,
					subpath: rawSubpath,
				});
				instantUploaderRef.current = new InstantRecordingUploader({
					videoId: creationResult.id,
					uploadId: uploadSession.uploadId,
					provider: uploadSession.provider,
					mimeType: pipeline.mimeType,
					subpath: rawSubpath,
					setUploadStatus,
					sendProgressUpdate: (uploaded, total) =>
						sendProgressUpdate(creationResult.id, uploaded, total),
					onChunkStateChange: setChunkUploads,
					onFatalError: handleLiveUploadFailure,
				});
			}

			assertSetupActive();
			if (!firstTrack || firstTrack.readyState === "ended") {
				throw new Error(
					"Screen or camera sharing ended before recording could start. Please try again.",
				);
			}
			const recorder = new MediaRecorder(
				mixedStream,
				getMediaRecorderOptions(pipeline.mimeType),
			);
			recorder.ondataavailable = handleRecorderDataAvailable;
			recorder.onstop = onRecorderStop;
			recorder.onerror = onRecorderError;

			const handleVideoEnded = () => {
				window.focus();
				stopRecordingRef.current?.().catch(() => {});
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

			if (generation === setupGenerationRef.current) {
				console.error("Failed to start recording", err);
				toast.error(
					getCaptureErrorMessage(
						err,
						recordingMode === "camera" ? "camera" : "display",
					),
				);
			}
			await resetState();
		} finally {
			startInFlightRef.current = false;
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

	const uploadStoppedRecording = useCallback(async () => {
		const recording = stoppedRecordingRef.current;
		const pipeline = recordingPipelineRef.current;
		const creation = videoCreationRef.current;
		if (!recording || !pipeline || !creation || stopInFlightRef.current) return;
		stopInFlightRef.current = true;
		const generation = setupGenerationRef.current;
		setCanRetryUpload(false);
		updatePhase("uploading");
		setCompletedShareUrl(creation.shareUrl);

		try {
			await uploadCancellationRef.current;
			if (generation !== setupGenerationRef.current) return;
			uploadCancellationRef.current = null;
			let uploader = instantUploaderRef.current;
			if (!uploader) {
				recording.blob = await resolveFailureBlob(recording.blob);
				if (generation !== setupGenerationRef.current) return;
				if (!recording.blob?.size) throw new Error("No recording available");
				if (recording.blob.size !== recording.totalBytes) {
					throw new Error(
						"The local backup is incomplete. The available data has been preserved.",
					);
				}
				const session = await initiateMultipartUpload({
					videoId: creation.id,
					contentType: pipeline.mimeType,
					subpath: `raw-upload.${pipeline.fileExtension}`,
				});
				uploader = new InstantRecordingUploader({
					videoId: creation.id,
					uploadId: session.uploadId,
					provider: session.provider,
					mimeType: pipeline.mimeType,
					subpath: `raw-upload.${pipeline.fileExtension}`,
					setUploadStatus,
					sendProgressUpdate: (uploaded, total) =>
						sendProgressUpdate(creation.id, uploaded, total),
					onChunkStateChange: setChunkUploads,
				});
				if (generation !== setupGenerationRef.current) {
					await uploader.cancel();
					return;
				}
				instantUploaderRef.current = uploader;
			}

			await uploader.finalize({
				finalBlob:
					recording.blob?.size === recording.totalBytes ? recording.blob : null,
				durationSeconds: recording.durationSeconds,
				...dimensionsRef.current,
				subpath: `raw-upload.${pipeline.fileExtension}`,
			});
			if (generation !== setupGenerationRef.current) return;
			if (!uploader.getProcessingStarted()) {
				toast.warning(
					"Recording uploaded. Processing hasn't started yet. You can retry processing from the video page.",
				);
			}

			instantUploaderRef.current = null;
			recordingPipelineRef.current = null;
			pendingInstantVideoIdRef.current = null;
			stoppedRecordingRef.current = null;
			await disposeRecordingSpool();
			resetRecorder();
			replaceErrorDownload(null);
			setUploadStatus(undefined);
			updatePhase("completed");
			toast.success("Recording uploaded. Your share link is ready.");
			openShareUrl(creation.shareUrl);
			router.refresh();
		} catch (error) {
			if (generation !== setupGenerationRef.current) return;
			console.error("Failed to upload recording", error);
			recording.blob = await resolveFailureBlob(recording.blob);
			if (generation !== setupGenerationRef.current) return;
			recording.completionUncertain =
				error instanceof MultipartCompletionUncertainError;
			if (!recording.completionUncertain && instantUploaderRef.current) {
				uploadCancellationRef.current = instantUploaderRef.current.cancel();
				instantUploaderRef.current = null;
			}
			replaceErrorDownload(recording.blob);
			setCanRetryUpload(true);
			setUploadStatus(undefined);
			updatePhase("error");
			toast.error(
				recording.completionUncertain
					? "Upload confirmation was interrupted. Your recording is kept here. Retry to check the same upload."
					: "Upload interrupted. Your recording is kept here. Retry without recording again.",
			);
		} finally {
			stopInFlightRef.current = false;
		}
	}, [
		disposeRecordingSpool,
		openShareUrl,
		replaceErrorDownload,
		resetRecorder,
		resolveFailureBlob,
		router,
		setUploadStatus,
		updatePhase,
	]);

	const stopRecording = useCallback(async () => {
		if (
			(phaseRef.current !== "recording" && phaseRef.current !== "paused") ||
			stopInFlightRef.current
		)
			return;
		const generation = setupGenerationRef.current;
		stopInFlightRef.current = true;
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		const timestamp = performance.now();
		commitPausedDuration(timestamp);
		const recording = {
			blob: null as Blob | null,
			totalBytes: 0,
			durationSeconds: Math.max(
				1,
				Math.round(syncDurationFromClock(timestamp) / 1000),
			),
			captureFailed: false,
			completionUncertain: false,
		};
		stoppedRecordingRef.current = recording;
		onRecordingStop?.();
		updatePhase("creating");
		setCompletedShareUrl(videoCreationRef.current?.shareUrl ?? null);
		try {
			recording.blob = await stopRecordingInternalWrapper();
			if (generation !== setupGenerationRef.current) return;
		} catch (error) {
			if (generation !== setupGenerationRef.current) return;
			console.error("Browser failed to finish recording", error);
			recording.captureFailed = true;
			recording.blob = await resolveFailureBlob(null);
			if (generation !== setupGenerationRef.current) return;
			replaceErrorDownload(recording.blob);
			setCanRetryUpload(Boolean(recording.blob?.size));
			setUploadStatus(undefined);
			updatePhase("error");
			toast.error(
				"The browser stopped recording early. You can save or upload the available recording.",
			);
		} finally {
			if (generation === setupGenerationRef.current) {
				recording.totalBytes = totalRecordedBytesRef.current;
			}
			stopInFlightRef.current = false;
		}
		if (!recording.captureFailed) await uploadStoppedRecording();
	}, [
		stopInstantChunkInterval,
		clearInstantChunkGuard,
		commitPausedDuration,
		syncDurationFromClock,
		onRecordingStop,
		updatePhase,
		stopRecordingInternalWrapper,
		resolveFailureBlob,
		replaceErrorDownload,
		setUploadStatus,
		uploadStoppedRecording,
		totalRecordedBytesRef,
	]);

	useEffect(() => {
		if (phase !== "error" || !canRetryUpload) return;
		const recording = stoppedRecordingRef.current;
		if (!recording || recording.captureFailed || recording.completionUncertain)
			return;
		const retryOnReconnect = () => {
			automaticUploadRetriesRef.current = 0;
			void uploadStoppedRecording();
		};
		const retryTimer = window.setTimeout(() => {
			if (!navigator.onLine || automaticUploadRetriesRef.current >= 3) return;
			automaticUploadRetriesRef.current += 1;
			void uploadStoppedRecording();
		}, 10_000);
		window.addEventListener("online", retryOnReconnect);
		return () => {
			window.clearTimeout(retryTimer);
			window.removeEventListener("online", retryOnReconnect);
		};
	}, [phase, canRetryUpload, uploadStoppedRecording]);

	useEffect(() => {
		if (
			(phase === "idle" || phase === "completed") &&
			!recoveredDownloads.some((download) =>
				memoryRecoveredRecordingsRef.current.has(download.id),
			)
		)
			return;
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [phase, recoveredDownloads]);

	useEffect(() => {
		stopRecordingRef.current = stopRecording;
	}, [stopRecording]);

	useEffect(() => {
		if (!recorderError || (phase !== "recording" && phase !== "paused")) return;
		console.error("Browser recording stopped unexpectedly", recorderError);
		void stopRecording();
	}, [recorderError, phase, stopRecording]);

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
		(phase === "idle" || phase === "completed") &&
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
	const isBusyState = isBusyPhase || isRestarting || isSettingUp;

	return {
		phase,
		durationMs,
		videoId,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		canRetryUpload,
		retryUpload: uploadStoppedRecording,
		prepareNewRecording,
		completedShareUrl,
		recoveredDownloads,
		isSettingUp,
		isMicrophoneUnavailable,
		respondToMicrophoneFailure,
		isRecording: isRecordingActive,
		isPaused,
		isBusy: isBusyState,
		canStartRecording,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		openCompletedShareUrl: () => openShareUrl(completedShareUrl),
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
