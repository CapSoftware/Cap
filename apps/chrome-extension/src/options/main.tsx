import {
	deleteRecoveredRecordingSpool,
	recoverOrphanedRecordingSpools,
} from "@cap/recorder-core";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapBrand, DoodleBoilFilter } from "../shared/cap-brand";
import { formatRecordedDuration } from "../shared/format-duration";
import { mountPageNav } from "../shared/page-nav";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	clearAuth,
	defaultSettings,
	FAILED_RECORDINGS_KEY,
	type FailedRecording,
	loadAuth,
	loadFailedRecordings,
	loadSettings,
	loadSharedRecordingState,
	removeFailedRecording,
	saveSettings,
} from "../shared/storage";
import type { ExtensionAuth, ExtensionSettings } from "../shared/types";
import "./styles.css";

mountPageNav("options");

// Spool sessions younger than this may still belong to a recording that is
// live in the offscreen document (mirrors the offscreen sweep's guard).
const SPOOL_MIN_IDLE_MS = 60 * 1000;

const formatBytes = (bytes: number) => {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Math.max(0, Math.round(bytes))} B`;
};

const fileExtensionForMimeType = (mimeType: string) =>
	mimeType.includes("webm") ? "webm" : "mp4";

const isActiveRecordingPhase = (phase: string | undefined) =>
	phase === "creating" ||
	phase === "recording" ||
	phase === "paused" ||
	phase === "uploading";

// Every extension page shares the extension-origin IndexedDB with the
// offscreen recorder, so this page reads the recording spool directly. The
// listing pairs the failed-recording metadata with the spools that still
// hold bytes, and also surfaces spools stranded by a crash before the
// offscreen sweep could record them (those have no metadata yet).
const loadRecoveredRecordings = async (): Promise<FailedRecording[]> => {
	const [failed, spools, recordingState] = await Promise.all([
		loadFailedRecordings(),
		recoverOrphanedRecordingSpools(),
		loadSharedRecordingState().catch(() => null),
	]);
	const spoolSessions = new Set(spools.map((spool) => spool.sessionId));
	const knownSessions = new Set(failed.map((entry) => entry.sessionId));
	const entries = failed.filter((entry) => spoolSessions.has(entry.sessionId));

	// Skip unknown spools while a recording is live anywhere: an in-flight
	// recording's spool is indistinguishable from a stranded one from here.
	if (!isActiveRecordingPhase(recordingState?.status.phase)) {
		const now = Date.now();
		for (const spool of spools) {
			if (knownSessions.has(spool.sessionId)) continue;
			if (spool.totalBytes <= 0) continue;
			if (now - spool.updatedAt < SPOOL_MIN_IDLE_MS) continue;
			entries.push({
				sessionId: spool.sessionId,
				videoId: null,
				shareUrl: null,
				mimeType: spool.mimeType,
				subpath: null,
				durationMs: 0,
				width: null,
				height: null,
				fps: null,
				totalBytes: spool.totalBytes,
				createdAt: spool.updatedAt,
				message: "The recording was interrupted before its upload finished.",
			});
		}
	}

	return entries.sort((left, right) => right.createdAt - left.createdAt);
};

type RecoveryNotice = {
	kind: "success" | "error";
	message: string;
	shareUrl?: string;
};

function RecoveredRecordingsSection() {
	const [entries, setEntries] = useState<FailedRecording[]>([]);
	const [busySession, setBusySession] = useState<string | null>(null);
	const [retryingSession, setRetryingSession] = useState<string | null>(null);
	const [notice, setNotice] = useState<RecoveryNotice | null>(null);

	const refresh = useCallback(() => {
		loadRecoveredRecordings()
			.then(setEntries)
			.catch(() => setEntries([]));
	}, []);

	useEffect(() => {
		refresh();
		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName !== "local" || !changes[FAILED_RECORDINGS_KEY]) return;
			refresh();
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => chrome.storage.onChanged.removeListener(handleStorageChange);
	}, [refresh]);

	const runAction = async (
		sessionId: string,
		task: () => Promise<RecoveryNotice | null>,
	) => {
		if (busySession !== null) return;
		setBusySession(sessionId);
		setNotice(null);
		try {
			setNotice(await task());
		} catch (err) {
			setNotice({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusySession(null);
			setRetryingSession(null);
		}
	};

	const download = (entry: FailedRecording) =>
		runAction(entry.sessionId, async () => {
			const spools = await recoverOrphanedRecordingSpools();
			const spool = spools.find(
				(candidate) => candidate.sessionId === entry.sessionId,
			);
			if (!spool || spool.blob.size === 0) {
				refresh();
				throw new Error("The recorded data is no longer available.");
			}
			const url = URL.createObjectURL(spool.blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `cap-recording-${
				entry.videoId ??
				new Date(entry.createdAt).toISOString().replace(/[:.]/g, "-")
			}.${fileExtensionForMimeType(entry.mimeType)}`;
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
			return null;
		});

	const remove = (entry: FailedRecording) =>
		runAction(entry.sessionId, async () => {
			await deleteRecoveredRecordingSpool(entry.sessionId);
			await removeFailedRecording(entry.sessionId).catch(() => undefined);
			refresh();
			return null;
		});

	const retry = (entry: FailedRecording) => {
		const videoId = entry.videoId;
		if (!videoId) return;
		setRetryingSession(entry.sessionId);
		void runAction(entry.sessionId, async () => {
			// The offscreen recorder re-uploads the whole spooled blob before this
			// resolves, so the button stays in its uploading state until then.
			const response = await sendServiceWorkerMessage({
				target: "service-worker",
				type: "retry-upload",
				videoId,
			});
			refresh();
			if (!response.ok) throw new Error(response.error);
			if (response.status?.phase === "error") {
				throw new Error(response.status.message);
			}
			return {
				kind: "success",
				message: "Upload finished.",
				shareUrl:
					response.status?.phase === "completed"
						? response.status.shareUrl
						: (entry.shareUrl ?? undefined),
			};
		});
	};

	if (entries.length === 0 && !notice) return null;

	return (
		<section className="card card-3">
			<h2>Recovered recordings</h2>
			<p className="recovery-lede">
				These recordings never finished uploading. Their captured data is still
				on this device, so you can download it or retry the upload.
			</p>
			<ul className="recovery-list">
				{entries.map((entry) => (
					<li key={entry.sessionId} className="recovery-item">
						<div className="recovery-meta">
							<span className="recovery-title">
								{new Date(entry.createdAt).toLocaleString()}
							</span>
							<span className="recovery-detail">
								{formatBytes(entry.totalBytes)}
								{entry.durationMs > 0
									? ` · ${formatRecordedDuration(entry.durationMs)}`
									: ""}
								{entry.videoId ? "" : " · interrupted before upload"}
							</span>
						</div>
						<div className="recovery-actions">
							{entry.videoId && (
								<button
									type="button"
									className="cta small"
									disabled={busySession !== null}
									onClick={() => retry(entry)}
								>
									{retryingSession === entry.sessionId
										? "Uploading…"
										: "Retry upload"}
								</button>
							)}
							<button
								type="button"
								className="cta small ghost"
								disabled={busySession !== null}
								onClick={() => void download(entry)}
							>
								Download
							</button>
							<button
								type="button"
								className="cta small ghost"
								disabled={busySession !== null}
								onClick={() => void remove(entry)}
							>
								Delete
							</button>
						</div>
					</li>
				))}
			</ul>
			{notice && (
				<p
					className={
						notice.kind === "success"
							? "paper-pill success"
							: "paper-pill error"
					}
				>
					{notice.message}
					{notice.shareUrl && (
						<a
							className="recovery-link"
							href={notice.shareUrl}
							target="_blank"
							rel="noreferrer"
						>
							Open video
						</a>
					)}
				</p>
			)}
		</section>
	);
}

const DoodleCheckbox = ({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) => (
	<label className="doodle-check">
		<input
			type="checkbox"
			checked={checked}
			onChange={(event) => onChange(event.currentTarget.checked)}
		/>
		<span className="doodle-check-box" aria-hidden="true">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path
					className="doodle-check-mark"
					pathLength={1}
					d="M 4 13 L 9.5 18 L 20 6"
				/>
			</svg>
		</span>
		{label}
	</label>
);

function App() {
	const [settings, setSettings] = useState<ExtensionSettings>(defaultSettings);
	const [auth, setAuth] = useState<ExtensionAuth | null>(null);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		Promise.all([loadSettings(), loadAuth()])
			.then(([nextSettings, nextAuth]) => {
				if (disposed) return;
				setSettings(nextSettings);
				setAuth(nextAuth);
			})
			.catch((err: unknown) => {
				if (!disposed) {
					setError(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			disposed = true;
		};
	}, []);

	const save = async () => {
		setError(null);
		setSaved(false);
		try {
			new URL(settings.apiBaseUrl);
			await saveSettings(settings);
			await sendServiceWorkerMessage({
				target: "service-worker",
				type: "settings-updated",
				settings,
			}).catch(() => undefined);
			setSaved(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const signOut = async () => {
		setError(null);
		const response = await sendServiceWorkerMessage({
			target: "service-worker",
			type: "auth-revoke",
		}).catch((err: unknown) => ({
			ok: false as const,
			error: err instanceof Error ? err.message : String(err),
		}));
		if (!response.ok) {
			setError(response.error);
			return;
		}
		await clearAuth();
		setAuth(null);
	};

	return (
		<>
			<main className="stage">
				<header className="brand">
					<CapBrand />
				</header>
				<svg className="doodle" viewBox="0 0 120 104" aria-hidden="true">
					<defs>
						<DoodleBoilFilter />
					</defs>
					<g className="doodle-boil">
						<path
							className="doodle-stroke slider-line line-1"
							pathLength={1}
							d="M 22 28 L 98 28"
						/>
						<path
							className="doodle-stroke slider-line line-2"
							pathLength={1}
							d="M 22 54 L 98 54"
						/>
						<path
							className="doodle-stroke slider-line line-3"
							pathLength={1}
							d="M 22 80 L 98 80"
						/>
						<g className="slider-knob knob-1">
							<circle className="knob-circle" cx="44" cy="28" r="7.5" />
						</g>
						<g className="slider-knob knob-2">
							<circle
								className="knob-circle knob-accent"
								cx="76"
								cy="54"
								r="7.5"
							/>
						</g>
						<g className="slider-knob knob-3">
							<circle className="knob-circle" cx="58" cy="80" r="7.5" />
						</g>
					</g>
				</svg>
				<h1>Recorder options</h1>
				<p className="lede">
					Tune where Cap uploads and how your camera shows up by default.
				</p>

				<div className="sheet">
					<section className="card card-1">
						<h2>Connection</h2>
						<label className="field">
							<span>Cap URL</span>
							<input
								type="url"
								value={settings.apiBaseUrl}
								onChange={(event) =>
									setSettings({
										...settings,
										apiBaseUrl: event.currentTarget.value,
									})
								}
							/>
						</label>
					</section>

					<section className="card card-2">
						<h2>Recording defaults</h2>
						<div className="field-grid">
							<label className="field">
								<span>Camera size</span>
								<input
									type="number"
									min="120"
									max="420"
									value={settings.webcam.size}
									onChange={(event) =>
										setSettings({
											...settings,
											webcam: {
												...settings.webcam,
												size: Number(event.currentTarget.value),
											},
										})
									}
								/>
							</label>
							<label className="field">
								<span>Position</span>
								<select
									value={settings.webcam.position}
									onChange={(event) =>
										setSettings({
											...settings,
											webcam: {
												...settings.webcam,
												position: event.currentTarget
													.value as ExtensionSettings["webcam"]["position"],
											},
										})
									}
								>
									<option value="bottom-right">Bottom right</option>
									<option value="bottom-left">Bottom left</option>
									<option value="top-right">Top right</option>
									<option value="top-left">Top left</option>
								</select>
							</label>
							<label className="field">
								<span>Shape</span>
								<select
									value={settings.webcam.shape}
									onChange={(event) =>
										setSettings({
											...settings,
											webcam: {
												...settings.webcam,
												shape: event.currentTarget
													.value as ExtensionSettings["webcam"]["shape"],
											},
										})
									}
								>
									<option value="round">Round</option>
									<option value="square">Square</option>
									<option value="full">Full</option>
								</select>
							</label>
							<label className="field">
								<span>Countdown</span>
								<select
									value={String(settings.countdown.seconds)}
									disabled={!settings.countdown.enabled}
									onChange={(event) =>
										setSettings({
											...settings,
											countdown: {
												...settings.countdown,
												seconds: Number(event.currentTarget.value),
											},
										})
									}
								>
									<option value="3">3 seconds</option>
									<option value="5">5 seconds</option>
									<option value="10">10 seconds</option>
								</select>
							</label>
						</div>
						<div className="checks">
							<DoodleCheckbox
								label="Show camera preview by default"
								checked={settings.webcam.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										webcam: {
											...settings.webcam,
											enabled: checked && Boolean(settings.webcam.deviceId),
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Enable microphone by default"
								checked={settings.microphone.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										microphone: {
											...settings.microphone,
											enabled: checked,
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Enable system audio by default"
								checked={settings.systemAudio.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										systemAudio: {
											...settings.systemAudio,
											enabled: checked,
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Play recording sounds"
								checked={settings.sounds.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										sounds: {
											...settings.sounds,
											enabled: checked,
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Show countdown before recording"
								checked={settings.countdown.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										countdown: {
											...settings.countdown,
											enabled: checked,
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Warn about microphone issues"
								checked={settings.microphoneWarning.enabled}
								onChange={(checked) =>
									setSettings({
										...settings,
										microphoneWarning: {
											...settings.microphoneWarning,
											enabled: checked,
										},
									})
								}
							/>
							<DoodleCheckbox
								label="Mirror webcam"
								checked={settings.webcam.mirror}
								onChange={(checked) =>
									setSettings({
										...settings,
										webcam: {
											...settings.webcam,
											mirror: checked,
										},
									})
								}
							/>
						</div>
					</section>

					<RecoveredRecordingsSection />

					<div className="actions">
						<button type="button" className="cta" onClick={() => void save()}>
							Save changes
						</button>
						<button
							type="button"
							className="cta ghost"
							disabled={!auth}
							onClick={() => void signOut()}
						>
							Sign out
						</button>
						{saved && (
							<p className="paper-pill success">
								<svg
									className="check-mini"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path
										className="check-mini-path"
										pathLength={1}
										d="M 4 13 L 9.5 18 L 20 6"
									/>
								</svg>
								Saved
							</p>
						)}
					</div>
					{error && <p className="paper-pill error">{error}</p>}
				</div>
			</main>
			<p className="footnote">
				Changes apply the next time you open the recorder.
			</p>
		</>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
