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
	ChevronDownIcon,
	LoaderCircleIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
	XIcon,
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
import { MicrophoneUnavailablePrompt } from "./MicrophoneUnavailablePrompt";
import {
	DeviceMenu,
	RecordingBar,
	RestartConfirm,
	StartRecordingButton,
} from "./recorder-dock";
import {
	BoilFilter,
	CountdownDial,
	Doodle,
	formatClock,
	LiveVideo,
	Squiggle,
	useLiveStream,
	useMicLevel,
} from "./recorder-parts";
import {
	CameraPlaceholder,
	MicChip,
	RecorderSettings,
	ScreenPlaceholder,
	StillFrame,
	SystemAudioChip,
} from "./recorder-stage";
import type { RecordingMode } from "./recording-mode";
import { useRecordingQuality } from "./recording-quality";
import { canRecordMicOnly, startRecordingChoice } from "./recording-sources";
import { SystemAudioGuide } from "./system-audio-guide";
import { useCameraDevices } from "./useCameraDevices";
import { useDeviceAccessRequest } from "./useDeviceAccessRequest";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicOnlyRecorder } from "./useMicOnlyRecorder";
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

type ScreenSurface = Exclude<RecordingMode, "camera">;

const SURFACE_LABELS: Record<ScreenSurface, string> = {
	fullscreen: "Entire screen",
	window: "Window",
	tab: "Browser tab",
};

const SURFACE_PHRASES: Record<ScreenSurface, string> = {
	fullscreen: "your entire screen",
	window: "a window",
	tab: "a browser tab",
};

const AUDIO_GUIDE_DISMISSED_KEY = "cap-web-recorder-audio-guide-dismissed";
const NO_CAMERA_KEY = "cap-web-recorder-no-camera";

type SharedScreen = {
	stream: MediaStream;
	surface: ScreenSurface;
};

