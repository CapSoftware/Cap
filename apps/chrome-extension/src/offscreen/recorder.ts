import {
	appendLocalRecordingChunk,
	type ChunkUploadState,
	DEFAULT_API_REQUEST_TIMEOUT_MS,
	DISPLAY_MEDIA_IDEAL,
	deleteRecoveredRecordingSpool,
	describeRecordingCodecs,
	detectRecordingModeFromTrack,
	InstantRecordingUploader,
	initialLocalRecordingState,
	initiateMultipartUpload,
	isUserCancellationError,
	type LocalRecordingState,
	listRecordingSpoolSessions,
	MultipartCompletionUncertainError,
	RECORDING_SPOOL_LIVE_MIN_IDLE_MS,
	RecordingSpool,
	recoverRecordingSpoolSession,
	selectRecordingPipeline,
	type VideoId,
} from "@cap/recorder-core";

import {
	createInstantRecording,
	deleteInstantRecording,
	updateUploadProgress,
} from "../shared/api";
import { toCameraDevices, toMicrophoneDevices } from "../shared/devices";
import { isOffscreenRequest } from "../shared/messages";
import {
	loadAuth,
	loadFailedRecordings,
	loadLiveRecordingManifests,
	loadSettings,
	pruneLiveRecordingManifests,
	removeFailedRecording,
	removeLiveRecordingManifest,
	saveFailedRecordings,
	saveLiveRecordingManifest,
	upsertFailedRecording,
} from "../shared/storage";
import type {
	ConnectCameraPreviewRequest,
	ExtensionSettings,
	MediaPermissionSnapshot,
	MediaPermissionState,
	MicrophoneProbeResult,
	MicrophoneSettings,
	OffscreenRequest,
	OffscreenResponse,
	RecordingCaptureSource,
	RecordingMode,
	RecordingStatus,
	RecordingStatusBroadcast,
	ServiceWorkerRequest,
	StartRecordingRequest,
	UploadSummary,
	WebcamSettings,
} from "../shared/types";
import {
	DEFAULT_CAMERA_DEVICE_ID,
	DEFAULT_MICROPHONE_DEVICE_ID,
} from "../shared/types";
import {
	toSessionDescriptionInit,
	waitForIceGatheringComplete,
} from "../shared/webrtc";
import { captureDisplayStream } from "./display-capture";

const RECORDING_TIMESLICE_MS = 1000;
const RECORDING_TIMESLICE_GUARD_MS = RECORDING_TIMESLICE_MS * 3;
const DEFAULT_WIDTH = DISPLAY_MEDIA_IDEAL.width;
const DEFAULT_HEIGHT = DISPLAY_MEDIA_IDEAL.height;
const DEFAULT_FPS = DISPLAY_MEDIA_IDEAL.frameRate;
// Upload progress reaches the upload page (and the session-storage mirror)
// through broadcasts; throttle them so chunk-level callbacks do not flood
// every open tab with messages.
const PROGRESS_BROADCAST_INTERVAL_MS = 500;
// Recordings stranded by a crash or abandoned after a failed upload are kept
// recoverable for this long before the spool sweep reclaims the space.
const ORPHAN_SPOOL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Cap on the in-memory continuation kept after a spool write failure. An
// offscreen document cannot page memory out, so an unbounded backup would pin
// the rest of an hour-long session in RAM (risking an OOM that also kills the
// healthy streaming upload). Overflow drops the local copy entirely — a
// truncated backup cannot be retried — while the upload continues untouched.
const MEMORY_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
const UNCERTAIN_COMPLETION_MESSAGE =
	"Upload confirmation was interrupted. Open the video to verify it processed before retrying.";

type ChunkingMode = "manual" | "timeslice";
type RecordingSound = "start-recording" | "stop-recording";

type ActiveRecording = {
	recorder: MediaRecorder;
	stopPromise: Promise<void>;
	streams: MediaStream[];
	recordingStream: MediaStream;
	statusTimer: number | null;
	spool: RecordingSpool;
	uploader: InstantRecordingUploader;
	startedAt: number;
	durationMs: number;
	lastResumedAt: number | null;
	videoId: VideoId;
	shareUrl: string;
	width: number;
	height: number;
	fps: number;
	subpath: string;
	mimeType: string;
	maxDurationMs: number | null;
	audioContext?: AudioContext;
	chunkChain: Promise<void>;
	dataRequestInterval: number | null;
	chunkStartGuard: number | null;
	chunkingMode: ChunkingMode | null;
	lastChunkAt: number | null;
	recordedBytes: number;
	finalizePromise: Promise<RecordingStatus> | null;
	cleanedUp: boolean;
	// A spool write failure (IndexedDB quota, backpressure) must not end an
	// otherwise healthy session: the local copy degrades to capped memory
	// (mirrors the dashboard recorder's in-memory fallback) while the
	// streaming upload continues untouched.
	spoolFailed: boolean;
	memoryBackup: LocalRecordingState;
};

let activeRecording: ActiveRecording | null = null;
let status: RecordingStatus = { phase: "idle" };
// Set synchronously when a start request is accepted so two near-simultaneous
// starts cannot both pass the activeRecording check (which is only assigned
// after several awaits).
let startInProgress = false;
// Lets a stop request abort a start that is still in the "creating" phase
// (capture picker open, server round-trips pending).
let startCancelRequested = false;
// True only while the pre-roll countdown is running (capture is fully set up
// but no frame has been recorded yet). A stop request during this window is a
// cancellation, not a real recording stop.
let countdownInProgress = false;
// Resolves the in-progress countdown wait early so a cancel takes effect
// immediately instead of after the full countdown elapses.
let countdownResolve: (() => void) | null = null;
// Mirrors startInProgress for retries: a retry upload must not run while a
// recording starts (or vice versa), or its terminal status write would
// clobber the live session's state machine.
let retryInProgress = false;
let lastProgressBroadcastAt = 0;
let cameraPreviewStream: MediaStream | null = null;
let cameraPreviewDeviceId: string | null = null;
const cameraPreviewSessions = new Map<string, RTCPeerConnection>();
const activeRecordingSounds = new Set<HTMLAudioElement>();

const playRecordingSound = (
	sound: RecordingSound,
	settings: ExtensionSettings,
) => {
	if (!settings.sounds.enabled) return;
	const audio = new Audio(chrome.runtime.getURL(`sounds/${sound}.ogg`));
	const releaseAudio = () => {
		activeRecordingSounds.delete(audio);
	};
	activeRecordingSounds.add(audio);
	audio.addEventListener("ended", releaseAudio, { once: true });
	audio.addEventListener("error", releaseAudio, { once: true });
	void audio.play().catch(releaseAudio);
};

const broadcastStatus = () => {
	chrome.runtime.sendMessage(
		{
			target: "recording-status",
			type: "recording-status-changed",
			status,
		} satisfies RecordingStatusBroadcast,
		() => {
			void chrome.runtime.lastError;
		},
	);
};

