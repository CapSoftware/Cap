import { RECORDING_STATE_KEY, SHARED_UI_STATE_KEY } from "./storage-keys";
import type {
	BootstrapData,
	CapturePreferences,
	DevicePreference,
	ExtensionAuth,
	ExtensionSettings,
	OverlayPosition,
	OverlayUiState,
	PendingAuth,
	RecordingMode,
	SharedRecordingState,
	SharedUiState,
	WebcamPreviewFrame,
} from "./types";

export { RECORDING_STATE_KEY, SHARED_UI_STATE_KEY };

export const SETTINGS_KEY = "cap-extension-settings";
export const AUTH_KEY = "cap-extension-auth";
const PENDING_AUTH_KEY = "cap-extension-pending-auth";
const BOOTSTRAP_CACHE_KEY = "cap-extension-bootstrap-cache";
export const OVERLAY_UI_STATE_KEY = "cap-extension-overlay-ui-state";
export const WEBCAM_PREVIEW_DISMISSED_KEY =
	"cap-extension-webcam-preview-dismissed";
export const MEDIA_ACCESS_KEY = "cap-extension-media-access";
export const FAILED_RECORDINGS_KEY = "cap-extension-failed-recordings";
const OVERLAY_TOKENS_KEY = "cap-extension-overlay-tokens";
const LAST_WEBCAM_PREVIEW_FRAME_KEY = "cap-extension-last-webcam-preview-frame";
const PRODUCTION_API_BASE_URL = "https://cap.so";
const DEFAULT_API_BASE_URL =
	import.meta.env.MODE === "development"
		? "http://localhost:3000"
		: PRODUCTION_API_BASE_URL;

export type MediaAccessState = {
	camera: boolean;
	microphone: boolean;
	updatedAt: number;
};

// Metadata for a recording whose upload did not complete. The captured bytes
// stay in the IndexedDB recording spool under sessionId until the upload is
// retried successfully or the entry is pruned.
export type FailedRecording = {
	sessionId: string;
	videoId: string | null;
	shareUrl: string | null;
	mimeType: string;
	subpath: string | null;
	durationMs: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	totalBytes: number;
	createdAt: number;
	message: string | null;
};

export const defaultSettings: ExtensionSettings = {
	apiBaseUrl: DEFAULT_API_BASE_URL,
	capture: {
		recordingMode: "fullscreen",
		camera: null,
		microphone: null,
	},
	webcam: {
		enabled: false,
		deviceId: null,
		position: "bottom-left",
		size: 230,
		shape: "round",
		mirror: false,
	},
	microphone: {
		enabled: true,
		deviceId: null,
	},
	systemAudio: {
		enabled: true,
	},
	sounds: {
		enabled: true,
	},
	countdown: {
		enabled: true,
		seconds: 3,
	},
	microphoneWarning: {
		enabled: true,
	},
};

const defaultMediaAccessState: MediaAccessState = {
	camera: false,
	microphone: false,
	updatedAt: 0,
};

// chrome.storage has no transactions, so concurrent read-modify-write calls
// (parallel service-worker handlers, several extension pages) can interleave
// and silently drop writes. Every RMW helper below funnels through this
// per-key promise chain so updates to the same key apply one at a time
// within a JS context. The key set is small and fixed, so the map never
// needs pruning.
const keyWriteQueues = new Map<string, Promise<unknown>>();

const withKeyLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
	const previous = keyWriteQueues.get(key) ?? Promise.resolve();
	const run = previous.then(task, task);
	keyWriteQueues.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
};

const getLocal = (keys: string[]) =>
	new Promise<Record<string, unknown>>((resolve) => {
		chrome.storage.local.get(keys, (items) => resolve(items));
	});

const setLocal = (items: Record<string, unknown>) =>
	new Promise<void>((resolve) => {
		chrome.storage.local.set(items, resolve);
	});

const removeLocal = (keys: string[] | string) =>
	new Promise<void>((resolve) => {
		chrome.storage.local.remove(keys, resolve);
	});

const getSession = (keys: string[]) =>
	new Promise<Record<string, unknown>>((resolve) => {
		chrome.storage.session.get(keys, (items) => resolve(items));
	});

