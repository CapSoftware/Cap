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
	InstantMp4Uploader,
	initiateMultipartUpload,
} from "./instant-mp4-uploader";
import type { RecordingMode } from "./RecordingModeSelector";
import { captureThumbnail } from "./recording-conversion";
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
} from "./web-recorder-constants";
import type {
	ChunkUploadState,
	RecorderPhase,
	RecordingFailureDownload,
	VideoId,
} from "./web-recorder-types";
import {
	detectCapabilities,
	pickSupportedMimeType,
	type RecorderCapabilities,
	shouldRetryDisplayMediaWithoutPreferences,
} from "./web-recorder-utils";

interface UseStudioRecorderOptions {
	organisationId: string | undefined;
	selectedMicId: string | null;
	micEnabled: boolean;
	recordingMode: RecordingMode;
	selectedCameraId: string | null;
	isProUser: boolean;
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

export const useStudioRecorder = ({
	organisationId,
	selectedMicId,
	micEnabled,
	recordingMode,
	selectedCameraId,
	isProUser,
	onRecordingSurfaceDetected,
	onRecordingStart,
	onRecordingStop,
}: UseStudioRecorderOptions) => {
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
	const supportsDisplayRecording = supportCheckCompleted
		? rawCanRecordDisplay
		: true;
	const supportsMp4Recording = supportCheckCompleted
		? capabilities.hasMp4MediaRecorder
		: true;
	const isBrowserSupported =
		supportsDisplayRecording && rawCanRecordCamera && supportsMp4Recording;
	const screenCaptureWarning =
		supportCheckCompleted && rawCanRecordCamera && !capabilities.hasDisplayMedia
			? "Screen sharing isn't supported in this browser. Studio mode requires screen capture."
			: supportCheckCompleted &&
					rawCanRecordCamera &&
					capabilities.hasDisplayMedia &&
					!capabilities.hasMp4MediaRecorder
				? "Studio mode requires MP4 recording which isn't supported in this browser. Try Chrome, Edge, or Safari."
				: null;
	const unsupportedReason = supportCheckCompleted
		? !capabilities.hasMediaRecorder
			? "This browser doesn't support in-browser recording."
			: !capabilities.hasUserMedia
				? "Camera and microphone access are unavailable."
				: !capabilities.hasDisplayMedia
					? "Screen capture isn't supported in this browser."
					: !capabilities.hasMp4MediaRecorder
						? "Studio mode requires MP4 recording which isn't available in this browser. Try Chrome, Edge, or Safari."
						: null
		: null;

	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const displayRecorderRef = useRef<MediaRecorder | null>(null);
	const cameraRecorderRef = useRef<MediaRecorder | null>(null);
	const displayChunksRef = useRef<Blob[]>([]);
	const cameraChunksRef = useRef<Blob[]>([]);
	const displayTotalBytesRef = useRef(0);
	const cameraTotalBytesRef = useRef(0);
	const instantUploaderRef = useRef<InstantMp4Uploader | null>(null);
	const videoCreationRef = useRef<{
		id: VideoId;
		shareUrl: string;
	} | null>(null);
	const pendingVideoIdRef = useRef<VideoId | null>(null);
	const dataRequestIntervalRef = useRef<number | null>(null);
	const instantChunkModeRef = useRef<InstantChunkingMode | null>(null);
	const lastInstantChunkAtRef = useRef<number | null>(null);
	const chunkStartGuardTimeoutRef = useRef<number | null>(null);
	const freePlanAutoStopTriggeredRef = useRef(false);
	const errorDownloadUrlRef = useRef<string | null>(null);
	const studioCameraStreamRef = useRef<MediaStream | null>(null);
	const isStoppingRef = useRef(false);
	const stopRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

	const rpc = useRpcClient();
	type RpcClient = typeof rpc;
	type VideoStudioCreateVariables = Parameters<
		RpcClient["VideoStudioCreate"]
	>[0];
	const router = useRouter();
	const queryClient = useQueryClient();
	const { setUploadStatus } = useUploadingContext();

	const deleteVideo = useEffectMutation({
		mutationFn: (id: VideoId) => rpc.VideoDelete(id),
	});
	const videoStudioCreate = useEffectMutation({
		mutationFn: (variables: VideoStudioCreateVariables) =>
			rpc.VideoStudioCreate(variables),
	});

	const isFreePlan = !isProUser;

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
		const url = URL.createObjectURL(blob);
		errorDownloadUrlRef.current = url;
		setErrorDownload({
			url,
			fileName: `cap-studio-recording-${timestamp}.mp4`,
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

	const requestInstantRecorderData = useCallback(() => {
		if (instantChunkModeRef.current !== "manual") return;
		const recorder = displayRecorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
		try {
			recorder.requestData();
		} catch (error) {
			console.warn("Failed to request recorder data", error);
		}
	}, []);

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
		window.clearTimeout(chunkStartGuardTimeoutRef.current);
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

	const updatePhase = useCallback((newPhase: RecorderPhase) => {
		setPhase(newPhase);
	}, []);

	const cleanupRecordingState = useCallback(() => {
		cleanupStreams();
		if (studioCameraStreamRef.current) {
			studioCameraStreamRef.current.getTracks().forEach((t) => {
				t.stop();
			});
			studioCameraStreamRef.current = null;
		}
		clearTimer();
		resetTimer();
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		displayRecorderRef.current = null;
		cameraRecorderRef.current = null;
		displayChunksRef.current = [];
		cameraChunksRef.current = [];
		displayTotalBytesRef.current = 0;
		cameraTotalBytesRef.current = 0;
		isStoppingRef.current = false;
		if (instantUploaderRef.current) {
			void instantUploaderRef.current.cancel();
		}
		instantUploaderRef.current = null;
		setUploadStatus(undefined);
		setChunkUploads([]);
		setHasAudioTrack(false);
		replaceErrorDownload(null);

		const pendingId = pendingVideoIdRef.current;
		pendingVideoIdRef.current = null;
		videoCreationRef.current = null;
		setVideoId(null);
		if (pendingId) {
			void deleteVideo.mutateAsync(pendingId);
		}
	}, [
		cleanupStreams,
		clearTimer,
		resetTimer,
		stopInstantChunkInterval,
		clearInstantChunkGuard,
		deleteVideo,
		setUploadStatus,
		replaceErrorDownload,
	]);

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

	const startRecording = async () => {
		if (!organisationId) {
			toast.error("Select an organization before recording.");
			return;
		}

		if (!selectedCameraId) {
			toast.error("Camera is required for Studio Mode.");
			return;
		}

		if (!isBrowserSupported) {
			toast.error(
				unsupportedReason ?? "Recording isn't supported in this browser.",
			);
			return;
		}

		replaceErrorDownload(null);
		setChunkUploads([]);
		setIsSettingUp(true);

		try {
			const desiredSurface =
				recordingMode !== "camera"
					? RECORDING_MODE_TO_DISPLAY_SURFACE[
							recordingMode as DetectedDisplayRecordingMode
						]
					: ("monitor" as DisplaySurfacePreference);
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

			const preferredOptions =
				recordingMode !== "camera"
					? DISPLAY_MODE_PREFERENCES[
							recordingMode as DetectedDisplayRecordingMode
						]
					: DISPLAY_MODE_PREFERENCES.fullscreen;

			let displayStream: MediaStream | null = null;
			if (preferredOptions) {
				try {
					displayStream = await navigator.mediaDevices.getDisplayMedia({
						...baseDisplayRequest,
						...preferredOptions,
						video: videoConstraints,
					});
				} catch (displayError) {
					if (shouldRetryDisplayMediaWithoutPreferences(displayError)) {
						displayStream =
							await navigator.mediaDevices.getDisplayMedia(baseDisplayRequest);
					} else {
						throw displayError;
					}
				}
			}
			if (!displayStream) {
				displayStream =
					await navigator.mediaDevices.getDisplayMedia(baseDisplayRequest);
			}
			displayStreamRef.current = displayStream;
			const displayTrack = displayStream.getVideoTracks()[0] ?? null;
			const displaySettings = displayTrack?.getSettings();

			if (recordingMode !== "camera") {
				scheduleSurfaceDetection(displayTrack, displaySettings);
			}

			dimensionsRef.current = {
				width: displaySettings?.width || undefined,
				height: displaySettings?.height || undefined,
			};

			let cameraStream: MediaStream;
			try {
				cameraStream = await navigator.mediaDevices.getUserMedia({
					video: {
						deviceId: { exact: selectedCameraId },
						frameRate: { ideal: 30 },
						width: { ideal: 1280 },
						height: { ideal: 720 },
					},
				});
			} catch (camError) {
				console.error("Camera acquisition failed", camError);
				toast.error(
					"Could not access camera. Please check permissions and try again.",
				);
				displayStream.getTracks().forEach((t) => {
					t.stop();
				});
				setIsSettingUp(false);
				return;
			}
			studioCameraStreamRef.current = cameraStream;
			cameraStreamRef.current = cameraStream;

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
				}
			}
			if (micStream) {
				micStreamRef.current = micStream;
			}

			const displayMixedStream = new MediaStream([
				...displayStream.getVideoTracks(),
				...(micStream ? micStream.getAudioTracks() : []),
			]);
			mixedStreamRef.current = displayMixedStream;
			const hasAudio = displayMixedStream.getAudioTracks().length > 0;
			setHasAudioTrack(hasAudio);

			const mp4Candidates = hasAudio
				? [...MP4_MIME_TYPES.withAudio, ...MP4_MIME_TYPES.videoOnly]
				: [...MP4_MIME_TYPES.videoOnly, ...MP4_MIME_TYPES.withAudio];
			const supportedMp4MimeType = pickSupportedMimeType(mp4Candidates);
			if (!supportedMp4MimeType) {
				throw new Error(
					"Browser does not support MP4 recording required for Studio Mode.",
				);
			}

			const camVideoOnlyMime = pickSupportedMimeType(MP4_MIME_TYPES.videoOnly);
			if (!camVideoOnlyMime) {
				throw new Error("Browser does not support MP4 recording for camera.");
			}

			const width = dimensionsRef.current.width;
			const height = dimensionsRef.current.height;
			const resolution = width && height ? `${width}x${height}` : undefined;
			const camSettings = cameraStream.getVideoTracks()[0]?.getSettings();

			const creation = unwrapExitOrThrow(
				await videoStudioCreate.mutateAsync({
					orgId: Organisation.OrganisationId.make(organisationId),
					folderId: Option.none(),
					resolution,
					width,
					height,
					cameraWidth: camSettings?.width,
					cameraHeight: camSettings?.height,
					videoCodec: "h264",
					audioCodec: hasAudio ? "aac" : undefined,
					supportsUploadProgress: true,
				}),
			);

			const creationResult = {
				id: creation.id,
				shareUrl: creation.shareUrl,
			};
			videoCreationRef.current = creationResult;
			setVideoId(creation.id);
			pendingVideoIdRef.current = creation.id;

			let displayUploadId: string;
			try {
				displayUploadId = await initiateMultipartUpload(
					creation.id,
					"display.mp4",
				);
			} catch (initError) {
				await deleteVideo.mutateAsync(creation.id);
				pendingVideoIdRef.current = null;
				videoCreationRef.current = null;
				throw initError;
			}

			instantUploaderRef.current = new InstantMp4Uploader({
				videoId: creation.id,
				uploadId: displayUploadId,
				mimeType: supportedMp4MimeType,
				subpath: "display.mp4",
				setUploadStatus,
				sendProgressUpdate: (uploaded, total) =>
					sendProgressUpdate(creation.id, uploaded, total),
				onChunkStateChange: setChunkUploads,
			});

			displayChunksRef.current = [];
			cameraChunksRef.current = [];
			displayTotalBytesRef.current = 0;
			cameraTotalBytesRef.current = 0;

			const displayRecorder = new MediaRecorder(displayMixedStream, {
				mimeType: supportedMp4MimeType,
			});
			displayRecorder.ondataavailable = (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					displayChunksRef.current.push(event.data);
					displayTotalBytesRef.current += event.data.size;
					lastInstantChunkAtRef.current =
						typeof performance !== "undefined" ? performance.now() : Date.now();
					if (instantChunkModeRef.current === "timeslice") {
						clearInstantChunkGuard();
					}
					instantUploaderRef.current?.handleChunk(
						event.data,
						displayTotalBytesRef.current,
					);
				}
			};
			displayRecorder.onstop = () => {};
			displayRecorder.onerror = () => {};
			displayRecorderRef.current = displayRecorder;

			const cameraRecorder = new MediaRecorder(
				new MediaStream(cameraStream.getVideoTracks()),
				{ mimeType: camVideoOnlyMime },
			);
			cameraRecorder.ondataavailable = (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					cameraChunksRef.current.push(event.data);
					cameraTotalBytesRef.current += event.data.size;
				}
			};
			cameraRecorder.onstop = () => {};
			cameraRecorder.onerror = () => {};
			cameraRecorderRef.current = cameraRecorder;

			const handleDisplayEnded = () => {
				stopRecordingRef.current().catch(() => {});
			};
			displayTrack?.addEventListener("ended", handleDisplayEnded, {
				once: true,
			});

			instantChunkModeRef.current = null;
			lastInstantChunkAtRef.current = null;
			clearInstantChunkGuard();
			stopInstantChunkInterval();

			let startedWithTimeslice = false;
			try {
				displayRecorder.start(INSTANT_UPLOAD_REQUEST_INTERVAL_MS);
				instantChunkModeRef.current = "timeslice";
				startedWithTimeslice = true;
			} catch {
				console.warn(
					"Failed to start display recorder with timeslice; falling back to manual",
				);
			}

			if (startedWithTimeslice) {
				scheduleInstantChunkGuard();
			} else {
				displayRecorder.start();
				beginManualInstantChunking();
			}

			cameraRecorder.start(200);
			onRecordingStart?.();
			startTimer();
			updatePhase("recording");
		} catch (err) {
			const orphanId = videoCreationRef.current?.id;
			if (orphanId) {
				instantUploaderRef.current = null;
				videoCreationRef.current = null;
				pendingVideoIdRef.current = null;
				await deleteVideo.mutateAsync(orphanId);
			}
			console.error("Failed to start studio recording", err);
			toast.error("Could not start recording.");
			resetState();
		} finally {
			setIsSettingUp(false);
		}
	};

	const pauseRecording = useCallback(() => {
		if (phase !== "recording") return;
		const display = displayRecorderRef.current;
		const camera = cameraRecorderRef.current;
		if (!display || display.state !== "recording") return;

		try {
			const timestamp = performance.now();
			display.pause();
			if (camera && camera.state === "recording") camera.pause();
			pauseTimer(timestamp);
			updatePhase("paused");
		} catch (error) {
			console.error("Failed to pause recording", error);
			toast.error("Could not pause recording.");
		}
	}, [phase, pauseTimer, updatePhase]);

	const resumeRecording = useCallback(() => {
		if (phase !== "paused") return;
		const display = displayRecorderRef.current;
		const camera = cameraRecorderRef.current;
		if (!display || display.state !== "paused") return;

		try {
			const timestamp = performance.now();
			resumeTimer(timestamp);
			display.resume();
			if (camera && camera.state === "paused") camera.resume();
			startInstantChunkInterval();
			updatePhase("recording");
		} catch (error) {
			console.error("Failed to resume recording", error);
			toast.error("Could not resume recording.");
		}
	}, [phase, resumeTimer, updatePhase, startInstantChunkInterval]);

	const stopRecording = useCallback(async () => {
		stopInstantChunkInterval();
		clearInstantChunkGuard();
		instantChunkModeRef.current = null;
		lastInstantChunkAtRef.current = null;
		replaceErrorDownload(null);

		if (phase !== "recording" && phase !== "paused") return;
		if (isStoppingRef.current) return;
		isStoppingRef.current = true;

		const orgId = organisationId;
		if (!orgId) {
			updatePhase("error");
			isStoppingRef.current = false;
			return;
		}

		const timestamp = performance.now();
		commitPausedDuration(timestamp);
		const recordedDurationMs = syncDurationFromClock(timestamp);
		const durationSeconds = Math.max(1, Math.round(recordedDurationMs / 1000));
		const width = dimensionsRef.current.width;
		const height = dimensionsRef.current.height;

		const creationResult = videoCreationRef.current;
		if (!creationResult) {
			updatePhase("error");
			isStoppingRef.current = false;
			return;
		}

		let displayBlob: Blob | null = null;
		let cameraBlob: Blob | null = null;

		try {
			onRecordingStop?.();
			updatePhase("creating");

			const stopMediaRecorder = (recorder: MediaRecorder | null) =>
				new Promise<void>((resolve) => {
					if (!recorder || recorder.state === "inactive") {
						resolve();
						return;
					}
					const origOnStop = recorder.onstop;
					recorder.onstop = (e) => {
						if (typeof origOnStop === "function") origOnStop.call(recorder, e);
						resolve();
					};
					recorder.stop();
				});

			await Promise.all([
				stopMediaRecorder(displayRecorderRef.current),
				stopMediaRecorder(cameraRecorderRef.current),
			]);

			cleanupStreams();
			if (studioCameraStreamRef.current) {
				studioCameraStreamRef.current.getTracks().forEach((t) => {
					t.stop();
				});
				studioCameraStreamRef.current = null;
			}
			clearTimer();

			if (displayChunksRef.current.length > 0) {
				displayBlob = new Blob(displayChunksRef.current, {
					type: "video/mp4",
				});
			}
			if (cameraChunksRef.current.length > 0) {
				cameraBlob = new Blob(cameraChunksRef.current, {
					type: "video/mp4",
				});
			}

			if (!displayBlob) throw new Error("No display recording available");
			if (!cameraBlob) throw new Error("No camera recording available");

			setUploadStatus({ status: "creating" });

			updatePhase("uploading");
			setUploadStatus({
				status: "uploadingVideo",
				capId: creationResult.id,
				progress: 0,
				thumbnailUrl: undefined,
			});

			const instantUploader = instantUploaderRef.current;
			if (instantUploader) {
				instantUploader.setThumbnailUrl(undefined);
				await instantUploader.finalize({
					finalBlob: displayBlob,
					durationSeconds,
					width,
					height,
				});
				instantUploaderRef.current = null;
			}

			let cameraUploadId: string;
			try {
				cameraUploadId = await initiateMultipartUpload(
					creationResult.id,
					"camera.mp4",
				);
			} catch (initError) {
				throw new Error(
					`Failed to initiate camera upload: ${initError instanceof Error ? initError.message : String(initError)}`,
				);
			}

			const cameraUploader = new InstantMp4Uploader({
				videoId: creationResult.id,
				uploadId: cameraUploadId,
				mimeType: "video/mp4",
				subpath: "camera.mp4",
				setUploadStatus: () => {},
				sendProgressUpdate: async () => {},
			});
			cameraUploader.handleChunk(cameraBlob, cameraBlob.size);
			await cameraUploader.finalize({
				finalBlob: cameraBlob,
				durationSeconds,
			});

			let thumbnailBlob: Blob | null = null;
			let thumbnailPreviewUrl: string | undefined;
			try {
				thumbnailBlob = await captureThumbnail(
					displayBlob,
					dimensionsRef.current,
				);
				thumbnailPreviewUrl = thumbnailBlob
					? URL.createObjectURL(thumbnailBlob)
					: undefined;
			} catch {
				console.warn("Failed to capture thumbnail");
			}

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

					await new Promise<void>((resolve, reject) => {
						const xhr = new XMLHttpRequest();
						xhr.open("POST", screenshotData.presignedPostData.url);
						xhr.onload = () => {
							if (xhr.status >= 200 && xhr.status < 300) resolve();
							else reject(new Error(`Thumbnail upload failed: ${xhr.status}`));
						};
						xhr.onerror = () => reject(new Error("Thumbnail upload failed"));
						xhr.send(screenshotFormData);
					});

					queryClient.refetchQueries({
						queryKey: ThumbnailRequest.queryKey(creationResult.id),
					});
				} catch (thumbErr) {
					console.error("Failed to upload thumbnail", thumbErr);
				}
			}

			if (thumbnailPreviewUrl) {
				URL.revokeObjectURL(thumbnailPreviewUrl);
			}

			pendingVideoIdRef.current = null;
			setUploadStatus(undefined);
			updatePhase("completed");
			toast.success("Studio recording uploaded! Opening editor...");
			router.push(`/editor/${creationResult.id}`);
			router.refresh();
		} catch (err) {
			console.error("Failed to process studio recording", err);
			setUploadStatus(undefined);
			updatePhase("error");
			replaceErrorDownload(displayBlob);

			const idToDelete = creationResult?.id ?? videoId;
			if (idToDelete) {
				await deleteVideo.mutateAsync(idToDelete);
				if (pendingVideoIdRef.current === idToDelete) {
					pendingVideoIdRef.current = null;
				}
			}
		} finally {
			isStoppingRef.current = false;
		}
	}, [
		stopInstantChunkInterval,
		clearInstantChunkGuard,
		phase,
		organisationId,
		videoId,
		updatePhase,
		setUploadStatus,
		deleteVideo,
		router,
		queryClient,
		onRecordingStop,
		commitPausedDuration,
		syncDurationFromClock,
		cleanupStreams,
		clearTimer,
		replaceErrorDownload,
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
			const stopMediaRecorder = (recorder: MediaRecorder | null) => {
				if (!recorder || recorder.state === "inactive") return;
				try {
					recorder.stop();
				} catch {}
			};
			stopMediaRecorder(displayRecorderRef.current);
			stopMediaRecorder(cameraRecorderRef.current);
			cleanupRecordingState();
			updatePhase("idle");
		} catch (error) {
			console.error("Failed to restart recording", error);
			toast.error("Could not restart recording. Please try again.");
			cleanupRecordingState();
			updatePhase("idle");
		} finally {
			setIsRestarting(false);
		}
	}, [cleanupRecordingState, isRestarting, phase, updatePhase]);

	const canStartRecording =
		Boolean(organisationId) &&
		Boolean(selectedCameraId) &&
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