const broadcastProgressThrottled = () => {
	const now = Date.now();
	if (now - lastProgressBroadcastAt < PROGRESS_BROADCAST_INTERVAL_MS) return;
	lastProgressBroadcastAt = now;
	broadcastStatus();
};

const summarizeChunks = (chunks: ChunkUploadState[]): UploadSummary => {
	let totalBytes = 0;
	let uploadedBytes = 0;
	let completedChunks = 0;
	let failedChunks = 0;
	for (const chunk of chunks) {
		totalBytes += chunk.sizeBytes;
		uploadedBytes += chunk.uploadedBytes;
		if (chunk.status === "complete") completedChunks += 1;
		if (chunk.status === "error") failedChunks += 1;
	}
	return {
		totalBytes,
		uploadedBytes,
		totalChunks: chunks.length,
		completedChunks,
		failedChunks,
	};
};

const throwIfStartCanceled = () => {
	if (startCancelRequested) {
		throw new DOMException("Recording start was canceled", "AbortError");
	}
};

// Plays the pre-roll countdown on the recorded/active tab and waits for it to
// run its course before the caller starts the MediaRecorder. The animation
// lives in the page overlay; this side only owns the timing, so the recording
// begins the instant the countdown ends and the count never lands in the
// captured frames. A stop request resolves the wait early via
// `countdownResolve` so cancelling does not block for the full duration.
const runStartCountdown = async (request: StartRecordingRequest) => {
	const { enabled, seconds } = request.settings.countdown;
	if (!enabled || seconds <= 0) return;
	const durationMs = seconds * 1000;

	// The offscreen document cannot call chrome.tabs; the service worker relays
	// the countdown to the recorded tab's content overlay. Fire-and-forget: a
	// tab that cannot show the overlay (e.g. a chrome:// page) just leaves the
	// screen blank for the wait, which still keeps the count out of the capture.
	chrome.runtime.sendMessage(
		{
			target: "service-worker",
			type: "show-countdown",
			tabId: request.tabId,
			seconds,
			durationMs,
		} satisfies ServiceWorkerRequest,
		() => {
			void chrome.runtime.lastError;
		},
	);

	countdownInProgress = true;
	try {
		await new Promise<void>((resolve) => {
			const finish = () => {
				window.clearTimeout(timer);
				countdownResolve = null;
				resolve();
			};
			const timer = window.setTimeout(finish, durationMs);
			countdownResolve = finish;
		});
	} finally {
		countdownInProgress = false;
		countdownResolve = null;
	}
};

const stopTracks = (stream: MediaStream) => {
	for (const track of stream.getTracks()) {
		track.stop();
	}
};

const stopCameraPreviewStream = () => {
	if (!cameraPreviewStream) return;
	stopTracks(cameraPreviewStream);
	cameraPreviewStream = null;
	cameraPreviewDeviceId = null;
};

const disconnectCameraPreview = (sessionId: string) => {
	const peer = cameraPreviewSessions.get(sessionId);
	if (!peer) return;
	cameraPreviewSessions.delete(sessionId);
	peer.close();
	if (cameraPreviewSessions.size === 0) {
		stopCameraPreviewStream();
	}
};

const disconnectCameraPreviews = () => {
	for (const sessionId of Array.from(cameraPreviewSessions.keys())) {
		disconnectCameraPreview(sessionId);
	}
	stopCameraPreviewStream();
};

const getCameraPreviewStream = async (settings: WebcamSettings) => {
	if (
		cameraPreviewStream?.active &&
		cameraPreviewDeviceId === settings.deviceId
	) {
		return cameraPreviewStream;
	}

	disconnectCameraPreviews();
	cameraPreviewStream = await getCameraMediaStream(settings, false);
	cameraPreviewDeviceId = settings.deviceId;
	return cameraPreviewStream;
};

const getStreamSize = (stream: MediaStream) => {
	const settings = stream.getVideoTracks()[0]?.getSettings();
	return {
		width: Math.max(1, settings?.width ?? DEFAULT_WIDTH),
		height: Math.max(1, settings?.height ?? DEFAULT_HEIGHT),
		fps: Math.max(1, settings?.frameRate ?? DEFAULT_FPS),
	};
};

const getDisplaySurface = (settings: MediaTrackSettings) => {
	const value = (settings as Partial<{ displaySurface?: unknown }>)
		.displaySurface;
	return typeof value === "string" ? value : null;
};

const getCaptureSource = (
	request: StartRecordingRequest,
	stream: MediaStream,
): RecordingCaptureSource | null => {
	if (request.mode === "camera") return null;
	const track = stream.getVideoTracks()[0] ?? null;
	if (!track) return null;
	const settings = track.getSettings();
	return {
		requestedMode: request.mode,
		detectedMode:
			request.mode === "tab"
				? "tab"
				: detectRecordingModeFromTrack(track, settings),
		displaySurface: getDisplaySurface(settings),
		label: track.label || null,
		tabId: request.tabId,
	};
};

const broadcastCaptureSource = (source: RecordingCaptureSource) => {
	chrome.runtime.sendMessage(
		{
			target: "service-worker",
			type: "recording-capture-source",
			source,
		},
		() => {
			void chrome.runtime.lastError;
		},
	);
};

const getVideoConstraint = (webcam: WebcamSettings) =>
	webcam.deviceId && webcam.deviceId !== DEFAULT_CAMERA_DEVICE_ID
		? {
				deviceId: { exact: webcam.deviceId },
			}
		: true;

const shouldRetryDefaultCamera = (webcam: WebcamSettings, error: unknown) =>
	webcam.deviceId !== null &&
	webcam.deviceId !== DEFAULT_CAMERA_DEVICE_ID &&
	error instanceof DOMException &&
	(error.name === "NotFoundError" || error.name === "OverconstrainedError");

const getCameraMediaStream = async (
	webcam: WebcamSettings,
	audio: boolean | MediaTrackConstraints,
) => {
	try {
		return await navigator.mediaDevices.getUserMedia({
			video: getVideoConstraint(webcam),
			audio,
		});
	} catch (error) {
		if (!shouldRetryDefaultCamera(webcam, error)) {
			throw error;
		}

		return navigator.mediaDevices.getUserMedia({
			video: true,
			audio,
		});
	}
};

const tabCaptureConstraints = (streamId: string, includeAudio: boolean) =>
	({
		...(includeAudio
			? {
					audio: {
						mandatory: {
							chromeMediaSource: "tab",
							chromeMediaSourceId: streamId,
						},
					},
				}
			: {}),
		video: {
			mandatory: {
				chromeMediaSource: "tab",
				chromeMediaSourceId: streamId,
			},
		},
	}) as unknown as MediaStreamConstraints;

