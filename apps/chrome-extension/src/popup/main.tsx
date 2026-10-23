import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { toCameraDevices, toMicrophoneDevices } from "../shared/devices";
import {
	reconcileRememberedDevices,
	rememberCameraSelection,
	rememberMicrophoneSelection,
	rememberRecordingMode,
} from "../shared/preferences";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	defaultSettings,
	FAILED_RECORDINGS_KEY,
	loadAuth,
	loadCachedBootstrap,
	loadFailedRecordings,
	loadMediaAccessState,
	loadSettings,
	MEDIA_ACCESS_KEY,
	type MediaAccessState,
	saveSettings,
	updateMediaAccessState,
} from "../shared/storage";
import type {
	BootstrapData,
	CameraDevice,
	ExtensionAuth,
	ExtensionSettings,
	MediaPermissionSnapshot,
	MediaPermissionState,
	MicrophoneDevice,
	RecordingMode,
	RecordingStatus,
} from "../shared/types";
import { DEFAULT_MICROPHONE_DEVICE_ID } from "../shared/types";
import { CameraSelector } from "./components/camera-selector";
import { DashboardButton } from "./components/dashboard-button";
import { HowItWorksButton } from "./components/how-it-works-button";
import { MicrophoneSelector } from "./components/microphone-selector";
import { RecorderHeader } from "./components/recorder-header";
import { RecordingBar } from "./components/recording-bar";
import { RecordingButton } from "./components/recording-button";
import { RecordingModeSelector } from "./components/recording-mode-selector";
import { SettingsButton } from "./components/settings-button";
import { SignInView } from "./components/sign-in-view";
import { SystemAudioToggle } from "./components/system-audio-toggle";
import "./styles.css";

type ActiveRecordingStatus = Extract<
	RecordingStatus,
	{ phase: "recording" | "paused" | "uploading" }
>;

const PANEL_TOKEN = decodeURIComponent(window.location.hash.slice(1));
const IS_EMBEDDED = PANEL_TOKEN.length > 0 && window.parent !== window;
const DEFAULT_MEDIA_ACCESS: MediaAccessState = {
	camera: false,
	microphone: false,
	updatedAt: 0,
};

const postPanelMessage = (
	message: { type: "size"; height: number } | { type: "dismiss" },
) => {
	if (!IS_EMBEDDED) return;
	window.parent.postMessage(
		{
			source: "cap-extension-panel",
			token: PANEL_TOKEN,
			...message,
		},
		"*",
	);
};

// Maps the offscreen document's authoritative permission query to a stored
// access flag. "unknown" (no Permissions API) leaves the flag untouched so a
// browser that cannot report state never wipes a working grant.
const accessFromPermission = (
	state: MediaPermissionState,
): boolean | undefined => {
	if (state === "granted") return true;
	if (state === "prompt" || state === "denied") return false;
	return undefined;
};

const isRecordingStatus = (
	status: RecordingStatus,
): status is ActiveRecordingStatus =>
	status.phase === "recording" ||
	status.phase === "paused" ||
	status.phase === "uploading";