const setSession = (items: Record<string, unknown>) =>
	new Promise<void>((resolve) => {
		chrome.storage.session.set(items, resolve);
	});

const removeSession = (keys: string[] | string) =>
	new Promise<void>((resolve) => {
		chrome.storage.session.remove(keys, resolve);
	});

export const loadSettings = async () => {
	const result = await getLocal([SETTINGS_KEY]);
	const saved = result[SETTINGS_KEY];
	if (!isSettings(saved)) return defaultSettings;
	const apiBaseUrl =
		import.meta.env.MODE === "development" &&
		saved.apiBaseUrl === PRODUCTION_API_BASE_URL
			? DEFAULT_API_BASE_URL
			: saved.apiBaseUrl;
	return {
		...defaultSettings,
		...saved,
		apiBaseUrl,
		capture: normalizeCapturePreferences(saved.capture),
		webcam: normalizeWebcamSettings(saved.webcam),
		microphone: normalizeMicrophoneSettings(saved.microphone),
		systemAudio: {
			...defaultSettings.systemAudio,
			...saved.systemAudio,
		},
		sounds: normalizeSoundSettings(saved.sounds),
		countdown: normalizeCountdownSettings(saved.countdown),
		microphoneWarning: normalizeMicrophoneWarningSettings(
			saved.microphoneWarning,
		),
	};
};

export const saveSettings = (settings: ExtensionSettings) =>
	setLocal({ [SETTINGS_KEY]: settings });

export const loadAuth = async () => {
	const result = await getLocal([AUTH_KEY]);
	const saved = result[AUTH_KEY];
	return isAuth(saved) ? saved : null;
};

export const saveAuth = (auth: ExtensionAuth) => setLocal({ [AUTH_KEY]: auth });

export const clearAuth = () => removeLocal(AUTH_KEY);

export const loadPendingAuth = async () => {
	const result = await getLocal([PENDING_AUTH_KEY]);
	const saved = result[PENDING_AUTH_KEY];
	return isPendingAuth(saved) ? saved : null;
};

export const loadCachedBootstrap = async () => {
	const result = await getLocal([BOOTSTRAP_CACHE_KEY]);
	const saved = result[BOOTSTRAP_CACHE_KEY];
	if (isBootstrap(saved)) return saved;
	if (isCachedBootstrap(saved)) return saved.bootstrap;
	return null;
};

export const saveCachedBootstrap = (bootstrap: BootstrapData) =>
	setLocal({
		[BOOTSTRAP_CACHE_KEY]: {
			bootstrap,
			cachedAt: Date.now(),
		},
	});

export const clearCachedBootstrap = () => removeLocal(BOOTSTRAP_CACHE_KEY);

export const savePendingAuth = (pendingAuth: PendingAuth) =>
	setLocal({ [PENDING_AUTH_KEY]: pendingAuth });

export const clearPendingAuth = () => removeLocal(PENDING_AUTH_KEY);

export const loadMediaAccessState = async () => {
	const result = await getLocal([MEDIA_ACCESS_KEY]);
	return normalizeMediaAccessState(result[MEDIA_ACCESS_KEY]);
};

export const updateMediaAccessState = (
	access: Partial<Pick<MediaAccessState, "camera" | "microphone">>,
) =>
	withKeyLock(MEDIA_ACCESS_KEY, async () => {
		const current = await loadMediaAccessState();
		const next = normalizeMediaAccessState({
			...current,
			...access,
			updatedAt: Date.now(),
		});
		await setLocal({ [MEDIA_ACCESS_KEY]: next });
		return next;
	});

export const loadOverlayUiState = async () => {
	const result = await getLocal([OVERLAY_UI_STATE_KEY]);
	return normalizeOverlayUiState(result[OVERLAY_UI_STATE_KEY]);
};

export const saveOverlayUiState = (state: OverlayUiState) =>
	setLocal({ [OVERLAY_UI_STATE_KEY]: state });