const getMainStream = async (request: StartRecordingRequest) => {
	if (request.mode === "tab") {
		if (!request.tabStreamId) throw new Error("Tab stream id is missing");
		return navigator.mediaDevices.getUserMedia(
			tabCaptureConstraints(
				request.tabStreamId,
				request.settings.systemAudio.enabled,
			),
		);
	}

	if (request.mode === "camera") {
		return getCameraMediaStream(
			request.settings.webcam,
			getAudioConstraint(request.settings.microphone),
		);
	}

	return captureDisplayStream(
		request.mode,
		request.settings.systemAudio.enabled,
		(options) =>
			navigator.mediaDevices.getDisplayMedia(
				options as DisplayMediaStreamOptions,
			),
	);
};

const getAudioConstraint = (
	microphone: MicrophoneSettings,
): boolean | MediaTrackConstraints => {
	if (!microphone.enabled) return false;
	if (
		microphone.deviceId &&
		microphone.deviceId !== DEFAULT_MICROPHONE_DEVICE_ID
	) {
		return {
			deviceId: { exact: microphone.deviceId },
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
		};
	}
	return true;
};

const getMicrophoneStream = async (
	microphone: MicrophoneSettings,
	mode: RecordingMode,
) => {
	if (mode === "camera") return null;
	if (!microphone.enabled) return null;

	const audio = getAudioConstraint(microphone);
	const constraints: MediaStreamConstraints = {
		audio,
		video: false,
	};

	try {
		return await navigator.mediaDevices.getUserMedia(constraints);
	} catch {
		return null;
	}
};

// How long a probe listens before declaring the mic silent, and the peak
// amplitude (time-domain, 0..1) that counts as sound. A muted/dead device
// flat-lines near 0; a working mic's noise floor clears this threshold, so it
// only flags an effectively-silent input.
const MIC_PROBE_WINDOW_MS = 1200;
const MIC_PROBE_SAMPLE_INTERVAL_MS = 50;
const MIC_SOUND_MIN_PEAK = 0.0015;

// Opens the selected mic and listens for any signal so the recorder can warn
// before starting. Resolves as soon as sound is heard; only a genuinely silent
// mic waits out the full window. Unlike a popup, the offscreen AudioContext is
// not blocked by the page autoplay policy, so the analyser actually runs.
const probeMicrophone = async (
	microphone: MicrophoneSettings,
): Promise<MicrophoneProbeResult> => {
	if (!microphone.enabled) return { available: false, hasSound: false };

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: getAudioConstraint(microphone),
			video: false,
		});
	} catch {
		return { available: false, hasSound: false };
	}

	const context = new AudioContext();
	try {
		if (context.state === "suspended") {
			await context.resume().catch(() => undefined);
		}
		const source = context.createMediaStreamSource(stream);
		const analyser = context.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);
		const buffer = new Float32Array(analyser.fftSize);

		const deadline = performance.now() + MIC_PROBE_WINDOW_MS;
		let peak = 0;
		while (performance.now() < deadline) {
			analyser.getFloatTimeDomainData(buffer);
			for (let i = 0; i < buffer.length; i += 1) {
				const amplitude = Math.abs(buffer[i]);
				if (amplitude > peak) peak = amplitude;
			}
			if (peak >= MIC_SOUND_MIN_PEAK) break;
			await new Promise<void>((resolve) => {
				window.setTimeout(resolve, MIC_PROBE_SAMPLE_INTERVAL_MS);
			});
		}
		return { available: true, hasSound: peak >= MIC_SOUND_MIN_PEAK };
	} catch {
		// If the measurement itself fails, do not block the recording with a
		// false silence warning.
		return { available: true, hasSound: true };
	} finally {
		stopTracks(stream);
		await context.close().catch(() => undefined);
	}
};

const addAudioTracks = ({
	output,
	streams,
	routeFirstStreamToSpeakers,
}: {
	output: MediaStream;
	streams: MediaStream[];
	routeFirstStreamToSpeakers: boolean;
}) => {
	const streamsWithAudio = streams.filter(
		(stream) => stream.getAudioTracks().length > 0,
	);
	if (streamsWithAudio.length === 0) return undefined;

	const audioContext = new AudioContext();
	const destination = audioContext.createMediaStreamDestination();

	streamsWithAudio.forEach((stream, index) => {
		const source = audioContext.createMediaStreamSource(stream);
		source.connect(destination);
		if (routeFirstStreamToSpeakers && index === 0) {
			source.connect(audioContext.destination);
		}
	});

	for (const track of destination.stream.getAudioTracks()) {
		output.addTrack(track);
	}

	return audioContext;
};

const updateStatusDuration = () => {
	if (!activeRecording) return;
	const now = Date.now();
	const durationMs = getRecordingDuration(activeRecording, now);
	// Enforce the free-plan cap (the floating bar only displays the
	// countdown); routing through the service worker mirrors a user-initiated
	// stop so the upload page opens as usual.
	if (
		activeRecording.maxDurationMs !== null &&
		durationMs >= activeRecording.maxDurationMs &&
		!activeRecording.finalizePromise
	) {
		stopRecordingFromTrackEnd();
	}
	if (status.phase === "recording") {
		status = {
			...status,
			durationMs,
			updatedAt: now,
		};
	}
};

const getRecordingDuration = (recording: ActiveRecording, now = Date.now()) =>
	recording.lastResumedAt === null
		? recording.durationMs
		: recording.durationMs + Math.max(0, now - recording.lastResumedAt);

const cleanupActiveRecording = async (recording: ActiveRecording) => {
	if (recording.cleanedUp) return;
	recording.cleanedUp = true;
	if (recording.statusTimer !== null) {
		window.clearInterval(recording.statusTimer);
	}
	if (recording.dataRequestInterval !== null) {
		window.clearInterval(recording.dataRequestInterval);
	}
	if (recording.chunkStartGuard !== null) {
		window.clearTimeout(recording.chunkStartGuard);
	}
	for (const stream of recording.streams) {
		stopTracks(stream);
	}
	stopTracks(recording.recordingStream);
	await recording.audioContext?.close().catch(() => undefined);
};

