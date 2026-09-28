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
	CheckIcon,
	ChevronRightIcon,
	CirclePlayIcon,
	LoaderCircleIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { setRecorderCamera } from "@/actions/video/set-recorder-camera";
import { useDashboardContext } from "../../../Contexts";
import {
	CameraPreviewWindow,
	type CameraPreviewWindowHandle,
} from "./CameraPreviewWindow";
import { CameraBubble, useCameraLayout } from "./camera-layout";
import { capturesThisTab, identifyThisTab } from "./capture-handle";
import { HowRecordingWorks } from "./how-recording-works";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import {
	DeviceMenu,
	OptionsMenu,
	RecordingBar,
	StartRecordingButton,
} from "./recorder-dock";
import {
	BoilFilter,
	CountdownDial,
	Doodle,
	formatClock,
	LevelFill,
	LiveVideo,
	type MicLevelBinding,
	SourceRow,
	Squiggle,
	Switch,
	type TrackKind,
	useLiveStream,
	useMicLevel,
} from "./recorder-parts";
import type { RecordingMode } from "./recording-mode";
import { useRecordingQuality } from "./recording-quality";
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

/**
 * The browser recorder. By default it's a button that opens the recorder
 * full screen; `embedded` renders the recorder inline (the Editor page's
 * Record tab), always open.
 */