export const updateOverlayUiState = (
	update: (current: OverlayUiState) => OverlayUiState,
) =>
	withKeyLock(OVERLAY_UI_STATE_KEY, async () => {
		const current = await loadOverlayUiState();
		const next = normalizeOverlayUiState(update(current));
		await saveOverlayUiState(next);
		return next;
	});

export const loadLastWebcamPreviewFrame = async () => {
	const result = await getSession([LAST_WEBCAM_PREVIEW_FRAME_KEY]);
	const saved = result[LAST_WEBCAM_PREVIEW_FRAME_KEY];
	return isWebcamPreviewFrame(saved) ? saved : null;
};

export const saveLastWebcamPreviewFrame = (frame: WebcamPreviewFrame) =>
	setSession({ [LAST_WEBCAM_PREVIEW_FRAME_KEY]: frame });

export const loadWebcamPreviewDismissed = async () => {
	const result = await getSession([WEBCAM_PREVIEW_DISMISSED_KEY]);
	return result[WEBCAM_PREVIEW_DISMISSED_KEY] === true;
};

export const saveWebcamPreviewDismissed = (dismissed: boolean) =>
	setSession({ [WEBCAM_PREVIEW_DISMISSED_KEY]: dismissed });

const MAX_FAILED_RECORDINGS = 5;

const isFailedRecording = (value: unknown): value is FailedRecording => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<FailedRecording>;
	return (
		typeof candidate.sessionId === "string" &&
		typeof candidate.mimeType === "string" &&
		typeof candidate.totalBytes === "number" &&
		typeof candidate.createdAt === "number"
	);
};

export const loadFailedRecordings = async (): Promise<FailedRecording[]> => {
	const result = await getLocal([FAILED_RECORDINGS_KEY]);
	const saved = result[FAILED_RECORDINGS_KEY];
	if (!Array.isArray(saved)) return [];
	return saved.filter(isFailedRecording);
};

// The metadata list is capped; entries pushed out by newer failures are
// returned so the caller can also reclaim their spooled bytes in IndexedDB.
// Silently dropping them would leave multi-GB spools stranded (and later
// re-surfaced by the orphan sweep with videoId null, i.e. unretryable).
export const saveFailedRecordings = async (
	recordings: FailedRecording[],
): Promise<{ kept: FailedRecording[]; dropped: FailedRecording[] }> => {
	const sorted = [...recordings].sort(
		(left, right) => right.createdAt - left.createdAt,
	);
	const kept = sorted.slice(0, MAX_FAILED_RECORDINGS);
	const dropped = sorted.slice(MAX_FAILED_RECORDINGS);
	await setLocal({ [FAILED_RECORDINGS_KEY]: kept });
	return { kept, dropped };
};

export const upsertFailedRecording = (recording: FailedRecording) =>
	withKeyLock(FAILED_RECORDINGS_KEY, async () => {
		const current = await loadFailedRecordings();
		const next = [
			recording,
			...current.filter((entry) => entry.sessionId !== recording.sessionId),
		];
		return saveFailedRecordings(next);
	});

export const removeFailedRecording = (sessionId: string) =>
	withKeyLock(FAILED_RECORDINGS_KEY, async () => {
		const current = await loadFailedRecordings();
		const next = current.filter((entry) => entry.sessionId !== sessionId);
		return saveFailedRecordings(next);
	});

// Identity of a recording that is currently live in the offscreen document,
// keyed by its spool session. Persisted when the recording starts so that a
// browser/offscreen-document crash still leaves enough metadata for the
// orphan sweep to surface a retryable failed-recording entry (videoId,
// subpath, dimensions) instead of a download-only one.
export type LiveRecordingManifest = {
	sessionId: string;
	videoId: string;
	shareUrl: string;
	mimeType: string;
	subpath: string;
	width: number;
	height: number;
	fps: number;
	startedAt: number;
};

const LIVE_RECORDING_MANIFESTS_KEY = "cap-extension-live-recordings";