// Reconcile the IndexedDB recording spool with the failed-recording metadata
// whenever this document starts: drop metadata whose bytes are gone, record
// spools stranded by a crash so they stay recoverable from the upload page,
// and reclaim space from abandoned recordings. Works from session metadata
// only — materialising every stranded recording's chunks just to take
// inventory would re-read gigabytes of IndexedDB on each recorder spin-up.
const sweepOrphanedRecordingSpools = async () => {
	try {
		const [sessions, failed, manifests] = await Promise.all([
			listRecordingSpoolSessions(),
			loadFailedRecordings(),
			loadLiveRecordingManifests(),
		]);
		const now = Date.now();
		const knownSessions = new Set(failed.map((entry) => entry.sessionId));
		const manifestsBySession = new Map(
			manifests.map((manifest) => [manifest.sessionId, manifest]),
		);
		const remainingSessions = new Set<string>();
		let entries = [...failed];

		for (const orphan of sessions) {
			if (activeRecording?.spool.sessionId === orphan.sessionId) {
				remainingSessions.add(orphan.sessionId);
				continue;
			}
			if (now - orphan.updatedAt < RECORDING_SPOOL_LIVE_MIN_IDLE_MS) {
				remainingSessions.add(orphan.sessionId);
				continue;
			}

			// Idle sessions that never received a chunk hold no recoverable data.
			if (
				orphan.chunkCount === 0 ||
				now - orphan.updatedAt > ORPHAN_SPOOL_MAX_AGE_MS
			) {
				await deleteRecoveredRecordingSpool(orphan.sessionId).catch(
					() => undefined,
				);
				entries = entries.filter(
					(entry) => entry.sessionId !== orphan.sessionId,
				);
				continue;
			}

			remainingSessions.add(orphan.sessionId);
			if (!knownSessions.has(orphan.sessionId) && orphan.totalBytes > 0) {
				// A crash-stranded session whose live manifest survived keeps its
				// videoId/subpath so the entry stays retryable, not download-only.
				// The duration is a wall-clock estimate (it includes pauses); it
				// only feeds the completion metadata on retry.
				const manifest = manifestsBySession.get(orphan.sessionId);
				entries.push({
					sessionId: orphan.sessionId,
					videoId: manifest?.videoId ?? null,
					shareUrl: manifest?.shareUrl ?? null,
					mimeType: orphan.mimeType,
					subpath: manifest?.subpath ?? null,
					durationMs: manifest
						? Math.max(0, orphan.updatedAt - manifest.startedAt)
						: 0,
					width: manifest?.width ?? null,
					height: manifest?.height ?? null,
					fps: manifest?.fps ?? null,
					totalBytes: orphan.totalBytes,
					createdAt: orphan.updatedAt,
					message: "The recording was interrupted before its upload finished.",
				});
			}
		}

		const { dropped } = await saveFailedRecordings(
			entries.filter((entry) => remainingSessions.has(entry.sessionId)),
		);
		// Entries pushed out by the metadata cap can never be retried; reclaim
		// their spooled bytes instead of leaving them for the 14-day sweep.
		const survivingSessions = new Set(remainingSessions);
		for (const entry of dropped) {
			survivingSessions.delete(entry.sessionId);
			await deleteRecoveredRecordingSpool(entry.sessionId).catch(
				() => undefined,
			);
		}
		await pruneLiveRecordingManifests(survivingSessions).catch(() => undefined);
	} catch {
		// Recovery bookkeeping must never block the recorder from starting.
	}
};

function stopRecorderAfterError(recorder: MediaRecorder) {
	if (recorder.state !== "inactive") {
		recorder.stop();
	}
	window.setTimeout(() => {
		if (activeRecording?.recorder === recorder) {
			void stopRecording();
		}
	}, 0);
}

const requestRecorderData = (recording: ActiveRecording) => {
	if (recording.chunkingMode !== "manual") return;
	if (recording.recorder.state !== "recording") return;
	try {
		recording.recorder.requestData();
	} catch {}
};

const stopManualChunking = (recording: ActiveRecording) => {
	if (recording.dataRequestInterval !== null) {
		window.clearInterval(recording.dataRequestInterval);
		recording.dataRequestInterval = null;
	}
	if (recording.chunkStartGuard !== null) {
		window.clearTimeout(recording.chunkStartGuard);
		recording.chunkStartGuard = null;
	}
};

const beginManualChunking = (recording: ActiveRecording) => {
	recording.chunkingMode = "manual";
	recording.lastChunkAt = null;
	stopManualChunking(recording);
	requestRecorderData(recording);
	recording.dataRequestInterval = window.setInterval(() => {
		requestRecorderData(recording);
	}, RECORDING_TIMESLICE_MS);
};

const scheduleTimesliceGuard = (recording: ActiveRecording) => {
	if (recording.chunkStartGuard !== null) {
		window.clearTimeout(recording.chunkStartGuard);
	}
	recording.chunkStartGuard = window.setTimeout(() => {
		recording.chunkStartGuard = null;
		if (recording.chunkingMode !== "timeslice") return;
		if (recording.lastChunkAt !== null) return;
		beginManualChunking(recording);
	}, RECORDING_TIMESLICE_GUARD_MS);
};

const stopRecordingFromTrackEnd = () => {
	const recording = activeRecording;
	if (!recording || recording.finalizePromise) return;
	chrome.runtime.sendMessage(
		{ target: "service-worker", type: "stop-recording" },
		() => {
			if (!chrome.runtime.lastError) return;
			void stopRecording();
		},
	);
};

