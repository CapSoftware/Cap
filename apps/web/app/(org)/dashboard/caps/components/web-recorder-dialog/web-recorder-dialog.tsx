"use client";

import { acquireDisplayStream } from "@cap/recorder-core/capture-streams";
import { detectRecordingModeFromTrack } from "@cap/recorder-core/recorder-utils";
import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import clsx from "clsx";
import {
	CameraIcon,
	LoaderCircleIcon,
	MicIcon,
	MonitorIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	Volume2Icon,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import {
	CameraPreviewWindow,
	type CameraPreviewWindowHandle,
} from "./CameraPreviewWindow";
import { HowRecordingWorks } from "./how-recording-works";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { DeviceMenu, OptionsMenu, RecordButton } from "./recorder-dock";
import {
	BoilFilter,
	CountdownDial,
	Doodle,
	formatClock,
	LiveVideo,
	MicMeter,
	Squiggle,
	Switch,
	TrackRow,
	useLiveStream,
	useMicLevel,
	Waveform,
} from "./recorder-parts";
import type { RecordingMode } from "./recording-mode";
import { SystemAudioGuide } from "./system-audio-guide";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import { FREE_PLAN_MAX_RECORDING_MS } from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";
import "./recorder.css";

const recoveredRecordingTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

const waitForNextFrame = () =>
	new Promise<void>((resolve) => {
		if (typeof window === "undefined") {
			resolve();
			return;
		}

		window.requestAnimationFrame(() => resolve());
	});

const stopStream = (stream: MediaStream | null) => {
	for (const track of stream?.getTracks() ?? []) track.stop();
};

const SURFACE_LABELS: Record<Exclude<RecordingMode, "camera">, string> = {
	fullscreen: "Entire screen",
	window: "Window",
	tab: "Browser tab",
};

const WAVE_SAMPLE_MS = 150;
const AUDIO_GUIDE_DISMISSED_KEY = "cap-web-recorder-audio-guide-dismissed";
const LIVE_PREVIEW_KEY = "cap-web-recorder-live-preview";

type SharedScreen = {
	stream: MediaStream;
	surface: Exclude<RecordingMode, "camera">;
};

const joinWords = (words: string[]) =>
	words.length <= 1
		? (words[0] ?? "")
		: `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

const MediaLabel = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<span
		className={clsx(
			"absolute inline-flex h-6 items-center gap-1.5 rounded-md bg-black/55 px-2 text-[12px] font-medium text-white backdrop-blur-md",
			className,
		)}
	>
		{children}
	</span>
);

const LiveDot = ({ paused = false }: { paused?: boolean }) => (
	<span
		className={clsx(
			"size-1.5 shrink-0 rounded-full",
			paused ? "bg-current opacity-50" : "rec-pulse bg-[var(--rec-red)]",
		)}
	/>
);

const EmptyTile = ({
	icon,
	title,
	body,
	action,
}: {
	icon: ReactNode;
	title: string;
	body: string;
	action?: ReactNode;
}) => (
	<div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
		<span className="flex size-10 items-center justify-center rounded-full bg-[var(--rec-ctl)] text-[var(--rec-text-2)]">
			{icon}
		</span>
		<div className="flex max-w-[17rem] flex-col gap-0.5">
			<span className="text-[14px] font-medium text-[var(--rec-text-1)]">
				{title}
			</span>
			<span className="text-[13px] leading-snug text-[var(--rec-text-2)]">
				{body}
			</span>
		</div>
		{action}
	</div>
);

export const WebRecorderDialog = () => {
	const [open, setOpen] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [sharedScreen, setSharedScreen] = useState<SharedScreen | null>(null);
	const sharedScreenRef = useRef<SharedScreen | null>(null);
	const [sharePending, setSharePending] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);
	const cameraPreviewRef = useRef<CameraPreviewWindowHandle>(null);
	const getCameraPreviewStream = useCallback(
		() => cameraPreviewRef.current?.getVideoStream() ?? null,
		[],
	);

	const replaceSharedScreen = useCallback((next: SharedScreen | null) => {
		sharedScreenRef.current = next;
		setSharedScreen(next);
	}, []);

	const stopSharing = useCallback(() => {
		stopStream(sharedScreenRef.current?.stream ?? null);
		replaceSharedScreen(null);
	}, [replaceSharedScreen]);

	useEffect(
		() => () => {
			stopStream(sharedScreenRef.current?.stream ?? null);
			sharedScreenRef.current = null;
		},
		[],
	);

	// The recorder takes ownership of the shared screen when it starts, so the
	// dialog forgets it rather than stopping it.
	const takeSharedDisplayStream = useCallback(() => {
		const shared = sharedScreenRef.current;
		replaceSharedScreen(null);
		const live = shared?.stream
			.getVideoTracks()
			.some((track) => track.readyState === "live");
		return live ? (shared?.stream ?? null) : null;
	}, [replaceSharedScreen]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const startSound = new Audio("/sounds/start-recording.ogg");
		startSound.preload = "auto";
		const stopSound = new Audio("/sounds/stop-recording.ogg");
		stopSound.preload = "auto";

		startSoundRef.current = startSound;
		stopSoundRef.current = stopSound;

		return () => {
			startSound.pause();
			stopSound.pause();
			startSoundRef.current = null;
			stopSoundRef.current = null;
		};
	}, []);

	const playAudio = useCallback((audio: HTMLAudioElement | null) => {
		if (!audio) {
			return;
		}
		audio.currentTime = 0;
		void audio.play().catch(() => {
			/* ignore */
		});
	}, []);

	const handleRecordingStartSound = useCallback(() => {
		playAudio(startSoundRef.current);
	}, [playAudio]);

	const handleRecordingStopSound = useCallback(() => {
		playAudio(stopSoundRef.current);
	}, [playAudio]);

	const [countdown, setCountdown] = useState<number | null>(null);
	const finishCountdownRef = useRef<(() => void) | null>(null);
	const tickContextRef = useRef<AudioContext | null>(null);
	useEffect(
		() => () => {
			void tickContextRef.current?.close().catch(() => {});
		},
		[],
	);
	const playTick = useCallback(() => {
		try {
			const context = tickContextRef.current ?? new AudioContext();
			tickContextRef.current = context;
			void context.resume();
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const now = context.currentTime;
			oscillator.type = "sine";
			oscillator.frequency.value = 880;
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
			oscillator.connect(gain).connect(context.destination);
			oscillator.start(now);
			oscillator.stop(now + 0.2);
		} catch {
			/* sound is a nicety */
		}
	}, []);
	const runCountdown = useCallback(
		() =>
			new Promise<void>((resolve) => {
				let remaining = 3;
				let timer = 0;
				const finish = () => {
					window.clearTimeout(timer);
					finishCountdownRef.current = null;
					setCountdown(null);
					resolve();
				};
				finishCountdownRef.current = finish;
				const step = () => {
					if (remaining === 0) {
						finish();
						return;
					}
					setCountdown(remaining);
					playTick();
					remaining -= 1;
					timer = window.setTimeout(step, 1000);
				};
				step();
			}),
		[playTick],
	);

	const { activeOrganization, user } = useDashboardContext();
	const organisationId = activeOrganization?.organization.id;
	const { devices: availableMics, refresh: refreshMics } =
		useMicrophoneDevices(open);
	const { devices: availableCameras, refresh: refreshCameras } =
		useCameraDevices(open);

	const {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		systemAudioEnabled,
		setSelectedCameraId,
		handleCameraChange,
		handleMicChange,
		handleSystemAudioChange,
		handleRememberDevicesChange,
	} = useDevicePreferences({
		open,
		availableCameras,
		availableMics,
	});

	const micEnabled = selectedMicId !== null;
	const cameraEnabled = selectedCameraId !== null;

	// With access already granted, open with the camera and mic on so the
	// first thing people see is themselves. Remembered choices win.
	const autoSelectedRef = useRef({ camera: false, mic: false });
	useEffect(() => {
		const done = autoSelectedRef.current;
		if (!open) {
			done.camera = false;
			done.mic = false;
			return;
		}
		if (rememberDevices) return;
		const camera = availableCameras[0];
		if (!done.camera && camera) {
			done.camera = true;
			if (!selectedCameraId) handleCameraChange(camera.deviceId);
		}
		const mic = availableMics[0];
		if (!done.mic && mic) {
			done.mic = true;
			if (!selectedMicId) handleMicChange(mic.deviceId);
		}
	}, [
		open,
		rememberDevices,
		availableCameras,
		availableMics,
		selectedCameraId,
		selectedMicId,
		handleCameraChange,
		handleMicChange,
	]);

	const lastCameraIdRef = useRef<string | null>(null);
	const lastMicIdRef = useRef<string | null>(null);
	if (selectedCameraId) lastCameraIdRef.current = selectedCameraId;
	if (selectedMicId) lastMicIdRef.current = selectedMicId;

	const [requestingAccess, setRequestingAccess] = useState(false);
	const requestAccess = useCallback(
		async (kinds: { video: boolean; audio: boolean }) => {
			setRequestingAccess(true);
			try {
				const stream = await navigator.mediaDevices.getUserMedia(kinds);
				stopStream(stream);
				await Promise.all([refreshCameras(), refreshMics()]);
			} catch {
				toast.error(
					"Your browser blocked access. Allow the camera and microphone in the address bar, then try again.",
				);
			} finally {
				setRequestingAccess(false);
			}
		},
		[refreshCameras, refreshMics],
	);

	const toggleCamera = () => {
		if (cameraEnabled) {
			handleCameraChange(null);
			return;
		}
		if (availableCameras.length === 0) {
			void requestAccess({ video: true, audio: availableMics.length === 0 });
			return;
		}
		const remembered = availableCameras.find(
			(camera) => camera.deviceId === lastCameraIdRef.current,
		);
		handleCameraChange((remembered ?? availableCameras[0])?.deviceId ?? null);
	};

	const toggleMic = () => {
		if (micEnabled) {
			handleMicChange(null);
			return;
		}
		if (availableMics.length === 0) {
			void requestAccess({
				video: availableCameras.length === 0,
				audio: true,
			});
			return;
		}
		const remembered = availableMics.find(
			(mic) => mic.deviceId === lastMicIdRef.current,
		);
		handleMicChange((remembered ?? availableMics[0])?.deviceId ?? null);
	};

	const shareScreen = useCallback(async () => {
		setSharePending(true);
		try {
			const stream = await acquireDisplayStream({
				mode: "fullscreen",
				systemAudioEnabled,
				onSystemAudioFallback: () => {
					toast.warning(
						"System audio isn't supported in this browser. Recording without it.",
					);
				},
			});
			await cameraPreviewRef.current?.closePictureInPicture();
			stopStream(sharedScreenRef.current?.stream ?? null);
			const track = stream.getVideoTracks()[0] ?? null;
			const shared: SharedScreen = {
				stream,
				surface: detectRecordingModeFromTrack(track) ?? "fullscreen",
			};
			track?.addEventListener("ended", () => {
				if (sharedScreenRef.current === shared) replaceSharedScreen(null);
			});
			replaceSharedScreen(shared);
			return true;
		} catch (error) {
			if (
				!(error instanceof DOMException && error.name === "NotAllowedError")
			) {
				console.error("Screen share failed", error);
				toast.error("Couldn't share your screen. Try again.");
			}
			return false;
		} finally {
			setSharePending(false);
		}
	}, [replaceSharedScreen, systemAudioEnabled]);

	const {
		phase,
		durationMs,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		cameraErrorDownload,
		audioErrorDownloads,
		completedShareUrl,
		completedEditUrl,
		recoveredDownloads,
		isSettingUp,
		isRecording,
		isPaused,
		isBusy,
		isRestarting,
		canStartRecording,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		openCompletedShareUrl,
		restartRecording,
		resetState,
		dismissRecoveredDownload,
		getActiveCameraStream,
		getActiveDisplayStream,
		recordedBytes,
	} = useWebRecorder({
		organisationId,
		selectedMicId,
		micEnabled,
		systemAudioEnabled,
		recordingMode,
		selectedCameraId,
		getCameraPreviewStream,
		onDisplayStreamAcquired: async () => {
			await cameraPreviewRef.current?.closePictureInPicture();
		},
		takeSharedDisplayStream,
		isProUser: user.isPro,
		onRecordingSurfaceDetected: (mode) => {
			setRecordingMode(mode);
		},
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
		beforeRecordingStarts: runCountdown,
	});
	const activeCameraGetterRef = useRef(getActiveCameraStream);
	activeCameraGetterRef.current = getActiveCameraStream;
	const activeDisplayGetterRef = useRef(getActiveDisplayStream);
	activeDisplayGetterRef.current = getActiveDisplayStream;
	// Camera-only recordings own their camera stream; screen recordings keep
	// recording a clone of the preview, so fall back to that.
	const getLiveCamera = useCallback(
		() => activeCameraGetterRef.current() ?? getCameraPreviewStream(),
		[getCameraPreviewStream],
	);
	const getRecordingScreen = useCallback(
		() => activeDisplayGetterRef.current(),
		[],
	);

	useEffect(() => {
		if (!isSettingUp) finishCountdownRef.current?.();
	}, [isSettingUp]);

	const screenSupported = !supportCheckCompleted || supportsDisplayRecording;

	// What gets recorded follows what's switched on: a shared screen records
	// the screen (plus the camera as its own track), otherwise the camera.
	useEffect(() => {
		if (phase !== "idle" || isSettingUp) return;
		setRecordingMode(
			sharedScreen
				? sharedScreen.surface
				: cameraEnabled || !screenSupported
					? "camera"
					: "fullscreen",
		);
	}, [phase, isSettingUp, sharedScreen, cameraEnabled, screenSupported]);

	const {
		handlePointerDownOutside,
		handleFocusOutside,
		handleInteractOutside,
	} = useDialogInteractions({
		dialogContentRef,
		isRecording,
		isBusy,
	});

	const handleOpenChange = (next: boolean) => {
		if (next && supportCheckCompleted && !isBrowserSupported) {
			toast.error(
				"This browser isn't compatible with Cap's web recorder. We recommend Google Chrome or other Chromium-based browsers.",
			);
			return;
		}

		if (!next && isBusy) {
			toast.info("Keep this page open while your upload finishes.");
			return;
		}

		if (!next) {
			void resetState();
			stopSharing();
			setHowOpen(false);
			setAudioGuideOpen(false);
			setAudioGuide(null);
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
		}
		setOpen(next);
	};

	const handleStopClick = () => {
		stopRecording().catch((err: unknown) => {
			console.error("Stop recording error", err);
		});
	};

	const startRecordingRef = useRef(startRecording);
	startRecordingRef.current = startRecording;

	const [audioGuide, setAudioGuide] = useState<{
		thenRecord: boolean;
	} | null>(null);
	const [audioGuideDismissed, setAudioGuideDismissed] = useState(false);
	useEffect(() => {
		try {
			setAudioGuideDismissed(
				window.localStorage.getItem(AUDIO_GUIDE_DISMISSED_KEY) === "true",
			);
		} catch {
			/* the guide just keeps showing */
		}
	}, []);

	const shareThenMaybeRecord = async (thenRecord: boolean) => {
		const shared = await shareScreen();
		if (shared && thenRecord) await startRecordingRef.current();
	};

	// Sharing with system audio on goes through the guide first; the popup
	// covers anything shown while it's open.
	const beginShare = (thenRecord = false) => {
		if (systemAudioEnabled && !audioGuideDismissed) {
			setAudioGuide({ thenRecord });
			return;
		}
		void shareThenMaybeRecord(thenRecord);
	};

	const continueFromAudioGuide = (dontShowAgain: boolean) => {
		const thenRecord = audioGuide?.thenRecord ?? false;
		setAudioGuide(null);
		if (dontShowAgain) {
			setAudioGuideDismissed(true);
			try {
				window.localStorage.setItem(AUDIO_GUIDE_DISMISSED_KEY, "true");
			} catch {
				/* remembered for this visit only */
			}
		}
		void shareThenMaybeRecord(thenRecord);
	};

	const handleRecordClick = async () => {
		const screenReady = sharedScreenRef.current !== null;
		if (!screenReady && !cameraEnabled && screenSupported) {
			beginShare(true);
			return;
		}

		if (!screenReady && recordingMode === "camera") {
			cameraPreviewRef.current?.stopStream();
			await waitForNextFrame();
		}

		await startRecording();
	};

	const handleClose = () => {
		if (!isBusy) {
			handleOpenChange(false);
		}
	};

	const screenMode = recordingMode !== "camera";
	const finishing =
		phase === "creating" || phase === "converting" || phase === "uploading";
	const recordingScreen = useLiveStream(
		getRecordingScreen,
		open && (isSettingUp || isRecording),
	);
	const screenStream = sharedScreen?.stream ?? recordingScreen;
	const stage =
		phase === "error"
			? "error"
			: phase === "completed"
				? "opening"
				: finishing
					? "finishing"
					: isRecording
						? "recording"
						: countdown !== null
							? "countdown"
							: isSettingUp
								? screenMode && !screenStream
									? "picking"
									: "starting"
								: "setup";
	const live = stage === "recording";
	const showCameraPreview =
		selectedCameraId &&
		(recordingMode !== "camera" || (!isSettingUp && !isBusy));
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);
	const previewStream = useLiveStream(
		getCameraPreviewStream,
		open && cameraEnabled && (stage === "setup" || stage === "starting"),
	);
	const liveCameraStream = useLiveStream(
		getLiveCamera,
		open && cameraEnabled && (stage === "recording" || stage === "countdown"),
	);
	const cameraStream =
		stage === "recording" || stage === "countdown"
			? liveCameraStream
			: previewStream;
	const micLevel = useMicLevel(
		selectedMicId,
		open &&
			(stage === "setup" ||
				stage === "starting" ||
				stage === "countdown" ||
				stage === "recording"),
	);
	const [micSamples, setMicSamples] = useState<number[]>([]);
	const micLevelRef = useRef(micLevel);
	micLevelRef.current = micLevel;
	useEffect(() => {
		if (!isRecording) {
			if (phase === "idle") setMicSamples([]);
			return;
		}
		if (isPaused) return;
		const interval = window.setInterval(() => {
			setMicSamples((samples) => [...samples, micLevelRef.current]);
		}, WAVE_SAMPLE_MS);
		return () => window.clearInterval(interval);
	}, [isRecording, isPaused, phase]);
	const [howOpen, setHowOpen] = useState(false);
	// Watching your own screen while recording it is distracting (and shows up
	// in the capture), so the preview starts hidden once recording begins.
	const [livePreview, setLivePreviewState] = useState(false);
	useEffect(() => {
		try {
			setLivePreviewState(
				window.localStorage.getItem(LIVE_PREVIEW_KEY) === "true",
			);
		} catch {
			/* hidden by default */
		}
	}, []);
	const setLivePreview = useCallback((next: boolean) => {
		setLivePreviewState(next);
		try {
			window.localStorage.setItem(LIVE_PREVIEW_KEY, next ? "true" : "false");
		} catch {
			/* remembered for this visit only */
		}
	}, []);
	const [audioGuideOpen, setAudioGuideOpen] = useState(false);

	useEffect(() => {
		if (countdown === null) return;
		const previous = document.title;
		document.title = `Recording in ${countdown}… · Cap`;
		return () => {
			document.title = previous;
		};
	}, [countdown]);

	useEffect(() => {
		if (!isRecording) return;
		const previous = document.title;
		document.title = `${isPaused ? "Paused" : "Recording"} ${formatClock(recordingTimerDisplayMs)} · Cap`;
		return () => {
			document.title = previous;
		};
	}, [isRecording, isPaused, recordingTimerDisplayMs]);

	const setupLocked = stage !== "setup";
	const screenOn = live ? screenMode : sharedScreen !== null;
	const systemAudioOn =
		systemAudioEnabled &&
		(live
			? screenMode && (recordingScreen?.getAudioTracks().length ?? 0) > 0
			: sharedScreen
				? sharedScreen.stream.getAudioTracks().length > 0
				: true);
	const sourceWords = [
		...(screenOn ? ["screen"] : []),
		...(cameraEnabled ? ["camera"] : []),
		...(micEnabled ? ["mic"] : []),
		...(screenSupported && systemAudioOn && (screenOn || !cameraEnabled)
			? ["computer sound"]
			: []),
	];
	const trackCount = sourceWords.length;
	const recordedWordsRef = useRef<string[]>([]);
	if (live) recordedWordsRef.current = sourceWords;

	const scaleMs = Math.max(
		60_000,
		Math.ceil((durationMs + 6_000) / 60_000) * 60_000,
	);
	const playheadPct = Math.min(100, (durationMs / scaleMs) * 100);
	const sentBytes = chunkUploads.reduce(
		(total, chunk) =>
			total +
			(chunk.status === "complete" ? chunk.sizeBytes : chunk.uploadedBytes),
		0,
	);
	const partsSent = chunkUploads.filter(
		(chunk) => chunk.status === "complete",
	).length;
	const totalBytes = Math.max(
		recordedBytes,
		chunkUploads.reduce((total, chunk) => total + chunk.sizeBytes, 0),
	);
	const saveProgress =
		phase === "uploading" && totalBytes > 0
			? Math.min(0.99, sentBytes / totalBytes)
			: null;

	const segment = (label: ReactNode) => (
		<span
			className="rec-segment absolute inset-y-1.5 left-0 flex items-center overflow-hidden rounded-md pl-2.5 text-[12px] font-medium transition-[width] duration-500 ease-out"
			style={{ width: `${Math.max(playheadPct, 0.8)}%` }}
		>
			<span className="relative truncate">{label}</span>
		</span>
	);
	const notRecording = (
		<span className="text-[13px] text-[var(--rec-text-3)]">Not recording</span>
	);
	const laneText = (text: string) => (
		<span className="truncate px-2 text-[13px] text-[var(--rec-text-1)]">
			{text}
		</span>
	);
	const offText = (text = "Off") => (
		<span className="truncate px-2 text-[13px] text-[var(--rec-text-3)]">
			{text}
		</span>
	);

	const screenTile = screenSupported && (
		<div
			className={clsx(
				"rec-tile relative overflow-hidden rounded-[10px]",
				screenStream
					? "bg-[var(--rec-media)]"
					: "bg-[var(--rec-card-2)] shadow-[inset_0_0_0_1px_var(--rec-line)]",
			)}
		>
			{screenStream ? (
				<>
					<LiveVideo
						stream={screenStream}
						mirror={false}
						className="absolute inset-0 size-full object-contain"
					/>
					<MediaLabel className="left-2.5 top-2.5">
						{live ? (
							<LiveDot paused={isPaused} />
						) : (
							<MonitorIcon className="size-3.5" aria-hidden />
						)}
						Screen
					</MediaLabel>
				</>
			) : sharePending ? (
				<EmptyTile
					icon={<LoaderCircleIcon className="size-[18px] animate-spin" />}
					title="Pick what to share"
					body="Choose a screen, window or tab in your browser's popup, then click Share."
				/>
			) : (
				<EmptyTile
					icon={<MonitorIcon className="size-[18px]" />}
					title="Share your screen"
					body="A screen, window or tab. It records on its own track."
					action={
						<button
							type="button"
							className="rec-btn mt-1"
							onClick={() => beginShare()}
							disabled={setupLocked}
						>
							Choose what to share
						</button>
					}
				/>
			)}
		</div>
	);

	const cameraTile = (
		<div
			className={clsx(
				"rec-tile relative overflow-hidden rounded-[10px]",
				cameraEnabled
					? "bg-[var(--rec-media)]"
					: "bg-[var(--rec-card-2)] shadow-[inset_0_0_0_1px_var(--rec-line)]",
			)}
		>
			{cameraEnabled ? (
				cameraStream ? (
					<LiveVideo
						stream={cameraStream}
						className="absolute inset-0 size-full object-cover"
					/>
				) : (
					<div className="absolute inset-0 flex items-center justify-center">
						<LoaderCircleIcon
							className="size-5 animate-spin text-white/50"
							aria-hidden
						/>
					</div>
				)
			) : availableCameras.length === 0 ? (
				<EmptyTile
					icon={<CameraIcon className="size-[18px]" />}
					title="Show your face"
					body="Allow your camera and mic to record yourself on separate tracks."
					action={
						<button
							type="button"
							className="rec-btn mt-1"
							onClick={() => void requestAccess({ video: true, audio: true })}
							disabled={requestingAccess || setupLocked}
						>
							Allow camera and mic
						</button>
					}
				/>
			) : (
				<EmptyTile
					icon={<CameraIcon className="size-[18px]" />}
					title="Camera is off"
					body="Turn it on to record yourself on a separate track."
					action={
						<button
							type="button"
							className="rec-btn mt-1"
							onClick={toggleCamera}
							disabled={setupLocked}
						>
							Turn on camera
						</button>
					}
				/>
			)}
			{cameraEnabled && (
				<MediaLabel className="left-2.5 top-2.5">
					{live ? (
						<LiveDot paused={isPaused} />
					) : (
						<CameraIcon className="size-3.5" aria-hidden />
					)}
					Camera
				</MediaLabel>
			)}
			{cameraEnabled && !live && (
				<MediaLabel className="right-2.5 top-2.5 bg-black/35 font-normal text-white/80">
					Preview
				</MediaLabel>
			)}
		</div>
	);

	const transport = live ? (
		<>
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					className="rec-btn is-ghost"
					disabled={isRestarting}
					onClick={() => {
						void restartRecording();
					}}
				>
					<RotateCcwIcon className="size-3.5" aria-hidden />
					<span className="hidden sm:inline">Start over</span>
				</button>
				<button
					type="button"
					className="rec-btn"
					onClick={() => {
						void (isPaused ? resumeRecording() : pauseRecording());
					}}
				>
					{isPaused ? (
						<PlayIcon className="size-3.5" aria-hidden />
					) : (
						<PauseIcon className="size-3.5" aria-hidden />
					)}
					{isPaused ? "Resume" : "Pause"}
				</button>
			</div>
			<RecordButton
				recording
				elapsed={formatClock(durationMs)}
				onClick={handleStopClick}
			/>
			<div className="flex flex-col items-end gap-0.5">
				{!user.isPro && (
					<>
						<span className="text-[17px] font-medium tabular-nums leading-none">
							{formatClock(recordingTimerDisplayMs)}
						</span>
						<span className="text-[12px] leading-none text-[var(--rec-text-3)]">
							left on Free
						</span>
					</>
				)}
			</div>
		</>
	) : (
		<>
			<div className="min-w-0 text-[13px] leading-snug">
				<span className="block truncate text-[var(--rec-text-1)]">
					{trackCount === 0
						? "Nothing switched on yet"
						: `${joinWords(sourceWords).replace(/^./, (c) => c.toUpperCase())}`}
				</span>
				<span className="block truncate text-[var(--rec-text-3)]">
					{trackCount === 0
						? screenSupported
							? "Press record to choose a screen"
							: "Turn on your camera to record"
						: `${trackCount} separate ${trackCount === 1 ? "track" : "tracks"}`}
				</span>
			</div>
			<RecordButton
				recording={false}
				busy={
					stage === "starting" || stage === "picking" || stage === "countdown"
				}
				disabled={
					!canStartRecording ||
					sharePending ||
					(!screenSupported && !cameraEnabled)
				}
				onClick={() => {
					void handleRecordClick();
				}}
			/>
			<div className="flex flex-col items-end gap-0.5">
				{!user.isPro && (
					<>
						<span className="text-[17px] font-medium tabular-nums leading-none text-[var(--rec-text-3)]">
							{formatClock(FREE_PLAN_MAX_RECORDING_MS)}
						</span>
						<span className="text-[12px] leading-none text-[var(--rec-text-3)]">
							on Free
						</span>
					</>
				)}
			</div>
		</>
	);

	const cameraName =
		availableCameras.find((camera) => camera.deviceId === selectedCameraId)
			?.label || "Camera";

	const tracks = (
		<section className="rec-card flex shrink-0 flex-col gap-1.5 p-1.5">
			<header className="flex h-8 items-center justify-between gap-3 pl-2 pr-0.5">
				<span className="text-[12px] font-medium text-[var(--rec-text-2)]">
					Tracks
				</span>
				<span className="flex min-w-0 items-center gap-2">
					{live ? (
						<span className="flex min-w-0 items-center gap-2 truncate text-[12px] text-[var(--rec-text-2)]">
							<svg
								viewBox="0 0 24 8"
								className="h-2 w-6 shrink-0"
								aria-hidden="true"
							>
								<path
									d="M 1 4 L 23 4"
									className="rec-ink rec-march"
									style={{ strokeWidth: 2, stroke: "var(--rec-accent)" }}
								/>
							</svg>
							<span className="truncate">
								{partsSent === 0
									? "Uploading as you record"
									: `Uploading as you record · ${partsSent} ${partsSent === 1 ? "part" : "parts"} sent`}
							</span>
						</span>
					) : (
						<span className="hidden truncate text-[12px] text-[var(--rec-text-3)] sm:inline">
							Each track stays separate in the editor
						</span>
					)}
					{!live && (
						<OptionsMenu
							disabled={setupLocked}
							rememberDevices={rememberDevices}
							onRememberDevicesChange={handleRememberDevicesChange}
						/>
					)}
				</span>
			</header>
			<div
				className="relative -mb-0.5 h-4 [--gutter:calc(6px+8.5rem+8px)] sm:[--gutter:calc(6px+10rem+8px)]"
				aria-hidden="true"
			>
				{[0, 1, 2, 3, 4].map((tick) => (
					<span
						key={tick}
						className="absolute top-0 flex h-full items-start gap-1 text-[11px] tabular-nums leading-none text-[var(--rec-text-3)]"
						style={{
							left: `calc(var(--gutter) + (100% - var(--gutter) - 6px) * ${tick / 4})`,
						}}
					>
						<span className="h-full w-px bg-[var(--rec-line-strong)]" />
						{tick < 4 && formatClock((scaleMs / 4) * tick)}
					</span>
				))}
			</div>
			<ul className="relative flex flex-col gap-1.5 [--gutter:calc(6px+8.5rem+8px)] sm:[--gutter:calc(6px+10rem+8px)]">
				{screenSupported && (
					<TrackRow
						kind="screen"
						icon={MonitorIcon}
						label="Screen"
						on={screenOn}
						actions={
							!live && (
								<>
									{sharedScreen && (
										<button
											type="button"
											className="rec-btn is-ghost !h-7 !px-2.5 !text-[12px]"
											onClick={() => beginShare()}
											disabled={setupLocked || sharePending}
										>
											Change
										</button>
									)}
									<Switch
										label="Share screen"
										on={sharedScreen !== null}
										disabled={setupLocked || sharePending}
										onChange={(next) => {
											if (next) beginShare();
											else stopSharing();
										}}
									/>
								</>
							)
						}
					>
						{live
							? screenMode
								? segment(SURFACE_LABELS[recordingMode])
								: notRecording
							: sharePending
								? offText("Choose in your browser's popup")
								: sharedScreen
									? laneText(SURFACE_LABELS[sharedScreen.surface])
									: offText("Not shared")}
					</TrackRow>
				)}
				<TrackRow
					kind="camera"
					icon={CameraIcon}
					label="Camera"
					on={cameraEnabled}
					actions={
						!live &&
						(availableCameras.length === 0 ? (
							<button
								type="button"
								className="rec-btn !h-7 !px-2.5 !text-[12px]"
								onClick={() => void requestAccess({ video: true, audio: true })}
								disabled={requestingAccess || setupLocked}
							>
								Allow access
							</button>
						) : (
							<Switch
								label="Camera"
								on={cameraEnabled}
								disabled={setupLocked || requestingAccess}
								onChange={toggleCamera}
							/>
						))
					}
				>
					{live ? (
						cameraEnabled ? (
							segment(cameraName)
						) : (
							notRecording
						)
					) : cameraEnabled ? (
						<DeviceMenu
							title="Camera"
							devices={availableCameras}
							selectedId={selectedCameraId}
							fallbackName="Camera"
							disabled={setupLocked}
							onSelect={handleCameraChange}
						/>
					) : (
						offText(availableCameras.length === 0 ? "Needs permission" : "Off")
					)}
				</TrackRow>
				<TrackRow
					kind="mic"
					icon={MicIcon}
					label="Microphone"
					on={micEnabled}
					actions={
						!live &&
						(availableMics.length === 0 ? (
							<button
								type="button"
								className="rec-btn !h-7 !px-2.5 !text-[12px]"
								onClick={() =>
									void requestAccess({ video: false, audio: true })
								}
								disabled={requestingAccess || setupLocked}
							>
								Allow access
							</button>
						) : (
							<Switch
								label="Microphone"
								on={micEnabled}
								disabled={setupLocked || requestingAccess}
								onChange={toggleMic}
							/>
						))
					}
				>
					{live ? (
						micEnabled ? (
							<>
								{segment(null)}
								<span
									className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-500 ease-out"
									style={{ width: `${Math.max(playheadPct, 0.8)}%` }}
								>
									<span
										className="absolute inset-y-0 left-0"
										style={{
											width: `${10000 / Math.max(playheadPct, 0.8)}%`,
										}}
									>
										<Waveform
											samples={micSamples}
											span={scaleMs / WAVE_SAMPLE_MS}
										/>
									</span>
								</span>
							</>
						) : (
							notRecording
						)
					) : micEnabled ? (
						<>
							<DeviceMenu
								title="Microphone"
								devices={availableMics}
								selectedId={selectedMicId}
								fallbackName="Microphone"
								disabled={setupLocked}
								onSelect={handleMicChange}
							/>
							<MicMeter level={micLevel} />
						</>
					) : (
						offText(availableMics.length === 0 ? "Needs permission" : "Muted")
					)}
				</TrackRow>
				{screenSupported && (
					<TrackRow
						kind="system"
						icon={Volume2Icon}
						label="System audio"
						on={systemAudioOn && (live ? screenMode : true)}
						actions={
							!live && (
								<>
									{systemAudioEnabled && sharedScreen && !systemAudioOn ? (
										<button
											type="button"
											className="rec-btn !h-7 !px-2.5 !text-[12px]"
											onClick={() => beginShare()}
											disabled={setupLocked || sharePending}
										>
											Choose again
										</button>
									) : (
										<button
											type="button"
											className="rec-btn is-ghost !h-7 !px-2.5 !text-[12px]"
											onClick={() => setAudioGuideOpen((value) => !value)}
										>
											How to share it
										</button>
									)}
									<Switch
										label="System audio"
										on={systemAudioEnabled}
										disabled={setupLocked}
										onChange={handleSystemAudioChange}
									/>
								</>
							)
						}
					>
						{live
							? systemAudioOn && screenMode
								? segment("Computer sound")
								: notRecording
							: systemAudioEnabled
								? sharedScreen && !systemAudioOn
									? offText("Choose your screen again to include it")
									: laneText("Your computer's sound")
								: offText()}
					</TrackRow>
				)}
				{live && (
					<span
						className="rec-playhead pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-[var(--rec-red)] transition-[left] duration-500 ease-out"
						style={{
							left: `calc(var(--gutter) + (100% - var(--gutter) - 6px) * ${playheadPct / 100})`,
						}}
					>
						<span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-[var(--rec-red)]" />
					</span>
				)}
			</ul>
		</section>
	);

	const notices = (screenCaptureWarning ||
		(!isBrowserSupported && unsupportedReason) ||
		recoveredDownloads.length > 0) && (
		<div className="flex flex-col gap-1.5">
			{screenCaptureWarning && (
				<p className="px-2 text-[12px] leading-snug text-[var(--rec-text-2)]">
					This browser can only record your camera. Use Chrome, Edge or Cap
					Desktop on a computer to record your screen too.
				</p>
			)}
			{!isBrowserSupported && unsupportedReason && (
				<p className="px-2 text-[12px] leading-snug text-[var(--rec-red)]">
					{unsupportedReason}
				</p>
			)}
			{recoveredDownloads.map((download) => (
				<div
					key={download.id}
					className="rec-card flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
				>
					<div className="min-w-0">
						<div className="truncate font-medium">
							Recovered: {download.fileName}
						</div>
						<div className="text-[var(--rec-text-3)]">
							{recoveredRecordingTimeFormatter.format(
								new Date(download.createdAt),
							)}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<a
							href={download.url}
							download={download.fileName}
							className="rec-btn !h-7 !px-2.5 !text-[12px]"
							onClick={() =>
								setTimeout(() => dismissRecoveredDownload(download.id), 500)
							}
						>
							Download
						</a>
						<button
							type="button"
							className="rec-btn is-ghost !h-7 !px-2.5 !text-[12px]"
							onClick={() => dismissRecoveredDownload(download.id)}
						>
							Dismiss
						</button>
					</div>
				</div>
			))}
		</div>
	);

	const overlay =
		stage === "countdown" ? (
			<div className="rec-fade absolute inset-0 z-20 flex flex-col items-center justify-center gap-7 bg-[var(--rec-scrim)] px-4 text-center backdrop-blur-md">
				<CountdownDial value={countdown ?? 1} />
				<div className="flex flex-col items-center gap-1.5">
					<h2 className="text-[20px] font-medium tracking-[-0.01em]">
						Recording in {countdown}
					</h2>
					<p className="max-w-sm text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]">
						{screenMode
							? "When it starts, switch to what you're sharing and present as normal."
							: "Look at the camera and start talking when it hits zero."}
					</p>
				</div>
				<button
					type="button"
					className="rec-btn"
					onClick={() => finishCountdownRef.current?.()}
				>
					Start now
				</button>
			</div>
		) : stage === "picking" ? (
			<div className="rec-fade absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-[var(--rec-scrim)] px-4 text-center backdrop-blur-md">
				<Doodle kind="share" />
				<div className="flex flex-col items-center gap-1.5">
					<h2 className="text-[20px] font-medium tracking-[-0.01em]">
						Choose what to share
					</h2>
					<p className="max-w-sm text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]">
						Pick a screen, window or tab in your browser's popup, then click
						Share.
					</p>
				</div>
			</div>
		) : null;

	const studio = (
		<main className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 sm:px-3 sm:pb-3">
			<section className="rec-card relative flex min-h-[15rem] flex-1 flex-col overflow-hidden">
				{live && (
					<header className="flex h-12 shrink-0 items-center justify-between gap-3 pl-4 pr-2 shadow-[0_1px_0_var(--rec-line)]">
						<span className="flex min-w-0 items-center gap-2.5 text-[13px]">
							<LiveDot paused={isPaused} />
							<span className="truncate">
								<span className="font-medium">
									{isPaused
										? "Paused"
										: screenMode
											? "Switch to what you're sharing"
											: "Recording"}
								</span>
								<span className="text-[var(--rec-text-2)]">
									{isPaused
										? " · Resume when you're ready"
										: screenMode
											? " · Come back to this tab to stop"
											: " · Stop when you're done"}
								</span>
							</span>
						</span>
						{screenMode && (
							<span className="flex shrink-0 items-center gap-1 pl-2 text-[13px] text-[var(--rec-text-2)]">
								Preview
								<Switch
									label="Show preview"
									on={livePreview}
									onChange={setLivePreview}
								/>
							</span>
						)}
					</header>
				)}
				{live && screenMode && !livePreview ? (
					<div className="rec-fade flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-6 text-center">
						<span className="relative flex size-20 items-center justify-center">
							{!isPaused && (
								<>
									<span className="rec-ripple absolute inset-0 rounded-full" />
									<span
										className="rec-ripple absolute inset-0 rounded-full"
										style={{ animationDelay: "1.2s" }}
									/>
								</>
							)}
							<span className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--rec-red)_14%,transparent)]">
								<span
									className={clsx(
										"size-4 rounded-full",
										isPaused ? "bg-[var(--rec-text-3)]" : "bg-[var(--rec-red)]",
									)}
								/>
							</span>
						</span>
						<div className="flex flex-col items-center gap-1.5">
							<span className="text-[44px] font-medium tabular-nums leading-none tracking-[-0.02em]">
								{formatClock(durationMs)}
							</span>
							<span className="max-w-sm text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]">
								{isPaused
									? "Paused. Nothing is being recorded until you resume."
									: `Recording your ${joinWords(recordedWordsRef.current)}. The preview is hidden so it stays out of your way.`}
							</span>
						</div>
						<button
							type="button"
							className="rec-btn is-ghost"
							onClick={() => setLivePreview(true)}
						>
							Show preview
						</button>
					</div>
				) : (
					<div
						className={clsx(
							"rec-stage min-h-0 flex-1 p-3 sm:p-4",
							screenSupported ? "is-pair" : "is-single",
						)}
					>
						<div className="rec-tiles">
							{screenTile}
							{cameraTile}
						</div>
					</div>
				)}
				<footer className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 shadow-[0_-1px_0_var(--rec-line)]">
					{transport}
				</footer>
			</section>
			{tracks}
			{notices}
		</main>
	);

	const statusView = (
		doodle: "upload" | "done" | "error",
		title: string,
		body: string,
		extra?: ReactNode,
	) => (
		<main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-16 pt-6 text-center">
			<Doodle kind={doodle} />
			<h2
				key={title}
				className="rec-rise mt-6 text-balance text-[24px] font-medium tracking-[-0.01em]"
			>
				{title}
			</h2>
			<p
				key={body}
				className="rec-rise mt-2 max-w-md text-balance text-[15px] leading-relaxed text-[var(--rec-text-2)]"
				style={{ "--d": "0.05s" } as CSSProperties}
			>
				{body}
			</p>
			{extra}
		</main>
	);

	const savedTracks = (done: boolean) => (
		<ul
			className="rec-rise mt-8 flex flex-wrap items-center justify-center gap-1.5"
			style={{ "--d": "0.15s" } as CSSProperties}
		>
			{recordedWordsRef.current.map((word) => (
				<li
					key={word}
					className="rec-track flex h-8 items-center gap-2 rounded-lg bg-[var(--rec-ctl)] pl-1 pr-3 text-[13px]"
					data-kind={
						word === "screen"
							? "screen"
							: word === "camera"
								? "camera"
								: word === "mic"
									? "mic"
									: "system"
					}
				>
					<span className="rec-track-tile flex size-6 items-center justify-center rounded-md">
						{word === "screen" ? (
							<MonitorIcon className="size-3.5" aria-hidden />
						) : word === "camera" ? (
							<CameraIcon className="size-3.5" aria-hidden />
						) : word === "mic" ? (
							<MicIcon className="size-3.5" aria-hidden />
						) : (
							<Volume2Icon className="size-3.5" aria-hidden />
						)}
					</span>
					{word.replace(/^./, (c) => c.toUpperCase())}
					{done ? (
						<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
							<path
								className="rec-ink rec-draw"
								pathLength={1}
								style={{ strokeWidth: 2.2, stroke: "var(--rec-green)" }}
								d="M 3 8.5 L 6.5 12 L 13 4.5"
							/>
						</svg>
					) : (
						<LoaderCircleIcon
							className="size-3.5 animate-spin text-[var(--rec-text-3)]"
							aria-hidden
						/>
					)}
				</li>
			))}
		</ul>
	);

	const body =
		stage === "finishing"
			? statusView(
					"upload",
					"Saving your recording",
					"Your link is already live. The editor opens as soon as the last parts land.",
					<>
						<div className="mt-9">
							<Squiggle progress={saveProgress} />
						</div>
						{savedTracks(false)}
					</>,
				)
			: stage === "opening"
				? statusView(
						"done",
						"Opening the editor",
						"Your recording is saved and your link is live. Every track is ready to edit.",
						<>
							{savedTracks(true)}
							{completedEditUrl && (
								<a
									href={completedEditUrl}
									className="rec-btn rec-rise mt-7"
									style={{ "--d": "0.4s" } as CSSProperties}
								>
									Open the editor
								</a>
							)}
						</>,
					)
				: stage === "error"
					? statusView(
							"error",
							"Your recording didn't finish saving",
							"Download the recovered files from the bar at the top of the page, or close this and try again.",
							<div className="mt-7 flex gap-2">
								{completedShareUrl && (
									<button
										type="button"
										className="rec-btn is-accent"
										onClick={openCompletedShareUrl}
									>
										Open recording
									</button>
								)}
								<button type="button" className="rec-btn" onClick={handleClose}>
									Close
								</button>
							</div>,
						)
					: studio;

	return (
		<>
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogTrigger asChild>
					<Button variant="blue" size="sm" className="flex items-center gap-2">
						<MonitorIcon className="size-3.5" />
						Record in Browser
					</Button>
				</DialogTrigger>
				<DialogContent
					ref={dialogContentRef}
					className="cap-rec flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-[var(--rec-window)] p-0 shadow-none [&>button]:hidden"
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
					onEscapeKeyDown={(event) => {
						if (isBusy || isSettingUp || howOpen) event.preventDefault();
					}}
				>
					<DialogTitle className="sr-only">New recording</DialogTitle>
					{/* A full-screen flow: the support launcher would sit over its controls. */}
					<style>{".cap-messenger-launcher{display:none!important}"}</style>
					<BoilFilter />
					<WebRecorderDialogHeader
						isBusy={isBusy || isSettingUp}
						freeMinutes={freeMinutes}
						onClose={handleClose}
						onShowHowItWorks={
							stage === "setup" ? () => setHowOpen(true) : undefined
						}
					/>
					<div className="relative flex min-h-0 flex-1 flex-col">
						{body}
						{overlay}
						{howOpen && <HowRecordingWorks onClose={() => setHowOpen(false)} />}
						{audioGuide && (
							<SystemAudioGuide
								onContinue={continueFromAudioGuide}
								onClose={() => setAudioGuide(null)}
							/>
						)}
						{audioGuideOpen && !audioGuide && (
							<SystemAudioGuide onClose={() => setAudioGuideOpen(false)} />
						)}
					</div>
				</DialogContent>
			</Dialog>
			{phase === "error" && (
				<InProgressRecordingBar
					phase={phase}
					durationMs={recordingTimerDisplayMs}
					hasAudioTrack={hasAudioTrack}
					chunkUploads={chunkUploads}
					errorDownload={errorDownload}
					cameraErrorDownload={cameraErrorDownload}
					audioErrorDownloads={audioErrorDownloads}
					onStop={handleStopClick}
					onPause={pauseRecording}
					onResume={resumeRecording}
					onRestart={restartRecording}
					isRestarting={isRestarting}
				/>
			)}
			{showCameraPreview && (
				<CameraPreviewWindow
					ref={cameraPreviewRef}
					cameraId={selectedCameraId}
					hidden
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);
};