const isLiveRecordingManifest = (
	value: unknown,
): value is LiveRecordingManifest => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<LiveRecordingManifest>;
	return (
		typeof candidate.sessionId === "string" &&
		typeof candidate.videoId === "string" &&
		typeof candidate.shareUrl === "string" &&
		typeof candidate.mimeType === "string" &&
		typeof candidate.subpath === "string" &&
		typeof candidate.width === "number" &&
		typeof candidate.height === "number" &&
		typeof candidate.fps === "number" &&
		typeof candidate.startedAt === "number"
	);
};

export const loadLiveRecordingManifests = async (): Promise<
	LiveRecordingManifest[]
> => {
	const result = await getLocal([LIVE_RECORDING_MANIFESTS_KEY]);
	const saved = result[LIVE_RECORDING_MANIFESTS_KEY];
	if (!Array.isArray(saved)) return [];
	return saved.filter(isLiveRecordingManifest);
};

export const saveLiveRecordingManifest = (manifest: LiveRecordingManifest) =>
	withKeyLock(LIVE_RECORDING_MANIFESTS_KEY, async () => {
		const current = await loadLiveRecordingManifests();
		await setLocal({
			[LIVE_RECORDING_MANIFESTS_KEY]: [
				manifest,
				...current.filter((entry) => entry.sessionId !== manifest.sessionId),
			],
		});
	});

export const removeLiveRecordingManifest = (sessionId: string) =>
	withKeyLock(LIVE_RECORDING_MANIFESTS_KEY, async () => {
		const current = await loadLiveRecordingManifests();
		await setLocal({
			[LIVE_RECORDING_MANIFESTS_KEY]: current.filter(
				(entry) => entry.sessionId !== sessionId,
			),
		});
	});

// Manifests are bookkeeping for spool sessions; once a session is gone its
// manifest is dead weight (a failed-recording entry carries its own copy of
// the metadata).
export const pruneLiveRecordingManifests = (
	survivingSessionIds: ReadonlySet<string>,
) =>
	withKeyLock(LIVE_RECORDING_MANIFESTS_KEY, async () => {
		const current = await loadLiveRecordingManifests();
		const next = current.filter((entry) =>
			survivingSessionIds.has(entry.sessionId),
		);
		if (next.length !== current.length) {
			await setLocal({ [LIVE_RECORDING_MANIFESTS_KEY]: next });
		}
	});

// Sign-in failures land in a detached launchWebAuthFlow callback with no open
// UI to reject into; the popup reads this on its next status poll. Session
// storage survives service-worker restarts but clears with the browser.
const AUTH_ERROR_KEY = "cap-extension-auth-error";

export const loadAuthError = async (): Promise<string | null> => {
	const result = await getSession([AUTH_ERROR_KEY]);
	const saved = result[AUTH_ERROR_KEY];
	return typeof saved === "string" && saved.length > 0 ? saved : null;
};

export const saveAuthError = (message: string) =>
	setSession({ [AUTH_ERROR_KEY]: message });

export const clearAuthError = () => removeSession(AUTH_ERROR_KEY);

// Tokens registered by content scripts for the extension iframes they embed.
// chrome.storage.session survives service worker restarts but clears with the
// browser session, matching the lifetime of the iframes themselves.
const MAX_OVERLAY_TOKENS = 64;

export const loadOverlayTokens = async (): Promise<Record<string, number>> => {
	const result = await getSession([OVERLAY_TOKENS_KEY]);
	const saved = result[OVERLAY_TOKENS_KEY];
	if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
	const entries = Object.entries(saved as Record<string, unknown>).filter(
		(entry): entry is [string, number] => typeof entry[1] === "number",
	);
	return Object.fromEntries(entries);
};

export const registerOverlayToken = async (token: string) => {
	if (!token) return;
	await withKeyLock(OVERLAY_TOKENS_KEY, async () => {
		const tokens = await loadOverlayTokens();
		tokens[token] = Date.now();
		const pruned = Object.entries(tokens)
			.sort((left, right) => right[1] - left[1])
			.slice(0, MAX_OVERLAY_TOKENS);
		await setSession({ [OVERLAY_TOKENS_KEY]: Object.fromEntries(pruned) });
	});
};

export const isOverlayTokenRegistered = async (token: string) => {
	if (!token) return false;
	const tokens = await loadOverlayTokens();
	return Object.hasOwn(tokens, token);
};