const startRecording = async (request: StartRecordingRequest) => {
	if (activeRecording || startInProgress || retryInProgress) {
		// Thrown before this attempt owns anything, so the cleanup below must
		// never run for it: a duplicate start would otherwise tear down — and
		// delete server-side — the live recording it was rejected to protect.
		throw new Error("Recording is already active");
	}
	startInProgress = true;
	startCancelRequested = false;

	// Everything acquired by THIS attempt. The failure path releases exactly
	// these; module state like activeRecording is only touched when this
	// attempt is the one that set it.
	const ownedStreams: MediaStream[] = [];
	let ownedVideoId: string | null = null;
	let ownedSpool: RecordingSpool | null = null;
	let ownedRecording: ActiveRecording | null = null;
	let countdownPromise: Promise<void> | null = null;

	try {
		status = { phase: "creating" };

		const mainStream = await getMainStream(request);
		ownedStreams.push(mainStream);
		throwIfStartCanceled();
		const captureSource = getCaptureSource(request, mainStream);
		if (captureSource) {
			broadcastCaptureSource(captureSource);
		}
		countdownPromise = runStartCountdown(request);
		const microphoneStream = await getMicrophoneStream(
			request.settings.microphone,
			request.mode,
		);
		if (microphoneStream) {
			ownedStreams.push(microphoneStream);
		}
		throwIfStartCanceled();
		const { width, height, fps } = getStreamSize(mainStream);
		const videoTracks = mainStream.getVideoTracks();
		if (videoTracks.length === 0) {
			throw new Error("No video track was captured");
		}
		const recordingStream = new MediaStream(videoTracks);
		const streams = microphoneStream
			? [mainStream, microphoneStream]
			: [mainStream];
		const audioContext = addAudioTracks({
			output: recordingStream,
			streams,
			routeFirstStreamToSpeakers: request.mode === "tab",
		});
		const hasAudio = recordingStream.getAudioTracks().length > 0;
		const pipeline = selectRecordingPipeline(hasAudio);
		if (!pipeline) throw new Error("No supported recorder format is available");

		const { videoCodec, audioCodec } = describeRecordingCodecs(
			pipeline.mimeType,
			hasAudio,
		);
		const creation = await createInstantRecording({
			settings: request.settings,
			auth: request.auth,
			input: {
				orgId: request.bootstrap.organization.id,
				folderId: undefined,
				resolution: `${width}x${height}`,
				width,
				height,
				videoCodec,
				audioCodec,
				supportsUploadProgress: true,
			},
		});
		ownedVideoId = creation.id;
		throwIfStartCanceled();
		const subpath = `raw-upload.${pipeline.fileExtension}`;
		const api = {
			baseUrl: request.settings.apiBaseUrl,
			authToken: request.auth.authApiKey,
			requestTimeoutMs: DEFAULT_API_REQUEST_TIMEOUT_MS,
		};
		const uploadSession = await initiateMultipartUpload({
			videoId: creation.id,
			contentType: pipeline.mimeType,
			subpath,
			api,
		});
		throwIfStartCanceled();
		const spool = await RecordingSpool.create({ mimeType: pipeline.mimeType });
		ownedSpool = spool;
		throwIfStartCanceled();
		const uploader = new InstantRecordingUploader({
			videoId: creation.id,
			uploadId: uploadSession.uploadId,
			provider: uploadSession.provider,
			mimeType: pipeline.mimeType,
			subpath,
			api,
			setUploadStatus: (uploadStatus) => {
				if (
					status.phase === "recording" ||
					status.phase === "paused" ||
					status.phase === "uploading"
				) {
					status = { ...status, uploadStatus };
					broadcastProgressThrottled();
				}
			},
			sendProgressUpdate: (uploaded, total) =>
				updateUploadProgress({
					settings: request.settings,
					auth: request.auth,
					videoId: creation.id,
					uploaded,
					total,
				}).then(() => undefined),
			onChunkStateChange: (nextChunks) => {
				if (
					status.phase === "recording" ||
					status.phase === "paused" ||
					status.phase === "uploading"
				) {
					status = { ...status, upload: summarizeChunks(nextChunks) };
					broadcastProgressThrottled();
				}
			},
			// Deliberately no onOverflow handler: when uploads fall 128MB behind
			// (MAX_PENDING_UPLOAD_BYTES) the recording is stopped via
			// onFatalError instead of degrading like the dashboard recorder.
			// Every byte is already double-written to the IndexedDB spool, so
			// the user keeps retry/download, and capping the buffer matters
			// more in an offscreen document the browser can't page out.
			onFatalError: (error) => {
				status = {
					phase: "error",
					message: error.message,
					videoId: creation.id,
				};
				broadcastStatus();
				if (activeRecording?.recorder) {
					stopRecorderAfterError(activeRecording.recorder);
				}
			},
		});

		const recorder = new MediaRecorder(recordingStream, {
			mimeType: pipeline.mimeType,
		});

		await countdownPromise;
		throwIfStartCanceled();

		const startedAt = Date.now();
		const plan = request.bootstrap.plan;
		const maxDurationMs =
			!plan.isPro && plan.maxRecordingSeconds !== null
				? plan.maxRecordingSeconds * 1000
				: null;

		const recording: ActiveRecording = {
			recorder,
			stopPromise: Promise.resolve(),
			streams,
			recordingStream,
			statusTimer: null,
			spool,
			uploader,
			startedAt,
			durationMs: 0,
			lastResumedAt: startedAt,
			videoId: creation.id,
			shareUrl: creation.shareUrl,
			width,
			height,
			fps,
			subpath,
			mimeType: pipeline.mimeType,
			maxDurationMs,
			audioContext,
			chunkChain: Promise.resolve(),
			dataRequestInterval: null,
			chunkStartGuard: null,
			chunkingMode: null,
			lastChunkAt: null,
			recordedBytes: 0,
			finalizePromise: null,
			cleanedUp: false,
			spoolFailed: false,
			memoryBackup: initialLocalRecordingState(),
		};

		ownedRecording = recording;
		activeRecording = recording;
		for (const track of mainStream.getVideoTracks()) {
			track.addEventListener("ended", stopRecordingFromTrackEnd, {
				once: true,
			});
		}
		// A crash from here on strands the spool; persisting the recording's
		// identity alongside it lets the startup sweep surface a retryable
		// failed-recording entry (videoId, subpath) instead of download-only.
		await saveLiveRecordingManifest({
			sessionId: spool.sessionId,
			videoId: creation.id,
			shareUrl: creation.shareUrl,
			mimeType: pipeline.mimeType,
			subpath,
			width,
			height,
			fps,
			startedAt,
		}).catch(() => undefined);
		recording.statusTimer = window.setInterval(updateStatusDuration, 1000);
		recording.stopPromise = new Promise<void>((resolve, reject) => {
			recorder.onstop = () => resolve();
			recorder.onerror = () => reject(new Error("MediaRecorder failed"));
		});
		// A mid-recording recorder failure must stop the session right away;
		// without this the rejection sits unhandled while the timer keeps
		// ticking over a recorder that no longer produces chunks, and nothing
		// surfaces until the user stops manually.
		recording.stopPromise.catch(() => {
			if (activeRecording !== recording || recording.finalizePromise) return;
			status = {
				phase: "error",
				message: "Recording failed: the recorder stopped unexpectedly",
				videoId: creation.id,
			};
			broadcastStatus();
			stopRecorderAfterError(recorder);
		});
		recorder.ondataavailable = (event) => {
			if (event.data.size === 0) return;
			recording.lastChunkAt =
				typeof performance !== "undefined" ? performance.now() : Date.now();
			if (
				recording.chunkingMode === "timeslice" &&
				recording.chunkStartGuard !== null
			) {
				window.clearTimeout(recording.chunkStartGuard);
				recording.chunkStartGuard = null;
			}
			recording.recordedBytes += event.data.size;
			const recordedBytes = recording.recordedBytes;
			recording.chunkChain = recording.chunkChain.then(async () => {
				if (recording.spoolFailed) {
					appendMemoryBackupChunk(recording, event.data);
					return;
				}
				try {
					await spool.appendChunk(event.data);
				} catch (error) {
					// The local crash-recovery copy degrades to memory; the
					// streaming upload still has every byte, so erroring the whole
					// session here would throw away a healthy recording. The failed
					// chunk is deliberately NOT added to the memory backup: the
					// spool keeps it in its pending buffer and recoverBlob() returns
					// it, so appending it here too would duplicate its bytes
					// mid-file in every recovered blob.
					recording.spoolFailed = true;
					console.warn(
						"Recording spool failed; keeping the local backup in memory",
						error,
					);
				}
			});
			try {
				uploader.handleChunk(event.data, recordedBytes);
			} catch (error) {
				status = {
					phase: "error",
					message: error instanceof Error ? error.message : String(error),
					videoId: creation.id,
				};
				stopRecorderAfterError(recorder);
			}
		};

		status = {
			phase: "recording",
			videoId: creation.id,
			startedAt,
			durationMs: 0,
			updatedAt: startedAt,
		};

		try {
			recorder.start(RECORDING_TIMESLICE_MS);
			recording.chunkingMode = "timeslice";
			scheduleTimesliceGuard(recording);
		} catch {
			recorder.start();
			beginManualChunking(recording);
		}
		playRecordingSound("start-recording", request.settings);
		// The service worker that sent start-recording may have been killed
		// while the capture picker was open, which destroys the response
		// channel. The broadcast wakes it (or its replacement) so the badge and
		// the floating recording bar still update.
		broadcastStatus();
		return status;
	} catch (error) {
		chrome.runtime.sendMessage(
			{
				target: "service-worker",
				type: "hide-recording-start-overlays",
			} satisfies ServiceWorkerRequest,
			() => {
				void chrome.runtime.lastError;
			},
		);
		countdownResolve?.();
		await countdownPromise?.catch(() => undefined);
		// Release only what this attempt acquired. No chunk can have been
		// captured yet — chunks only flow once recorder.start() succeeds, after
		// which nothing here throws — so the spool holds no recoverable data.
		for (const stream of ownedStreams) {
			stopTracks(stream);
		}
		if (ownedVideoId) {
			await deleteInstantRecording(
				request.settings,
				request.auth,
				ownedVideoId,
			).catch(() => undefined);
		}
		if (ownedRecording) {
			if (activeRecording === ownedRecording) {
				activeRecording = null;
			}
			await cleanupActiveRecording(ownedRecording);
		}
		if (ownedSpool) {
			await removeLiveRecordingManifest(ownedSpool.sessionId).catch(
				() => undefined,
			);
			await ownedSpool.dispose().catch(() => undefined);
		}
		// Reset the "creating" status so later status syncs do not report a
		// phantom in-progress recording.
		if (status.phase === "creating") {
			status = isUserCancellationError(error)
				? { phase: "idle" }
				: {
						phase: "error",
						message: error instanceof Error ? error.message : String(error),
					};
		}
		throw error;
	} finally {
		startInProgress = false;
	}
};