const joinWords = (words: string[]) =>
	words.length <= 1
		? (words[0] ?? "")
		: `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

const LiveDot = ({ paused = false }: { paused?: boolean }) => (
	<span
		className={clsx(
			"size-1.5 shrink-0 rounded-full",
			paused ? "bg-current opacity-50" : "rec-pulse bg-[var(--rec-red)]",
		)}
	/>
);

const Notice = ({
	children,
	action,
	onDismiss,
}: {
	children: ReactNode;
	action?: ReactNode;
	onDismiss?: () => void;
}) => (
	<div className="rec-card rec-fade flex items-center gap-3 py-2 pl-3.5 pr-2 text-[13px] leading-snug">
		<span className="min-w-0 flex-1 text-[var(--rec-text-2)]">{children}</span>
		{action}
		{onDismiss && (
			<button
				type="button"
				aria-label="Dismiss"
				className="rec-btn is-ghost is-icon !size-7"
				onClick={onDismiss}
			>
				<XIcon className="size-3.5" aria-hidden />
			</button>
		)}
	</div>
);

/**
 * The browser recorder. By default it's a button that opens the recorder
 * full screen; `embedded` renders the recorder inline (the Editor page's
 * Record tab), always open, with the page's `tabs` in its top bar.
 */
export const WebRecorderDialog = ({
	embedded = false,
	tabs,
}: {
	embedded?: boolean;
	tabs?: ReactNode;
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
	const refreshDevices = useCallback(
		() => Promise.all([refreshCameras(), refreshMics()]),
		[refreshCameras, refreshMics],
	);

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

	const [cameraDeclined, setCameraDeclinedState] = useState(false);
	useEffect(() => {
		try {
			setCameraDeclinedState(
				window.localStorage.getItem(NO_CAMERA_KEY) === "true",
			);
		} catch {
			/* the camera is offered again next time */
		}
	}, []);
	const setCameraDeclined = useCallback((next: boolean) => {
		setCameraDeclinedState(next);
		try {
			if (next) window.localStorage.setItem(NO_CAMERA_KEY, "true");
			else window.localStorage.removeItem(NO_CAMERA_KEY);
		} catch {
			/* remembered for this visit only */
		}
	}, []);

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
			if (!selectedCameraId && !cameraDeclined)
				handleCameraChange(camera.deviceId);
		}
		const mic = availableMics[0];
		if (!done.mic && mic) {
			done.mic = true;
			if (!selectedMicId) handleMicChange(mic.deviceId);
		}
	}, [
		open,
		rememberDevices,
		cameraDeclined,
		availableCameras,
		availableMics,
		selectedCameraId,
		selectedMicId,
		handleCameraChange,
		handleMicChange,
	]);

	const lastCameraIdRef = useRef<string | null>(null);
	if (selectedCameraId) lastCameraIdRef.current = selectedCameraId;

	const chooseCamera = useCallback(
		(cameraId: string) => {
			setCameraDeclined(false);
			handleCameraChange(cameraId);
		},
		[setCameraDeclined, handleCameraChange],
	);

	const declineCamera = () => {
		setCameraDeclined(true);
		handleCameraChange(null);
	};

	const { requestAccess, requesting: requestingAccess } =
		useDeviceAccessRequest({
			open,
			availableCameras,
			availableMics,
			refreshDevices,
			onCameraGranted: chooseCamera,
			onMicGranted: handleMicChange,
		});

	const turnOnCamera = () => {
		if (availableCameras.length === 0) {
			void requestAccess({ video: true, audio: availableMics.length === 0 });
			return;
		}
		const remembered = availableCameras.find(
			(camera) => camera.deviceId === lastCameraIdRef.current,
		);
		const camera = remembered ?? availableCameras[0];
		if (camera) chooseCamera(camera.deviceId);
	};

	const [screenNotice, setScreenNotice] = useState(true);

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
			setScreenNotice(true);
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

	const webRecorder = useWebRecorder({
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
	const micOnly = useMicOnlyRecorder({
		organisationId,
		selectedMicId,
		quality,
		isProUser: user.isPro,
		editorEnabled: webStudioEnabled,
		beforeRecordingStarts: runCountdown,
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
	});
	const micOnlyActive = micOnly.active;
	// A microphone-only take runs outside the screen and camera recorder, so
	// while it does, everything below follows its state instead.
	const {
		phase,
		videoId,
		durationMs,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		cameraErrorDownload,
		audioErrorDownloads,
		canRetryUpload,
		retryUpload,
		prepareNewRecording,
		completedShareUrl,
		recoveredDownloads,
		isSettingUp,
		isMicrophoneUnavailable,
		respondToMicrophoneFailure,
		isRecording,
		isPaused,
		isBusy,
		isRestarting,
		canStartRecording,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		openCompletedShareUrl,
		restartRecording,
		dismissRecoveredDownload,
		getActiveCameraStream,
		getActiveDisplayStream,
		recordedBytes,
	} = micOnlyActive
		? {
				...webRecorder,
				phase: micOnly.phase,
				videoId: null,
				durationMs: micOnly.durationMs,
				hasAudioTrack: true,
				chunkUploads: [],
				errorDownload: micOnly.errorDownload,
				cameraErrorDownload: null,
				audioErrorDownloads: [],
				completedShareUrl: micOnly.completedShareUrl,
				isSettingUp: micOnly.isSettingUp,
				isRecording: micOnly.isRecording,
				isPaused: micOnly.isPaused,
				isBusy: micOnly.isBusy,
				isRestarting: micOnly.isRestarting,
				pauseRecording: micOnly.pause,
				resumeRecording: micOnly.resume,
				stopRecording: micOnly.stop,
				openCompletedShareUrl: () => {
					if (micOnly.completedShareUrl)
						window.open(micOnly.completedShareUrl, "_blank", "noopener");
				},
				restartRecording: micOnly.restart,
				canRetryUpload: false,
				prepareNewRecording: async () => {
					await micOnly.reset();
					return true;
				},
				recordedBytes: micOnly.recordedBytes,
			}
		: webRecorder;
	const resetState = async () => {
		await micOnly.reset();
		await webRecorder.resetState();
	};
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

	const [howOpen, setHowOpen] = useState(false);
	const [audioHelpOpen, setAudioHelpOpen] = useState(false);
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

	// Recording starts once the shared screen is in state, so the recorder
	// sees the screen and not the camera-only mode from before sharing.
	const [recordAfterShare, setRecordAfterShare] = useState(false);

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
			setAudioHelpOpen(false);
			setAudioGuide(null);
			setRecordAfterShare(false);
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

	useEffect(() => {
		if (!recordAfterShare || !sharedScreen || recordingMode === "camera")
			return;
		setRecordAfterShare(false);
		void startRecordingRef.current();
	}, [recordAfterShare, sharedScreen, recordingMode]);

	const shareThenMaybeRecord = async (thenRecord: boolean) => {
		const shared = await shareScreen();
		if (shared && thenRecord) setRecordAfterShare(true);
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
		const choice = startRecordingChoice({
			screenShared: sharedScreenRef.current !== null,
			cameraEnabled,
			screenSupported,
		});
		if (choice === "share-then-record") {
			beginShare(true);
			return;
		}
		if (sharedScreenRef.current === null && recordingMode === "camera") {
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

	const screenMode = !micOnlyActive && recordingMode !== "camera";

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
	const statusStage =
		stage === "finishing" || stage === "opening" || stage === "error";
	const showCameraPreview =
		selectedCameraId &&
		(recordingMode !== "camera" || (!isSettingUp && !isBusy));
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);
	const previewStream = useLiveStream(
		getCameraPreviewStream,
		open &&
			cameraEnabled &&
			(stage === "setup" || stage === "picking" || stage === "starting"),
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
	const [confirmRestart, setConfirmRestart] = useState(false);
	useEffect(() => {
		if (!isRecording) setConfirmRestart(false);
	}, [isRecording]);
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

	// Fetch the share page's code while recording so Stop opens it at once.
	const router = useRouter();
	useEffect(() => {
		if (phase !== "recording" || !videoId) return;
		router.prefetch(`/s/${encodeURIComponent(videoId)}`);
	}, [router, phase, videoId]);
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

	// A capture that can see this tab would show the previews inside the
	// video, so while recording they pause unless asked for, for one take.
	const [previewsShown, setPreviewsShown] = useState(false);
	useEffect(() => {
		if (!live) setPreviewsShown(false);
	}, [live]);
	const [audioNotice, setAudioNotice] = useState(true);
	useEffect(() => {
		if (sharedScreen) setAudioNotice(true);
	}, [sharedScreen]);

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
	const micOnlyAvailable = canRecordMicOnly({
		screenShared: sharedScreen !== null,
		cameraEnabled,
		micEnabled,
		idle: stage === "setup",
	});
	const surface: ScreenSurface =
		sharedScreen?.surface ??
		(recordingMode === "camera" ? "fullscreen" : recordingMode);
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
	const recordedWordsRef = useRef<string[]>([]);
	if (live) recordedWordsRef.current = sourceWords;

	const sentBytes = chunkUploads.reduce(
		(total, chunk) =>
			total +
			(chunk.status === "complete" ? chunk.sizeBytes : chunk.uploadedBytes),
		0,
	);
	const totalBytes = Math.max(
		recordedBytes,
		chunkUploads.reduce((total, chunk) => total + chunk.sizeBytes, 0),
	);
	const saveProgress = micOnlyActive
		? micOnly.saveProgress
		: phase === "uploading" && totalBytes > 0
			? Math.min(0.99, sentBytes / totalBytes)
			: null;

	const showScreen =
		screenSupported && screenStream !== null && !micOnlyActive && !statusStage;
	const cameraSettings = cameraStream?.getVideoTracks()[0]?.getSettings();
	const cameraAspect =
		cameraSettings?.width && cameraSettings.height
			? cameraSettings.width / cameraSettings.height
			: 16 / 9;
	const mirrorRisk = useMemo(
		() => capturesThisTab(screenStream),
		[screenStream],
	);
	const sharingThisTab = mirrorRisk && surface === "tab";
	const previewsPaused = live && screenMode && mirrorRisk && !previewsShown;
	const cameraFull =
		!micOnlyActive &&
		!screenMode &&
		cameraEnabled &&
		(stage === "starting" || stage === "countdown" || stage === "recording");
	const framePad = previewFrame ? (previewFrame.height / 1080) * 50 : 16;

	const cameraVideo = cameraStream ? (
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
	);

	const selectCameraClass =
		"rec-btn is-accent !h-8 max-w-full !rounded-full !px-3 !text-[13px]";
	const selectCamera =
		availableCameras.length > 1 ? (
			<DeviceMenu
				title="Camera"
				devices={availableCameras}
				selectedId={null}
				fallbackName="Camera"
				onSelect={(cameraId) => {
					if (cameraId) chooseCamera(cameraId);
				}}
				className={selectCameraClass}
			>
				{() => (
					<>
						<CameraIcon
							className="rec-cam-icon size-3.5 shrink-0"
							aria-hidden
						/>
						<span className="rec-cam-label truncate">Select camera</span>
					</>
				)}
			</DeviceMenu>
		) : (
			<button
				type="button"
				aria-label="Select camera"
				className={selectCameraClass}
				disabled={requestingAccess}
				onClick={turnOnCamera}
			>
				{requestingAccess ? (
					<LoaderCircleIcon
						className="size-3.5 shrink-0 animate-spin"
						aria-hidden
					/>
				) : (
					<CameraIcon className="rec-cam-icon size-3.5 shrink-0" aria-hidden />
				)}
				<span className="rec-cam-label truncate">Select camera</span>
			</button>
		);

	const cameraLayer =
		statusStage || micOnlyActive || cameraFull ? null : cameraEnabled ? (
			<CameraBubble
				frame={previewFrame}
				layout={cameraLayout}
				cameraAspect={cameraAspect}
				locked={setupLocked}
				onChange={setCameraLayout}
				label={
					stage === "setup" && (
						<DeviceMenu
							title="Camera"
							devices={availableCameras}
							selectedId={selectedCameraId}
							fallbackName="Camera"
							offLabel="No camera"
							onSelect={(cameraId) => {
								if (cameraId) chooseCamera(cameraId);
								else declineCamera();
							}}
							className="rec-focus rec-cam-label absolute bottom-[7%] left-1/2 flex h-6 max-w-[84%] -translate-x-1/2 items-center gap-1 rounded-full bg-black/65 pl-2.5 pr-1.5 text-[11px] font-medium text-white transition-colors hover:bg-black/80 data-[state=open]:bg-black/80"
						>
							{(name) => (
								<>
									<span className="truncate">{name}</span>
									<ChevronDownIcon
										className="size-3 shrink-0 opacity-70"
										aria-hidden
									/>
								</>
							)}
						</DeviceMenu>
					)
				}
				corner={
					stage === "setup" && (
						<button
							type="button"
							aria-label="Remove camera"
							title="No camera"
							onClick={declineCamera}
							className="rec-focus absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-[var(--rec-text-1)] text-[var(--rec-card)] opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.3)] transition-opacity focus-visible:opacity-100 group-hover/cam:opacity-100 [@media(hover:none)]:opacity-100"
						>
							<XIcon className="size-3.5" aria-hidden />
						</button>
					)
				}
			>
				{previewsPaused ? (
					<span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#1b1b1e] p-2 text-center text-[11px] leading-tight text-white/70">
						<span className="flex items-center gap-1.5">
							<LiveDot paused={isPaused} />
							<CameraIcon className="size-4" aria-hidden />
						</span>
						<span className="rec-cam-label">Camera recording</span>
					</span>
				) : (
					cameraVideo
				)}
			</CameraBubble>
		) : cameraDeclined ? (
			stage === "setup" && (
				<button
					type="button"
					onClick={turnOnCamera}
					disabled={requestingAccess}
					className={clsx(
						"rec-focus rec-fade absolute flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors",
						showScreen
							? "bg-black/65 text-white hover:bg-black/80"
							: "bg-[var(--rec-ctl)] text-[var(--rec-text-1)] hover:bg-[var(--rec-ctl-hover)]",
					)}
					style={{
						[cameraLayout.position.y]: framePad,
						...(cameraLayout.position.x === "center"
							? { left: "50%", transform: "translateX(-50%)" }
							: { [cameraLayout.position.x]: framePad }),
					}}
				>
					<CameraIcon className="size-3.5" aria-hidden />
					Add camera
				</button>
			)
		) : (
			stage === "setup" && (
				<CameraBubble
					frame={previewFrame}
					layout={cameraLayout}
					cameraAspect={16 / 9}
					locked
					onChange={setCameraLayout}
					surfaceClassName="bg-[var(--rec-card)] ring-1 ring-[var(--rec-line-strong)] !shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)]"
				>
					<CameraPlaceholder select={selectCamera} onDecline={declineCamera} />
				</CameraBubble>
			)
		);

	const avoidCamera: CSSProperties | undefined =
		cameraLayer && previewFrame && cameraLayout.position.x === "center"
			? {
					[cameraLayout.position.y === "bottom"
						? "paddingBottom"
						: "paddingTop"]:
						(Math.min(previewFrame.width, previewFrame.height) *
							cameraLayout.size) /
							100 +
						framePad * 2,
				}
			: undefined;

	const screenChip = showScreen && screenMode && (
		<div
			className={clsx(
				"absolute left-3 top-3 z-10 flex h-8 items-center gap-1.5 rounded-lg bg-black/65 pl-2.5 text-[12px] font-medium text-white",
				stage === "setup" || (live && mirrorRisk && previewsShown)
					? "pr-1"
					: "pr-2.5",
			)}
		>
			{live ? (
				<LiveDot paused={isPaused} />
			) : (
				<MonitorIcon className="size-3.5" aria-hidden />
			)}
			<span className="whitespace-nowrap">
				{live
					? `${isPaused ? "Paused" : "Recording"} · ${SURFACE_LABELS[surface]}`
					: SURFACE_LABELS[surface]}
			</span>
			{stage === "setup" && (
				<>
					<button
						type="button"
						className="rec-focus ml-1 h-6 rounded-md px-2 text-white/85 transition-colors hover:bg-white/15 hover:text-white"
						onClick={() => beginShare()}
						disabled={sharePending}
					>
						Change
					</button>
					<button
						type="button"
						aria-label="Stop sharing this screen"
						title="Remove screen"
						className="rec-focus flex size-6 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/15 hover:text-white"
						onClick={stopSharing}
					>
						<XIcon className="size-3.5" aria-hidden />
					</button>
				</>
			)}
			{live && mirrorRisk && previewsShown && (
				<button
					type="button"
					className="rec-focus ml-1 h-6 rounded-md px-2 text-white/85 transition-colors hover:bg-white/15 hover:text-white"
					onClick={() => setPreviewsShown(false)}
				>
					Pause previews
				</button>
			)}
		</div>
	);

	const statusView = (
		doodle: "upload" | "done" | "error",
		title: string,
		body: string,
		extra?: ReactNode,
	) => (
		<div className="rec-fade absolute inset-0 flex flex-col items-center justify-center overflow-y-auto px-6 py-6 text-center">
			<Doodle kind={doodle} />
			<h2
				key={title}
				className="rec-rise mt-[clamp(0.75rem,4cqh,1.5rem)] text-balance text-[clamp(18px,2.4cqw,24px)] font-medium tracking-[-0.01em]"
			>
				{title}
			</h2>
			<p
				key={body}
				className="rec-rise mt-2 max-w-md text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]"
				style={{ "--d": "0.05s" } as CSSProperties}
			>
				{body}
			</p>
			{extra}
		</div>
	);

	const savedTracks = (done: boolean) => (
		<ul
			className="rec-rise mt-[clamp(1rem,5cqh,2rem)] flex flex-wrap items-center justify-center gap-1.5"
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

	const frameContent =
		stage === "finishing" ? (
			statusView(
				"upload",
				"Saving your recording",
				micOnlyActive
					? "Your audio is being uploaded. It opens as soon as it's saved."
					: "Your link is already live. It opens as soon as the last parts land.",
				savedTracks(false),
			)
		) : stage === "opening" ? (
			statusView(
				"done",
				"Opening your link",
				"Your recording is saved and your link is live. Every track is ready to edit.",
				savedTracks(true),
			)
		) : stage === "error" ? (
			statusView(
				"error",
				"Your recording didn't finish saving",
				canRetryUpload
					? "It's kept here, so you can retry the upload without recording again. The recovered files are also in the bar at the top of the page."
					: "Download the recovered files from the bar at the top of the page, or start a new recording.",
			)
		) : micOnlyActive ? (
			<div className="rec-fade absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center">
				<span className="relative flex size-20 items-center justify-center">
					{live && !isPaused && (
						<>
							<span className="rec-ripple absolute inset-0 rounded-full" />
							<span
								className="rec-ripple absolute inset-0 rounded-full"
								style={{ animationDelay: "1.2s" }}
							/>
						</>
					)}
					<span className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--rec-red)_14%,transparent)] text-[var(--rec-red)]">
						<MicIcon className="size-5" aria-hidden />
					</span>
				</span>
				<span className="text-[clamp(28px,6cqw,44px)] font-medium tabular-nums leading-none tracking-[-0.02em]">
					{formatClock(durationMs)}
				</span>
				<span className="text-[14px] text-[var(--rec-text-2)]">
					{isPaused ? "Paused" : "Recording your microphone"}
				</span>
			</div>
		) : cameraFull ? (
			<>
				{cameraVideo}
				{live && (
					<span className="absolute left-3 top-3 flex h-8 items-center gap-1.5 rounded-lg bg-black/65 px-2.5 text-[12px] font-medium text-white">
						<LiveDot paused={isPaused} />
						{isPaused ? "Paused" : "Recording · Camera"}
					</span>
				)}
			</>
		) : (
			<>
				{showScreen ? (
					mirrorRisk && !(live && previewsShown) ? (
						<StillFrame
							stream={screenStream}
							className="absolute inset-0 size-full object-contain"
						/>
					) : (
						<LiveVideo
							stream={screenStream}
							mirror={false}
							className="absolute inset-0 size-full object-contain"
						/>
					)
				) : (
					<ScreenPlaceholder
						supported={screenSupported}
						picking={sharePending || stage === "picking"}
						disabled={setupLocked}
						onSelect={() => beginShare()}
						style={avoidCamera}
					/>
				)}
				{previewsPaused && (
					<div
						className="rec-fade absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-6 text-center text-white"
						style={avoidCamera}
					>
						<span className="flex items-center gap-2 text-[clamp(15px,2.2cqw,18px)] font-medium">
							<LiveDot paused={isPaused} />
							{isPaused
								? "Paused"
								: sharingThisTab
									? "Recording this tab"
									: "Recording your entire screen"}
						</span>
						<p className="max-w-sm text-balance text-[13px] leading-snug text-white/70">
							Previews are paused here so they don't end up in your video.
							Switch to what you want to show, then come back to stop.
						</p>
						<button
							type="button"
							className="rec-focus mt-1 h-7 rounded-md bg-white/10 px-3 text-[12px] font-medium transition-colors hover:bg-white/20"
							onClick={() => setPreviewsShown(true)}
						>
							Show live previews
						</button>
					</div>
				)}
				{screenChip}
				{cameraLayer}
			</>
		);

	const frame = (
		<div
			ref={previewRef}
			className={clsx(
				"rec-preview rec-frame relative overflow-hidden rounded-2xl shadow-[var(--rec-card-shadow)] transition-colors duration-300",
				(showScreen || cameraFull) && !statusStage
					? "bg-[var(--rec-media)]"
					: "bg-[var(--rec-card)]",
			)}
		>
			{frameContent}
			{stage === "countdown" && (
				<div className="rec-fade absolute inset-0 z-20 flex flex-col items-center justify-center gap-[clamp(0.5rem,3.5cqh,1.5rem)] bg-[color-mix(in_srgb,var(--rec-card)_92%,transparent)] px-4 text-center">
					<div className="rec-dial-fit">
						<CountdownDial value={countdown ?? 1} />
					</div>
					<p className="rec-countdown-hint max-w-sm text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]">
						{screenMode
							? "When it starts, switch to what you're sharing."
							: "Look at the camera and start talking when it hits zero."}
					</p>
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
			)}
		</div>
	);

	const recordLabel =
		screenSupported && !sharedScreen && cameraEnabled
			? "Record Camera Only"
			: "Start Recording";

	const centre =
		stage === "finishing" ? (
			<Squiggle progress={saveProgress} />
		) : stage === "opening" ? (
			completedShareUrl && (
				<a href={completedShareUrl} className="rec-btn">
					Open your link
				</a>
			)
		) : stage === "error" ? (
			<div className="flex flex-wrap justify-center gap-2">
				{canRetryUpload && (
					<button
						type="button"
						className="rec-btn is-accent"
						onClick={() => {
							void retryUpload();
						}}
					>
						Retry upload
					</button>
				)}
				<button
					type="button"
					className="rec-btn"
					onClick={() => {
						void prepareNewRecording();
					}}
				>
					New recording
				</button>
				{completedShareUrl && (
					<button
						type="button"
						className="rec-btn"
						onClick={openCompletedShareUrl}
					>
						Open recording
					</button>
				)}
				<button type="button" className="rec-btn" onClick={handleClose}>
					Close
				</button>
			</div>
		) : live ? (
			<RecordingBar
				time={formatClock(durationMs)}
				paused={isPaused}
				restarting={isRestarting}
				onStop={handleStopClick}
				onPauseToggle={() => {
					void (isPaused ? resumeRecording() : pauseRecording());
				}}
				onRestart={() => setConfirmRestart(true)}
			/>
		) : (
			<StartRecordingButton
				label={recordLabel}
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
		);

	const audioControls = !statusStage && !micOnlyActive && (
		<>
			<MicChip
				devices={availableMics}
				selectedId={selectedMicId}
				level={micLevel}
				locked={setupLocked}
				requesting={requestingAccess}
				onSelect={handleMicChange}
				onRequestAccess={() =>
					void requestAccess({ video: false, audio: true })
				}
			/>
			{screenSupported && (!live || screenMode) && (
				<SystemAudioChip
					on={live ? systemAudioOn : systemAudioEnabled}
					locked={setupLocked}
					onChange={handleSystemAudioChange}
				/>
			)}
		</>
	);

	const sharing = sharedScreen ? SURFACE_PHRASES[sharedScreen.surface] : null;
	const readyWords = [
		...(sharing ? [sharing] : []),
		...(cameraEnabled ? ["your camera"] : []),
		...(micEnabled ? ["your mic"] : []),
		...(sharing && systemAudioOn ? ["your computer's sound"] : []),
	];
	const status: { text: string; detail?: string } | null =
		stage === "setup"
			? !screenSupported && !cameraEnabled
				? { text: "Turn on your camera to start recording." }
				: sharing
					? { text: `Ready to record ${joinWords(readyWords)}.` }
					: cameraEnabled
						? {
								text: `Ready to record ${joinWords(readyWords)}.`,
								detail: screenSupported
									? "Select a screen above to include it too."
									: undefined,
							}
						: {
								text: "Select a screen to get started.",
								detail:
									"Or press Start Recording and your browser asks which one.",
							}
			: stage === "picking"
				? { text: "Choose what to share in your browser's popup." }
				: stage === "starting"
					? { text: "Getting ready to record." }
					: stage === "countdown"
						? { text: "Recording starts after the countdown." }
						: live
							? isPaused
								? { text: "Paused. Nothing is recorded until you resume." }
								: micOnlyActive
									? {
											text: "Recording your microphone. Stop when you're done.",
										}
									: screenMode
										? {
												text: "Switch to what you're sharing. Come back to this tab to stop.",
												detail:
													"Your video uploads as you record, so your link is ready the moment you stop.",
											}
										: {
												text: "Recording your camera. Stop when you're done.",
												detail:
													"Your video uploads as you record, so your link is ready the moment you stop.",
											}
							: null;

	const notices = [
		stage === "setup" && sharingThisTab && screenNotice && (
			<Notice
				key="this-tab"
				onDismiss={() => setScreenNotice(false)}
				action={
					<button
						type="button"
						className="rec-btn !h-7 !px-2.5 !text-[12px]"
						onClick={() => beginShare()}
					>
						Change
					</button>
				}
			>
				You're sharing this tab, so your video shows this page. Pick another tab
				or window to record something else.
			</Notice>
		),
		stage === "setup" &&
			sharedScreen &&
			systemAudioEnabled &&
			!systemAudioOn &&
			audioNotice && (
				<Notice
					key="audio"
					onDismiss={() => setAudioNotice(false)}
					action={
						<>
							<button
								type="button"
								className="rec-btn is-ghost !h-7 !px-2.5 !text-[12px]"
								onClick={() => setAudioHelpOpen(true)}
							>
								Show me how
							</button>
							<button
								type="button"
								className="rec-btn !h-7 !px-2.5 !text-[12px]"
								onClick={() => beginShare()}
							>
								Select again
							</button>
						</>
					}
				>
					Your computer's sound wasn't shared. Select your screen again and turn
					on audio in the popup.
				</Notice>
			),
		!isBrowserSupported && unsupportedReason && (
			<Notice key="unsupported">
				<span className="text-[var(--rec-red)]">{unsupportedReason}</span>
			</Notice>
		),
		...recoveredDownloads.map((download) => (
			<Notice
				key={download.id}
				onDismiss={() => dismissRecoveredDownload(download.id)}
				action={
					<a
						href={download.url}
						download={download.fileName}
						className="rec-btn !h-7 !px-2.5 !text-[12px]"
					>
						Download
					</a>
				}
			>
				<span className="block truncate font-medium text-[var(--rec-text-1)]">
					Recovered: {download.fileName}
				</span>
				<span className="block text-[12px] text-[var(--rec-text-3)]">
					{recoveredRecordingTimeFormatter.format(new Date(download.createdAt))}
				</span>
			</Notice>
		)),
	].filter(Boolean);

	const studio = (
		<main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-3 pb-4 pt-1 sm:gap-4 sm:px-6 sm:pb-6">
			<div className="rec-stage min-h-[15rem] w-full flex-1">{frame}</div>
			<div
				className="flex w-full shrink-0 flex-wrap items-center justify-center gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
				style={{ maxWidth: previewFrame?.width }}
			>
				<div className="flex min-w-0 max-w-full items-center gap-2 max-lg:flex-wrap max-lg:justify-center">
					{audioControls}
				</div>
				<div className="flex min-h-11 items-center justify-center max-lg:order-first max-lg:basis-full">
					{centre}
				</div>
				<div className="flex min-w-0 justify-end">
					{stage === "setup" && (
						<RecorderSettings
							quality={quality}
							onQualityChange={setQuality}
							rememberDevices={rememberDevices}
							onRememberDevicesChange={handleRememberDevicesChange}
						/>
					)}
				</div>
			</div>
			<div
				className="flex h-12 w-full shrink-0 flex-col items-center gap-0.5 text-center"
				aria-live="polite"
			>
				{status && (
					<>
						<p className="text-balance text-[14px] font-medium text-[var(--rec-text-1)]">
							{status.text}
						</p>
						{(status.detail || micOnlyAvailable) && (
							<p className="text-balance text-[13px] text-[var(--rec-text-2)]">
								{status.detail}
								{micOnlyAvailable && (
									<>
										{status.detail && " "}
										<button
											type="button"
											className="rec-focus rounded px-0.5 font-medium text-[var(--rec-accent)] hover:underline disabled:opacity-50"
											disabled={!canStartRecording || sharePending}
											onClick={() => {
												void micOnly.start();
											}}
										>
											Record just your voice instead
										</button>
									</>
								)}
							</p>
						)}
					</>
				)}
			</div>
			{notices.length > 0 && (
				<div
					className="flex w-full shrink-0 flex-col gap-2"
					style={{ maxWidth: Math.min(previewFrame?.width ?? 640, 640) }}
				>
					{notices}
				</div>
			)}
		</main>
	);

	const stageArea = (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{studio}
			{confirmRestart && isRecording && (
				<RestartConfirm
					onCancel={() => setConfirmRestart(false)}
					onConfirm={() => {
						setConfirmRestart(false);
						void restartRecording();
					}}
				/>
			)}
			{howOpen && <HowRecordingWorks onClose={() => setHowOpen(false)} />}
			{isMicrophoneUnavailable && (
				<div className="absolute inset-0 z-40 flex items-center justify-center bg-black/20 p-4">
					<div className="w-[min(22rem,100%)]">
						<MicrophoneUnavailablePrompt
							onRespond={respondToMicrophoneFailure}
						/>
					</div>
				</div>
			)}
			{audioGuide && (
				<SystemAudioGuide
					onContinue={continueFromAudioGuide}
					onClose={() => setAudioGuide(null)}
				/>
			)}
			{audioHelpOpen && !audioGuide && (
				<SystemAudioGuide onClose={() => setAudioHelpOpen(false)} />
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
					onRetryUpload={canRetryUpload ? retryUpload : undefined}
					onNewRecording={async () => {
						if (await prepareNewRecording()) setOpen(true);
					}}
					shareUrl={completedShareUrl}
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

	const showHowItWorks =
		stage === "setup" || stage === "recording"
			? () => setHowOpen(true)
			: undefined;

	if (embedded) {
		return (
			<div className="cap-rec relative flex h-full min-h-0 flex-col bg-[var(--rec-window)]">
				<BoilFilter />
				<WebRecorderDialogHeader
					isBusy={isBusy || isSettingUp}
					freeMinutes={freeMinutes}
					onBack={() => router.push("/dashboard/caps")}
					onShowHowItWorks={showHowItWorks}
					tabs={tabs}
				/>
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
						onBack={handleClose}
						onShowHowItWorks={showHowItWorks}
					/>
					{stageArea}
				</DialogContent>
			</Dialog>
			{outside}
		</>
	);
};
