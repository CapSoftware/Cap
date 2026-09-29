"use client";

import {
	AudioRecordingSidecar,
	uploadRecoveredAudioSidecar,
} from "@cap/recorder-core";
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
	type RecorderApiOptions,
} from "@cap/recorder-core/instant-mp4-uploader";
import {
	appendLocalRecordingChunk,
	initialLocalRecordingState,
	type LocalRecordingState,
} from "@cap/recorder-core/local-recording-backup";
import { recorderOptions } from "@cap/recorder-core/recorder-encoding";
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
	openShareUrlInNewTab,
	type RecorderCapabilities,
	type RecordingPipeline,
	selectRecordingPipeline,
} from "@cap/recorder-core/recorder-utils";
import {
	canUseRecordingSpool,
	createRecordingSessionId,
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
import type { RecordingMode } from "./recording-mode";
import {
	DEFAULT_RECORDING_QUALITY,
	qualityBitrateScale,
	type RecordingQuality,
} from "./recording-quality";
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

function selectPairedCameraPipeline(displayPipeline: RecordingPipeline) {
	if (
		displayPipeline.mode === "buffered-raw" &&
		displayPipeline.fileExtension === "mp4"
	) {
		const mimeType = "video/webm;codecs=vp8";
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return {
				mode: "streaming",
				mimeType,
				fileExtension: "webm",
				supportsProgressiveUpload: true,
			} satisfies RecordingPipeline;
		}
	}
	return selectRecordingPipeline(false);
}

interface UseWebRecorderOptions {
	organisationId: string | undefined;
	selectedMicId: string | null;
	micEnabled: boolean;
	systemAudioEnabled: boolean;
	recordingMode: RecordingMode;
	selectedCameraId: string | null;
	getCameraPreviewStream: () => MediaStream | null;
	onDisplayStreamAcquired?: () => Promise<void>;
	// Hands over a screen the user already shared from the recorder, so
	// starting doesn't open the browser picker a second time.
	takeSharedDisplayStream?: () => MediaStream | null;
	isProUser: boolean;
	onPhaseChange?: (phase: RecorderPhase) => void;
	onRecordingSurfaceDetected?: (mode: RecordingMode) => void;
	onRecordingStart?: () => void;
	onRecordingStop?: () => void;
	// Awaited once the capture sources are live and before the recorders
	// start; setup keeps running underneath it, so a countdown costs nothing.
	// Resolving false cancels the start.
	beforeRecordingStarts?: () => Promise<boolean>;
	quality?: RecordingQuality;
	/** Open the studio editor directly when the recording is done. */
	studioEnabled?: boolean;
}