// The uploading-tab id is service-worker state, but MV3 workers restart at
// any time; mirroring the id into session storage lets a restarted worker
// reuse the existing tab instead of opening a duplicate.
const UPLOAD_PROGRESS_TAB_KEY = "cap-extension-upload-progress-tab";

export const loadUploadProgressTabId = async (): Promise<number | null> => {
	const result = await getSession([UPLOAD_PROGRESS_TAB_KEY]);
	const saved = result[UPLOAD_PROGRESS_TAB_KEY];
	return typeof saved === "number" && Number.isFinite(saved) ? saved : null;
};

export const saveUploadProgressTabId = (tabId: number | null) =>
	tabId === null
		? removeSession(UPLOAD_PROGRESS_TAB_KEY)
		: setSession({ [UPLOAD_PROGRESS_TAB_KEY]: tabId });

export const loadSharedRecordingState =
	async (): Promise<SharedRecordingState | null> => {
		const result = await getSession([RECORDING_STATE_KEY]);
		const saved = result[RECORDING_STATE_KEY];
		return isSharedRecordingState(saved) ? saved : null;
	};

export const saveSharedRecordingState = (state: SharedRecordingState) =>
	setSession({ [RECORDING_STATE_KEY]: state });

export const loadSharedUiState = async (): Promise<SharedUiState> => {
	const result = await getSession([SHARED_UI_STATE_KEY]);
	return normalizeSharedUiState(result[SHARED_UI_STATE_KEY]);
};

export const saveSharedUiState = (state: SharedUiState) =>
	setSession({ [SHARED_UI_STATE_KEY]: state });

export const updateSharedUiState = (
	update: (current: SharedUiState) => SharedUiState,
) =>
	withKeyLock(SHARED_UI_STATE_KEY, async () => {
		const current = await loadSharedUiState();
		const updated = update(current);
		// Callers signal "no change" by returning the object they were given;
		// skipping the write keeps high-frequency callers (the per-status panel
		// sync) from fanning storage.onChanged events out to every open tab.
		if (updated === current) return current;
		const next = normalizeSharedUiState(updated);
		await saveSharedUiState(next);
		return next;
	});

const isSettings = (value: unknown): value is ExtensionSettings => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ExtensionSettings>;
	return (
		typeof candidate.apiBaseUrl === "string" &&
		typeof candidate.webcam === "object" &&
		candidate.webcam !== null
	);
};

const isWebcamPreviewFrame = (value: unknown): value is WebcamPreviewFrame => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<WebcamPreviewFrame>;
	const dimensions = candidate.dimensions;
	return (
		typeof candidate.dataUrl === "string" &&
		candidate.dataUrl.startsWith("data:image/") &&
		typeof candidate.capturedAt === "number" &&
		Number.isFinite(candidate.capturedAt) &&
		!!dimensions &&
		typeof dimensions === "object" &&
		typeof dimensions.width === "number" &&
		typeof dimensions.height === "number" &&
		Number.isFinite(dimensions.width) &&
		Number.isFinite(dimensions.height) &&
		dimensions.width > 0 &&
		dimensions.height > 0
	);
};

const normalizeRecordingMode = (value: unknown): RecordingMode =>
	value === "tab" ||
	value === "fullscreen" ||
	value === "window" ||
	value === "camera"
		? value
		: defaultSettings.capture.recordingMode;

const normalizeDevicePreference = (value: unknown): DevicePreference | null => {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<DevicePreference>;
	if (
		typeof candidate.deviceId !== "string" ||
		candidate.deviceId.trim().length === 0
	) {
		return null;
	}

	return {
		deviceId: candidate.deviceId,
		label:
			typeof candidate.label === "string" && candidate.label.trim().length > 0
				? candidate.label
				: null,
		groupId:
			typeof candidate.groupId === "string" &&
			candidate.groupId.trim().length > 0
				? candidate.groupId
				: null,
		updatedAt:
			typeof candidate.updatedAt === "number" &&
			Number.isFinite(candidate.updatedAt)
				? candidate.updatedAt
				: 0,
	};
};

