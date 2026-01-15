"use client";

import { Button, LogoBadge, Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { CogIcon } from "../dashboard/_components/AnimatedIcons";
import { CameraPreviewWindow } from "../dashboard/caps/components/web-recorder-dialog/CameraPreviewWindow";
import { CameraSelector } from "../dashboard/caps/components/web-recorder-dialog/CameraSelector";
import { MicrophoneSelector } from "../dashboard/caps/components/web-recorder-dialog/MicrophoneSelector";
import {
	type RecordingMode,
	RecordingModeSelector,
} from "../dashboard/caps/components/web-recorder-dialog/RecordingModeSelector";
import { useCameraDevices } from "../dashboard/caps/components/web-recorder-dialog/useCameraDevices";
import { useDevicePreferences } from "../dashboard/caps/components/web-recorder-dialog/useDevicePreferences";
import { useMicrophoneDevices } from "../dashboard/caps/components/web-recorder-dialog/useMicrophoneDevices";
import { useWebRecorder } from "../dashboard/caps/components/web-recorder-dialog/useWebRecorder";
import { FREE_PLAN_MAX_RECORDING_MS } from "../dashboard/caps/components/web-recorder-dialog/web-recorder-constants";

export const RecorderPageContent = () => {
	const router = useRouter();
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
	const [isClient, setIsClient] = useState(false);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);

	const user = useCurrentUser();
	console.log('userrrrrrrrrr: ', user);

	useEffect(() => {
		setIsClient(true);
	}, []);

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
		void audio.play().catch(() => {});
	}, []);

	const handleRecordingStartSound = useCallback(() => {
		playAudio(startSoundRef.current);
	}, [playAudio]);

	const handleRecordingStopSound = useCallback(() => {
		playAudio(stopSoundRef.current);
	}, [playAudio]);

	useEffect(() => {
		if (!user) return;

		const requestPermissions = async () => {
			try {
				const savedCameraId = window.localStorage.getItem('cap-web-recorder-preferred-camera');
				const savedMicId = window.localStorage.getItem('cap-web-recorder-preferred-microphone');

				const constraints: MediaStreamConstraints = {
					video: savedCameraId ? { deviceId: { exact: savedCameraId } } : true,
					audio: savedMicId ? { deviceId: { exact: savedMicId } } : true
				};

				const stream = await navigator.mediaDevices.getUserMedia(constraints);
				console.log('Permission granted, tracks:', stream.getTracks().map(t => ({ kind: t.kind, label: t.label, id: t.id })));
				stream.getTracks().forEach(track => track.stop());
			} catch (error) {
				console.error('Permission request failed:', error);
				try {
					const stream = await navigator.mediaDevices.getUserMedia({
						video: true,
						audio: true
					});
					console.log('Fallback permission granted');
					stream.getTracks().forEach(track => track.stop());
				} catch (fallbackError) {
					console.error('Fallback permission also failed:', fallbackError);
				}
			}
		};

		requestPermissions();
	}, [user]);

	const { devices: availableMics, refresh: refreshMics } =
		useMicrophoneDevices(isClient);
	const { devices: availableCameras, refresh: refreshCameras } =
		useCameraDevices(isClient);
	const {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		setSelectedCameraId,
		handleCameraChange,
		handleMicChange,
		handleRememberDevicesChange,
	} = useDevicePreferences({
		open: isClient,
		availableCameras,
		availableMics,
	});

	const micEnabled = selectedMicId !== null;
	const organisationId = user?.defaultOrgId;

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
		isRecording,
		isBusy,
		canStartRecording,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
		startRecording,
		stopRecording,
	} = useWebRecorder({
		organisationId,
		selectedMicId,
		micEnabled,
		recordingMode,
		selectedCameraId,
		isProUser: user?.isPro ?? false,
		onRecordingSurfaceDetected: (mode) => {
			setRecordingMode(mode);
		},
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
	});

	useEffect(() => {
		console.log('Recording state:', {
			canStartRecording,
			isBrowserSupported,
			supportCheckCompleted,
			supportsDisplayRecording,
			recordingMode,
			organisationId,
			unsupportedReason
		});
	}, [canStartRecording, isBrowserSupported, supportCheckCompleted, supportsDisplayRecording, recordingMode, organisationId, unsupportedReason]);

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

	const handleStopClick = () => {
		stopRecording().catch((err: unknown) => {
			console.error("Stop recording error", err);
		});
	};

	const handleSignOut = async () => {
		try {
			await fetch("/api/auth/signout", {
				method: "POST",
				credentials: "include",
			});
			router.push(`/login?callbackUrl=${encodeURIComponent("/record")}`);
		} catch (error) {
			console.error("Sign out failed:", error);
		}
	};

	const recordingTimerDisplayMs = user?.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

	const formatDuration = (ms: number) => {
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${seconds.toString().padStart(2, "0")}`;
	};

	if (!user) {
		return (
			<div className="p-5">
				<div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
					<LogoBadge className="w-16 h-16" />
					<div className="text-center">
						<h2 className="text-lg font-semibold text-gray-12 mb-2">
							Sign in to Cap
						</h2>
						<p className="text-sm text-gray-11 mb-4">
							Sign in to start recording your screen
						</p>
					</div>
					<Button
						onClick={() => {
							router.push(`/login?callbackUrl=${encodeURIComponent("/record")}`);
						}}
						className="w-full"
						variant="primary"
					>
						Sign In
					</Button>
				</div>
			</div>
		);
	}

	if (!isClient) {
		return (
			<div className="p-5">
				<div className="flex flex-col items-center justify-center min-h-[300px]">
					<div className="flex flex-col items-center gap-4">
						<svg
							className="animate-spin text-blue-9"
							width="32"
							height="32"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<circle cx="12" cy="12" r="10" opacity="0.25" />
							<path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
						</svg>
						<p className="text-sm font-medium text-gray-11">Loading...</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="p-5 relative">
				<div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-3">
					<LogoBadge className="w-8 h-8" />
					<h1 className="text-xl font-semibold text-gray-12">Cap</h1>
				</div>

				<div className="mb-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white font-semibold text-sm">
								{(user.name || user.email).charAt(0).toUpperCase()}
							</div>
							<span className="text-sm font-medium text-gray-12">
								{user.name || user.email}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => setSettingsPanelOpen(true)}
								className="p-1 flex items-center justify-center rounded border-none bg-transparent text-gray-11 hover:bg-gray-3 transition-colors cursor-pointer"
								title="Settings"
							>
								<CogIcon size={16} />
							</button>
							<button
								type="button"
								onClick={handleSignOut}
								className="p-1 flex items-center justify-center rounded border-none bg-transparent text-gray-11 hover:bg-gray-3 transition-colors cursor-pointer"
								title="Sign Out"
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								>
									<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
									<polyline points="16 17 21 12 16 7" />
									<line x1="21" y1="12" x2="9" y2="12" />
								</svg>
							</button>
						</div>
					</div>
				</div>

				<div className="mb-3 w-full">
					<div className="w-full [&_button]:!max-w-full [&_[role='listbox']]:!max-w-full">
						<RecordingModeSelector
							mode={recordingMode}
							disabled={isBusy}
							onModeChange={setRecordingMode}
						/>
					</div>
				</div>

				{screenCaptureWarning && (
					<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12 mb-3">
						{screenCaptureWarning}
					</div>
				)}

				<div className="mb-3">
					<CameraSelector
						selectedCameraId={selectedCameraId}
						availableCameras={availableCameras}
						dialogOpen={isClient}
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
				</div>

				<div className="mb-3">
					<MicrophoneSelector
						selectedMicId={selectedMicId}
						availableMics={availableMics}
						dialogOpen={isClient}
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
				</div>

				{isRecording && (
					<div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-3 text-red-11 rounded-md text-[13px] font-semibold mb-3">
						<span className="w-2 h-2 bg-red-9 rounded-full animate-pulse" />
						<span>{formatDuration(recordingTimerDisplayMs)}</span>
					</div>
				)}

				<Button
					onClick={
						isRecording
							? handleStopClick
							: () => {
									startRecording().catch((err: unknown) => {
										console.error("Start recording error", err);
									});
								}
					}
					disabled={!canStartRecording || (isBusy && !isRecording)}
					className="w-full flex items-center justify-center gap-2 py-3.5 px-5 text-base"
					variant={isRecording ? "destructive" : "primary"}
				>
					{isRecording ? (
						<>
							<svg
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="currentColor"
							>
								<rect x="6" y="6" width="12" height="12" />
							</svg>
							Stop Recording
						</>
					) : (
						<>
							<svg
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="currentColor"
							>
								<circle cx="12" cy="12" r="10" />
							</svg>
							Start Recording
						</>
					)}
				</Button>

				{!isBrowserSupported && unsupportedReason && (
					<div className="rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12 mt-3">
						{unsupportedReason}
					</div>
				)}

				<AnimatePresence mode="wait">
					{settingsPanelOpen && (
						<motion.div
							key="web-recorder-settings"
							initial={{ opacity: 0, y: -12 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -12 }}
							transition={{ duration: 0.2, ease: "easeOut" }}
							className="absolute inset-0 z-40 flex flex-col gap-4 p-4 border border-gray-3 rounded-lg bg-gray-1 shadow-lg dark:bg-gray-2"
						>
							<div className="flex items-center justify-between">
								<button
									type="button"
									onClick={() => setSettingsPanelOpen(false)}
									className="flex items-center gap-1 text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
								>
									<ArrowLeftIcon className="size-4" />
									Back
								</button>
								<h2 className="text-sm font-semibold text-gray-12">
									Recorder settings
								</h2>
								<span className="w-9 h-9" aria-hidden />
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex gap-4 justify-between items-start p-4 text-left rounded-xl border border-gray-3 bg-gray-1 dark:bg-gray-3">
									<div className="flex flex-col gap-1 text-left">
										<p className="text-sm font-medium text-gray-12">
											Automatically select your last webcam/microphone
										</p>
										<p className="text-xs text-gray-10">
											If available, the last used camera and mic will be
											automatically selected.
										</p>
									</div>
									<Switch
										checked={rememberDevices}
										onCheckedChange={handleRememberDevicesChange}
										aria-label="Remember selected devices"
									/>
								</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{selectedCameraId && (
				<CameraPreviewWindow
					cameraId={selectedCameraId}
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);
};