const INSTANT_UPLOAD_REQUEST_INTERVAL_MS = 1000;
const INSTANT_CHUNK_GUARD_DELAY_MS = INSTANT_UPLOAD_REQUEST_INTERVAL_MS * 3;
const MEMORY_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
const CAMERA_BACKUP_TIMEOUT_MS = 5000;
const readMediaRecorderState = (recorder: MediaRecorder) => recorder.state;

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
	role?: "screen" | "camera" | "microphone" | "system-audio",
) => {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	const extension = getFileExtensionFromMime(mime);
	return `cap-recording-${timestamp}${role ? `-${role}` : ""}.${extension}`;
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

/**
 * A take the browser has finished, kept until it uploads so a failed upload
 * can be retried without recording again.
 */
type StoppedRecording = {
	blob: Blob | null;
	totalBytes: number;
	durationSeconds: number;
	captureFailed: boolean;
	completionUncertain: boolean;
	pairedCameraCapture: boolean;
	cameraRecordedBytes: number;
	cameraSettings: MediaTrackSettings | undefined;
	audioSidecars: AudioRecordingSidecar[];
	// Set once a failed attempt aborted the sidecars' live uploads, so a
	// retry sends their backups instead.
	audioLiveUploadsAborted: boolean;
	uploadedAudio: Set<AudioRecordingSidecar>;
	cameraUploaded: boolean;
};

class RecordingStartCancelledError extends Error {
	constructor() {
		super("Recording start was cancelled");
		this.name = "RecordingStartCancelledError";
	}
}

const settleAll = async (tasks: Promise<unknown>[]) => {
	const failed = (await Promise.allSettled(tasks)).find(
		(result) => result.status === "rejected",
	);
	if (failed?.status === "rejected") throw failed.reason;
};

export const useWebRecorder = ({
	organisationId,
	selectedMicId,
	micEnabled,
	systemAudioEnabled,
	recordingMode,
	selectedCameraId,
	getCameraPreviewStream,
	onDisplayStreamAcquired,
	takeSharedDisplayStream,
	isProUser,
	onPhaseChange,
	onRecordingSurfaceDetected,
	onRecordingStart,
	onRecordingStop,
	beforeRecordingStarts,
	quality = DEFAULT_RECORDING_QUALITY,
	studioEnabled = false,
}: UseWebRecorderOptions) => {
	const beforeRecordingStartsRef = useRef(beforeRecordingStarts);
	beforeRecordingStartsRef.current = beforeRecordingStarts;
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
	const [recordedBytes, setRecordedBytes] = useState(0);
	const [errorDownload, setErrorDownload] =
		useState<RecordingFailureDownload | null>(null);
	const [cameraErrorDownload, setCameraErrorDownload] =
		useState<RecordingFailureDownload | null>(null);
	const [audioErrorDownloads, setAudioErrorDownloads] = useState<
		Array<{
			kind: "mic" | "systemAudio";
			download: RecordingFailureDownload;
		}>
	>([]);
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
		localRecordingOverflowedRef,
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
	const restartDisplayStreamRef = useRef<MediaStream | null>(null);
	const instantUploaderRef = useRef<InstantRecordingUploader | null>(null);
	const cameraUploaderRef = useRef<InstantRecordingUploader | null>(null);
	const cameraMediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioSidecarsRef = useRef<AudioRecordingSidecar[]>([]);
	const cameraRecorderBytesRef = useRef(0);
	const cameraRecorderFailedRef = useRef(false);
	const cameraSpoolRef = useRef<RecordingSpool | null>(null);
	const cameraSpoolFailedRef = useRef(false);
	const cameraFallbackRef = useRef<LocalRecordingState>(
		initialLocalRecordingState(),
	);
	const recordingPairIdRef = useRef<string | null>(null);
	const cameraSettingsRef = useRef<MediaTrackSettings | undefined>(undefined);
	const cameraUploadApiRef = useRef<RecorderApiOptions | null>(null);
	const cameraUploadSubpathRef = useRef<string | null>(null);
	const cameraMimeTypeRef = useRef<string | null>(null);
	const cameraOffsetMsRef = useRef(0);
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
	const cameraErrorDownloadUrlRef = useRef<string | null>(null);
	const audioErrorDownloadUrlsRef = useRef<string[]>([]);
	const stopInFlightRef = useRef(false);
	const stoppedRecordingRef = useRef<StoppedRecording | null>(null);
	const uploadCancellationRef = useRef<Promise<unknown> | null>(null);
	const automaticUploadRetriesRef = useRef(0);
	const spoolFallbackRef = useRef<Promise<unknown> | null>(null);
	const setupGenerationRef = useRef(0);
	const recordingSpoolRef = useRef<RecordingSpool | null>(null);
	const degradedRecordingSpoolRef = useRef<RecordingSpool | null>(null);
	const recordingSpoolDegradingRef = useRef(false);
	const recordingSpoolWarningShownRef = useRef(false);
	const recordingSpoolHeartbeatRef = useRef<number | null>(null);
	const cameraSpoolHeartbeatRef = useRef<number | null>(null);
	const recoveredDownloadUrlsRef = useRef(new Map<string, string>());
	const memoryRecoveredRecordingsRef = useRef(new Set<string>());
	const dismissedRecoveredIdsRef = useRef(new Set<string>());

	const isStreamingPipelineActive = useCallback(
		() => recordingPipelineRef.current?.mode === "streaming",
		[],
	);

	const stopCameraRecorder = useCallback(async () => {
		const recorder = cameraMediaRecorderRef.current;
		if (!recorder) return 0;

		const finalizeBytes = () => {
			cameraMediaRecorderRef.current = null;
			return cameraRecorderBytesRef.current;
		};

		if (recorder.state === "inactive") {
			return finalizeBytes();
		}

		return new Promise<number>((resolve, reject) => {
			recorder.addEventListener(
				"stop",
				() => {
					const bytes = finalizeBytes();
					if (cameraRecorderFailedRef.current) {
						reject(new Error("Camera recording failed"));
						return;
					}
					resolve(bytes);
				},
				{ once: true },
			);
			recorder.addEventListener(
				"error",
				() => {
					cameraRecorderFailedRef.current = true;
					reject(new Error("Camera recording failed"));
				},
				{ once: true },
			);
			try {
				recorder.stop();
			} catch (error) {
				reject(error);
			}
		});
	}, []);

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

	const replaceCameraErrorDownload = useCallback((blob: Blob | null) => {
		if (cameraErrorDownloadUrlRef.current) {
			URL.revokeObjectURL(cameraErrorDownloadUrlRef.current);
			cameraErrorDownloadUrlRef.current = null;
		}
		if (!blob || typeof window === "undefined") {
			setCameraErrorDownload(null);
			return;
		}
		const url = URL.createObjectURL(blob);
		cameraErrorDownloadUrlRef.current = url;
		setCameraErrorDownload({
			url,
			fileName: createRecordingDownloadName(Date.now(), blob.type, "camera"),
		});
	}, []);

	const replaceAudioErrorDownloads = useCallback(
		(sources: Array<{ kind: "mic" | "systemAudio"; blob: Blob | null }>) => {
			for (const url of audioErrorDownloadUrlsRef.current) {
				URL.revokeObjectURL(url);
			}
			audioErrorDownloadUrlsRef.current = [];
			if (typeof window === "undefined") {
				setAudioErrorDownloads([]);
				return;
			}
			const downloads = sources.flatMap(({ kind, blob }) => {
				if (!blob) return [];
				const url = URL.createObjectURL(blob);
				audioErrorDownloadUrlsRef.current.push(url);
				return [
					{
						kind,
						download: {
							url,
							fileName: createRecordingDownloadName(
								Date.now(),
								blob.type,
								kind === "mic" ? "microphone" : "system-audio",
							),
						},
					},
				];
			});
			setAudioErrorDownloads(downloads);
		},
		[],
	);

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
			if (cameraErrorDownloadUrlRef.current) {
				URL.revokeObjectURL(cameraErrorDownloadUrlRef.current);
				cameraErrorDownloadUrlRef.current = null;
			}
			for (const url of audioErrorDownloadUrlsRef.current) {
				URL.revokeObjectURL(url);
			}
			audioErrorDownloadUrlsRef.current = [];
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
									item.sessionId.endsWith("-camera")
										? "camera"
										: item.sessionId.endsWith("-display")
											? "screen"
											: item.sessionId.endsWith("-microphone")
												? "microphone"
												: undefined,
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

	const stopCameraSpoolHeartbeat = useCallback(() => {
		if (cameraSpoolHeartbeatRef.current === null) return;
		window.clearInterval(cameraSpoolHeartbeatRef.current);
		cameraSpoolHeartbeatRef.current = null;
	}, []);

	useEffect(() => stopCameraSpoolHeartbeat, [stopCameraSpoolHeartbeat]);

	const disposeRecordingSpool = useCallback(async () => {
		const spool = recordingSpoolRef.current;
		recordingSpoolRef.current = null;
		degradedRecordingSpoolRef.current = null;
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

	const disposeCameraSpool = useCallback(async () => {
		const spool = cameraSpoolRef.current;
		const failed = cameraSpoolFailedRef.current;
		cameraSpoolRef.current = null;
		cameraSpoolFailedRef.current = false;
		cameraFallbackRef.current = initialLocalRecordingState();
		stopCameraSpoolHeartbeat();
		if (!spool) return;
		const dispose = async () => {
			try {
				await spool.dispose();
			} catch (error) {
				console.error("Failed to dispose camera recording spool", error);
			}
		};
		if (failed) {
			void dispose();
			return;
		}
		await dispose();
	}, [stopCameraSpoolHeartbeat]);

	const createRecordingSpool = useCallback(
		async (mimeType: string, role: "display" | "camera") => {
			if (!canUseRecordingSpool()) {
				return null;
			}

			try {
				const spool = await RecordingSpool.create({
					mimeType,
					sessionId: `${recordingPairIdRef.current}-${role}`,
				});
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

	const createCameraSpool = useCallback(
		async (mimeType: string) => {
			if (!canUseRecordingSpool()) return null;
			try {
				const spool = await RecordingSpool.create({
					mimeType,
					sessionId: `${recordingPairIdRef.current}-camera`,
				});
				cameraSpoolRef.current = spool;
				stopCameraSpoolHeartbeat();
				cameraSpoolHeartbeatRef.current = window.setInterval(() => {
					if (cameraSpoolRef.current !== spool) {
						stopCameraSpoolHeartbeat();
						return;
					}
					void spool.touch();
				}, RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS);
				return spool;
			} catch (error) {
				console.error("Failed to initialize camera recording spool", error);
				return null;
			}
		},
		[stopCameraSpoolHeartbeat],
	);

	const switchCameraBackupToMemory = useCallback(
		(error: unknown) => {
			if (cameraSpoolFailedRef.current) return;
			const unwrittenChunks =
				cameraSpoolRef.current?.getUnwrittenChunks() ?? [];
			const fallback = cameraFallbackRef.current;
			const retainedBytes =
				unwrittenChunks.reduce((total, chunk) => total + chunk.size, 0) +
				fallback.retainedBytes;
			const overflowed =
				fallback.overflowed || retainedBytes > MEMORY_BACKUP_MAX_BYTES;
			cameraFallbackRef.current = overflowed
				? { chunks: [], retainedBytes: 0, overflowed: true }
				: {
						chunks: [...unwrittenChunks, ...fallback.chunks],
						retainedBytes,
						overflowed: false,
					};
			cameraSpoolFailedRef.current = true;
			stopCameraSpoolHeartbeat();
			console.warn("Camera backup changed", error);
			toast.warning(
				overflowed
					? "Camera backup is unavailable. Recording continues, but camera video cannot be recovered if upload fails."
					: "Camera backup is limited to memory while recording continues.",
			);
		},
		[stopCameraSpoolHeartbeat],
	);

	const persistCameraChunk = useCallback(
		(chunk: Blob) => {
			const spool = cameraSpoolRef.current;
			if (!spool || cameraSpoolFailedRef.current) {
				const previous = cameraFallbackRef.current;
				const next = appendLocalRecordingChunk(previous, chunk, {
					mode: "capped",
					maxBytes: MEMORY_BACKUP_MAX_BYTES,
				});
				cameraFallbackRef.current = next;
				return !previous.overflowed && next.overflowed;
			}
			void spool.appendChunk(chunk).catch((error) => {
				if (cameraSpoolRef.current !== spool || cameraSpoolFailedRef.current) {
					return;
				}
				switchCameraBackupToMemory(error);
			});
			return false;
		},
		[switchCameraBackupToMemory],
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
				degradedRecordingSpoolRef.current = spool;
				stopRecordingSpoolHeartbeat();
				const fallback = moveRecordingSpoolToInMemoryBackup({
					spool,
					strategy: {
						mode: "capped",
						maxBytes: MEMORY_BACKUP_MAX_BYTES,
					},
					setLocalRecordingStrategy,
					getRetainedChunks: () => [...recordedChunksRef.current],
					getLocalRecordingOverflowed: () =>
						localRecordingOverflowedRef.current,
					replaceLocalRecording,
				});
				spoolFallbackRef.current = fallback;
				const { recovered, overflowed: backupOverflowed } = await fallback;
				spoolFallbackRef.current = null;
				recordingSpoolDegradingRef.current = false;
				// The spool still holds the only copy of the recording's start,
				// so it stays on disk for recovery instead of being disposed.
				if (!recovered) {
					toast.error(
						"Local storage became unavailable. Stopping to protect the available recording.",
					);
					void stopRecordingRef.current?.();
					return;
				}

				// The memory backup couldn't take what the spool held, so the spool
				// stays for recovery until the upload succeeds.
				if (backupOverflowed) {
					recordingSpoolWarningShownRef.current = true;
					toast.warning(
						"Recording memory backup reached its limit. Finishing now.",
					);
					void stopRecordingRef.current?.();
					return;
				}

				try {
					await spool.dispose();
					if (degradedRecordingSpoolRef.current === spool) {
						degradedRecordingSpoolRef.current = null;
					}
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
					"Local recovery switched to a bounded memory backup. Recording will finish if it fills.",
				);
				if (!instantUploaderRef.current && isStreamingPipelineActive()) {
					void stopRecordingRef.current?.();
				}
			});
		},
		[
			recordedChunksRef,
			localRecordingOverflowedRef,
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

	const resolveCameraFailureBlob = useCallback(async () => {
		const spool = cameraSpoolRef.current;
		const fallback = cameraFallbackRef.current;
		if (fallback.overflowed) return null;
		if (fallback.retainedBytes === cameraRecorderBytesRef.current) {
			return fallback.chunks.length > 0
				? new Blob(fallback.chunks, { type: fallback.chunks[0]?.type })
				: null;
		}
		let timeoutId: number | null = null;
		try {
			const persisted = spool
				? await Promise.race([
						spool.recoverPersistedBlob(),
						new Promise<never>((_, reject) => {
							timeoutId = window.setTimeout(
								() => reject(new Error("Camera backup read timed out")),
								CAMERA_BACKUP_TIMEOUT_MS,
							);
						}),
					])
				: null;
			if (!persisted && fallback.chunks.length === 0) return null;
			if (
				(persisted?.size ?? 0) + fallback.retainedBytes !==
				cameraRecorderBytesRef.current
			) {
				return null;
			}
			return new Blob(
				persisted ? [persisted, ...fallback.chunks] : fallback.chunks,
				{ type: persisted?.type ?? fallback.chunks[0]?.type },
			);
		} catch (error) {
			console.error("Failed to reconstruct camera recording", error);
			return null;
		} finally {
			if (timeoutId !== null) window.clearTimeout(timeoutId);
		}
	}, []);

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

	// `preserveRecording` keeps what a take already captured: local backups
	// stay on disk for recovery and remote uploads are suspended rather than
	// aborted.
	const cleanupRecordingState = useCallback(
		async (preserveRecording = false) => {
			setupGenerationRef.current += 1;
			respondToMicrophoneFailure(false);
			if (preserveRecording) {
				await stopRecordingInternalWrapper().catch(() => {});
			}
			const audioSidecars = [
				...new Set([
					...audioSidecarsRef.current,
					...(stoppedRecordingRef.current?.audioSidecars ?? []),
				]),
			];
			audioSidecarsRef.current = [];
			await Promise.all(
				audioSidecars.map((sidecar) =>
					(preserveRecording ? sidecar.stop() : sidecar.cancel()).catch(
						(error) => {
							console.error("Failed to stop audio sidecar", error);
						},
					),
				),
			);
			try {
				await stopCameraRecorder();
			} catch {
				cameraMediaRecorderRef.current = null;
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
				const cameraSpool = cameraSpoolRef.current;
				cameraSpoolRef.current = null;
				stopCameraSpoolHeartbeat();
				await cameraSpool?.flush().catch(() => {});
				resetRecoveredRecordingSpoolsCache();
			} else {
				await disposeRecordingSpool();
				await disposeCameraSpool();
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
			const cameraUploader = cameraUploaderRef.current;
			cameraUploaderRef.current = null;
			if (cameraUploader) {
				try {
					if (preserveRecording) cameraUploader.suspend();
					else await cameraUploader.cancel();
				} catch (error) {
					console.error("Failed to cancel camera upload during cleanup", error);
				}
			}
			cameraUploadApiRef.current = null;
			cameraUploadSubpathRef.current = null;
			cameraMimeTypeRef.current = null;
			cameraRecorderBytesRef.current = 0;
			cameraRecorderFailedRef.current = false;
			cameraSettingsRef.current = undefined;
			cameraOffsetMsRef.current = 0;
			recordingPairIdRef.current = null;
			setUploadStatus(undefined);
			setChunkUploads([]);
			setRecordedBytes(0);
			setHasAudioTrack(false);
			replaceErrorDownload(null);
			replaceCameraErrorDownload(null);
			replaceAudioErrorDownloads([]);
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
			stopCameraRecorder,
			clearTimer,
			resetRecorder,
			resetTimer,
			stopInstantChunkInterval,
			clearInstantChunkGuard,
			disposeRecordingSpool,
			disposeCameraSpool,
			deletePendingVideoSafely,
			setUploadStatus,
			replaceErrorDownload,
			replaceCameraErrorDownload,
			replaceAudioErrorDownloads,
			stopRecordingSpoolHeartbeat,
			stopCameraSpoolHeartbeat,
			stopRecordingInternalWrapper,
			respondToMicrophoneFailure,
		],
	);

	const resetState = useCallback(async () => {
		// A stopped take waiting to upload survives closing the recorder; it
		// is only let go by uploading it or starting a new recording.
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

	// The screen keeps recording to its local backup when its live upload
	// fails; stopping then uploads the complete backup instead.
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
		toast.error(
			"Upload could not keep up with recording. Stopping to protect the recording.",
		);
		void stopRecordingRef.current?.();
	}, []);

	const handleRecorderDataAvailable = useCallback(
		(event: BlobEvent) => {
			const backupLimitReached = onRecorderDataAvailable(
				event,
				(chunk: Blob, totalBytes: number) => {
					if (isStreamingPipelineActive() && chunk.size > 0) {
						lastInstantChunkAtRef.current =
							typeof performance !== "undefined"
								? performance.now()
								: Date.now();
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
				},
			);
			if (backupLimitReached) {
				toast.warning(
					"Recording memory backup reached its limit. Finishing now.",
				);
				void stopRecordingRef.current?.();
			}
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
		replaceCameraErrorDownload(null);
		replaceAudioErrorDownloads([]);
		setCompletedShareUrl(null);
		startInFlightRef.current = true;
		shareUrlOpenedRef.current = false;
		setChunkUploads([]);
		setRecordedBytes(0);
		setIsSettingUp(true);
		automaticUploadRetriesRef.current = 0;
		stoppedRecordingRef.current = null;
		setCanRetryUpload(false);
		const generation = ++setupGenerationRef.current;
		const assertSetupActive = () => {
			if (generation !== setupGenerationRef.current) {
				throw new DOMException("Recording setup was cancelled", "AbortError");
			}
		};
		cameraRecorderBytesRef.current = 0;
		cameraRecorderFailedRef.current = false;
		cameraSpoolFailedRef.current = false;
		cameraFallbackRef.current = initialLocalRecordingState();
		cameraSettingsRef.current = undefined;
		cameraOffsetMsRef.current = 0;
		cameraUploadApiRef.current = null;
		cameraUploadSubpathRef.current = null;
		cameraMimeTypeRef.current = null;

		try {
			recordingPairIdRef.current = createRecordingSessionId();
			let videoStream: MediaStream | null = null;
			let cameraRecordingStream: MediaStream | null = null;
			let cameraPipeline: RecordingPipeline | null = null;
			let firstTrack: MediaStreamTrack | null = null;

			if (recordingMode === "camera") {
				if (!selectedCameraId) {
					throw new Error("Camera ID is required for camera-only mode");
				}
				videoStream = await acquireCameraStream(selectedCameraId, {
					height: quality.cameraHeight,
				});
				cameraStreamRef.current = videoStream;
				firstTrack = videoStream.getVideoTracks()[0] ?? null;
			} else {
				const restartDisplayStream = restartDisplayStreamRef.current;
				restartDisplayStreamRef.current = null;
				videoStream =
					restartDisplayStream ??
					takeSharedDisplayStream?.() ??
					(await acquireDisplayStream({
						mode: recordingMode as DetectedDisplayRecordingMode,
						quality: {
							height: quality.screenHeight,
							frameRate: quality.frameRate,
						},
						systemAudioEnabled,
						onSystemAudioFallback: () => {
							toast.warning(
								"System audio isn't supported in this browser. Recording without it.",
							);
						},
					}));
				displayStreamRef.current = videoStream;
				await onDisplayStreamAcquired?.();
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

			const runCountdown = () =>
				(beforeRecordingStartsRef.current?.() ?? Promise.resolve(true)).catch(
					(countdownError) => {
						console.warn("Recording countdown failed", countdownError);
						return true;
					},
				);
			let countdownFinished = runCountdown();
			let countdownSettled = false;
			void countdownFinished.then(() => {
				countdownSettled = true;
			});

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
						? "System audio wasn't captured. Make sure “Share tab audio” is checked in the browser picker."
						: "System audio wasn't captured. Your browser or OS may not support it for screen sharing. Try sharing a browser tab instead.",
				);
			}

			let micStream: MediaStream | null = null;
			if (micEnabled && selectedMicId) {
				try {
					micStream = await acquireMicStream(selectedMicId, quality.mic);
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
					// A countdown that ran out behind the prompt counts down again
					// from the answer.
					if (countdownSettled && (await countdownFinished)) {
						countdownFinished = runCountdown();
					}
				}
			}

			if (micStream) {
				micStreamRef.current = micStream;
			}

			assertSetupActive();

			let audioTracks: MediaStreamTrack[] = [];
			const hasSystemAudio = systemAudioTracks.length > 0;
			const hasMicAudio = (micStream?.getAudioTracks().length ?? 0) > 0;

			if (hasSystemAudio && hasMicAudio) {
				const mixer = await createAudioMixer({ systemAudioTracks, micStream });
				audioContextRef.current = mixer.context;
				audioTracks = mixer.stream.getAudioTracks();
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

			if (recordingMode !== "camera" && selectedCameraId) {
				const previewTrack =
					getCameraPreviewStream()?.getVideoTracks()[0] ?? null;
				if (previewTrack?.readyState === "live") {
					cameraRecordingStream = new MediaStream([previewTrack.clone()]);
				} else {
					cameraRecordingStream = await acquireCameraStream(selectedCameraId, {
						height: quality.cameraHeight,
					});
				}
				cameraStreamRef.current = cameraRecordingStream;
				assertSetupActive();
				cameraSettingsRef.current = cameraRecordingStream
					.getVideoTracks()[0]
					?.getSettings();
				cameraPipeline = selectPairedCameraPipeline(pipeline);
				if (!cameraPipeline) {
					throw new Error("No supported camera recording pipeline available");
				}
				cameraMimeTypeRef.current = cameraPipeline.mimeType;
			}

			recordedChunksRef.current = [];
			totalRecordedBytesRef.current = 0;
			instantUploaderRef.current = null;
			recordingPipelineRef.current = pipeline;

			const prepareLocalBackups = async () => {
				await disposeRecordingSpool();
				await disposeCameraSpool();
				const spool = await createRecordingSpool(
					pipeline.mimeType,
					recordingMode === "camera" ? "camera" : "display",
				);
				if (spool) {
					setLocalRecordingStrategy({ mode: "off" });
				} else if (pipeline.mode === "streaming") {
					setLocalRecordingStrategy({
						mode: "capped",
						maxBytes: MEMORY_BACKUP_MAX_BYTES,
					});
					toast.warning(
						"Durable local backup is unavailable. This recording will use bounded memory recovery.",
					);
				} else {
					// A buffered capture uploads after Stop, so without a disk
					// backup memory holds the only copy.
					setLocalRecordingStrategy({ mode: "full" });
				}
				if (
					cameraPipeline &&
					!(await createCameraSpool(cameraPipeline.mimeType))
				) {
					toast.warning(
						"Durable camera backup is unavailable. Camera recovery will use bounded memory.",
					);
				}
			};

			const createInstantVideo = async () => {
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
				videoCreationRef.current = creation;
				setVideoId(creation.id);
				pendingInstantVideoIdRef.current = creation.id;
				return creation;
			};

			const instantVideo = createInstantVideo();
			await settleAll([prepareLocalBackups(), instantVideo]);
			assertSetupActive();
			const creationResult = await instantVideo;

			if (creationResult) {
				const rawSubpath = `raw-upload.${pipeline.fileExtension}`;
				const startScreenUpload = async () => {
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
				};
				const cameraApi: RecorderApiOptions = {
					extraBody: {
						screenSubpath: rawSubpath,
						cameraOffsetMs: 0,
					},
				};
				if (cameraPipeline) cameraUploadApiRef.current = cameraApi;
				const startCameraUpload = async (cameraPipeline: RecordingPipeline) => {
					const cameraSubpath = `camera-upload.${cameraPipeline.fileExtension}`;
					cameraUploadSubpathRef.current = cameraSubpath;
					const cameraSession = await initiateMultipartUpload({
						videoId: creationResult.id,
						contentType: cameraPipeline.mimeType,
						subpath: cameraSubpath,
					});
					cameraUploaderRef.current = new InstantRecordingUploader({
						videoId: creationResult.id,
						uploadId: cameraSession.uploadId,
						provider: cameraSession.provider,
						mimeType: cameraPipeline.mimeType,
						subpath: cameraSubpath,
						setUploadStatus,
						sendProgressUpdate: (uploaded, total) =>
							sendProgressUpdate(creationResult.id, uploaded, total),
						api: cameraApi,
						onFatalError: () => {
							void stopRecordingRef.current?.();
						},
					});
				};
				const createAudioSidecar = async (
					kind: "mic" | "systemAudio",
					tracks: MediaStreamTrack[],
				) => {
					const label = kind === "mic" ? "Microphone" : "System audio";
					const sidecar = await AudioRecordingSidecar.create({
						kind,
						stream: new MediaStream(tracks),
						videoId: creationResult.id,
						screenSubpath: rawSubpath,
						onFatalError: () => {
							void stopRecordingRef.current?.();
						},
						onBackupFallback: (error, recoveryAvailable) => {
							console.warn(`${label} backup changed`, error);
							toast.warning(
								recoveryAvailable
									? `${label} backup is limited to memory while recording continues.`
									: `${label} backup is unavailable. Recording continues, but audio cannot be recovered if upload fails.`,
							);
						},
					});
					audioSidecarsRef.current.push(sidecar);
				};

				// Every upload session opens at once; each lands in its ref as soon
				// as it exists, so a failure part way still cleans all of them up.
				await settleAll([
					pipeline.mode === "streaming"
						? startScreenUpload()
						: Promise.resolve(),
					cameraPipeline
						? startCameraUpload(cameraPipeline)
						: Promise.resolve(),
					hasMicAudio && micStream
						? createAudioSidecar("mic", micStream.getAudioTracks())
						: Promise.resolve(),
					hasSystemAudio
						? createAudioSidecar("systemAudio", systemAudioTracks)
						: Promise.resolve(),
				]);
				assertSetupActive();
			}

			if (!(await countdownFinished)) {
				throw new RecordingStartCancelledError();
			}
			assertSetupActive();
			if (
				videoStream
					.getVideoTracks()
					.some((track) => track.readyState === "ended")
			) {
				throw new Error("Sharing stopped before the recording started");
			}

			const recorder = new MediaRecorder(
				mixedStream,
				recorderOptions(
					pipeline.mimeType,
					mixedStream.getVideoTracks()[0],
					(type) => MediaRecorder.isTypeSupported(type),
					qualityBitrateScale(quality),
				),
			);
			let cameraRecorder: MediaRecorder | null = null;
			if (cameraRecordingStream && cameraPipeline) {
				const cameraVideoStream = new MediaStream(
					cameraRecordingStream.getVideoTracks(),
				);
				cameraRecorder = new MediaRecorder(
					cameraVideoStream,
					recorderOptions(
						cameraPipeline.mimeType,
						cameraVideoStream.getVideoTracks()[0],
						(type) => MediaRecorder.isTypeSupported(type),
						qualityBitrateScale(quality),
					),
				);
				cameraRecorder.addEventListener("dataavailable", (event) => {
					if (
						cameraMediaRecorderRef.current !== cameraRecorder ||
						event.data.size === 0
					) {
						return;
					}
					cameraRecorderBytesRef.current += event.data.size;
					const cameraBackupLimitReached = persistCameraChunk(event.data);
					try {
						cameraUploaderRef.current?.handleChunk(
							event.data,
							cameraRecorderBytesRef.current,
						);
						if (cameraBackupLimitReached) {
							toast.warning(
								"Camera backup is unavailable. Recording continues, but camera video cannot be recovered if upload fails.",
							);
						}
					} catch (error) {
						cameraRecorderFailedRef.current = true;
						console.error("Failed to upload camera recording chunk", error);
						void stopRecordingRef.current?.();
					}
				});
				cameraRecorder.addEventListener("error", () => {
					cameraRecorderFailedRef.current = true;
					void stopRecordingRef.current?.();
				});
				cameraMediaRecorderRef.current = cameraRecorder;
				cameraVideoStream.getVideoTracks()[0]?.addEventListener(
					"ended",
					() => {
						if (cameraMediaRecorderRef.current?.state === "inactive") return;
						cameraRecorderFailedRef.current = true;
						void stopRecordingRef.current?.();
					},
					{ once: true },
				);
			}
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
			let screenStartRequestedAt = performance.now();
			if (pipeline.mode === "streaming") {
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
					screenStartRequestedAt = performance.now();
					recorder.start();
					beginManualInstantChunking();
				}
			} else {
				recorder.start(200);
			}
			if (cameraRecorder) {
				const cameraStartRequestedAt = performance.now();
				cameraRecorder.start(1000);
				cameraOffsetMsRef.current = Math.round(
					cameraStartRequestedAt - screenStartRequestedAt,
				);
				const cameraApi = cameraUploadApiRef.current;
				if (cameraApi) {
					cameraApi.extraBody = {
						...cameraApi.extraBody,
						cameraOffsetMs: cameraOffsetMsRef.current,
					};
				}
			}
			for (const audioSidecar of audioSidecarsRef.current) {
				audioSidecar.start(screenStartRequestedAt);
			}
			onRecordingStart?.();

			startTimer();
			updatePhase("recording");
		} catch (err) {
			const orphanVideoId = videoCreationRef.current?.id ?? null;
			if (instantUploaderRef.current) {
				await instantUploaderRef.current.cancel();
			}
			if (cameraUploaderRef.current) {
				try {
					await cameraUploaderRef.current.cancel();
				} catch (cameraCancelError) {
					console.error(
						"Failed to cancel camera upload during setup",
						cameraCancelError,
					);
				}
				cameraUploaderRef.current = null;
			}
			const audioSidecars = audioSidecarsRef.current;
			audioSidecarsRef.current = [];
			await Promise.all(
				audioSidecars.map((sidecar) =>
					sidecar.cancel().catch((error) => {
						console.error("Failed to cancel audio sidecar during setup", error);
					}),
				),
			);
			await disposeRecordingSpool();
			if (orphanVideoId) {
				instantUploaderRef.current = null;
				recordingPipelineRef.current = null;
				videoCreationRef.current = null;
				pendingInstantVideoIdRef.current = null;
				await deletePendingVideoSafely(orphanVideoId);
			}

			if (
				!(err instanceof RecordingStartCancelledError) &&
				generation === setupGenerationRef.current
			) {
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

		const cameraRecorder = cameraMediaRecorderRef.current;
		const audioSidecars = audioSidecarsRef.current;
		let cameraPaused = false;
		try {
			const timestamp = performance.now();
			if (cameraRecorder?.state === "recording") {
				cameraRecorder.pause();
				cameraPaused = true;
			}
			for (const audioSidecar of audioSidecars) audioSidecar.pause();
			recorder.pause();
			pauseTimer(timestamp);
			updatePhase("paused");
		} catch (error) {
			let rollbackFailed = false;
			if (readMediaRecorderState(recorder) === "paused") {
				try {
					recorder.resume();
				} catch (rollbackError) {
					rollbackFailed = true;
					console.error("Failed to restore screen recording", rollbackError);
				}
			}
			if (cameraPaused && cameraRecorder?.state === "paused") {
				try {
					cameraRecorder.resume();
				} catch (rollbackError) {
					rollbackFailed = true;
					console.error("Failed to restore camera recording", rollbackError);
				}
			}
			for (const audioSidecar of audioSidecars) {
				try {
					audioSidecar.resume();
				} catch (rollbackError) {
					rollbackFailed = true;
					console.error("Failed to restore audio recording", rollbackError);
				}
			}
			if (rollbackFailed) void stopRecordingRef.current?.();
			console.error("Failed to pause recording", error);
			toast.error("Could not pause recording.");
		}
	}, [phase, pauseTimer, updatePhase, mediaRecorderRef]);

	const resumeRecording = useCallback(() => {
		if (phase !== "paused") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "paused") return;

		const cameraRecorder = cameraMediaRecorderRef.current;
		const audioSidecars = audioSidecarsRef.current;
		let screenResumed = false;
		try {
			const timestamp = performance.now();
			recorder.resume();
			screenResumed = true;
			if (cameraRecorder?.state === "paused") {
				cameraRecorder.resume();
			}
			for (const audioSidecar of audioSidecars) audioSidecar.resume();
			resumeTimer(timestamp);
			if (isStreamingPipelineActive()) {
				startInstantChunkInterval();
			}
			updatePhase("recording");
		} catch (error) {
			let rollbackFailed = false;
			if (cameraRecorder?.state === "recording") {
				try {
					cameraRecorder.pause();
				} catch (rollbackError) {
					rollbackFailed = true;
					console.error("Failed to restore camera pause", rollbackError);
				}
			}
			if (screenResumed && readMediaRecorderState(recorder) === "recording") {
				try {
					recorder.pause();
				} catch (pauseError) {
					rollbackFailed = true;
					console.error("Failed to restore screen pause", pauseError);
				}
			}
			for (const audioSidecar of audioSidecars) {
				try {
					audioSidecar.pause();
				} catch (rollbackError) {
					rollbackFailed = true;
					console.error("Failed to restore audio pause", rollbackError);
				}
			}
			if (rollbackFailed) void stopRecordingRef.current?.();
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
		const orgId = organisationId;
		if (!recording || !pipeline || stopInFlightRef.current) return;
		stopInFlightRef.current = true;
		const generation = setupGenerationRef.current;
		setCanRetryUpload(false);
		const {
			durationSeconds,
			audioSidecars,
			pairedCameraCapture,
			cameraSettings,
		} = recording;
		const editorSidecarCapture =
			pairedCameraCapture || audioSidecars.length > 0;
		const width = dimensionsRef.current.width;
		const height = dimensionsRef.current.height;
		const fps = dimensionsRef.current.fps;
		const resolution = width && height ? `${width}x${height}` : undefined;
		const rawSubpath = `raw-upload.${pipeline.fileExtension}`;

		try {
			await uploadCancellationRef.current?.catch(() => {});
			if (generation !== setupGenerationRef.current) return;
			uploadCancellationRef.current = null;
			setUploadStatus({ status: "creating" });

			let creationResult = videoCreationRef.current;
			if (!creationResult) {
				if (!orgId) throw new Error("No organization selected");
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
			if (generation !== setupGenerationRef.current) return;
			const creation = creationResult;

			updatePhase("uploading");
			setCompletedShareUrl(creation.shareUrl);
			setUploadStatus({
				status: "uploadingVideo",
				capId: creation.id,
				progress: 0,
				thumbnailUrl: undefined,
			});

			// Without a live upload (it failed while recording, or an earlier
			// attempt aborted it) the screen goes up from its local backup,
			// which must hold the whole take.
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
				const uploadSession = await initiateMultipartUpload({
					videoId: creation.id,
					contentType: pipeline.mimeType,
					subpath: rawSubpath,
				});
				uploader = new InstantRecordingUploader({
					videoId: creation.id,
					uploadId: uploadSession.uploadId,
					provider: uploadSession.provider,
					mimeType: pipeline.mimeType,
					subpath: rawSubpath,
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
			const screenFinalBlob =
				recording.blob?.size === recording.totalBytes ? recording.blob : null;

			// Camera, mic and the screen's last chunk upload together; the screen
			// completes last because its completion starts processing and the
			// styled render.
			const finalizeCamera = async () => {
				if (recording.cameraUploaded) return;
				const cameraSubpath = cameraUploadSubpathRef.current;
				if (!cameraSubpath || cameraRecorderFailedRef.current) {
					throw new Error("Camera recording is unavailable for paired upload");
				}
				const cameraFinalize = {
					durationSeconds,
					width: cameraSettings?.width,
					height: cameraSettings?.height,
					fps:
						typeof cameraSettings?.frameRate === "number"
							? Math.round(cameraSettings.frameRate)
							: undefined,
					subpath: cameraSubpath,
				};
				let cameraUploader = cameraUploaderRef.current;
				if (cameraUploader) {
					if (recording.cameraRecordedBytes <= 0) {
						throw new Error(
							"Camera recording is unavailable for paired upload",
						);
					}
					await cameraUploader.finalize({ ...cameraFinalize, finalBlob: null });
				} else {
					const cameraBlob = await resolveCameraFailureBlob();
					const mimeType = cameraMimeTypeRef.current;
					if (!cameraBlob?.size || !mimeType) {
						throw new Error("The camera backup is incomplete.");
					}
					const cameraApi = cameraUploadApiRef.current ?? undefined;
					const session = await initiateMultipartUpload({
						videoId: creation.id,
						contentType: mimeType,
						subpath: cameraSubpath,
						api: cameraApi,
					});
					cameraUploader = new InstantRecordingUploader({
						videoId: creation.id,
						uploadId: session.uploadId,
						provider: session.provider,
						mimeType,
						subpath: cameraSubpath,
						setUploadStatus,
						sendProgressUpdate: (uploaded, total) =>
							sendProgressUpdate(creation.id, uploaded, total),
						api: cameraApi,
					});
					cameraUploaderRef.current = cameraUploader;
					await cameraUploader.finalize({
						...cameraFinalize,
						finalBlob: cameraBlob,
					});
				}
				cameraUploaderRef.current = null;
				recording.cameraUploaded = true;
			};
			const finalizeAudio = async (sidecar: AudioRecordingSidecar) => {
				if (sidecar.isUploadCompleted || recording.uploadedAudio.has(sidecar))
					return;
				if (!recording.audioLiveUploadsAborted) {
					await sidecar.finalize(durationSeconds);
					return;
				}
				const blob = await sidecar.recoverBlob();
				if (!blob) throw new Error("An audio backup is incomplete.");
				await uploadRecoveredAudioSidecar({
					videoId: creation.id,
					source: sidecar.metadata,
					blob,
					screenSubpath: rawSubpath,
					durationSeconds,
				});
				recording.uploadedAudio.add(sidecar);
			};
			const sidecarResults = await Promise.allSettled([
				pairedCameraCapture
					? finalizeCamera().catch((cameraUploadError) => {
							console.error(
								"Failed to upload camera recording",
								cameraUploadError,
							);
							throw cameraUploadError;
						})
					: Promise.resolve(),
				uploader.uploadRemaining(screenFinalBlob),
				...audioSidecars.map(finalizeAudio),
			]);
			const failedSidecar = sidecarResults.find(
				(result) => result.status === "rejected",
			);
			if (failedSidecar?.status === "rejected") throw failedSidecar.reason;
			if (generation !== setupGenerationRef.current) return;
			audioSidecarsRef.current = [];

			await uploader.finalize({
				finalBlob: screenFinalBlob,
				durationSeconds,
				width,
				height,
				fps,
				subpath: rawSubpath,
			});
			if (generation !== setupGenerationRef.current) return;

			if (!uploader.getProcessingStarted()) {
				toast.warning(
					"Recording uploaded. Processing did not start yet, but the original recording is available.",
				);
			}

			instantUploaderRef.current = null;
			cameraUploadApiRef.current = null;
			cameraUploadSubpathRef.current = null;
			cameraMimeTypeRef.current = null;
			cameraOffsetMsRef.current = 0;
			cameraRecorderBytesRef.current = 0;
			cameraRecorderFailedRef.current = false;
			cameraSettingsRef.current = undefined;
			recordingPipelineRef.current = null;
			pendingInstantVideoIdRef.current = null;
			stoppedRecordingRef.current = null;
			automaticUploadRetriesRef.current = 0;
			recordingSpoolRef.current?.markUploaded();
			degradedRecordingSpoolRef.current?.markUploaded();
			degradedRecordingSpoolRef.current = null;
			cameraSpoolRef.current?.markUploaded();
			for (const sidecar of audioSidecars) sidecar.markUploadedBackup();
			void Promise.all([
				disposeRecordingSpool(),
				disposeCameraSpool(),
				...audioSidecars.map((sidecar) =>
					sidecar.disposeBackup().catch((error) => {
						console.error("Failed to remove uploaded audio backup", error);
					}),
				),
			]);
			resetRecorder();
			replaceErrorDownload(null);
			replaceCameraErrorDownload(null);
			replaceAudioErrorDownloads([]);

			const studioRecording = studioEnabled && editorSidecarCapture;
			const videoPath = `/s/${encodeURIComponent(creation.id)}`;
			// The share link is already live, so the recording opens there. A
			// Studio recording's page publishes it in its default look when
			// nothing else is rendering it.
			const shareUrl = studioRecording
				? `${videoPath}?from=recording`
				: videoPath;
			// Everything is uploaded at this point, so a navigation failure must
			// not fall into the failure path below. It starts before the state
			// below re-renders the page, so the share page's request isn't
			// queued behind that work.
			try {
				router.push(shareUrl);
			} catch (navigationError) {
				console.error("Failed to open the share page", navigationError);
				window.location.assign(shareUrl);
			}
			setUploadStatus(undefined);
			setCompletedShareUrl(`${window.location.origin}${shareUrl}`);
			updatePhase("completed");
		} catch (err) {
			if (generation !== setupGenerationRef.current) return;
			console.error("Failed to upload recording", err);
			setUploadStatus(undefined);
			recording.blob = await resolveFailureBlob(recording.blob);
			if (generation !== setupGenerationRef.current) return;
			const cameraFailureBlob = pairedCameraCapture
				? await resolveCameraFailureBlob()
				: null;
			const audioFailureSources = await Promise.all(
				audioSidecars.map(async (sidecar) => ({
					kind: sidecar.metadata.kind,
					blob: await sidecar.recoverBlob(),
				})),
			);
			if (generation !== setupGenerationRef.current) return;
			recording.completionUncertain =
				err instanceof MultipartCompletionUncertainError;
			// An uncertain completion keeps its upload so a retry checks the same
			// one; anything else is aborted and a retry sends the backups.
			if (!recording.completionUncertain) {
				const cancellations: Promise<unknown>[] = [];
				const screenUploader = instantUploaderRef.current;
				instantUploaderRef.current = null;
				if (screenUploader) cancellations.push(screenUploader.cancel());
				const cameraUploader = cameraUploaderRef.current;
				cameraUploaderRef.current = null;
				if (cameraUploader) cancellations.push(cameraUploader.cancel());
				for (const sidecar of audioSidecars) {
					if (sidecar.isUploadCompleted) continue;
					cancellations.push(sidecar.abortUploadRetainSpool());
				}
				if (audioSidecars.length > 0) recording.audioLiveUploadsAborted = true;
				uploadCancellationRef.current = Promise.allSettled(cancellations);
			}
			replaceErrorDownload(recording.blob);
			replaceCameraErrorDownload(cameraFailureBlob);
			replaceAudioErrorDownloads(audioFailureSources);
			setCanRetryUpload(true);
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
		organisationId,
		hasAudioTrack,
		updatePhase,
		setUploadStatus,
		videoInstantCreate,
		router,
		studioEnabled,
		replaceErrorDownload,
		resolveFailureBlob,
		resolveCameraFailureBlob,
		disposeRecordingSpool,
		disposeCameraSpool,
		replaceCameraErrorDownload,
		replaceAudioErrorDownloads,
		resetRecorder,
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
		replaceErrorDownload(null);
		const timestamp = performance.now();
		commitPausedDuration(timestamp);
		const audioSidecars = [...audioSidecarsRef.current];
		const pairedCameraCapture = cameraUploadApiRef.current !== null;
		const recording: StoppedRecording = {
			blob: null,
			totalBytes: 0,
			durationSeconds: Math.max(
				1,
				Math.round(syncDurationFromClock(timestamp) / 1000),
			),
			captureFailed: false,
			completionUncertain: false,
			pairedCameraCapture,
			cameraRecordedBytes: 0,
			cameraSettings: cameraSettingsRef.current,
			audioSidecars,
			audioLiveUploadsAborted: false,
			uploadedAudio: new Set(),
			cameraUploaded: false,
		};
		stoppedRecordingRef.current = recording;

		// Every recorder is told to stop before anything is awaited, so they
		// finish their last chunks together while the UI updates.
		const cameraStopped = cameraMediaRecorderRef.current
			? stopCameraRecorder().then(
					(bytes) => {
						recording.cameraRecordedBytes = bytes;
					},
					(cameraError) => {
						cameraRecorderFailedRef.current = true;
						console.warn("Failed to stop camera recording", cameraError);
					},
				)
			: Promise.resolve();
		const audioStopped = Promise.allSettled(
			audioSidecars.map((sidecar) => sidecar.stop()),
		);
		const screenStopped = stopRecordingInternalWrapper();
		onRecordingStop?.();
		updatePhase("creating");
		setCompletedShareUrl(videoCreationRef.current?.shareUrl ?? null);

		try {
			await Promise.allSettled([screenStopped, cameraStopped, audioStopped]);
			recording.blob = await screenStopped;
			if (generation !== setupGenerationRef.current) return;
			setRecordedBytes(totalRecordedBytesRef.current);
			const failedAudioStop = (await audioStopped).find(
				(result) => result.status === "rejected",
			);
			if (failedAudioStop?.status === "rejected") {
				throw failedAudioStop.reason;
			}
			if (pairedCameraCapture) {
				let cameraFlushTimeoutId: number | null = null;
				try {
					const cameraSpool = cameraSpoolRef.current;
					if (cameraSpool) {
						await Promise.race([
							cameraSpool.flush(),
							new Promise<never>((_, reject) => {
								cameraFlushTimeoutId = window.setTimeout(
									() => reject(new Error("Camera backup write timed out")),
									CAMERA_BACKUP_TIMEOUT_MS,
								);
							}),
						]);
					}
				} catch (error) {
					switchCameraBackupToMemory(error);
				} finally {
					if (cameraFlushTimeoutId !== null) {
						window.clearTimeout(cameraFlushTimeoutId);
					}
				}
				if (cameraRecorderFailedRef.current) {
					throw new Error(
						"Camera recording ended before both clips were saved",
					);
				}
			}
		} catch (error) {
			if (generation !== setupGenerationRef.current) return;
			console.error("Browser failed to finish recording", error);
			recording.captureFailed = true;
			recording.blob = await resolveFailureBlob(recording.blob);
			if (generation !== setupGenerationRef.current) return;
			const cameraFailureBlob = pairedCameraCapture
				? await resolveCameraFailureBlob()
				: null;
			const audioFailureSources = await Promise.all(
				audioSidecars.map(async (sidecar) => ({
					kind: sidecar.metadata.kind,
					blob: await sidecar.recoverBlob(),
				})),
			);
			if (generation !== setupGenerationRef.current) return;
			replaceErrorDownload(recording.blob);
			replaceCameraErrorDownload(cameraFailureBlob);
			replaceAudioErrorDownloads(audioFailureSources);
			// A paired take whose camera clip broke can't be published whole.
			setCanRetryUpload(
				Boolean(recording.blob?.size) && !cameraRecorderFailedRef.current,
			);
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
		replaceErrorDownload,
		commitPausedDuration,
		syncDurationFromClock,
		stopCameraRecorder,
		stopRecordingInternalWrapper,
		onRecordingStop,
		updatePhase,
		switchCameraBackupToMemory,
		resolveFailureBlob,
		resolveCameraFailureBlob,
		replaceCameraErrorDownload,
		replaceAudioErrorDownloads,
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

		// The new take records the screen that's already shared. Asking again
		// would open the browser's picker after the old take is gone, where
		// cancelling (or Chrome refusing a click that's a few seconds old)
		// leaves nothing recording. Clones outlive the teardown below.
		const display = displayStreamRef.current;
		restartDisplayStreamRef.current = display
			?.getVideoTracks()
			.some((track) => track.readyState === "live")
			? new MediaStream(display.getTracks().map((track) => track.clone()))
			: null;

		try {
			try {
				await stopCameraRecorder();
			} catch (error) {
				console.warn("Failed to stop camera recorder before restart", error);
			}
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
			for (const track of restartDisplayStreamRef.current?.getTracks() ?? []) {
				track.stop();
			}
			restartDisplayStreamRef.current = null;
			setIsRestarting(false);
		}
	}, [
		displayStreamRef,
		cleanupRecordingState,
		isRestarting,
		phase,
		stopCameraRecorder,
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
		cameraErrorDownload,
		audioErrorDownloads,
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
		getActiveCameraStream: () => cameraStreamRef.current,
		getActiveDisplayStream: () => displayStreamRef.current,
		recordedBytes,
	};
};
