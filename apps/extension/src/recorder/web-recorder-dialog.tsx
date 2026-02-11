"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Ellipsis, Globe2, Video, VideoOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAP_WEB_ORIGIN } from "@/lib/cap-web";
import type { CameraState } from "@/lib/messages";
import { CameraSelector } from "./CameraSelector";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
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

type CaptureMode = "instant" | "studio";

type ActiveTabPreview = {
	title: string;
	host: string;
	faviconUrl: string | null;
	screenshotUrl: string | null;
};

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
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const [studioCameraDetached, setStudioCameraDetached] = useState(false);
	const [activeTabPreview, setActiveTabPreview] =
		useState<ActiveTabPreview | null>(null);
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

	useEffect(() => {
		if (captureMode !== "studio") return;
		setRecordingMode((currentMode) => {
			if (currentMode === "camera" || currentMode === "fullscreen") {
				return "tab";
			}
			return currentMode;
		});
	}, [captureMode]);

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
	};

	const refreshActiveTabPreview = useCallback(async () => {
		if (
			typeof chrome === "undefined" ||
			typeof chrome.tabs?.query !== "function"
		) {
			return;
		}

		const tab = await new Promise<{
			title?: string;
			url?: string;
			favIconUrl?: string;
		} | null>((resolve) => {
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				const [firstTab] = tabs as Array<{
					title?: string;
					url?: string;
					favIconUrl?: string;
				}>;
				resolve(firstTab ?? null);
			});
		});

		if (!tab) {
			setActiveTabPreview(null);
			return;
		}

		let host = "Current tab";
		if (tab.url) {
			try {
				host = new URL(tab.url).hostname.replace(/^www\./, "");
			} catch {
				host = "Current tab";
			}
		}

		const tabsWithCapture = chrome.tabs as typeof chrome.tabs & {
			captureVisibleTab?: (
				windowId?: number,
				options?: { format?: "jpeg" | "png"; quality?: number },
				callback?: (dataUrl?: string) => void,
			) => void;
		};

		const screenshotUrl = await new Promise<string | null>((resolve) => {
			if (typeof tabsWithCapture.captureVisibleTab !== "function") {
				resolve(null);
				return;
			}

			tabsWithCapture.captureVisibleTab(
				undefined,
				{ format: "jpeg", quality: 72 },
				(dataUrl) => {
					if (
						chrome.runtime.lastError ||
						typeof dataUrl !== "string" ||
						dataUrl.length === 0
					) {
						resolve(null);
						return;
					}

					resolve(dataUrl);
				},
			);
		});

		setActiveTabPreview({
			title: tab.title?.trim() || "Current tab",
			host,
			faviconUrl: tab.favIconUrl ?? null,
			screenshotUrl,
		});
	}, []);

	useEffect(() => {
		void refreshActiveTabPreview();

		const onFocus = () => {
			void refreshActiveTabPreview();
		};

		window.addEventListener("focus", onFocus);

		return () => {
			window.removeEventListener("focus", onFocus);
		};
	}, [refreshActiveTabPreview]);

	useEffect(() => {
		if (!selectedCameraId) {
			setStudioCameraDetached(false);
		}
	}, [selectedCameraId]);

	useEffect(() => {
		if (skipNextCameraSyncRef.current) {
			skipNextCameraSyncRef.current = false;
			return;
		}

		const shouldShowDetachedCamera =
			selectedCameraId && (captureMode === "instant" || studioCameraDetached);

		if (shouldShowDetachedCamera) {
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
	}, [selectedCameraId, captureMode, studioCameraDetached]);

	useEffect(() => {
		chrome.runtime.sendMessage(
			{ type: "GET_CAMERA_STATE" },
			(response: unknown) => {
				const res = response as { state?: CameraState | null } | null;
				if (res?.state?.deviceId) {
					skipNextCameraSyncRef.current = true;
					setSelectedCameraId(res.state.deviceId);
					setStudioCameraDetached(true);
				}
			},
		);
	}, [setSelectedCameraId]);

	const showInProgressBar = isRecording || isBusy || phase === "error";
	const recordingTimerDisplayMs = isProUser
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);
	const recordingActionDisabled =
		!canStartRecording || (isBusy && !isRecording);
	const studioMode = captureMode === "studio";

	return (
		<>
			<AnimatePresence mode="wait">
				<motion.div
					variants={dialogVariants}
					initial="hidden"
					animate="visible"
					exit="exit"
					className="relative flex h-[500px] flex-col overflow-hidden rounded-[22px] border border-gray-200 bg-white text-gray-900 shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
				>
					<div className="pointer-events-none absolute inset-x-0 top-0 h-[180px] bg-gradient-to-b from-gray-50/80 via-gray-50/20 to-transparent" />
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
					<div className="relative z-10 flex items-center px-3 pb-3 pt-3">
						<div className="flex w-full max-w-[220px] rounded-full border border-gray-200 bg-gray-100 p-[0.2rem]">
							<button
								type="button"
								disabled={isBusy}
								className={clsx(
									"flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
									captureMode === "instant"
										? "bg-white text-gray-900 shadow-sm"
										: "text-gray-500 hover:text-gray-700",
								)}
								onClick={() => setCaptureMode("instant")}
							>
								Instant
							</button>
							<button
								type="button"
								disabled={isBusy}
								className={clsx(
									"flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
									captureMode === "studio"
										? "bg-white text-gray-900 shadow-sm"
										: "text-gray-500 hover:text-gray-700",
								)}
								onClick={() => setCaptureMode("studio")}
							>
								Studio
							</button>
						</div>
					</div>
					<div className="relative z-10 flex min-h-0 flex-1 flex-col px-3">
						{studioMode ? (
							<div className="flex min-h-0 flex-1 flex-col gap-3 pb-3">
								<SelectedTabCard preview={activeTabPreview} />
								<StudioCameraCard
									cameraId={selectedCameraId}
									detached={studioCameraDetached}
									onAttach={() => setStudioCameraDetached(false)}
									onDetach={() => setStudioCameraDetached(true)}
									detachDisabled={isBusy}
								/>
							</div>
						) : (
							<div className="flex min-h-0 flex-1 flex-col gap-3 pb-3">
								<div className="relative flex-1 overflow-hidden rounded-[18px] border border-gray-200 bg-gray-50">
									{activeTabPreview?.screenshotUrl ? (
										<img
											src={activeTabPreview.screenshotUrl}
											alt="Current tab"
											className="h-full w-full object-cover"
										/>
									) : (
										<div className="flex h-full w-full items-center justify-center bg-gray-100">
											<div className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-500">
												<Globe2 className="size-3.5" />
												Current tab preview
											</div>
										</div>
									)}
									<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/80 to-transparent px-3 pb-3 pt-8">
										<div className="text-xs uppercase tracking-[0.12em] text-gray-400">
											Instant mode
										</div>
										<div className="mt-1 text-sm text-gray-600">
											Choose what to capture, then start recording.
										</div>
									</div>
								</div>
							</div>
						)}
						{captureMode === "studio" && !selectedCameraId && (
							<div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-700">
								Camera is required for Studio Mode. Select a camera below.
							</div>
						)}
						{screenCaptureWarning && (
							<div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-700">
								{screenCaptureWarning}
							</div>
						)}
						{!isBrowserSupported && unsupportedReason && (
							<div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-snug text-red-700">
								{unsupportedReason}
							</div>
						)}
					</div>
					<div className="relative z-10 border-t border-gray-200 bg-gray-50 px-2 pb-3 pt-7">
						<div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[65%]">
							<RecordControlButton
								isRecording={isRecording}
								disabled={recordingActionDisabled}
								onStart={startRecording}
								onStop={handleStopClick}
							/>
						</div>
						<div className="grid grid-cols-3 gap-1.5">
							<MicrophoneSelector
								selectedMicId={selectedMicId}
								availableMics={availableMics}
								dialogOpen={dialogOpen}
								disabled={isBusy}
								variant="compact"
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
							<CameraSelector
								selectedCameraId={selectedCameraId}
								availableCameras={availableCameras}
								dialogOpen={dialogOpen}
								disabled={isBusy}
								variant="compact"
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
							<RecordingModeSelector
								mode={recordingMode}
								disabled={isBusy}
								variant="compact"
								includeCameraOption={captureMode === "instant"}
								onModeChange={setRecordingMode}
							/>
						</div>
					</div>
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

function SelectedTabCard({ preview }: { preview: ActiveTabPreview | null }) {
	return (
		<div className="relative min-h-0 flex-[0.9] overflow-hidden rounded-[18px] border border-gray-200 bg-gray-50">
			{preview?.screenshotUrl ? (
				<img
					src={preview.screenshotUrl}
					alt="Selected tab preview"
					className="h-full w-full object-cover"
				/>
			) : (
				<div className="flex h-full w-full items-center justify-center bg-gray-100">
					<div className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-500">
						Selected tab
					</div>
				</div>
			)}
			<div className="absolute right-3 top-3 rounded-[10px] bg-white/80 p-1 text-gray-500 shadow-sm">
				<Ellipsis className="size-4" />
			</div>
			<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent px-3 pb-3 pt-7">
				<div className="flex items-center gap-2 min-w-0">
					{preview?.faviconUrl ? (
						<img
							src={preview.faviconUrl}
							alt="Tab icon"
							className="size-4 rounded-sm"
						/>
					) : (
						<Globe2 className="size-3.5 text-gray-400" />
					)}
					<div className="min-w-0">
						<p className="truncate text-[0.8rem] font-medium text-gray-800">
							{preview?.title || "Current tab"}
						</p>
						<p className="truncate text-[0.68rem] uppercase tracking-[0.09em] text-gray-400">
							{preview?.host || "No site selected"}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

function StudioCameraCard({
	cameraId,
	detached,
	onDetach,
	onAttach,
	detachDisabled,
}: {
	cameraId: string | null;
	detached: boolean;
	onDetach: () => void;
	onAttach: () => void;
	detachDisabled?: boolean;
}) {
	const [streamError, setStreamError] = useState<string | null>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);

	useEffect(() => {
		if (!cameraId || detached) {
			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => {
					track.stop();
				});
				streamRef.current = null;
			}
			if (videoRef.current) {
				videoRef.current.srcObject = null;
			}
			return;
		}

		let cancelled = false;

		const setVideoStream = async (stream: MediaStream) => {
			if (cancelled) {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				return;
			}

			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => {
					track.stop();
				});
			}

			streamRef.current = stream;

			if (videoRef.current) {
				videoRef.current.srcObject = stream;
				await videoRef.current.play().catch(() => {});
			}
		};

		const startStream = async () => {
			setStreamError(null);

			try {
				await setVideoStream(
					await navigator.mediaDevices.getUserMedia({
						video: { deviceId: { exact: cameraId } },
					}),
				);
				return;
			} catch {}

			try {
				await setVideoStream(
					await navigator.mediaDevices.getUserMedia({ video: true }),
				);
				return;
			} catch {
				setStreamError("Unable to load camera preview");
			}
		};

		void startStream();

		return () => {
			cancelled = true;
			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => {
					track.stop();
				});
				streamRef.current = null;
			}
			if (videoRef.current) {
				videoRef.current.srcObject = null;
			}
		};
	}, [cameraId, detached]);

	return (
		<div className="group relative min-h-0 flex-1 overflow-hidden rounded-[18px] border border-gray-200 bg-gray-50">
			{!cameraId ? (
				<div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-400">
					<VideoOff className="size-6" />
					<span className="text-xs uppercase tracking-[0.1em]">
						No camera selected
					</span>
				</div>
			) : detached ? (
				<div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-gray-100 px-4">
					<Video className="size-6 text-gray-500" />
					<p className="text-sm text-gray-700">Camera is detached</p>
					<button
						type="button"
						onClick={onAttach}
						className="rounded-full border border-gray-300 bg-gray-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800"
					>
						Attach camera
					</button>
				</div>
			) : streamError ? (
				<div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-400">
					<VideoOff className="size-6" />
					<span className="text-xs">{streamError}</span>
				</div>
			) : (
				<video
					ref={videoRef}
					playsInline
					muted
					autoPlay
					className="h-full w-full object-cover"
				/>
			)}
			{cameraId && !detached && (
				<button
					type="button"
					disabled={detachDisabled}
					onClick={onDetach}
					className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/40 via-black/15 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100 disabled:pointer-events-none"
				>
					<span className="mb-4 rounded-full border border-white/50 bg-black/50 px-3 py-1.5 text-xs font-medium text-white">
						Detatch camera
					</span>
				</button>
			)}
		</div>
	);
}

function RecordControlButton({
	isRecording,
	disabled,
	onStart,
	onStop,
}: {
	isRecording: boolean;
	disabled?: boolean;
	onStart: () => void;
	onStop: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={isRecording ? onStop : onStart}
			aria-label={isRecording ? "Stop recording" : "Start recording"}
			className="flex size-[66px] items-center justify-center rounded-full border border-[#ff7d74]/80 bg-[#ff5449]/15 transition-transform duration-150 hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
		>
			<span className="flex size-[48px] items-center justify-center rounded-full bg-[#ff5449] shadow-[0_8px_24px_rgba(255,84,73,0.45)]">
				{isRecording ? (
					<span className="size-4 rounded-sm bg-white" />
				) : (
					<span className="size-[34px] rounded-full border border-[#ff918a] bg-[#ff5449]" />
				)}
			</span>
		</button>
	);
}