const appendMemoryBackupChunk = (recording: ActiveRecording, chunk: Blob) => {
	const previous = recording.memoryBackup;
	recording.memoryBackup = appendLocalRecordingChunk(previous, chunk, {
		mode: "capped",
		maxBytes: MEMORY_BACKUP_MAX_BYTES,
	});
	if (recording.memoryBackup.overflowed && !previous.overflowed) {
		console.warn(
			"In-memory recording backup exceeded its cap; dropping the local copy (the streaming upload still has every byte)",
		);
	}
};

// The complete recording: the spool when it stayed healthy, otherwise the
// spooled prefix plus the in-memory continuation. Null once the capped
// memory backup has overflowed — a truncated local copy must not masquerade
// as the complete recording.
const recoverRecordingBlob = async (recording: ActiveRecording) => {
	if (!recording.spoolFailed) {
		return recording.spool.recoverBlob();
	}
	if (recording.memoryBackup.overflowed) return null;
	const spooledBlob = await recording.spool.recoverBlob().catch(() => null);
	const parts = spooledBlob
		? [spooledBlob, ...recording.memoryBackup.chunks]
		: recording.memoryBackup.chunks;
	if (parts.length === 0) return null;
	return new Blob(parts, { type: recording.mimeType });
};

// Returns whether the recording bytes are persisted and retryable from the
// upload page.
const rememberFailedRecording = async (
	recording: ActiveRecording,
	error: unknown,
): Promise<boolean> => {
	if (recording.recordedBytes === 0) return false;

	let sessionId = recording.spool.sessionId;
	if (recording.spoolFailed) {
		// The original spool is missing the tail that went to memory; a retry
		// reading it would upload a truncated file. Persist the full recording
		// into a fresh spool once, and if that also fails (quota), drop the
		// partial spool so the entry is never offered as retryable.
		const fullBlob = await recoverRecordingBlob(recording).catch(() => null);
		const replacement =
			fullBlob && fullBlob.size >= recording.recordedBytes
				? await RecordingSpool.create({
						mimeType: recording.mimeType,
						// One awaited write of the whole blob; the default budget
						// guards live capture and would reject any blob over it.
						maxPendingChunkBytes: fullBlob.size,
					})
						.then(async (spool) => {
							await spool.appendChunk(fullBlob);
							await spool.flush();
							return spool;
						})
						.catch(() => null)
				: null;
		await recording.spool.dispose().catch(() => undefined);
		if (!replacement) return false;
		sessionId = replacement.sessionId;
	}

	const saved = await upsertFailedRecording({
		sessionId,
		videoId: recording.videoId,
		shareUrl: recording.shareUrl,
		mimeType: recording.mimeType,
		subpath: recording.subpath,
		durationMs: recording.durationMs,
		width: recording.width,
		height: recording.height,
		fps: recording.fps,
		totalBytes: recording.recordedBytes,
		createdAt: Date.now(),
		message: error instanceof Error ? error.message : String(error),
	}).catch(() => null);
	if (!saved) return false;

	// Entries pushed out by the metadata cap can no longer be retried;
	// reclaim their spooled bytes right away.
	for (const dropped of saved.dropped) {
		await deleteRecoveredRecordingSpool(dropped.sessionId).catch(
			() => undefined,
		);
	}

	return saved.kept.some((entry) => entry.sessionId === sessionId);
};

const finalizeRecording = async (recording: ActiveRecording) => {
	try {
		await recording.stopPromise;
		await cleanupActiveRecording(recording);
		await recording.chunkChain;
		// finalBlob is null when the capped memory backup overflowed. The
		// streamed parts still carry every byte; the uploader just falls back
		// to its recorded-bytes counter instead of the local blob's size.
		const finalBlob = await recoverRecordingBlob(recording);
		if ((!finalBlob || finalBlob.size === 0) && recording.recordedBytes === 0) {
			throw new Error("No recording data was captured");
		}
		await recording.uploader.finalize({
			finalBlob: finalBlob && finalBlob.size > 0 ? finalBlob : null,
			durationSeconds: Math.max(1, Math.round(recording.durationMs / 1000)),
			width: recording.width,
			height: recording.height,
			fps: recording.fps,
			subpath: recording.subpath,
		});
		await recording.spool.dispose();
		await removeFailedRecording(recording.spool.sessionId).catch(
			() => undefined,
		);
		await removeLiveRecordingManifest(recording.spool.sessionId).catch(
			() => undefined,
		);
		status = {
			phase: "completed",
			videoId: recording.videoId,
			shareUrl: recording.shareUrl,
		};
		broadcastStatus();
		return status;
	} catch (error) {
		if (error instanceof MultipartCompletionUncertainError) {
			// The parts are uploaded but the completion call never got a
			// definitive answer (it is retried internally first). If it never
			// reached the server the S3 object was never assembled, so the
			// spooled bytes are the only remaining copy — keep them and the
			// failed-recording entry so the user can verify via the share link
			// and then retry or download (mirrors the dashboard recorder).
			const recoverable = await rememberFailedRecording(
				recording,
				new Error(UNCERTAIN_COMPLETION_MESSAGE),
			);
			status = {
				phase: "error",
				message: UNCERTAIN_COMPLETION_MESSAGE,
				videoId: recording.videoId,
				shareUrl: recording.shareUrl,
				recoverable,
			};
			broadcastStatus();
			return status;
		}
		// Keep the spooled bytes and remember the recording so the upload page
		// can retry the upload or download the file; disposing here would lose
		// the captured data forever.
		const recoverable = await rememberFailedRecording(recording, error);
		status = {
			phase: "error",
			message: error instanceof Error ? error.message : String(error),
			videoId: recording.videoId,
			recoverable,
		};
		broadcastStatus();
		return status;
	} finally {
		if (activeRecording === recording) {
			activeRecording = null;
		}
		await cleanupActiveRecording(recording);
	}
};