export const WebRecorderDialog = ({
	embedded = false,
}: {
	embedded?: boolean;
} = {}) => {
	const [open, setOpen] = useState(embedded);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [sharedScreen, setSharedScreen] = useState<SharedScreen | null>(null);
	const sharedScreenRef = useRef<SharedScreen | null>(null);
	const [sharePending, setSharePending] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);
	const cameraPreviewRef = useRef<CameraPreviewWindowHandle>(null);
	const [quality, setQuality] = useRecordingQuality();
	const [qualityOpen, setQualityOpen] = useState(false);
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
	const finishCountdownRef = useRef<((start?: boolean) => void) | null>(null);
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
			new Promise<boolean>((resolve) => {
				let remaining = 3;
				let timer = 0;
				const finish = (start = true) => {
					window.clearTimeout(timer);
					finishCountdownRef.current = null;
					setCountdown(null);
					resolve(start);
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

	const { activeOrganization, user, webStudioEnabled } = useDashboardContext();
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
				quality: { height: quality.screenHeight, frameRate: quality.frameRate },
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
			setMirrorPreviewShown(false);
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
	}, [replaceSharedScreen, systemAudioEnabled, quality]);

	const {
		phase,
		videoId,
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
		quality,
		studioEnabled: webStudioEnabled,
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
		setOpen(embedded || next);
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
				stage === "picking" ||
				stage === "starting" ||
				stage === "countdown" ||
				stage === "recording"),
	);
	const [howOpen, setHowOpen] = useState(false);
	useEffect(() => {
		if (open) identifyThisTab();
	}, [open]);
	const [cameraLayout, setCameraLayout] = useCameraLayout();

	// The editor and the first render open with the camera where it sat here.
	const savedLayoutForRef = useRef<string | null>(null);
	useEffect(() => {
		if (phase !== "recording" || !videoId || !cameraEnabled || !screenMode)
			return;
		if (savedLayoutForRef.current === videoId) return;
		savedLayoutForRef.current = videoId;
		void setRecorderCamera({
			videoId,
			layout: { version: 1, ...cameraLayout },
		}).catch((error) => {
			console.error("Failed to save the camera layout", error);
		});
	}, [phase, videoId, cameraEnabled, screenMode, cameraLayout]);

	// Fetch the editor route's code while recording so Stop opens it at once.
	const router = useRouter();
	useEffect(() => {
		if (!webStudioEnabled || phase !== "recording" || !videoId) return;
		router.prefetch(`/s/${encodeURIComponent(videoId)}/edit/studio`);
	}, [router, webStudioEnabled, phase, videoId]);
	const [previewFrame, setPreviewFrame] = useState<{
		width: number;
		height: number;
	} | null>(null);
	const previewObserverRef = useRef<ResizeObserver | null>(null);
	const previewRef = useCallback((element: HTMLDivElement | null) => {
		previewObserverRef.current?.disconnect();
		previewObserverRef.current = null;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			setPreviewFrame({
				width: entry.contentRect.width,
				height: entry.contentRect.height,
			});
		});
		observer.observe(element);
		previewObserverRef.current = observer;
	}, []);
	const [livePreview, setLivePreviewState] = useState(false);
	const [mirrorPreviewShown, setMirrorPreviewShown] = useState(false);
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

	const showScreen = screenSupported && screenStream !== null;
	const cameraSettings = cameraStream?.getVideoTracks()[0]?.getSettings();
	const cameraAspect =
		cameraSettings?.width && cameraSettings.height
			? cameraSettings.width / cameraSettings.height
			: 16 / 9;
	const mirrorRisk = useMemo(
		() => capturesThisTab(screenStream),
		[screenStream],
	);
	const dimScreen = mirrorRisk && !mirrorPreviewShown;
	const cameraVideo = cameraEnabled ? (
		cameraStream ? (
			<LiveVideo
				stream={cameraStream}
				mirror={cameraLayout.mirror}
				className="absolute inset-0 size-full object-cover"
			/>
		) : (
			<span className="absolute inset-0 flex items-center justify-center">
				<LoaderCircleIcon
					className="size-5 animate-spin text-white/50"
					aria-hidden
				/>
			</span>
		)
	) : null;

	// What the editor opens with: the screen, with the camera as a rounded
	// bubble in the corner, or the camera on its own.
	const preview = (
		<div
			ref={previewRef}
			className="rec-preview relative overflow-hidden rounded-[10px] bg-[var(--rec-media)] shadow-[0_1px_2px_rgba(0,0,0,0.08),0_12px_32px_-16px_rgba(0,0,0,0.35)]"
		>
			{showScreen ? (
				<>
					<LiveVideo
						stream={screenStream}
						mirror={false}
						className={clsx(
							"absolute inset-0 size-full object-contain transition-opacity duration-500",
							dimScreen ? "opacity-[0.07]" : "opacity-100",
						)}
					/>
					{mirrorRisk && (
						<div
							className={clsx(
								"absolute inset-0 flex items-center justify-center p-6 transition-opacity duration-300",
								dimScreen ? "opacity-100" : "pointer-events-none opacity-0",
							)}
						>
							<div className="flex max-w-sm flex-col items-center gap-2 text-center text-white">
								<span className="text-[14px] font-medium">
									Preview dimmed to avoid a mirror effect
								</span>
								<span className="text-[13px] leading-snug text-white/60">
									{recordingMode === "tab" || sharedScreen?.surface === "tab"
										? "You're sharing this tab"
										: "You're sharing your whole screen"}
									, so showing it here would repeat inside itself. It still
									records in full.
								</span>
								<button
									type="button"
									className="mt-1 h-7 rounded-md bg-white/10 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-white/15"
									onClick={() => setMirrorPreviewShown(true)}
								>
									Show anyway
								</button>
							</div>
						</div>
					)}
					{mirrorRisk && !dimScreen && (
						<button
							type="button"
							className="absolute right-3 top-3 h-6 rounded-md bg-black/55 px-2 text-[12px] font-medium text-white backdrop-blur-md transition-colors hover:bg-black/70"
							onClick={() => setMirrorPreviewShown(false)}
						>
							Dim preview
						</button>
					)}
					<MediaLabel className="left-3 top-3">
						{live ? (
							<LiveDot paused={isPaused} />
						) : (
							<MonitorIcon className="size-3.5" aria-hidden />
						)}
						Screen
					</MediaLabel>
					{cameraEnabled && (
						<CameraBubble
							frame={previewFrame}
							layout={cameraLayout}
							cameraAspect={cameraAspect}
							locked={setupLocked}
							onChange={setCameraLayout}
							label={
								<MediaLabel className="bottom-2 left-1/2 -translate-x-1/2 !h-5 !px-1.5 !text-[11px]">
									{live ? (
										<LiveDot paused={isPaused} />
									) : (
										<CameraIcon className="size-3" aria-hidden />
									)}
									Camera
								</MediaLabel>
							}
						>
							{cameraVideo}
						</CameraBubble>
					)}
					{live && cameraEnabled && (
						<span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white/80 backdrop-blur-md">
							Camera layout is locked while recording. Change it in the editor
							after you stop.
						</span>
					)}
				</>
			) : cameraEnabled ? (
				<>
					{cameraVideo}
					<MediaLabel className="left-3 top-3">
						{live ? (
							<LiveDot paused={isPaused} />
						) : (
							<CameraIcon className="size-3.5" aria-hidden />
						)}
						Camera
					</MediaLabel>
				</>
			) : (
				<span className="absolute inset-0 bg-[var(--rec-card-2)]" />
			)}
			{!live && !showScreen && screenSupported && (
				<div className="absolute inset-x-0 bottom-0 flex justify-center p-4">
					<div className="rec-pop flex items-center gap-3 py-2 pl-3 pr-2 text-[13px]">
						<MonitorIcon
							className="size-4 shrink-0 text-[var(--rec-text-2)]"
							aria-hidden
						/>
						<span className="text-[var(--rec-text-1)]">
							{sharePending
								? "Pick what to share in your browser's popup"
								: "Add your screen, a window or a tab"}
						</span>
						{!sharePending && (
							<button
								type="button"
								className="rec-btn is-accent !h-7 !px-2.5 !text-[12px]"
								onClick={() => beginShare()}
								disabled={setupLocked}
							>
								Share screen
							</button>
						)}
					</div>
				</div>
			)}
			{!live && !cameraEnabled && (
				<div
					className={clsx(
						"absolute flex",
						showScreen
							? "bottom-[5%] right-[3.5%]"
							: "inset-x-0 top-[38%] justify-center",
					)}
				>
					<button
						type="button"
						className="rec-pop flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--rec-text-1)] transition-colors hover:bg-[var(--rec-card-2)]"
						onClick={() =>
							availableCameras.length === 0
								? void requestAccess({ video: true, audio: true })
								: toggleCamera()
						}
						disabled={setupLocked || requestingAccess}
					>
						<CameraIcon
							className="size-4 text-[var(--rec-text-2)]"
							aria-hidden
						/>
						{availableCameras.length === 0
							? "Allow camera and mic"
							: "Turn on camera"}
					</button>
				</div>
			)}
		</div>
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

	const smallBtn = "rec-btn !h-7 !px-2.5 !text-[12px]";

	const showMeHow = (
		<button
			type="button"
			className="rec-focus inline-flex shrink-0 items-center gap-1 rounded px-1 font-medium text-[var(--rec-accent)] hover:underline"
			onClick={() => setAudioGuideOpen(true)}
		>
			<CirclePlayIcon className="size-3" aria-hidden />
			Show me how
		</button>
	);

	const liveBadge = (on: boolean) =>
		on ? (
			<span className="flex items-center gap-1.5 pr-2 text-[12px] text-[var(--rec-text-2)]">
				<LiveDot paused={isPaused} />
				{isPaused ? "Paused" : "Live"}
			</span>
		) : (
			<span className="pr-2 text-[12px] text-[var(--rec-text-3)]">Off</span>
		);

	const sources = (
		<ul className="flex flex-col gap-0.5">
			{screenSupported && (
				<SourceRow
					kind="screen"
					icon={MonitorIcon}
					label="Screen"
					on={live ? screenMode : sharedScreen !== null}
					detail={
						live
							? screenMode
								? SURFACE_LABELS[recordingMode]
								: "Not included"
							: sharePending
								? "Choose in your browser's popup"
								: sharedScreen
									? SURFACE_LABELS[sharedScreen.surface]
									: "Not shared"
					}
					actions={
						live ? (
							liveBadge(screenMode)
						) : (
							<>
								{sharedScreen && (
									<button
										type="button"
										className="rec-btn is-ghost !h-7 !px-2 !text-[12px]"
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
				/>
			)}
			<SourceRow
				kind="camera"
				icon={CameraIcon}
				label="Camera"
				on={cameraEnabled}
				detail={
					availableCameras.length === 0 ? (
						"Needs permission"
					) : (
						<DeviceMenu
							title="Camera"
							devices={availableCameras}
							selectedId={selectedCameraId ?? lastCameraIdRef.current}
							fallbackName="Camera"
							disabled={setupLocked}
							onSelect={handleCameraChange}
						/>
					)
				}
				actions={
					live ? (
						liveBadge(cameraEnabled)
					) : availableCameras.length === 0 ? (
						<button
							type="button"
							className={smallBtn}
							onClick={() => void requestAccess({ video: true, audio: true })}
							disabled={requestingAccess || setupLocked}
						>
							Allow
						</button>
					) : (
						<Switch
							label="Camera"
							on={cameraEnabled}
							disabled={setupLocked || requestingAccess}
							onChange={toggleCamera}
						/>
					)
				}
			/>
			<SourceRow
				kind="mic"
				icon={MicIcon}
				label="Microphone"
				on={micEnabled}
				level={micLevel}
				detail={
					availableMics.length === 0 ? (
						"Needs permission"
					) : (
						<DeviceMenu
							title="Microphone"
							devices={availableMics}
							selectedId={selectedMicId ?? lastMicIdRef.current}
							fallbackName="Microphone"
							disabled={setupLocked}
							onSelect={handleMicChange}
						/>
					)
				}
				actions={
					live ? (
						liveBadge(micEnabled)
					) : availableMics.length === 0 ? (
						<button
							type="button"
							className={smallBtn}
							onClick={() => void requestAccess({ video: false, audio: true })}
							disabled={requestingAccess || setupLocked}
						>
							Allow
						</button>
					) : (
						<Switch
							label="Microphone"
							on={micEnabled}
							disabled={setupLocked || requestingAccess}
							onChange={toggleMic}
						/>
					)
				}
			/>
			{screenSupported && (
				<SourceRow
					kind="system"
					icon={Volume2Icon}
					label="System audio"
					on={live ? systemAudioOn && screenMode : systemAudioEnabled}
					detail={
						live ? (
							systemAudioOn && screenMode ? (
								"Your computer's sound"
							) : (
								"Not included"
							)
						) : systemAudioEnabled && sharedScreen && !systemAudioOn ? (
							<button
								type="button"
								className="rec-focus -ml-1 rounded px-1 text-left text-[var(--rec-accent)] hover:underline"
								onClick={() => beginShare()}
								disabled={setupLocked || sharePending}
							>
								Choose your screen again to include it
							</button>
						) : (
							<>
								<span className="truncate">Computer sound</span>
								{showMeHow}
							</>
						)
					}
					actions={
						live ? (
							liveBadge(systemAudioOn && screenMode)
						) : (
							<Switch
								label="System audio"
								on={systemAudioEnabled}
								disabled={setupLocked}
								onChange={handleSystemAudioChange}
							/>
						)
					}
				/>
			)}
		</ul>
	);

	const micName =
		availableMics
			.find((mic) => mic.deviceId === selectedMicId)
			?.label?.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || "Microphone";
	const cameraName =
		availableCameras
			.find((camera) => camera.deviceId === selectedCameraId)
			?.label?.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || "Camera";
	const systemAudioLive = systemAudioOn && (live ? screenMode : true);
	const scaleMs = Math.max(
		60_000,
		Math.ceil((durationMs + 6_000) / 60_000) * 60_000,
	);
	const playheadPct = Math.min(100, (durationMs / scaleMs) * 100);

	const transport = live ? (
		<>
			<div className="flex min-w-0 items-center gap-2 text-[13px] tabular-nums text-[var(--rec-text-2)]">
				<span className="text-[var(--rec-text-1)]">
					{formatClock(durationMs)}
				</span>
				{!user.isPro && (
					<span className="truncate">
						/ {formatClock(FREE_PLAN_MAX_RECORDING_MS)}
					</span>
				)}
			</div>
			<RecordingBar
				time={formatClock(durationMs)}
				paused={isPaused}
				restarting={isRestarting}
				onStop={handleStopClick}
				onPauseToggle={() => {
					void (isPaused ? resumeRecording() : pauseRecording());
				}}
				onRestart={() => {
					void restartRecording();
				}}
			/>
			<div className="flex min-w-0 justify-end">
				{screenMode && (
					<span className="flex items-center gap-1 text-[13px] text-[var(--rec-text-2)]">
						Preview
						<Switch
							label="Show preview"
							on={livePreview}
							onChange={setLivePreview}
						/>
					</span>
				)}
			</div>
		</>
	) : (
		<>
			<div className="min-w-0 truncate text-[13px] tabular-nums text-[var(--rec-text-3)]">
				0:00
				{!user.isPro && ` / ${formatClock(FREE_PLAN_MAX_RECORDING_MS)}`}
			</div>
			<StartRecordingButton
				busy={
					stage === "starting" || stage === "picking" || stage === "countdown"
				}
				disabled={
					!canStartRecording ||
					sharePending ||
					(!screenSupported && !cameraEnabled)
				}
				detail="Studio Mode"
				onClick={() => {
					void handleRecordClick();
				}}
			/>
			<div />
		</>
	);

	type Lane = {
		kind: TrackKind;
		icon: typeof MonitorIcon;
		label: string;
		on: boolean;
		clip: string;
		idle: ReactNode;
		level?: MicLevelBinding;
	};
	const lanes: Lane[] = [
		...(screenSupported
			? [
					{
						kind: "screen" as const,
						icon: MonitorIcon,
						label: "Screen",
						on: live ? screenMode : sharedScreen !== null,
						clip: SURFACE_LABELS[
							recordingMode === "camera" ? "fullscreen" : recordingMode
						],
						idle: sharedScreen ? (
							`${SURFACE_LABELS[sharedScreen.surface]} · ready`
						) : (
							<button
								type="button"
								className="rec-focus rounded px-1 text-[var(--rec-accent)] hover:underline"
								onClick={() => beginShare()}
								disabled={setupLocked || sharePending}
							>
								{sharePending ? "Choose in the popup" : "Share a screen"}
							</button>
						),
					},
				]
			: []),
		{
			kind: "camera",
			icon: CameraIcon,
			label: "Camera",
			on: cameraEnabled,
			clip: cameraName,
			idle: cameraEnabled ? `${cameraName} · ready` : "Off",
		},
		{
			kind: "mic",
			icon: MicIcon,
			label: "Microphone",
			on: micEnabled,
			clip: micName,
			idle: micEnabled ? micName : "Muted",
			level: micEnabled ? micLevel : undefined,
		},
		...(screenSupported
			? [
					{
						kind: "system" as const,
						icon: Volume2Icon,
						label: "System audio",
						on: systemAudioLive,
						clip: "Computer sound",
						idle: systemAudioLive ? "Computer sound · ready" : showMeHow,
					},
				]
			: []),
	];

	const timeline = (
		<section className="rec-card shrink-0 px-2 pb-2 pt-1.5">
			<div className="relative flex h-7 items-center [--gutter:8.25rem]">
				<span className="w-[var(--gutter)] shrink-0 pl-2 text-[12px] font-medium text-[var(--rec-text-2)]">
					Tracks
				</span>
				<span className="relative h-full flex-1" aria-hidden="true">
					{[0, 1, 2, 3, 4].map((tick) => (
						<span
							key={tick}
							className="absolute top-1.5 flex items-start gap-1 text-[11px] tabular-nums leading-none text-[var(--rec-text-3)]"
							style={{ left: `${tick * 25}%` }}
						>
							<span className="h-3 w-px bg-[var(--rec-line-strong)]" />
							{tick < 4 && formatClock((scaleMs / 4) * tick)}
						</span>
					))}
				</span>
			</div>
			<div className="relative flex flex-col gap-1 [--gutter:8.25rem]">
				{lanes.map((lane) => (
					<div
						key={lane.kind}
						className="rec-track flex h-9 items-center"
						data-kind={lane.kind}
						data-on={lane.on}
					>
						<span className="flex w-[var(--gutter)] shrink-0 items-center gap-2 pl-1.5">
							<span className="rec-track-tile flex size-[22px] shrink-0 items-center justify-center rounded-md">
								<lane.icon className="size-3" aria-hidden />
							</span>
							<span
								className={clsx(
									"truncate text-[12px]",
									lane.on
										? "text-[var(--rec-text-1)]"
										: "text-[var(--rec-text-2)]",
								)}
							>
								{lane.label}
							</span>
						</span>
						<span className="relative isolate flex h-full min-w-0 flex-1 items-center overflow-hidden rounded-lg bg-[var(--rec-ctl)]">
							{live ? (
								lane.on && (
									<span
										className="rec-segment absolute inset-y-1 left-1 flex items-center overflow-hidden rounded-md pl-2.5 text-[12px] font-medium transition-[width] duration-1000 ease-linear"
										style={{
											width: `calc((100% - 8px) * ${Math.max(playheadPct, 1) / 100})`,
										}}
									>
										{lane.level !== undefined && (
											<span className="absolute inset-0 -z-10">
												<LevelFill bind={lane.level} />
											</span>
										)}
										<span className="relative truncate">{lane.clip}</span>
									</span>
								)
							) : (
								<>
									{lane.level !== undefined && (
										<span className="absolute inset-0 -z-10">
											<LevelFill bind={lane.level} />
										</span>
									)}
									<span
										className={clsx(
											"relative flex w-full items-center justify-center gap-1 truncate px-3 text-[12px]",
											lane.on
												? "text-[var(--rec-text-2)]"
												: "text-[var(--rec-text-3)]",
										)}
									>
										{lane.idle}
									</span>
								</>
							)}
						</span>
					</div>
				))}
				{live && (
					<span
						className="pointer-events-none absolute -top-8 bottom-0 z-10 w-px bg-[var(--rec-red)] transition-[left] duration-1000 ease-linear"
						style={{
							left: `calc(var(--gutter) + 4px + (100% - var(--gutter) - 8px) * ${playheadPct / 100})`,
						}}
					>
						<span className="absolute left-1/2 top-0 size-2.5 -translate-x-1/2 rounded-full bg-[var(--rec-red)]" />
					</span>
				)}
			</div>
		</section>
	);

	const qualitySummary = `${quality.screenHeight === 2160 ? "4K" : `${quality.screenHeight}p`} · ${quality.frameRate} fps · ${quality.level === "high" ? "High" : "Standard"}`;

	const segmented = <T extends string | number>(
		value: T,
		options: readonly { value: T; label: string }[],
		onChange: (next: T) => void,
		name: string,
	) => (
		<fieldset className="flex rounded-lg bg-[var(--rec-ctl)] p-0.5">
			<legend className="sr-only">{name}</legend>
			{options.map((option) => (
				<button
					key={String(option.value)}
					type="button"
					aria-pressed={value === option.value}
					disabled={setupLocked}
					onClick={() => onChange(option.value)}
					className={clsx(
						"rec-focus h-6 rounded-md px-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
						value === option.value
							? "bg-[var(--rec-card)] text-[var(--rec-text-1)] shadow-[0_1px_2px_rgba(0,0,0,0.1),0_0_0_1px_var(--rec-line)]"
							: "text-[var(--rec-text-2)] hover:text-[var(--rec-text-1)]",
					)}
				>
					{option.label}
				</button>
			))}
		</fieldset>
	);

	const qualityRow = (label: string, control: ReactNode) => (
		<div className="flex min-h-9 items-center justify-between gap-3 px-2">
			<span className="text-[13px] text-[var(--rec-text-2)]">{label}</span>
			{control}
		</div>
	);

	const qualitySection = (
		<section className="flex flex-col">
			<button
				type="button"
				aria-expanded={qualityOpen}
				onClick={() => setQualityOpen((value) => !value)}
				className="rec-focus flex h-9 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-[var(--rec-ctl)]"
			>
				<ChevronRightIcon
					className={clsx(
						"size-3.5 shrink-0 text-[var(--rec-text-3)] transition-transform",
						qualityOpen && "rotate-90",
					)}
					aria-hidden
				/>
				<span className="flex-1 text-[13px] font-medium">
					Recording quality
				</span>
				<span className="truncate text-[12px] text-[var(--rec-text-3)]">
					{qualitySummary}
				</span>
			</button>
			{qualityOpen && (
				<div className="rec-fade flex flex-col pb-1 pt-1">
					{qualityRow(
						"Screen",
						segmented(
							quality.screenHeight,
							[
								{ value: 1080, label: "1080p" },
								{ value: 1440, label: "1440p" },
								{ value: 2160, label: "4K" },
							] as const,
							(screenHeight) => setQuality({ screenHeight }),
							"Screen resolution",
						),
					)}
					{qualityRow(
						"Frame rate",
						segmented(
							quality.frameRate,
							[
								{ value: 30, label: "30 fps" },
								{ value: 60, label: "60 fps" },
							] as const,
							(frameRate) => setQuality({ frameRate }),
							"Frame rate",
						),
					)}
					{qualityRow(
						"Camera",
						segmented(
							quality.cameraHeight,
							[
								{ value: 720, label: "720p" },
								{ value: 1080, label: "1080p" },
							] as const,
							(cameraHeight) => setQuality({ cameraHeight }),
							"Camera resolution",
						),
					)}
					{qualityRow(
						"Quality",
						segmented(
							quality.level,
							[
								{ value: "standard", label: "Standard" },
								{ value: "high", label: "High" },
							] as const,
							(level) => setQuality({ level }),
							"Video quality",
						),
					)}
					{(
						[
							["noiseSuppression", "Noise suppression"],
							["echoCancellation", "Echo cancellation"],
							["autoGainControl", "Auto gain"],
						] as const
					).map(([key, label]) =>
						qualityRow(
							label,
							<Switch
								label={label}
								on={quality.mic[key]}
								disabled={setupLocked}
								onChange={(next) =>
									setQuality({ mic: { ...quality.mic, [key]: next } })
								}
							/>,
						),
					)}
					<p className="px-2 pt-1 text-[12px] leading-snug text-[var(--rec-text-3)]">
						Your video uploads while you record, so higher settings need a
						faster connection. The browser uses the closest size your screen and
						camera support.
					</p>
				</div>
			)}
		</section>
	);

	const steps = live
		? [
				{
					done: true,
					title: "Your link is live",
					body: "Anyone with it can watch as soon as you stop.",
				},
				{
					done: partsSent > 0,
					title:
						partsSent === 0
							? "Uploading as you record"
							: `${partsSent} ${partsSent === 1 ? "part" : "parts"} uploaded`,
					body: "No export to wait for at the end.",
				},
				{
					done: false,
					title: "Stop to open the editor",
					body: `Your ${trackCount} ${trackCount === 1 ? "track is" : "tracks are"} waiting there, separate.`,
				},
			]
		: [
				{
					done: false,
					title: "Each source is its own track",
					body: "Screen, camera and audio stay separate.",
				},
				{
					done: false,
					title: "Uploads while you record",
					body: "Your link works the moment you stop.",
				},
				{
					done: false,
					title: "Arrange it in the editor",
					body: "Pick a layout, trim, then save.",
				},
			];

	const whatHappens = (
		<section className="flex flex-col gap-1 rounded-[10px] bg-[var(--rec-card-2)] p-3">
			<span className="px-1 pb-1 text-[12px] font-medium text-[var(--rec-text-2)]">
				{live ? "While you record" : "What happens"}
			</span>
			<ol className="flex flex-col gap-2.5 px-1">
				{steps.map((step, index) => (
					<li key={step.body} className="flex gap-2.5">
						<span
							className={clsx(
								"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular-nums",
								step.done
									? "bg-[var(--rec-green)] text-white"
									: "bg-[var(--rec-ctl-active)] text-[var(--rec-text-2)]",
							)}
						>
							{step.done ? (
								<CheckIcon className="size-2.5" aria-hidden />
							) : (
								index + 1
							)}
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="text-[13px] font-medium leading-5">
								{step.title}
							</span>
							<span className="text-[12px] leading-snug text-[var(--rec-text-2)]">
								{step.body}
							</span>
						</span>
					</li>
				))}
			</ol>
			{!live && (
				<button
					type="button"
					className="rec-btn is-ghost mt-1.5 !h-7 self-start !px-1.5 !text-[12px] text-[var(--rec-accent)]"
					onClick={() => setHowOpen(true)}
				>
					<CirclePlayIcon className="size-3.5" aria-hidden />
					Watch how it works
				</button>
			)}
		</section>
	);

	const sidebar = (
		<aside className="rec-card flex w-full shrink-0 flex-col lg:w-[21rem] lg:min-h-0">
			<header className="flex h-11 shrink-0 items-center justify-between pl-4 pr-2 shadow-[0_1px_0_var(--rec-line)]">
				<span className="text-[13px] font-medium">
					{live ? "Recording" : "Sources"}
				</span>
				{live ? (
					<span className="flex items-center gap-2 pr-2 text-[12px] text-[var(--rec-text-2)]">
						<LiveDot paused={isPaused} />
						{isPaused ? "Paused" : "Live"}
					</span>
				) : (
					<OptionsMenu
						disabled={setupLocked}
						rememberDevices={rememberDevices}
						onRememberDevicesChange={handleRememberDevicesChange}
					/>
				)}
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2 [&>*]:shrink-0">
				{sources}
				{qualitySection}
				<div className="mt-auto">{whatHappens}</div>
				{notices}
			</div>
		</aside>
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
				<div className="flex gap-2">
					<button
						type="button"
						className="rec-btn is-ghost"
						onClick={() => finishCountdownRef.current?.(false)}
					>
						Cancel
					</button>
					<button
						type="button"
						className="rec-btn"
						onClick={() => finishCountdownRef.current?.()}
					>
						Start now
					</button>
				</div>
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
		<main className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 sm:px-3 sm:pb-3">
			<div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
				<section className="rec-card relative flex min-h-[22rem] flex-1 flex-col overflow-hidden">
					<header className="flex h-11 shrink-0 items-center gap-2.5 px-4 text-[13px] shadow-[0_1px_0_var(--rec-line)]">
						{live ? (
							<>
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
							</>
						) : (
							<span className="truncate">
								<span className="font-medium">Preview</span>
								<span className="text-[var(--rec-text-2)]">
									{" "}
									· Drag the camera to place it, and hover it to resize or flip.
									The editor opens the same way.
								</span>
							</span>
						)}
					</header>
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
											isPaused
												? "bg-[var(--rec-text-3)]"
												: "bg-[var(--rec-red)]",
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
						<div className="rec-stage min-h-0 flex-1 p-4">{preview}</div>
					)}
					<footer className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 shadow-[0_-1px_0_var(--rec-line)]">
						{transport}
					</footer>
				</section>
				{sidebar}
			</div>
			{timeline}
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

	const stageArea = (
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
	);

	const outside = (
		<>
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
					captureHeight={quality.cameraHeight}
					cameraId={selectedCameraId}
					hidden
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);

	if (embedded) {
		return (
			<div className="cap-rec relative flex h-full min-h-0 flex-col bg-[var(--rec-window)]">
				<BoilFilter />
				{stageArea}
				{outside}
			</div>
		);
	}

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
						if (countdown !== null) finishCountdownRef.current?.(false);
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
					{stageArea}
				</DialogContent>
			</Dialog>
			{outside}
		</>
	);
};
