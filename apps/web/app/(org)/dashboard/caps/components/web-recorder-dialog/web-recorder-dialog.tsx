"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import {
	CameraOffIcon,
	LoaderCircleIcon,
	MonitorIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
} from "lucide-react";
import {
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
import { CameraSelector } from "./CameraSelector";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import {
	type RecordingMode,
	RecordingModeSelector,
} from "./RecordingModeSelector";
import {
	CountdownDial,
	formatClock,
	LiveVideo,
	MicMeter,
	Overlay,
	PickingScreen,
	Steps,
	TrackList,
	UploadStream,
	useLiveStream,
	useMicLevel,
} from "./recorder-takeover";
import { SystemAudioToggle } from "./SystemAudioToggle";
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

const PREVIEW_FRAME =
	"relative mx-auto aspect-video w-full max-w-[min(100%,calc(62dvh*16/9))] overflow-hidden rounded-2xl bg-[#111214]";

const Label = ({ children }: { children: ReactNode }) => (
	<h2 className="flex items-center justify-between text-[0.8125rem] font-medium text-gray-11">
		{children}
	</h2>
);

const SecondaryButton = ({
	onClick,
	disabled,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled}
		className="flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-4 bg-gray-1 text-[0.875rem] font-medium text-gray-12 transition-colors hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 disabled:cursor-not-allowed disabled:opacity-40"
	>
		{children}
	</button>
);

export const WebRecorderDialog = () => {
	const [open, setOpen] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);
	const cameraPreviewRef = useRef<CameraPreviewWindowHandle>(null);
	const getCameraPreviewStream = useCallback(
		() => cameraPreviewRef.current?.getVideoStream() ?? null,
		[],
	);

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

	useEffect(() => {
		if (
			recordingMode === "camera" &&
			!selectedCameraId &&
			availableCameras.length > 0
		) {
			setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
		}
	}, [recordingMode, selectedCameraId, availableCameras, setSelectedCameraId]);

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
	// Camera-only recordings own their camera stream; screen recordings keep
	// recording a clone of the preview, so fall back to that.
	const getLiveCamera = useCallback(
		() => activeCameraGetterRef.current() ?? getCameraPreviewStream(),
		[getCameraPreviewStream],
	);

	useEffect(() => {
		if (!isSettingUp) finishCountdownRef.current?.();
	}, [isSettingUp]);

	useEffect(() => {
		if (
			!supportCheckCompleted ||
			supportsDisplayRecording ||
			recordingMode === "camera"
		) {
			return;
		}

		setRecordingMode("camera");
	}, [supportCheckCompleted, supportsDisplayRecording, recordingMode]);

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

	const handleStartClick = useCallback(async () => {
		if (recordingMode === "camera") {
			cameraPreviewRef.current?.stopStream();
			await waitForNextFrame();
		}

		await startRecording();
	}, [recordingMode, startRecording]);

	const handleClose = () => {
		if (!isBusy) {
			handleOpenChange(false);
		}
	};

	const screenMode = recordingMode !== "camera";
	const cameraEnabled = selectedCameraId !== null;
	const finishing =
		phase === "creating" || phase === "converting" || phase === "uploading";
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
								? screenMode
									? "picking"
									: "starting"
								: "setup";
	const showCameraPreview =
		selectedCameraId &&
		(recordingMode !== "camera" || (!isSettingUp && !isBusy));
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);
	const previewStream = useLiveStream(
		getCameraPreviewStream,
		open && cameraEnabled && stage === "setup",
	);
	const liveCameraStream = useLiveStream(
		getLiveCamera,
		open && cameraEnabled && (stage === "recording" || stage === "countdown"),
	);
	const micLevel = useMicLevel(selectedMicId, open && stage === "setup");

	// The picked surface only describes the last capture; the next one starts
	// from the full picker again.
	useEffect(() => {
		if (
			phase === "idle" &&
			!isSettingUp &&
			(recordingMode === "window" || recordingMode === "tab")
		) {
			setRecordingMode("fullscreen");
		}
	}, [phase, isSettingUp, recordingMode]);

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

	const recordingControls = (
		<div className="flex flex-col gap-2.5">
			<button
				type="button"
				onClick={handleStopClick}
				className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-[#e5484d] text-base font-semibold text-white shadow-[0_12px_28px_-14px_rgba(229,72,77,0.9)] transition-[filter,transform] hover:brightness-105 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5484d] focus-visible:ring-offset-2"
			>
				<span className="size-3.5 rounded-[3px] bg-white" aria-hidden />
				Stop recording
			</button>
			<div className="grid grid-cols-2 gap-2.5">
				<SecondaryButton
					onClick={() => {
						void (isPaused ? resumeRecording() : pauseRecording());
					}}
				>
					{isPaused ? (
						<PlayIcon className="size-4" aria-hidden />
					) : (
						<PauseIcon className="size-4" aria-hidden />
					)}
					{isPaused ? "Resume" : "Pause"}
				</SecondaryButton>
				<SecondaryButton
					onClick={() => {
						void restartRecording();
					}}
					disabled={isRestarting}
				>
					<RotateCcwIcon className="size-4" aria-hidden />
					Start over
				</SecondaryButton>
			</div>
		</div>
	);

	const recordingBadge = (
		<span className="inline-flex items-center gap-2 text-[0.875rem] font-medium text-gray-12">
			<span
				className={
					isPaused
						? "size-2.5 rounded-full bg-gray-8"
						: "size-2.5 animate-pulse rounded-full bg-[#e5484d] motion-reduce:animate-none"
				}
			/>
			{isPaused ? "Paused" : "Recording"}
		</span>
	);

	const startControls = (
		<>
			<RecordingButton
				isRecording={false}
				disabled={!canStartRecording}
				onStart={handleStartClick}
				onStop={handleStopClick}
			/>
			<p className="text-center text-[0.8125rem] leading-snug text-gray-10">
				{screenMode
					? "Next, your browser asks what to share."
					: "Recording starts straight away."}
				{user.isPro ? "" : ` Up to ${freeMinutes} minutes on Free.`}
			</p>
		</>
	);

	const setupView = (
		<div className="mx-auto grid w-full max-w-[1240px] gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10 lg:py-10">
			<section className="flex min-w-0 flex-col gap-5">
				<div className={PREVIEW_FRAME}>
					{cameraEnabled ? (
						previewStream ? (
							<LiveVideo
								stream={previewStream}
								className="absolute inset-0 size-full"
							/>
						) : (
							<div className="absolute inset-0 flex items-center justify-center">
								<LoaderCircleIcon
									className="size-6 animate-spin text-white/60"
									aria-hidden
								/>
							</div>
						)
					) : (
						<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white">
							<CameraOffIcon className="size-8 text-white/60" aria-hidden />
							<div className="flex flex-col gap-1">
								<span className="text-lg font-semibold">Camera is off</span>
								<span className="text-sm text-white/60">
									{screenMode
										? "Your recording will be your screen only."
										: "Choose a camera to record."}
								</span>
							</div>
							{availableCameras.length > 0 && (
								<button
									type="button"
									onClick={() =>
										handleCameraChange(availableCameras[0]?.deviceId ?? null)
									}
									className="mt-1 rounded-full bg-white px-4 py-2 text-sm font-medium text-[#111214] transition-colors hover:bg-white/90"
								>
									Turn on camera
								</button>
							)}
						</div>
					)}
					{cameraEnabled && (
						<Overlay className="absolute left-3 top-3">
							<span className="size-1.5 rounded-full bg-[#22B07D]" />
							Camera preview
						</Overlay>
					)}
				</div>
				<p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-gray-11">
					<span className="font-medium text-gray-12">
						This is only a preview.
					</span>{" "}
					{screenMode
						? "Your camera records on its own track, separate from your screen, and appears in your video when you stop recording."
						: "Your camera and mic record on their own tracks, and your video opens in the editor when you stop."}
				</p>
				<div className="flex flex-col gap-2.5">
					<span className="text-[0.8125rem] text-gray-10">
						Saved as separate tracks you can edit afterwards
					</span>
					<TrackList
						screen={screenMode ? true : null}
						camera={cameraEnabled}
						mic={micEnabled}
						systemAudio={screenMode ? systemAudioEnabled : null}
					/>
				</div>
			</section>
			<aside className="flex flex-col gap-5 lg:sticky lg:top-8 lg:self-start">
				<div className="flex flex-col gap-2">
					<Label>Record</Label>
					<RecordingModeSelector
						mode={recordingMode}
						disabled={isBusy}
						displayRecordingSupported={
							!supportCheckCompleted || supportsDisplayRecording
						}
						onModeChange={setRecordingMode}
					/>
					{screenCaptureWarning && (
						<p className="px-1 text-[0.8125rem] leading-snug text-gray-10">
							This browser can only record your camera. Use Chrome, Edge or Cap
							Desktop on a computer to record your screen too.
						</p>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<Label>Camera</Label>
					<CameraSelector
						selectedCameraId={selectedCameraId}
						availableCameras={availableCameras}
						dialogOpen={open}
						disabled={isBusy}
						open={cameraSelectOpen}
						onOpenChange={(isOpen) => {
							setCameraSelectOpen(isOpen);
							if (isOpen) setMicSelectOpen(false);
						}}
						onCameraChange={handleCameraChange}
						onRefreshDevices={refreshCameras}
					/>
				</div>
				<div className="flex flex-col gap-2">
					<Label>
						Microphone
						{micEnabled && <MicMeter level={micLevel} />}
					</Label>
					<MicrophoneSelector
						selectedMicId={selectedMicId}
						availableMics={availableMics}
						dialogOpen={open}
						disabled={isBusy}
						open={micSelectOpen}
						onOpenChange={(isOpen) => {
							setMicSelectOpen(isOpen);
							if (isOpen) setCameraSelectOpen(false);
						}}
						onMicChange={handleMicChange}
						onRefreshDevices={refreshMics}
					/>
					{screenMode && (
						<SystemAudioToggle
							enabled={systemAudioEnabled}
							disabled={isBusy}
							recordingMode={recordingMode}
							onToggle={handleSystemAudioChange}
						/>
					)}
				</div>
				<div className="hidden flex-col gap-2.5 pt-1 lg:flex">
					{startControls}
				</div>
				{!isBrowserSupported && unsupportedReason && (
					<p className="rounded-xl border border-red-6 bg-red-3 px-3 py-2 text-[0.8125rem] leading-snug text-red-12">
						{unsupportedReason}
					</p>
				)}
				{recoveredDownloads.length > 0 && (
					<div className="flex flex-col gap-2 rounded-xl border border-gray-4 bg-gray-1 p-3">
						<span className="text-[0.8125rem] font-medium text-gray-12">
							Recovered recordings
						</span>
						{recoveredDownloads.map((download) => (
							<div
								key={download.id}
								className="flex items-center justify-between gap-3 rounded-lg bg-gray-2 px-2.5 py-2 text-xs text-gray-12"
							>
								<div className="min-w-0">
									<div className="truncate font-medium">
										{download.fileName}
									</div>
									<div className="text-gray-10">
										{recoveredRecordingTimeFormatter.format(
											new Date(download.createdAt),
										)}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<a
										href={download.url}
										download={download.fileName}
										className="font-medium text-blue-11 hover:text-blue-12"
										onClick={() =>
											setTimeout(
												() => dismissRecoveredDownload(download.id),
												500,
											)
										}
									>
										Download
									</a>
									<button
										type="button"
										className="text-gray-10 hover:text-gray-12"
										onClick={() => dismissRecoveredDownload(download.id)}
									>
										Dismiss
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</aside>
			{screenMode && (
				<div className="lg:col-span-2">
					<Steps current={0} />
				</div>
			)}
		</div>
	);

	const cameraFrame = (overlay: ReactNode, dim = false) => (
		<div className={PREVIEW_FRAME}>
			{cameraEnabled ? (
				<LiveVideo
					stream={liveCameraStream}
					className="absolute inset-0 size-full"
				/>
			) : (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
					<MonitorIcon className="size-8" aria-hidden />
					<span className="text-sm">Recording your screen</span>
				</div>
			)}
			{dim && (
				<div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
			)}
			{overlay}
		</div>
	);

	const countdownView = (
		<div className="mx-auto flex w-full max-w-[1100px] flex-col items-center gap-6 px-4 py-6 sm:px-8 lg:py-10">
			{cameraFrame(
				<div className="absolute inset-0 flex items-center justify-center">
					<CountdownDial value={countdown ?? 1} />
				</div>,
				true,
			)}
			<div className="flex flex-col items-center gap-3 text-center">
				<h2 className="text-balance text-2xl font-semibold tracking-tight text-gray-12 sm:text-3xl">
					{screenMode ? "Get ready, you're about to record" : "Get ready"}
				</h2>
				<p className="max-w-xl text-balance text-base leading-relaxed text-gray-10">
					{screenMode
						? "Recording starts when the countdown ends. Then switch to your screen and present."
						: "Recording starts when the countdown ends."}
				</p>
				<button
					type="button"
					onClick={() => finishCountdownRef.current?.()}
					className="rounded-full border border-gray-4 bg-gray-1 px-4 py-2 text-sm font-medium text-gray-12 transition-colors hover:bg-gray-3"
				>
					Start now
				</button>
			</div>
		</div>
	);

	const recordingView = (
		<div className="mx-auto grid w-full max-w-[1240px] gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10 lg:py-10">
			<section className="flex min-w-0 flex-col gap-5">
				{cameraFrame(
					<>
						<Overlay className="absolute left-3 top-3">
							<span
								className={
									isPaused
										? "size-1.5 rounded-full bg-white/60"
										: "size-1.5 animate-pulse rounded-full bg-[#ff4d4d] motion-reduce:animate-none"
								}
							/>
							{isPaused ? "Paused" : "Recording"}
							<span className="tabular-nums text-white/80">
								{formatClock(durationMs)}
							</span>
						</Overlay>
						{cameraEnabled && (
							<Overlay className="absolute right-3 top-3">
								Camera preview
							</Overlay>
						)}
					</>,
				)}
				<UploadStream
					chunks={chunkUploads}
					recordedBytes={recordedBytes}
					recording
					paused={isPaused}
				/>
			</section>
			<aside className="flex flex-col gap-6 lg:sticky lg:top-8 lg:self-start">
				<div className="flex flex-col gap-1">
					{recordingBadge}
					<span className="text-6xl font-semibold tabular-nums tracking-tight text-gray-12">
						{formatClock(recordingTimerDisplayMs)}
					</span>
					{!user.isPro && (
						<span className="text-[0.8125rem] text-gray-10">
							left on the Free plan
						</span>
					)}
				</div>
				{screenMode ? (
					<div className="flex flex-col gap-2 rounded-2xl border border-blue-6 bg-blue-2 p-4">
						<span className="text-[1.0625rem] font-semibold leading-snug text-gray-12">
							Now switch to the screen you're sharing
						</span>
						<span className="text-[0.875rem] leading-relaxed text-gray-11">
							This tab is just your controls and camera preview. Present as
							normal, then come back here to stop.
						</span>
					</div>
				) : (
					<p className="text-[0.9375rem] leading-relaxed text-gray-11">
						You're recording your camera and mic. Stop when you're done and the
						editor opens.
					</p>
				)}
				{recordingControls}
				<div className="flex flex-col gap-2">
					<span className="text-[0.8125rem] text-gray-10">
						Recording as separate tracks
					</span>
					<TrackList
						live
						screen={screenMode ? true : null}
						camera={cameraEnabled}
						mic={micEnabled}
						systemAudio={screenMode ? systemAudioEnabled : null}
					/>
				</div>
			</aside>
		</div>
	);

	const statusView = (
		title: string,
		body: string,
		extra?: ReactNode,
		spinner = true,
	) => (
		<div className="mx-auto flex max-w-xl flex-col items-center gap-5 px-4 py-20 text-center">
			{spinner && (
				<LoaderCircleIcon
					className="size-8 animate-spin text-blue-9"
					aria-hidden
				/>
			)}
			<h2 className="text-balance text-2xl font-semibold tracking-tight text-gray-12 sm:text-3xl">
				{title}
			</h2>
			<p className="text-balance text-base leading-relaxed text-gray-10">
				{body}
			</p>
			{extra}
		</div>
	);

	const stageView =
		stage === "setup" ? (
			setupView
		) : stage === "picking" ? (
			<div className="mx-auto flex w-full max-w-[1000px] flex-col gap-12 px-4 pb-10 pt-[18vh] sm:px-8">
				<PickingScreen />
				<Steps current={1} />
			</div>
		) : stage === "starting" ? (
			statusView("Starting your camera", "Recording begins in a moment.")
		) : stage === "countdown" ? (
			countdownView
		) : stage === "recording" ? (
			recordingView
		) : stage === "finishing" ? (
			statusView(
				"Saving your recording",
				"Your link is already live. The editor opens as soon as the last parts finish uploading.",
				chunkUploads.length > 0 ? (
					<div className="w-full max-w-xl text-left">
						<UploadStream chunks={chunkUploads} recording={false} />
					</div>
				) : null,
			)
		) : stage === "opening" ? (
			statusView(
				"Opening the editor",
				"Your recording is saved and your link is live.",
				completedEditUrl ? (
					<a
						href={completedEditUrl}
						className="rounded-full bg-blue-9 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-10"
					>
						Open the editor
					</a>
				) : null,
			)
		) : (
			statusView(
				"Your recording didn't finish saving",
				"Download the recovered files from the bar at the top of the page, or close this and try again.",
				<div className="flex gap-3">
					{completedShareUrl && (
						<Button variant="blue" size="sm" onClick={openCompletedShareUrl}>
							Open recording
						</Button>
					)}
					<Button variant="gray" size="sm" onClick={handleClose}>
						Close
					</Button>
				</div>,
				false,
			)
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
					className="flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-gray-2 p-0 text-gray-12 shadow-none [&>button]:hidden"
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
						rememberDevices={rememberDevices}
						onRememberDevicesChange={handleRememberDevicesChange}
						onClose={handleClose}
					/>
					<main className="min-h-0 flex-1 overflow-y-auto">{stageView}</main>
					{stage === "setup" && (
						<div className="flex flex-col gap-2 border-t border-gray-3 bg-gray-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:hidden">
							{startControls}
						</div>
					)}
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