const getCurrentUploadSnapshot = () =>
	status.phase === "recording" ||
	status.phase === "paused" ||
	status.phase === "uploading"
		? {
				upload: status.upload,
				uploadStatus: status.uploadStatus,
			}
		: {
				upload: undefined,
				uploadStatus: undefined,
			};

async function stopRecording() {
	// A stop during the pre-roll countdown cancels the start before any frame is
	// captured. Resolving the countdown wait lets startRecording's
	// throwIfStartCanceled tear down the half-built session (streams, server
	// recording, spool) instead of finalizing an empty recording.
	if (countdownInProgress) {
		startCancelRequested = true;
		countdownResolve?.();
		return status;
	}

	const recording = activeRecording;
	if (!recording) {
		// A stop while the start sequence is still running (capture picker
		// open, server round-trips pending) aborts that start; the start call
		// itself resolves as a cancellation.
		if (startInProgress) {
			startCancelRequested = true;
		}
		return status;
	}

	stopManualChunking(recording);
	const now = Date.now();
	recording.durationMs = getRecordingDuration(recording, now);
	recording.lastResumedAt = null;

	if (recording.recorder.state !== "inactive") {
		recording.recorder.stop();
	}

	if (status.phase !== "error") {
		const snapshot = getCurrentUploadSnapshot();
		status = {
			phase: "uploading",
			videoId: recording.videoId,
			startedAt: recording.startedAt,
			durationMs: recording.durationMs,
			updatedAt: now,
			upload: snapshot.upload,
			uploadStatus: snapshot.uploadStatus,
		};
		broadcastStatus();
		void loadSettings()
			.then((settings) => playRecordingSound("stop-recording", settings))
			.catch(() => undefined);
	}

	if (!recording.finalizePromise) {
		recording.finalizePromise = finalizeRecording(recording);
		void recording.finalizePromise.catch(() => undefined);
	}

	return status;
}

const pauseRecording = () => {
	const recording = activeRecording;
	if (!recording || recording.recorder.state !== "recording") {
		return status;
	}
	const now = Date.now();
	recording.durationMs = getRecordingDuration(recording, now);
	recording.lastResumedAt = null;
	recording.recorder.pause();
	if (status.phase === "recording") {
		status = {
			...status,
			phase: "paused",
			durationMs: recording.durationMs,
			updatedAt: now,
		};
	}
	return status;
};

const resumeRecording = () => {
	const recording = activeRecording;
	if (!recording || recording.recorder.state !== "paused") {
		return status;
	}
	const now = Date.now();
	recording.recorder.resume();
	recording.lastResumedAt = now;
	if (status.phase === "paused") {
		status = {
			...status,
			phase: "recording",
			durationMs: recording.durationMs,
			updatedAt: now,
		};
	}
	return status;
};

// Re-upload a recording whose bytes are still spooled in IndexedDB after a
// failed upload. A fresh multipart session is started for the same video and
// the whole blob is re-sent.
const retryFailedUpload = async (videoId: string): Promise<RecordingStatus> => {
	if (activeRecording || startInProgress || retryInProgress) {
		throw new Error("A recording is already in progress");
	}
	retryInProgress = true;
	try {
		return await runFailedUploadRetry(videoId);
	} finally {
		retryInProgress = false;
	}
};

const runFailedUploadRetry = async (
	videoId: string,
): Promise<RecordingStatus> => {
	const failed = (await loadFailedRecordings()).find(
		(entry) => entry.videoId === videoId,
	);
	if (!failed?.videoId) {
		throw new Error("This recording is no longer available to retry.");
	}

	const orphan = await recoverRecordingSpoolSession(failed.sessionId);
	if (!orphan || orphan.blob.size === 0) {
		await removeFailedRecording(failed.sessionId).catch(() => undefined);
		throw new Error("The recorded data is no longer available.");
	}

	const [settings, auth] = await Promise.all([loadSettings(), loadAuth()]);
	if (!auth) {
		throw new Error("Sign in to Cap to retry this upload.");
	}

	const typedVideoId = failed.videoId as VideoId;
	const shareUrl =
		failed.shareUrl ??
		new URL(`/s/${failed.videoId}`, settings.apiBaseUrl).toString();
	const subpath =
		failed.subpath ??
		`raw-upload.${failed.mimeType.includes("webm") ? "webm" : "mp4"}`;
	const api = {
		baseUrl: settings.apiBaseUrl,
		authToken: auth.authApiKey,
		requestTimeoutMs: DEFAULT_API_REQUEST_TIMEOUT_MS,
	};

	status = {
		phase: "uploading",
		videoId: typedVideoId,
		startedAt: failed.createdAt,
		durationMs: failed.durationMs,
		updatedAt: Date.now(),
	};
	broadcastStatus();

	// Defense in depth on top of the retryInProgress lock: status writes only
	// land while this retry's "uploading" status is still the live one, so a
	// path that slips past the lock can never repaint another session.
	const retryOwnsStatus = () =>
		status.phase === "uploading" && status.videoId === typedVideoId;

	const setRetryStatus = (nextStatus: RecordingStatus) => {
		if (!retryOwnsStatus()) return;
		status = nextStatus;
		broadcastStatus();
	};

	try {
		const uploadSession = await initiateMultipartUpload({
			videoId: typedVideoId,
			contentType: failed.mimeType,
			subpath,
			api,
		});
		const uploader = new InstantRecordingUploader({
			videoId: typedVideoId,
			uploadId: uploadSession.uploadId,
			provider: uploadSession.provider,
			mimeType: failed.mimeType,
			subpath,
			api,
			setUploadStatus: (uploadStatus) => {
				if (retryOwnsStatus() && status.phase === "uploading") {
					status = { ...status, uploadStatus };
					broadcastProgressThrottled();
				}
			},
			sendProgressUpdate: (uploaded, total) =>
				updateUploadProgress({
					settings,
					auth,
					videoId: typedVideoId,
					uploaded,
					total,
				}).then(() => undefined),
			onChunkStateChange: (nextChunks) => {
				if (retryOwnsStatus() && status.phase === "uploading") {
					status = { ...status, upload: summarizeChunks(nextChunks) };
					broadcastProgressThrottled();
				}
			},
		});

		await uploader.finalize({
			finalBlob: orphan.blob,
			durationSeconds: Math.max(1, Math.round(failed.durationMs / 1000)),
			width: failed.width ?? undefined,
			height: failed.height ?? undefined,
			fps: failed.fps ?? undefined,
			subpath,
		});
		await deleteRecoveredRecordingSpool(failed.sessionId).catch(
			() => undefined,
		);
		await removeFailedRecording(failed.sessionId).catch(() => undefined);
		setRetryStatus({
			phase: "completed",
			videoId: typedVideoId,
			shareUrl,
		});
		return status;
	} catch (error) {
		if (error instanceof MultipartCompletionUncertainError) {
			// Keep the spooled bytes and the entry: if the retried completion
			// never reached the server, this is still the only copy. The user
			// can verify via the share link, then retry again or download.
			await upsertFailedRecording({
				...failed,
				message: UNCERTAIN_COMPLETION_MESSAGE,
			}).catch(() => undefined);
			setRetryStatus({
				phase: "error",
				message: UNCERTAIN_COMPLETION_MESSAGE,
				videoId: typedVideoId,
				shareUrl,
				recoverable: true,
			});
			return status;
		}
		setRetryStatus({
			phase: "error",
			message: error instanceof Error ? error.message : String(error),
			videoId: typedVideoId,
			recoverable: true,
		});
		return status;
	}
};

