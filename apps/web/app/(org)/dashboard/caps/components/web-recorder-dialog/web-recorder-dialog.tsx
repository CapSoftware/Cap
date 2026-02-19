"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import { CameraPreviewWindow } from "./CameraPreviewWindow";
import { CameraSelector } from "./CameraSelector";
import { HowItWorksButton } from "./HowItWorksButton";
import { HowItWorksPanel } from "./HowItWorksPanel";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import {
	type RecordingMode,
	RecordingModeSelector,
} from "./RecordingModeSelector";
import { SettingsButton } from "./SettingsButton";
import { SettingsPanel } from "./SettingsPanel";
import { SystemAudioToggle } from "./SystemAudioToggle";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useStudioRecorder } from "./useStudioRecorder";
import { useWebRecorder } from "./useWebRecorder";
import {
	dialogVariants,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";

type CaptureMode = "instant" | "studio";

type RecorderDialogHostProps = {
	open: boolean;
	setOpen: (open: boolean) => void;
	captureMode: CaptureMode;
	setCaptureMode: (mode: CaptureMode) => void;
};

export const WebRecorderDialog = () => {
	const [open, setOpen] = useState(false);
	const [captureMode, setCaptureMode] = useState<CaptureMode>("instant");

	const hostProps: RecorderDialogHostProps = {
		open,
		setOpen,
		captureMode,
		setCaptureMode,
	};

	if (captureMode === "studio") {
		return <StudioRecorderDialog key="studio" {...hostProps} />;
	}
	return <InstantRecorderDialog key="instant" {...hostProps} />;
};

function InstantRecorderDialog(props: RecorderDialogHostProps) {
	return <RecorderDialogInner {...props} useRecorder={useWebRecorder} />;
}

function StudioRecorderDialog(props: RecorderDialogHostProps) {
	return <RecorderDialogInner {...props} useRecorder={useStudioRecorder} />;
}

function RecorderDialogInner({
	open,
	setOpen,
	captureMode,
	setCaptureMode,
	useRecorder,
}: RecorderDialogHostProps & {
	useRecorder: typeof useWebRecorder;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [howItWorksOpen, setHowItWorksOpen] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);

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

	useEffect(() => {
		if (
			captureMode === "studio" &&
			!selectedCameraId &&
			availableCameras.length > 0
		) {
			setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
		}
	}, [captureMode, selectedCameraId, availableCameras, setSelectedCameraId]);

	const {
		phase,
		durationMs,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
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
		restartRecording,
		resetState,
	} = useRecorder({
		organisationId,
		selectedMicId,
		micEnabled,
		systemAudioEnabled,
		recordingMode,
		selectedCameraId,
		isProUser: user.isPro,
		onRecordingSurfaceDetected: (mode) => {
			setRecordingMode(mode);
		},
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
	});

	useEffect(() => {
		if (phase === "completed") {
			setOpen(false);
		}
	}, [phase, setOpen]);

	useEffect(() => {
		if (
			!supportCheckCompleted ||
			supportsDisplayRecording ||
			recordingMode === "camera"
		) {
			return;
		}

		if (captureMode === "instant") {
			setRecordingMode("camera");
		}
	}, [
		supportCheckCompleted,
		supportsDisplayRecording,
		recordingMode,
		captureMode,
	]);

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
			resetState();
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
			setCaptureMode("instant");
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
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

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
					className="w-[300px] border-none bg-transparent p-0 [&>button]:hidden"
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
				>
					<DialogTitle className="sr-only">
						{captureMode === "studio"
							? "Studio Mode Recorder"
							: "Instant Mode Recorder"}
					</DialogTitle>
					<AnimatePresence mode="wait">
						{open && (
							<motion.div
								variants={dialogVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								className="relative flex justify-center flex-col p-[1rem] pt-[2rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[350px]"
							>
								<SettingsButton
									visible={!settingsOpen}
									onClick={handleSettingsOpen}
								/>
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
								/>
								<div className="flex rounded-lg border border-gray-3 p-0.5 gap-0.5">
									<button
										type="button"
										disabled={isBusy}
										className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
											captureMode === "instant"
												? "bg-gray-12 text-gray-1"
												: "text-gray-11 hover:text-gray-12"
										} disabled:opacity-50`}
										onClick={() => setCaptureMode("instant")}
									>
										Instant
									</button>
									<button
										type="button"
										disabled={isBusy}
										className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
											captureMode === "studio"
												? "bg-gray-12 text-gray-1"
												: "text-gray-11 hover:text-gray-12"
										} disabled:opacity-50`}
										onClick={() => setCaptureMode("studio")}
									>
										Studio
									</button>
								</div>
								{captureMode === "studio" && !selectedCameraId && (
									<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12">
										Camera is required for Studio Mode. Select a camera below.
									</div>
								)}
								{captureMode === "instant" && (
									<RecordingModeSelector
										mode={recordingMode}
										disabled={isBusy}
										onModeChange={setRecordingMode}
									/>
								)}
								{screenCaptureWarning && (
									<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12">
										{screenCaptureWarning}
									</div>
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
								<RecordingButton
									isRecording={isRecording}
									disabled={!canStartRecording || (isBusy && !isRecording)}
									onStart={startRecording}
									onStop={handleStopClick}
								/>
								{!isBrowserSupported && unsupportedReason && (
									<div className="rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
										{unsupportedReason}
									</div>
								)}
								<HowItWorksButton onClick={handleHowItWorksOpen} />
							</motion.div>
						)}
					</AnimatePresence>
				</DialogContent>
			</Dialog>
			{showInProgressBar && (
				<InProgressRecordingBar
					phase={phase}
					durationMs={recordingTimerDisplayMs}
					hasAudioTrack={hasAudioTrack}
					chunkUploads={chunkUploads}
					errorDownload={errorDownload}
					onStop={handleStopClick}
					onPause={pauseRecording}
					onResume={resumeRecording}
					onRestart={restartRecording}
					isRestarting={isRestarting}
				/>
			)}
			{selectedCameraId && (
				<CameraPreviewWindow
					cameraId={selectedCameraId}
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);
}
