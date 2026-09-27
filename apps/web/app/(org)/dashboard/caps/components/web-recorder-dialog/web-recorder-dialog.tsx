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
	CameraOffIcon,
	LoaderCircleIcon,
	MicIcon,
	MicOffIcon,
	MonitorIcon,
	MonitorOffIcon,
	MonitorUpIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
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
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import {
	DeviceMenu,
	DockButton,
	MoreMenu,
	RecordButton,
} from "./recorder-dock";
import {
	CountdownDial,
	formatClock,
	LiveDot,
	LiveVideo,
	MicMeter,
	PickingScreen,
	TileLabel,
	TrackStrip,
	UploadStream,
	useLiveStream,
	useMicLevel,
} from "./recorder-takeover";
import type { RecordingMode } from "./recording-mode";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import { FREE_PLAN_MAX_RECORDING_MS } from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";

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

type SharedScreen = {
	stream: MediaStream;
	surface: Exclude<RecordingMode, "camera">;
};

const Tile = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<div
		className={clsx(
			"relative aspect-video w-full overflow-hidden rounded-[1.25rem] bg-[#18191c] ring-1 ring-inset ring-white/[0.06]",
			className,
		)}
	>
		{children}
	</div>
);

const TileMessage = ({
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
	<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
		<span className="flex size-12 items-center justify-center rounded-full bg-white/[0.06] text-white/70">
			{icon}
		</span>
		<div className="flex max-w-xs flex-col gap-1">
			<span className="text-[0.9375rem] font-semibold text-white">{title}</span>
			<span className="text-[0.8125rem] leading-snug text-white/50">
				{body}
			</span>
		</div>
		{action}
	</div>
);

const PillButton = ({
	onClick,
	children,
	tone = "light",
	disabled,
}: {
	onClick: () => void;
	children: ReactNode;
	tone?: "light" | "blue";
	disabled?: boolean;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled}
		className={clsx(
			"mt-1 inline-flex h-9 items-center gap-2 rounded-full px-4 text-[0.8125rem] font-medium transition-[filter,transform] hover:brightness-110 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#18191c] disabled:opacity-50",
			tone === "blue" ? "bg-[#4785FF] text-white" : "bg-white text-[#111214]",
		)}
	>
		{children}
	</button>
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

	const handleRecordClick = async () => {
		let screenReady = sharedScreenRef.current !== null;
		if (!screenReady && !cameraEnabled && screenSupported) {
			screenReady = await shareScreen();
			if (!screenReady) return;
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
		open && (stage === "setup" || stage === "starting"),
	);

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
	const willRecordScreen = sharedScreen !== null || !cameraEnabled;
	const recordLabel =
		sharedScreen || cameraEnabled
			? "Start recording"
			: "Choose a screen and start recording";
	const systemAudioOn =
		systemAudioEnabled &&
		(live
			? screenMode && (recordingScreen?.getAudioTracks().length ?? 0) > 0
			: sharedScreen
				? sharedScreen.stream.getAudioTracks().length > 0
				: willRecordScreen);

	const screenTile = screenSupported && (
		<Tile
			className={clsx(
				!screenStream &&
					"bg-transparent ring-0 [background-image:linear-gradient(135deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))]",
			)}
		>
			{screenStream ? (
				<>
					<LiveVideo
						stream={screenStream}
						mirror={false}
						className="absolute inset-0 size-full bg-black object-contain"
					/>
					<TileLabel className="absolute left-3 top-3">
						{live ? (
							<LiveDot paused={isPaused} />
						) : (
							<MonitorIcon className="size-3.5" aria-hidden />
						)}
						Screen
						{sharedScreen && (
							<span className="text-white/55">
								· {SURFACE_LABELS[sharedScreen.surface]}
							</span>
						)}
					</TileLabel>
					{stage === "setup" && sharedScreen && (
						<button
							type="button"
							onClick={() => void shareScreen()}
							className="absolute right-3 top-3 inline-flex h-7 items-center rounded-full bg-black/55 px-3 text-[0.75rem] font-medium text-white backdrop-blur-md transition-colors hover:bg-black/75"
						>
							Change
						</button>
					)}
				</>
			) : (
				<>
					<span className="pointer-events-none absolute inset-0 rounded-[1.25rem] border-[1.5px] border-dashed border-white/15" />
					{sharePending ? (
						<TileMessage
							icon={<LoaderCircleIcon className="size-5 animate-spin" />}
							title="Pick what to share"
							body="Choose a screen, window or tab in your browser's popup, then click Share."
						/>
					) : (
						<TileMessage
							icon={<MonitorUpIcon className="size-5" />}
							title="Share your screen"
							body="A screen, window or tab. It records on its own track."
							action={
								<PillButton
									tone="blue"
									onClick={() => void shareScreen()}
									disabled={setupLocked}
								>
									Choose what to share
								</PillButton>
							}
						/>
					)}
				</>
			)}
		</Tile>
	);

	const cameraTile = (
		<Tile>
			{cameraEnabled ? (
				cameraStream ? (
					<LiveVideo
						stream={cameraStream}
						className="absolute inset-0 size-full object-cover"
					/>
				) : (
					<div className="absolute inset-0 flex items-center justify-center">
						<LoaderCircleIcon
							className="size-6 animate-spin text-white/50"
							aria-hidden
						/>
					</div>
				)
			) : availableCameras.length === 0 ? (
				<TileMessage
					icon={<CameraIcon className="size-5" />}
					title="Show your face"
					body="Allow your camera and mic to record yourself on separate tracks."
					action={
						<PillButton
							onClick={() => void requestAccess({ video: true, audio: true })}
							disabled={requestingAccess || setupLocked}
						>
							Allow camera and mic
						</PillButton>
					}
				/>
			) : (
				<TileMessage
					icon={<CameraOffIcon className="size-5" />}
					title="Camera is off"
					body="Turn it on to record yourself on a separate track."
					action={
						<PillButton onClick={toggleCamera} disabled={setupLocked}>
							Turn on camera
						</PillButton>
					}
				/>
			)}
			{cameraEnabled && (
				<TileLabel className="absolute left-3 top-3">
					{live ? (
						<LiveDot paused={isPaused} />
					) : (
						<CameraIcon className="size-3.5" aria-hidden />
					)}
					Camera
				</TileLabel>
			)}
			{cameraEnabled && !live && (
				<TileLabel className="absolute right-3 top-3 bg-black/40 text-white/75">
					Preview
				</TileLabel>
			)}
			<TileLabel className="absolute bottom-3 left-3">
				{micEnabled ? (
					<>
						<MicIcon className="size-3.5" aria-hidden />
						{stage === "setup" || stage === "starting" ? (
							<MicMeter level={micLevel} />
						) : (
							"Mic"
						)}
					</>
				) : (
					<>
						<MicOffIcon className="size-3.5 text-[#ff8587]" aria-hidden />
						Muted
					</>
				)}
			</TileLabel>
		</Tile>
	);

	const tiles = (reserve: string) => (
		<div
			className={clsx(
				"grid w-full gap-3",
				screenSupported
					? "max-w-[calc((100dvh_-_var(--reserve))_*_0.85)] lg:max-w-[min(1600px,calc((100dvh_-_var(--reserve))_*_3.4))] lg:grid-cols-2"
					: "max-w-[min(1100px,calc((100dvh_-_var(--reserve))_*_1.77))]",
			)}
			style={{ "--reserve": reserve } as CSSProperties}
		>
			{screenTile}
			{cameraTile}
		</div>
	);

	const trackStrip = (
		<TrackStrip
			live={live}
			paused={isPaused}
			screen={
				screenSupported ? (live ? screenMode : sharedScreen !== null) : null
			}
			camera={cameraEnabled}
			mic={micEnabled}
			systemAudio={screenSupported ? systemAudioOn : null}
		/>
	);

	const notices = (
		<>
			{screenCaptureWarning && (
				<p className="max-w-md text-center text-[0.8125rem] leading-snug text-white/50">
					This browser can only record your camera. Use Chrome, Edge or Cap
					Desktop on a computer to record your screen too.
				</p>
			)}
			{!isBrowserSupported && unsupportedReason && (
				<p className="max-w-md rounded-xl bg-[#ff4d4f]/10 px-3 py-2 text-center text-[0.8125rem] leading-snug text-[#ff9a9b]">
					{unsupportedReason}
				</p>
			)}
			{recoveredDownloads.length > 0 && (
				<div className="flex w-full max-w-md flex-col gap-1.5 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-2.5">
					<span className="px-1 text-[0.8125rem] font-medium text-white/85">
						Recovered recordings
					</span>
					{recoveredDownloads.map((download) => (
						<div
							key={download.id}
							className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-2.5 py-2 text-xs text-white"
						>
							<div className="min-w-0">
								<div className="truncate font-medium">{download.fileName}</div>
								<div className="text-white/45">
									{recoveredRecordingTimeFormatter.format(
										new Date(download.createdAt),
									)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<a
									href={download.url}
									download={download.fileName}
									className="font-medium text-[#7ea8ff] hover:text-white"
									onClick={() =>
										setTimeout(() => dismissRecoveredDownload(download.id), 500)
									}
								>
									Download
								</a>
								<button
									type="button"
									className="text-white/45 hover:text-white"
									onClick={() => dismissRecoveredDownload(download.id)}
								>
									Dismiss
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);

	const stageOverlay =
		stage === "countdown" ? (
			<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-[#0c0c0e]/70 px-4 text-center backdrop-blur-md">
				<CountdownDial value={countdown ?? 1} />
				<div className="flex flex-col items-center gap-2">
					<h2 className="text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
						Get ready
					</h2>
					<p className="max-w-md text-balance text-[0.9375rem] leading-relaxed text-white/60">
						{screenMode
							? "When the countdown ends, switch to what you're sharing and start presenting."
							: "Recording starts when the countdown ends."}
					</p>
				</div>
				<button
					type="button"
					onClick={() => finishCountdownRef.current?.()}
					className="h-9 rounded-full bg-white/10 px-4 text-[0.8125rem] font-medium text-white transition-colors hover:bg-white/15"
				>
					Start now
				</button>
			</div>
		) : stage === "picking" ? (
			<div className="absolute inset-0 z-10 flex items-start justify-center bg-[#0c0c0e]/80 px-4 pt-[16vh] backdrop-blur-md">
				<PickingScreen />
			</div>
		) : null;

	const studio = (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-4 py-5 sm:px-8">
				{live && screenMode && (
					<div className="flex max-w-2xl items-center gap-2.5 rounded-full border border-[#4785FF]/30 bg-[#4785FF]/10 py-1.5 pl-2 pr-4 text-[0.8125rem] text-white/85">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#4785FF] text-white">
							<MonitorIcon className="size-3.5" aria-hidden />
						</span>
						<span>
							<span className="font-medium text-white">
								Now switch to what you're sharing.
							</span>{" "}
							This tab keeps your controls. Come back here to stop.
						</span>
					</div>
				)}
				{tiles(live ? "27rem" : "19rem")}
				{trackStrip}
				{live && (
					<div className="w-full max-w-3xl">
						<UploadStream
							chunks={chunkUploads}
							recordedBytes={recordedBytes}
							recording
							paused={isPaused}
						/>
					</div>
				)}
				{!live && notices}
			</main>
			{stageOverlay}
		</div>
	);

	const dock = live ? (
		<>
			<div className="flex items-center justify-end gap-1 sm:gap-2">
				<DockButton
					icon={RotateCcwIcon}
					label="Start over"
					on
					disabled={isRestarting}
					onClick={() => {
						void restartRecording();
					}}
				/>
				<DockButton
					icon={isPaused ? PlayIcon : PauseIcon}
					label={isPaused ? "Resume" : "Pause"}
					on
					onClick={() => {
						void (isPaused ? resumeRecording() : pauseRecording());
					}}
				/>
			</div>
			<RecordButton
				recording
				label="Stop recording"
				onClick={handleStopClick}
			/>
			<div className="flex items-center justify-start">
				<div className="flex min-w-[7.5rem] flex-col gap-1 px-2">
					<span className="flex items-center gap-2 text-[1.375rem] font-semibold leading-none tabular-nums text-white">
						<LiveDot paused={isPaused} />
						{formatClock(recordingTimerDisplayMs)}
					</span>
					<span className="text-[0.75rem] leading-none text-white/45">
						{isPaused ? "Paused" : user.isPro ? "Recording" : "left on Free"}
					</span>
				</div>
			</div>
		</>
	) : (
		<>
			<div className="flex items-center justify-end gap-0.5 sm:gap-1">
				<DockButton
					icon={micEnabled ? MicIcon : MicOffIcon}
					label={micEnabled ? "Mute" : "Unmute"}
					on={micEnabled}
					disabled={setupLocked || requestingAccess}
					onClick={toggleMic}
					menu={
						availableMics.length > 0 && (
							<DeviceMenu
								title="Microphone"
								devices={availableMics}
								selectedId={selectedMicId}
								fallbackName="Microphone"
								offLabel="No microphone"
								disabled={setupLocked}
								onSelect={handleMicChange}
							/>
						)
					}
				/>
				<DockButton
					icon={cameraEnabled ? CameraIcon : CameraOffIcon}
					label={cameraEnabled ? "Stop camera" : "Start camera"}
					on={cameraEnabled}
					disabled={setupLocked || requestingAccess}
					onClick={toggleCamera}
					menu={
						availableCameras.length > 0 && (
							<DeviceMenu
								title="Camera"
								devices={availableCameras}
								selectedId={selectedCameraId}
								fallbackName="Camera"
								offLabel="No camera"
								disabled={setupLocked}
								onSelect={handleCameraChange}
							/>
						)
					}
				/>
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
				label={recordLabel}
				onClick={() => {
					void handleRecordClick();
				}}
			/>
			<div className="flex items-center justify-start gap-0.5 sm:gap-1">
				{screenSupported && (
					<DockButton
						icon={sharedScreen ? MonitorOffIcon : MonitorUpIcon}
						label={sharedScreen ? "Stop sharing" : "Share screen"}
						on
						disabled={setupLocked || sharePending}
						onClick={() => {
							if (sharedScreen) stopSharing();
							else void shareScreen();
						}}
					/>
				)}
				<MoreMenu
					disabled={setupLocked}
					systemAudio={
						screenSupported
							? {
									enabled: systemAudioEnabled,
									hint: sharedScreen
										? "Takes effect next time you choose what to share."
										: null,
									onChange: handleSystemAudioChange,
								}
							: null
					}
					rememberDevices={rememberDevices}
					onRememberDevicesChange={handleRememberDevicesChange}
				/>
			</div>
		</>
	);

	const statusView = (
		title: string,
		body: string,
		extra?: ReactNode,
		spinner = true,
	) => (
		<main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
			<div className="flex w-full max-w-xl flex-col items-center gap-5 text-center">
				{spinner && (
					<LoaderCircleIcon
						className="size-8 animate-spin text-[#4785FF]"
						aria-hidden
					/>
				)}
				<h2 className="text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
					{title}
				</h2>
				<p className="text-balance text-[0.9375rem] leading-relaxed text-white/60">
					{body}
				</p>
				{extra}
			</div>
		</main>
	);

	const body =
		stage === "finishing" ? (
			statusView(
				"Saving your recording",
				"Your link is already live. The editor opens as soon as the last parts finish uploading.",
				chunkUploads.length > 0 || recordedBytes > 0 ? (
					<div className="w-full text-left">
						<UploadStream
							chunks={chunkUploads}
							recordedBytes={recordedBytes}
							recording={false}
						/>
					</div>
				) : null,
			)
		) : stage === "opening" ? (
			statusView(
				"Opening the editor",
				"Your recording is saved and your link is live. Every track is ready to edit.",
				completedEditUrl ? (
					<a
						href={completedEditUrl}
						className="rounded-full bg-[#4785FF] px-5 py-2.5 text-sm font-medium text-white hover:brightness-110"
					>
						Open the editor
					</a>
				) : null,
			)
		) : stage === "error" ? (
			statusView(
				"Your recording didn't finish saving",
				"Download the recovered files from the bar at the top of the page, or close this and try again.",
				<div className="flex gap-3">
					{completedShareUrl && (
						<Button variant="blue" size="sm" onClick={openCompletedShareUrl}>
							Open recording
						</Button>
					)}
					<Button variant="white" size="sm" onClick={handleClose}>
						Close
					</Button>
				</div>,
				false,
			)
		) : (
			<>
				{studio}
				<footer className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-white/[0.06] bg-[#111214] px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
					{dock}
				</footer>
			</>
		);

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
					className="flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-[#0c0c0e] p-0 text-white shadow-none [color-scheme:dark] [&>button]:hidden"
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
					onEscapeKeyDown={(event) => {
						if (isBusy || isSettingUp) event.preventDefault();
					}}
				>
					<DialogTitle className="sr-only">New recording</DialogTitle>
					{/* A full-screen flow: the support launcher would sit over its controls. */}
					<style>{".cap-messenger-launcher{display:none!important}"}</style>
					<WebRecorderDialogHeader
						isBusy={isBusy || isSettingUp}
						freeMinutes={freeMinutes}
						onClose={handleClose}
					/>
					{body}
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