const normalizeCapturePreferences = (value: unknown): CapturePreferences => {
	const capture =
		value && typeof value === "object"
			? (value as Partial<CapturePreferences>)
			: {};

	return {
		recordingMode: normalizeRecordingMode(capture.recordingMode),
		camera: normalizeDevicePreference(capture.camera),
		microphone: normalizeDevicePreference(capture.microphone),
	};
};

const normalizeWebcamShape = (
	value: unknown,
): ExtensionSettings["webcam"]["shape"] => {
	if (value === "round" || value === "full" || value === "square") {
		return value;
	}
	if (value === "circle") {
		return "round";
	}
	if (value === "rounded") {
		return "square";
	}
	return defaultSettings.webcam.shape;
};

const normalizeWebcamSettings = (
	value: unknown,
): ExtensionSettings["webcam"] => {
	const webcam =
		value && typeof value === "object"
			? (value as Partial<ExtensionSettings["webcam"]>)
			: {};
	const size =
		typeof webcam.size === "number" && Number.isFinite(webcam.size)
			? webcam.size
			: defaultSettings.webcam.size;
	const position =
		webcam.position === "top-left" ||
		webcam.position === "top-right" ||
		webcam.position === "bottom-left" ||
		webcam.position === "bottom-right"
			? webcam.position
			: defaultSettings.webcam.position;
	const deviceId =
		typeof webcam.deviceId === "string" && webcam.deviceId.trim().length > 0
			? webcam.deviceId
			: null;

	return {
		enabled:
			typeof webcam.enabled === "boolean"
				? webcam.enabled
				: defaultSettings.webcam.enabled,
		deviceId,
		position,
		size: Math.max(120, Math.min(420, size)),
		shape: normalizeWebcamShape(webcam.shape),
		mirror: typeof webcam.mirror === "boolean" ? webcam.mirror : false,
	};
};

const normalizeMicrophoneSettings = (
	value: unknown,
): ExtensionSettings["microphone"] => {
	const microphone =
		value && typeof value === "object"
			? (value as Partial<ExtensionSettings["microphone"]>)
			: {};
	return {
		enabled:
			typeof microphone.enabled === "boolean"
				? microphone.enabled
				: defaultSettings.microphone.enabled,
		deviceId:
			typeof microphone.deviceId === "string" &&
			microphone.deviceId.trim().length > 0
				? microphone.deviceId
				: null,
	};
};

const normalizeSoundSettings = (
	value: unknown,
): ExtensionSettings["sounds"] => {
	const sounds =
		value && typeof value === "object"
			? (value as Partial<ExtensionSettings["sounds"]>)
			: {};

	return {
		enabled:
			typeof sounds.enabled === "boolean"
				? sounds.enabled
				: defaultSettings.sounds.enabled,
	};
};

// Only 3/5/10 are offered in the UI, but any positive integer is accepted so a
// hand-edited or future value is not silently reset to the default.
const ALLOWED_COUNTDOWN_SECONDS = [3, 5, 10];

const normalizeCountdownSettings = (
	value: unknown,
): ExtensionSettings["countdown"] => {
	const countdown =
		value && typeof value === "object"
			? (value as Partial<ExtensionSettings["countdown"]>)
			: {};
	const seconds =
		typeof countdown.seconds === "number" &&
		Number.isFinite(countdown.seconds) &&
		countdown.seconds > 0
			? Math.round(countdown.seconds)
			: defaultSettings.countdown.seconds;

	return {
		enabled:
			typeof countdown.enabled === "boolean"
				? countdown.enabled
				: defaultSettings.countdown.enabled,
		seconds: ALLOWED_COUNTDOWN_SECONDS.includes(seconds)
			? seconds
			: defaultSettings.countdown.seconds,
	};
};

const normalizeMicrophoneWarningSettings = (
	value: unknown,
): ExtensionSettings["microphoneWarning"] => {
	const warning =
		value && typeof value === "object"
			? (value as Partial<ExtensionSettings["microphoneWarning"]>)
			: {};

	return {
		enabled:
			typeof warning.enabled === "boolean"
				? warning.enabled
				: defaultSettings.microphoneWarning.enabled,
	};
};

