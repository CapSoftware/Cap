"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import {
	CameraPreviewWindow,
	type CameraPreviewWindowHandle,
} from "./CameraPreviewWindow";
import { CameraSelector } from "./CameraSelector";
import { HowItWorksPanel } from "./HowItWorksPanel";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecorderStage } from "./RecorderStage";
import { RecordingButton } from "./RecordingButton";
import {
	type RecordingMode,
	RecordingModeSelector,
} from "./RecordingModeSelector";
import { ScreenPickerGuide } from "./ScreenPickerGuide";
import { SettingsPanel } from "./SettingsPanel";
import { SystemAudioToggle } from "./SystemAudioToggle";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import {
	dialogVariants,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";
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

export const WebRecorderDialog = () => {
	const [open, setOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [howItWorksOpen, setHowItWorksOpen] = useState(false);
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
	});

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
			toast.info("Keep this dialog open while your upload finishes.");
			return;
		}

		if (!next) {
			void resetState();
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
			setSettingsOpen(false);
			setHowItWorksOpen(false);
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

	const handleSettingsOpen = () => {
		setSettingsOpen(true);
		setHowItWorksOpen(false);
	};

	const handleHowItWorksOpen = () => {
		setHowItWorksOpen(true);
		setSettingsOpen(false);
	};

	const showInProgressBar = isRecording || isBusy || phase === "error";
	const showCameraPreview =
		selectedCameraId &&
		(recordingMode !== "camera" || (!isSettingUp && !isBusy));
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

	const guideOpen = isSettingUp && recordingMode !== "camera";
	const cameraEnabled = selectedCameraId !== null;

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
					className={clsx(
						"w-[calc(100vw-1.5rem)] max-w-[46rem] border-none bg-transparent p-0 shadow-none transition-opacity duration-200 [&>button]:hidden",
						guideOpen && "pointer-events-none opacity-0",
					)}
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
				>
					<DialogTitle className="sr-only">Record a Cap</DialogTitle>
					<AnimatePresence mode="wait">
						{open && (
							<motion.div
								variants={dialogVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								className={clsx(
									"relative flex max-h-[calc(100dvh-1.5rem)] flex-col gap-4 overflow-y-auto rounded-2xl border border-gray-4 bg-gray-2 p-4 text-[0.875rem] text-gray-12 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)] sm:p-5",
								)}
							>
								<SettingsPanel
									open={settingsOpen}
									rememberDevices={rememberDevices}
									onClose={() => setSettingsOpen(false)}
									onRememberDevicesChange={handleRememberDevicesChange}
								/>
								<HowItWorksPanel
									open={howItWorksOpen}
									onClose={() => setHowItWorksOpen(false)}
								/>
								<WebRecorderDialogHeader
									isBusy={isBusy}
									onClose={handleClose}
									onOpenSettings={handleSettingsOpen}
									onOpenHelp={handleHowItWorksOpen}
								/>
								<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_17.5rem] md:gap-5">
									<RecorderStage
										mode={recordingMode}
										cameraEnabled={cameraEnabled}
										micEnabled={micEnabled}
										systemAudioEnabled={
											recordingMode !== "camera" && systemAudioEnabled
										}
										showLiveCamera={!isSettingUp && !isBusy}
										recording={isRecording}
										getCameraStream={getCameraPreviewStream}
									/>
									<div className="flex min-w-0 flex-col gap-2.5">
										<RecordingModeSelector
											mode={recordingMode}
											disabled={isBusy}
											displayRecordingSupported={
												!supportCheckCompleted || supportsDisplayRecording
											}
											onModeChange={setRecordingMode}
										/>
										{screenCaptureWarning && (
											<p className="px-1 text-[0.75rem] leading-snug text-gray-10">
												This browser can only record your camera. Use Chrome,
												Edge or Cap Desktop on a computer to record your screen
												too.
											</p>
										)}
										<CameraSelector
											selectedCameraId={selectedCameraId}
											availableCameras={availableCameras}
											dialogOpen={open}
											disabled={isBusy}
											open={cameraSelectOpen}
											onOpenChange={(isOpen) => {
												setCameraSelectOpen(isOpen);
												if (isOpen) {
													setMicSelectOpen(false);
												}
											}}
											onCameraChange={handleCameraChange}
											onRefreshDevices={refreshCameras}
										/>
										<MicrophoneSelector
											selectedMicId={selectedMicId}
											availableMics={availableMics}
											dialogOpen={open}
											disabled={isBusy}
											open={micSelectOpen}
											onOpenChange={(isOpen) => {
												setMicSelectOpen(isOpen);
												if (isOpen) {
													setCameraSelectOpen(false);
												}
											}}
											onMicChange={handleMicChange}
											onRefreshDevices={refreshMics}
										/>
										{recordingMode !== "camera" && (
											<SystemAudioToggle
												enabled={systemAudioEnabled}
												disabled={isBusy}
												recordingMode={recordingMode}
												onToggle={handleSystemAudioChange}
											/>
										)}
										<div className="mt-auto flex flex-col gap-2 pt-1">
											<RecordingButton
												isRecording={isRecording}
												isStarting={isSettingUp}
												isFinishing={isBusy && !isRecording}
												disabled={
													!canStartRecording || (isBusy && !isRecording)
												}
												onStart={handleStartClick}
												onStop={handleStopClick}
											/>
											<p className="text-center text-[0.75rem] leading-snug text-gray-10">
												{isBusy && !isRecording
													? "Your link is live. The editor opens as soon as the upload finishes."
													: user.isPro
														? "When you stop, the editor opens and your link is already live."
														: `Up to ${freeMinutes} minutes on Free. When you stop, the editor opens and your link is already live.`}
											</p>
										</div>
									</div>
								</div>
								{!isBrowserSupported && unsupportedReason && (
									<div className="rounded-xl border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
										{unsupportedReason}
									</div>
								)}
								{phase === "completed" && completedEditUrl && (
									<div className="flex items-center justify-between gap-3 rounded-xl border border-gray-4 bg-gray-1 px-3.5 py-3">
										<div className="min-w-0">
											<div className="text-[0.8125rem] font-medium text-gray-12">
												Your Cap is shared
											</div>
											<div className="text-[0.75rem] text-gray-10">
												Opening the editor…
											</div>
										</div>
										<a
											href={completedEditUrl}
											className="shrink-0 rounded-lg bg-blue-9 px-3 py-1.5 text-[0.8125rem] font-medium text-white transition-colors hover:bg-blue-10"
										>
											Open editor
										</a>
									</div>
								)}
								{phase === "error" && completedShareUrl && (
									<div className="flex items-center justify-between gap-3 rounded-xl border border-gray-4 bg-gray-1 px-3.5 py-3">
										<div className="text-[0.8125rem] text-gray-12">
											Check the recording before retrying.
										</div>
										<Button
											variant="blue"
											size="sm"
											onClick={openCompletedShareUrl}
										>
											Open recording
										</Button>
									</div>
								)}
								{phase === "idle" && recoveredDownloads.length > 0 && (
									<div className="rounded-xl border border-gray-4 bg-gray-1 px-3.5 py-3">
										<div className="text-xs font-medium text-gray-12">
											Recovered recordings
										</div>
										<div className="mt-2 flex flex-col gap-2">
											{recoveredDownloads.map((download) => (
												<div
													key={download.id}
													className="flex items-center justify-between gap-3 rounded-lg bg-gray-3 px-2.5 py-2 text-xs text-gray-12"
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
															onClick={() =>
																dismissRecoveredDownload(download.id)
															}
														>
															Dismiss
														</button>
													</div>
												</div>
											))}
										</div>
									</div>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</DialogContent>
			</Dialog>
			<ScreenPickerGuide
				open={open && guideOpen}
				mode={recordingMode}
				cameraEnabled={cameraEnabled}
				micEnabled={micEnabled}
				systemAudioEnabled={systemAudioEnabled}
			/>
			{showInProgressBar && (
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
