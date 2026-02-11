"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAP_WEB_ORIGIN } from "@/lib/cap-web";
import type { CameraState } from "@/lib/messages";
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
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useStudioRecorder } from "./useStudioRecorder";
import { useWebRecorder } from "./useWebRecorder";
import {
	dialogVariants,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";

type CaptureMode = "instant" | "studio";

export const WebRecorderPanel = ({
	organisationId,
	isProUser,
	apiKey,
	onOpenDashboard,
	onSignOut,
}: {
	organisationId: string;
	isProUser: boolean;
	apiKey: string;
	onOpenDashboard?: () => void;
	onSignOut?: () => void;
}) => {
	const [captureMode, setCaptureMode] = useState<CaptureMode>("instant");

	if (captureMode === "studio") {
		return (
			<RecorderPanelInner
				key="studio"
				apiOrigin={CAP_WEB_ORIGIN}
				apiKey={apiKey}
				organisationId={organisationId}
				isProUser={isProUser}
				captureMode={captureMode}
				setCaptureMode={setCaptureMode}
				onOpenDashboard={onOpenDashboard}
				onSignOut={onSignOut}
				useRecorder={useStudioRecorder}
			/>
		);
	}

	return (
		<RecorderPanelInner
			key="instant"
			apiOrigin={CAP_WEB_ORIGIN}
			apiKey={apiKey}
			organisationId={organisationId}
			isProUser={isProUser}
			captureMode={captureMode}
			setCaptureMode={setCaptureMode}
			onOpenDashboard={onOpenDashboard}
			onSignOut={onSignOut}
			useRecorder={useWebRecorder}
		/>
	);
};

function RecorderPanelInner({
	apiOrigin,
	apiKey,
	organisationId,
	isProUser,
	captureMode,
	setCaptureMode,
	onOpenDashboard,
	onSignOut,
	useRecorder,
}: {
	apiOrigin: string;
	apiKey: string;
	organisationId: string;
	isProUser: boolean;
	captureMode: CaptureMode;
	setCaptureMode: (mode: CaptureMode) => void;
	onOpenDashboard?: () => void;
	onSignOut?: () => void;
	useRecorder: typeof useWebRecorder;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [howItWorksOpen, setHowItWorksOpen] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);
	const skipNextCameraSyncRef = useRef(false);

	useEffect(() => {
		if (typeof window === "undefined") return;

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
		if (!audio) return;
		audio.currentTime = 0;
		void audio.play().catch(() => {});
	}, []);

	const handleRecordingStartSound = useCallback(() => {
		playAudio(startSoundRef.current);
	}, [playAudio]);

	const handleRecordingStopSound = useCallback(() => {
		playAudio(stopSoundRef.current);
	}, [playAudio]);

	const dialogOpen = true;
	const { devices: availableMics, refresh: refreshMics } =
		useMicrophoneDevices(dialogOpen);
	const { devices: availableCameras, refresh: refreshCameras } =
		useCameraDevices(dialogOpen);

	const {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		setSelectedCameraId,
		handleCameraChange,
		handleMicChange,
		handleRememberDevicesChange,
	} = useDevicePreferences({
		open: dialogOpen,
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
	} = useRecorder({
		apiOrigin,
		apiKey,
		organisationId,
		selectedMicId,
		micEnabled,
		recordingMode,
		selectedCameraId,
		isProUser,
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

		if (captureMode === "instant") {
			setRecordingMode("camera");
		}
	}, [
		supportCheckCompleted,
		supportsDisplayRecording,
		recordingMode,
		captureMode,
	]);

	const handleStopClick = () => {
		stopRecording().catch((err: unknown) => {
			console.error("Stop recording error", err);
		});
	};

	const handleSettingsOpen = () => {
		setSettingsOpen(true);
		setHowItWorksOpen(false);
	};

	const handleHowItWorksOpen = () => {
		setHowItWorksOpen(true);
		setSettingsOpen(false);
	};

	useEffect(() => {
		if (skipNextCameraSyncRef.current) {
			skipNextCameraSyncRef.current = false;
			return;
		}

		if (selectedCameraId) {
			const state: CameraState = {
				deviceId: selectedCameraId,
				size: "sm",
				shape: "round",
				mirrored: false,
			};
			chrome.runtime.sendMessage({ type: "SHOW_CAMERA", state });
		} else {
			chrome.runtime.sendMessage({ type: "HIDE_CAMERA" });
		}
	}, [selectedCameraId]);

	useEffect(() => {
		chrome.runtime.sendMessage(
			{ type: "GET_CAMERA_STATE" },
			(response: unknown) => {
				const res = response as { state?: CameraState | null } | null;
				if (res?.state?.deviceId) {
					skipNextCameraSyncRef.current = true;
					setSelectedCameraId(res.state.deviceId);
				}
			},
		);
	}, [setSelectedCameraId]);

	const showInProgressBar = isRecording || isBusy || phase === "error";
	const recordingTimerDisplayMs = isProUser
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

	return (
		<>
			<AnimatePresence mode="wait">
				<motion.div
					variants={dialogVariants}
					initial="hidden"
					animate="visible"
					exit="exit"
					className="relative flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[350px]"
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
						onOpenDashboard={onOpenDashboard}
						onSignOut={onSignOut}
					/>
					<HowItWorksPanel
						open={howItWorksOpen}
						onClose={() => setHowItWorksOpen(false)}
					/>
					<WebRecorderDialogHeader isProUser={isProUser} />
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
						dialogOpen={dialogOpen}
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
						dialogOpen={dialogOpen}
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
			</AnimatePresence>
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
		</>
	);
}