const normalizeMediaAccessState = (value: unknown): MediaAccessState => {
	const access =
		value && typeof value === "object"
			? (value as Partial<MediaAccessState>)
			: {};

	return {
		camera:
			typeof access.camera === "boolean"
				? access.camera
				: defaultMediaAccessState.camera,
		microphone:
			typeof access.microphone === "boolean"
				? access.microphone
				: defaultMediaAccessState.microphone,
		updatedAt:
			typeof access.updatedAt === "number" && Number.isFinite(access.updatedAt)
				? access.updatedAt
				: defaultMediaAccessState.updatedAt,
	};
};

const normalizeOverlayPosition = (value: unknown): OverlayPosition | null => {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<OverlayPosition>;
	if (
		typeof candidate.x !== "number" ||
		typeof candidate.y !== "number" ||
		typeof candidate.viewportWidth !== "number" ||
		typeof candidate.viewportHeight !== "number" ||
		typeof candidate.updatedAt !== "number" ||
		!Number.isFinite(candidate.x) ||
		!Number.isFinite(candidate.y) ||
		!Number.isFinite(candidate.viewportWidth) ||
		!Number.isFinite(candidate.viewportHeight) ||
		!Number.isFinite(candidate.updatedAt)
	) {
		return null;
	}

	return {
		x: candidate.x,
		y: candidate.y,
		viewportWidth: Math.max(1, candidate.viewportWidth),
		viewportHeight: Math.max(1, candidate.viewportHeight),
		updatedAt: candidate.updatedAt,
	};
};

const RECORDING_PHASES = new Set([
	"idle",
	"creating",
	"recording",
	"paused",
	"uploading",
	"completed",
	"error",
]);

const isSharedRecordingState = (
	value: unknown,
): value is SharedRecordingState => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SharedRecordingState>;
	const status = candidate.status as { phase?: unknown } | undefined;
	return (
		!!status &&
		typeof status === "object" &&
		typeof status.phase === "string" &&
		RECORDING_PHASES.has(status.phase) &&
		typeof candidate.updatedAt === "number" &&
		Number.isFinite(candidate.updatedAt)
	);
};

const normalizeSharedUiState = (value: unknown): SharedUiState => {
	const state =
		value && typeof value === "object" ? (value as Partial<SharedUiState>) : {};

	return {
		panelOpen: state.panelOpen === true,
		readyBarDismissed: state.readyBarDismissed === true,
		updatedAt:
			typeof state.updatedAt === "number" && Number.isFinite(state.updatedAt)
				? state.updatedAt
				: 0,
	};
};

const normalizeOverlayUiState = (value: unknown): OverlayUiState => {
	const state =
		value && typeof value === "object"
			? (value as Partial<OverlayUiState>)
			: {};

	return {
		webcamPosition: normalizeOverlayPosition(state.webcamPosition),
		recordingBarPosition: normalizeOverlayPosition(state.recordingBarPosition),
	};
};

const isAuth = (value: unknown): value is ExtensionAuth => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ExtensionAuth>;
	return (
		typeof candidate.authApiKey === "string" &&
		typeof candidate.userId === "string"
	);
};

const isPendingAuth = (value: unknown): value is PendingAuth => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PendingAuth>;
	return (
		typeof candidate.state === "string" &&
		typeof candidate.redirectUri === "string" &&
		typeof candidate.startedAt === "number"
	);
};

const isBootstrap = (value: unknown): value is BootstrapData => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<BootstrapData>;
	return (
		typeof candidate.user === "object" &&
		candidate.user !== null &&
		typeof candidate.organization === "object" &&
		candidate.organization !== null &&
		typeof candidate.plan === "object" &&
		candidate.plan !== null
	);
};

const isCachedBootstrap = (
	value: unknown,
): value is { bootstrap: BootstrapData; cachedAt: number } => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		bootstrap?: unknown;
		cachedAt?: unknown;
	};
	return isBootstrap(candidate.bootstrap);
};