// This document is a top-level extension page, so once the extension origin
// holds the camera/mic grant (the same grant that lets recording getUserMedia
// run here without a prompt) enumerateDevices() returns full labels — unlike
// the recorder panel, which Chrome treats as a cross-origin iframe and strips
// device labels from.
const enumerateMediaDevices = async () => {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return {
		cameras: toCameraDevices(devices),
		microphones: toMicrophoneDevices(devices),
	};
};

// The recorder panel is a cross-origin iframe whose own permission query is
// delegated from the host page, so it cannot tell when Chrome has reset the
// extension's camera/mic grant (which happens automatically after the
// extension goes unused for a while). This top-level page shares the grant
// with the recording pipeline, so its query is the authoritative source.
const queryMediaPermission = async (
	name: PermissionName,
): Promise<MediaPermissionState> => {
	if (!navigator.permissions?.query) return "unknown";
	try {
		const status = await navigator.permissions.query({ name });
		return status.state;
	} catch {
		return "unknown";
	}
};

const queryMediaPermissions = async (): Promise<MediaPermissionSnapshot> => {
	const [camera, microphone] = await Promise.all([
		queryMediaPermission("camera" as PermissionName),
		queryMediaPermission("microphone" as PermissionName),
	]);
	return { camera, microphone };
};

const connectCameraPreview = async (request: ConnectCameraPreviewRequest) => {
	disconnectCameraPreview(request.sessionId);
	const stream = await getCameraPreviewStream(request.settings);
	const peer = new RTCPeerConnection();
	cameraPreviewSessions.set(request.sessionId, peer);

	try {
		peer.addEventListener("connectionstatechange", () => {
			if (
				peer.connectionState === "closed" ||
				peer.connectionState === "disconnected" ||
				peer.connectionState === "failed"
			) {
				disconnectCameraPreview(request.sessionId);
			}
		});

		await peer.setRemoteDescription(request.offer);
		for (const track of stream.getVideoTracks()) {
			peer.addTrack(track, stream);
		}
		await peer.setLocalDescription(await peer.createAnswer());
		await waitForIceGatheringComplete(peer);

		return toSessionDescriptionInit(peer.localDescription);
	} catch (error) {
		disconnectCameraPreview(request.sessionId);
		throw error;
	}
};

const handleRequest = async (
	message: OffscreenRequest,
): Promise<OffscreenResponse> => {
	if (message.type === "start-recording") {
		const nextStatus = await startRecording(message);
		return { ok: true, status: nextStatus };
	}

	if (message.type === "stop-recording") {
		const nextStatus = await stopRecording();
		return { ok: true, status: nextStatus };
	}

	if (message.type === "pause-recording") {
		return { ok: true, status: pauseRecording() };
	}

	if (message.type === "resume-recording") {
		return { ok: true, status: resumeRecording() };
	}

	if (message.type === "connect-camera-preview") {
		return { ok: true, answer: await connectCameraPreview(message) };
	}

	if (message.type === "disconnect-camera-preview") {
		disconnectCameraPreview(message.sessionId);
		return { ok: true, status };
	}

	if (message.type === "disconnect-camera-previews") {
		disconnectCameraPreviews();
		return { ok: true, status };
	}

	if (message.type === "acknowledge-error") {
		if (status.phase === "error") {
			status = { phase: "idle" };
		}
		return { ok: true, status };
	}

	if (message.type === "retry-upload") {
		return { ok: true, status: await retryFailedUpload(message.videoId) };
	}

	if (message.type === "enumerate-devices") {
		const [devices, permissions] = await Promise.all([
			enumerateMediaDevices(),
			queryMediaPermissions(),
		]);
		return { ok: true, devices, permissions };
	}

	if (message.type === "probe-microphone") {
		return { ok: true, micProbe: await probeMicrophone(message.microphone) };
	}

	return { ok: true, status };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!isOffscreenRequest(message)) return false;

	handleRequest(message)
		.then(sendResponse)
		.catch((error: unknown) => {
			// Failure cleanup is owned by each handler (startRecording releases
			// exactly the resources its own attempt acquired); this layer only
			// formats the rejection. Tearing anything down here would let an
			// unrelated failed message — a duplicate start rejected by the
			// already-active guard, a camera-preview error — destroy a live
			// recording's streams or delete its video server-side.
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				canceled: isUserCancellationError(error),
			} satisfies OffscreenResponse);
		});

	return true;
});

void sweepOrphanedRecordingSpools();

// After the first recording this document would otherwise live for the rest
// of the browser session, fielding a status round trip on every tab switch.
// Close it once nothing here is live — the service worker recreates it on
// demand and serves its own status mirror while it is gone. Error statuses
// keep the document open so the upload page's retry context stays live.
const IDLE_CLOSE_CHECK_INTERVAL_MS = 60 * 1000;

const canCloseIdleDocument = () =>
	!activeRecording &&
	!startInProgress &&
	!retryInProgress &&
	cameraPreviewSessions.size === 0 &&
	cameraPreviewStream === null &&
	activeRecordingSounds.size === 0 &&
	(status.phase === "idle" || status.phase === "completed");

window.setInterval(() => {
	if (canCloseIdleDocument()) {
		window.close();
	}
}, IDLE_CLOSE_CHECK_INTERVAL_MS);