function App() {
	// This page is web accessible, so any site can put it in an iframe and
	// overlay it for clickjacking. When embedded, render nothing until the
	// service worker confirms the URL-hash token was registered by one of our
	// content scripts — only the extension overlay can do that.
	const [embedAuthorized, setEmbedAuthorized] = useState(!IS_EMBEDDED);
	const [auth, setAuth] = useState<ExtensionAuth | null>(null);
	const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
	const [settings, setSettings] = useState<ExtensionSettings>(defaultSettings);
	const [status, setStatus] = useState<RecordingStatus>({ phase: "idle" });
	const [mode, setMode] = useState<RecordingMode>("fullscreen");
	const [authPending, setAuthPending] = useState(false);
	const [bootstrapped, setBootstrapped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
	const [micDevices, setMicDevices] = useState<MicrophoneDevice[]>([]);
	const [mediaAccess, setMediaAccess] =
		useState<MediaAccessState>(DEFAULT_MEDIA_ACCESS);
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const [failedRecordingsCount, setFailedRecordingsCount] = useState(0);
	const settingsRef = useRef(defaultSettings);

	const recordingActive = isRecordingStatus(status);
	const isPro = Boolean(bootstrap?.plan.isPro);
	const cameraRequired = mode === "camera" && !settings.webcam.deviceId;

	const selectedCameraId =
		settings.webcam.enabled && settings.webcam.deviceId
			? settings.webcam.deviceId
			: null;
	const selectedMicId = settings.microphone.enabled
		? (settings.microphone.deviceId ?? DEFAULT_MICROPHONE_DEVICE_ID)
		: null;

	const updateSettings = useCallback(async (next: ExtensionSettings) => {
		settingsRef.current = next;
		setSettings(next);
		setMode(next.capture.recordingMode);
		await saveSettings(next);
		await sendServiceWorkerMessage({
			target: "service-worker",
			type: "settings-updated",
			settings: next,
		}).catch(() => undefined);
	}, []);

	const applySettings = useCallback((next: ExtensionSettings) => {
		settingsRef.current = next;
		setSettings(next);
		setMode(next.capture.recordingMode);
	}, []);

	const loadDevices = useCallback(async () => {
		let cameras: CameraDevice[] = [];
		let microphones: MicrophoneDevice[] = [];
		let permissions: MediaPermissionSnapshot | null = null;

		if (navigator.mediaDevices?.enumerateDevices) {
			try {
				const devices = await navigator.mediaDevices.enumerateDevices();
				cameras = toCameraDevices(devices);
				microphones = toMicrophoneDevices(devices);
			} catch {
				// The offscreen fallback below covers the failure.
			}
		}

		// This panel usually runs as a cross-origin iframe inside the host page,
		// where Chrome withholds device labels from enumerateDevices() even though
		// the extension origin holds the camera/mic grant. Ask the offscreen
		// document (a top-level extension page that keeps the grant) for whichever
		// list came up empty, and for the authoritative permission state — the
		// iframe's own query is delegated from the host page, so it cannot tell
		// when Chrome has reset the extension's grant.
		if (cameras.length === 0 || microphones.length === 0) {
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "get-media-devices",
			}).catch(() => null);
			if (response?.ok) {
				if (cameras.length === 0 && response.cameraDevices) {
					cameras = response.cameraDevices;
				}
				if (microphones.length === 0 && response.microphoneDevices) {
					microphones = response.microphoneDevices;
				}
				if (response.mediaPermissions) {
					permissions = response.mediaPermissions;
				}
			}
		}

		setCameraDevices(cameras);
		setMicDevices(microphones);

		// Keep the persisted access flags honest in both directions: seeing a
		// device (or a "granted" query) proves the grant exists, while a
		// definitively non-granted query proves it is gone. Without the clearing
		// half, a grant Chrome resets while the extension sits unused would leave
		// the flags stuck on, so the panel would silently show empty pickers
		// instead of a "Request permission" prompt.
		const access: Partial<Pick<MediaAccessState, "camera" | "microphone">> = {};
		if (cameras.length > 0) access.camera = true;
		if (microphones.length > 0) access.microphone = true;
		if (permissions) {
			const cameraAccess = accessFromPermission(permissions.camera);
			if (cameraAccess !== undefined) access.camera = cameraAccess;
			const microphoneAccess = accessFromPermission(permissions.microphone);
			if (microphoneAccess !== undefined) access.microphone = microphoneAccess;
		}
		if (access.camera !== undefined || access.microphone !== undefined) {
			const nextAccess = await updateMediaAccessState(access);
			setMediaAccess(nextAccess);
		}
		const reconciled = reconcileRememberedDevices(
			settingsRef.current,
			cameras,
			microphones,
		);
		if (reconciled !== settingsRef.current) {
			await updateSettings(reconciled);
		}
	}, [updateSettings]);

	const openPermissionPage = () => {
		chrome.tabs.create({
			url: chrome.runtime.getURL("camera-permission.html"),
			active: true,
		});
	};

	useEffect(() => {
		if (!IS_EMBEDDED) return;
		let disposed = false;
		sendServiceWorkerMessage({
			target: "service-worker",
			type: "validate-overlay-token",
			token: PANEL_TOKEN,
		})
			.then((response) => {
				if (!disposed) {
					setEmbedAuthorized(response.ok && response.valid === true);
				}
			})
			.catch(() => {
				if (!disposed) setEmbedAuthorized(false);
			});
		return () => {
			disposed = true;
		};
	}, []);

	useEffect(() => {
		if (!IS_EMBEDDED) return;
		const postSize = () => {
			postPanelMessage({
				type: "size",
				height: Math.ceil(document.body.getBoundingClientRect().height),
			});
		};
		const observer = new ResizeObserver(postSize);
		observer.observe(document.body);
		postSize();
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!IS_EMBEDDED) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") postPanelMessage({ type: "dismiss" });
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	useEffect(() => {
		let disposed = false;

		Promise.all([
			loadSettings(),
			loadAuth(),
			loadCachedBootstrap(),
			loadMediaAccessState(),
		])
			.then(
				([cachedSettings, cachedAuth, cachedBootstrap, cachedMediaAccess]) => {
					if (disposed || !cachedAuth) return;
					applySettings(cachedSettings);
					setAuth(cachedAuth);
					setBootstrap(cachedBootstrap);
					setMediaAccess(cachedMediaAccess);
					setBootstrapped(true);
				},
			)
			.catch(() => undefined);

		sendServiceWorkerMessage({ target: "service-worker", type: "bootstrap" })
			.then((response) => {
				if (disposed) return;
				setBootstrapped(true);
				if (!response.ok) {
					setError(response.error);
					return;
				}
				setAuth(response.auth ?? null);
				setAuthPending(Boolean(response.authPending && !response.auth));
				setBootstrap(response.bootstrap ?? null);
				if (response.authError) setError(response.authError);
				if (response.cameraDevices) setCameraDevices(response.cameraDevices);
				if (response.microphoneDevices)
					setMicDevices(response.microphoneDevices);
				if (response.settings) applySettings(response.settings);
				if (response.status) setStatus(response.status);
			})
			.catch((err: unknown) => {
				if (!disposed) {
					setBootstrapped(true);
					setError(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			disposed = true;
		};
	}, [applySettings]);

	useEffect(() => {
		const handleMessage = (message: unknown) => {
			if (!message || typeof message !== "object") return false;
			const candidate = message as {
				type?: unknown;
				devices?: unknown;
			};
			if (
				candidate.type === "camera-devices-changed" &&
				Array.isArray(candidate.devices)
			) {
				setCameraDevices(candidate.devices as CameraDevice[]);
			}
			return false;
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, []);

	useEffect(() => {
		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName !== "local" || !changes[MEDIA_ACCESS_KEY]) return;
			void loadMediaAccessState()
				.then(setMediaAccess)
				.catch(() => undefined);
		};

		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => chrome.storage.onChanged.removeListener(handleStorageChange);
	}, []);

	// Recordings whose upload failed (or that a crash stranded) wait in local
	// storage; surface a small recovery link so they are discoverable from
	// here instead of only from the options page.
	useEffect(() => {
		let disposed = false;
		const refreshFailedRecordings = () => {
			loadFailedRecordings()
				.then((entries) => {
					if (!disposed) setFailedRecordingsCount(entries.length);
				})
				.catch(() => undefined);
		};

		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName !== "local" || !changes[FAILED_RECORDINGS_KEY]) return;
			refreshFailedRecordings();
		};

		refreshFailedRecordings();
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			disposed = true;
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);

	useEffect(() => {
		if (!auth) return;

		void loadDevices();

		const handleDeviceChange = () => {
			void loadDevices();
		};

		navigator.mediaDevices?.addEventListener(
			"devicechange",
			handleDeviceChange,
		);
		return () => {
			navigator.mediaDevices?.removeEventListener(
				"devicechange",
				handleDeviceChange,
			);
		};
	}, [auth, loadDevices]);

	useEffect(() => {
		if (!authPending || auth) return;
		const interval = window.setInterval(() => {
			sendServiceWorkerMessage({ target: "service-worker", type: "bootstrap" })
				.then((response) => {
					if (!response.ok) return;
					setAuth(response.auth ?? null);
					setAuthPending(Boolean(response.authPending && !response.auth));
					setBootstrap(response.bootstrap ?? null);
					// A failed sign-in clears authPending (stopping this poll), so
					// the stored failure is surfaced here or never.
					if (response.authError) setError(response.authError);
					if (response.cameraDevices) setCameraDevices(response.cameraDevices);
					if (response.microphoneDevices)
						setMicDevices(response.microphoneDevices);
					if (response.settings) applySettings(response.settings);
					if (response.status) setStatus(response.status);
				})
				.catch(() => undefined);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [authPending, auth, applySettings]);

	useEffect(() => {
		if (!recordingActive) return;
		const interval = window.setInterval(() => {
			sendServiceWorkerMessage({
				target: "service-worker",
				type: "get-recording-status",
			})
				.then((response) => {
					if (response.ok && response.status) setStatus(response.status);
				})
				.catch(() => undefined);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [recordingActive]);

	const run = async (task: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await task();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const signIn = () =>
		run(async () => {
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "auth-start",
			});
			if (!response.ok) throw new Error(response.error);
			setAuth(response.auth ?? null);
			setAuthPending(Boolean(response.authPending && !response.auth));
			setBootstrap(response.bootstrap ?? null);
			if (response.settings) applySettings(response.settings);
		});

	// The microphone warning (no mic / no sound) is handled centrally in the
	// service worker so the panel and the floating recording bar share one
	// flow; a declined warning comes back as a cancellation.
	const start = () =>
		run(async () => {
			if (cameraRequired) {
				throw new Error("Select a camera before recording.");
			}
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "start-recording",
				mode,
			});
			if (!response.ok) {
				// Dismissing the capture picker or the mic warning is a deliberate
				// action, not a failure worth surfacing.
				if (response.canceled) return;
				throw new Error(response.error);
			}
			if (response.status) setStatus(response.status);
			postPanelMessage({ type: "dismiss" });
		});

	const stop = () =>
		run(async () => {
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "stop-recording",
			});
			if (!response.ok) throw new Error(response.error);
			if (response.status) setStatus(response.status);
		});

	const pauseOrResume = () =>
		run(async () => {
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type:
					status.phase === "paused" ? "resume-recording" : "pause-recording",
			});
			if (!response.ok) throw new Error(response.error);
			if (response.status) setStatus(response.status);
		});

	const openOptions = () =>
		sendServiceWorkerMessage({
			target: "service-worker",
			type: "open-options",
		}).catch(() => undefined);

	const openHowItWorks = () =>
		sendServiceWorkerMessage({
			target: "service-worker",
			type: "open-how-it-works",
		}).catch(() => undefined);

	const handleModeChange = (recordingMode: RecordingMode) => {
		setMode(recordingMode);
		void updateSettings(
			rememberRecordingMode(settingsRef.current, recordingMode),
		);
	};

	const handleCameraChange = (cameraId: string | null) => {
		void updateSettings(
			rememberCameraSelection(settingsRef.current, cameraId, cameraDevices),
		);
	};

	const handleMicChange = (micId: string | null) => {
		void updateSettings(
			rememberMicrophoneSelection(settingsRef.current, micId, micDevices),
		);
	};

	const handleUpgradeClick = () => {
		chrome.tabs.create({
			url: `${settings.apiBaseUrl}/pricing`,
			active: true,
		});
	};

	const openDashboard = () => {
		chrome.tabs.create({
			url: `${settings.apiBaseUrl}/dashboard`,
			active: true,
		});
	};

	const closePanel = () => {
		if (busy) return;
		// Closing the recorder tears down every piece of Cap UI: the panel,
		// the camera preview and the recording bar in every tab.
		postPanelMessage({ type: "dismiss" });
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "close-extension-ui",
		}).catch(() => undefined);
		if (!IS_EMBEDDED) window.close();
	};

	const maxRecordingMs =
		bootstrap && bootstrap.plan.maxRecordingSeconds !== null
			? bootstrap.plan.maxRecordingSeconds * 1000
			: null;
	const recordingTimerDisplayMs =
		recordingActive && status.phase !== "uploading"
			? isPro || maxRecordingMs === null
				? status.durationMs
				: Math.max(0, maxRecordingMs - status.durationMs)
			: 0;

	const recordingBarStatus = recordingActive
		? status.phase === "uploading"
			? status
			: { ...status, durationMs: recordingTimerDisplayMs }
		: null;

	const signedOut = bootstrapped && !auth;

	if (!embedAuthorized) return null;

	return (
		<main className="flex w-full justify-center">
			<div
				className={clsx(
					"relative flex justify-center flex-col w-full p-[1rem] pt-[3.25rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] min-h-[440px]",
					signedOut ? "bg-[--paper]" : "bg-gray-2",
				)}
			>
				{auth && (
					<div className="absolute right-3 top-3 z-10 flex gap-2">
						<DashboardButton onClick={openDashboard} />
						<SettingsButton onClick={() => void openOptions()} />
					</div>
				)}
				<RecorderHeader
					isBusy={busy || recordingActive}
					isPro={isPro}
					showPlan={Boolean(auth)}
					minimal={signedOut}
					onClose={closePanel}
					onUpgradeClick={handleUpgradeClick}
				/>

				{!bootstrapped ? (
					<div className="flex flex-1 items-center justify-center">
						<output
							className="block size-6 animate-spin rounded-full border-2 border-gray-5 border-t-gray-10"
							aria-label="Loading"
						/>
					</div>
				) : auth ? (
					<>
						<div className="cap-fade-up cap-fade-up-1">
							<RecordingModeSelector
								mode={mode}
								disabled={recordingActive || busy}
								onModeChange={handleModeChange}
							/>
						</div>
						<div className="cap-fade-up cap-fade-up-2">
							<CameraSelector
								selectedCameraId={selectedCameraId}
								availableCameras={cameraDevices}
								permissionGranted={mediaAccess.camera}
								disabled={recordingActive || busy}
								open={cameraSelectOpen}
								onOpenChange={(isOpen) => {
									setCameraSelectOpen(isOpen);
									if (isOpen) {
										setMicSelectOpen(false);
									}
								}}
								onCameraChange={handleCameraChange}
								onRefreshDevices={loadDevices}
								onPermissionBlocked={openPermissionPage}
							/>
						</div>
						<div className="cap-fade-up cap-fade-up-3">
							<MicrophoneSelector
								selectedMicId={selectedMicId}
								availableMics={micDevices}
								permissionGranted={mediaAccess.microphone}
								disabled={recordingActive || busy}
								open={micSelectOpen}
								onOpenChange={(isOpen) => {
									setMicSelectOpen(isOpen);
									if (isOpen) {
										setCameraSelectOpen(false);
									}
								}}
								onMicChange={handleMicChange}
								onRefreshDevices={loadDevices}
								onPermissionBlocked={openPermissionPage}
							/>
						</div>
						{mode !== "camera" && (
							<div className="cap-fade-up cap-fade-up-4">
								<SystemAudioToggle
									enabled={settings.systemAudio.enabled}
									disabled={recordingActive || busy}
									recordingMode={mode}
									onToggle={(enabled) =>
										void updateSettings({
											...settings,
											systemAudio: { ...settings.systemAudio, enabled },
										})
									}
								/>
							</div>
						)}
						<div className="cap-fade-up cap-fade-up-5">
							<RecordingButton
								isRecording={recordingActive}
								disabled={busy || (!recordingActive && cameraRequired)}
								onStart={() => void start()}
								onStop={() => void stop()}
							/>
						</div>
						{recordingBarStatus && (
							<div className="cap-fade-up">
								<RecordingBar
									status={recordingBarStatus}
									hasAudioTrack={settings.microphone.enabled}
									disabled={busy}
									onStop={() => void stop()}
									onPauseResume={() => void pauseOrResume()}
								/>
							</div>
						)}
						{status.phase === "error" && (
							<div className="cap-fade-up rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
								<span className="font-medium">Recording failed.</span>{" "}
								{status.message}
							</div>
						)}
						<div className="cap-fade-up cap-fade-up-6 flex justify-center">
							<HowItWorksButton onClick={() => void openHowItWorks()} />
						</div>
						{failedRecordingsCount > 0 && (
							<div className="cap-fade-up cap-fade-up-6">
								<button
									type="button"
									onClick={() => void openOptions()}
									className="flex w-full items-center justify-center gap-1 text-xs font-medium text-[var(--red-11)] transition-colors hover:text-[var(--red-12)]"
								>
									Recover {failedRecordingsCount}{" "}
									{failedRecordingsCount === 1 ? "recording" : "recordings"}
								</button>
							</div>
						)}
					</>
				) : (
					<SignInView
						authPending={authPending}
						busy={busy}
						onSignIn={() => void signIn()}
					/>
				)}

				{error && (
					<div
						className={clsx(
							"cap-fade-up",
							signedOut
								? "cap-paper-error"
								: "rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12",
						)}
					>
						{error}
					</div>
				)}
			</div>
		</main>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
