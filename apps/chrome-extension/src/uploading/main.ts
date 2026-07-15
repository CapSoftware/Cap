import { recoverRecordingSpoolSession } from "@cap/recorder-core";
import { isRecordingStatusBroadcast } from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	type FailedRecording,
	loadFailedRecordings,
	loadSharedRecordingState,
	RECORDING_STATE_KEY,
} from "../shared/storage";
import type { RecordingStatus } from "../shared/types";
import "./styles.css";

// Live updates arrive via status broadcasts and the session-storage mirror;
// the poll only reconciles drift, so it can be slow instead of forcing a
// service-worker -> offscreen round trip several times a second.
const POLL_INTERVAL_MS = 2000;
const REDIRECT_DELAY_MS = 1600;
// After a retry starts (or its message channel dies with the service
// worker), live broadcasts from the offscreen document decide the outcome.
// Only declare failure if no fresh status shows up for this long.
const RETRY_STATUS_TIMEOUT_MS = 45_000;
const RETRY_SILENT_FAILURE_MESSAGE =
	"重试没有报告任何进度。任务可能仍在运行，请先检查你的 Cap 视频再重新尝试。";

type ActiveStatus = Extract<
	RecordingStatus,
	{ phase: "recording" | "paused" | "uploading" }
>;
type ErrorStatus = Extract<RecordingStatus, { phase: "error" }>;
type StageMode = "waiting" | "uploading" | "finalizing" | "completed" | "error";

const byId = <T extends Element>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element: ${id}`);
	return element as unknown as T;
};

const stage = byId<HTMLElement>("stage");
const titleElement = byId<HTMLElement>("upload-title");
const detailElement = byId<HTMLElement>("upload-detail");
const metaElement = byId<HTMLElement>("upload-meta");
const percentValue = byId<HTMLElement>("percent-value");
const squiggleProgress = byId<SVGPathElement>("squiggle-progress");
const shareLink = byId<HTMLAnchorElement>("share-link");
const errorActions = byId<HTMLElement>("error-actions");
const retryButton = byId<HTMLButtonElement>("retry-upload");
const downloadButton = byId<HTMLButtonElement>("download-recording");

const urlVideoId = new URL(window.location.href).searchParams.get("videoId");

let mode: StageMode = "waiting";
let redirecting = false;
// Locks the retry button while a retry request is in flight; live status
// renders are never suppressed by it.
let retrying = false;
// Set while a retry waits for its first fresh status: the pre-retry error is
// still mirrored in session storage and must not repaint over the retry UI.
let retryPendingFreshStatus = false;
let retryWatchdog: number | null = null;
let targetPercent = 0;
let displayedPercent = 0;
let activeStateKey = "";
let lastTitleKey = "";
let consecutivePollFailures = 0;
let currentErrorVideoId: string | null = null;
let frameHandle: number | null = null;
let lastPercentText: string | null = null;
let lastDashOffset: string | null = null;

const setMode = (next: StageMode) => {
	if (mode === next) return;
	mode = next;
	stage.dataset.mode = next;
};

const applyStageState = (key: string, title: string, detail: string) => {
	if (activeStateKey === key) return;
	activeStateKey = key;
	titleElement.textContent = title;
	detailElement.textContent = detail;
};

const formatBytes = (bytes: number) => {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Math.max(0, Math.round(bytes))} B`;
};

// The title is driven by the status handlers (which keep firing in
// background tabs) instead of the rAF loop, which the browser suspends for
// hidden tabs and which stops once the status is terminal.
const syncTabTitle = () => {
	const percent = Math.round(targetPercent);
	const key =
		mode === "uploading" || mode === "finalizing" ? `${mode}:${percent}` : mode;
	if (key === lastTitleKey) return;
	lastTitleKey = key;
	if (mode === "completed") {
		document.title = "已就绪 - Cap";
		return;
	}
	if (mode === "error") {
		document.title = "上传需要处理 - Cap";
		return;
	}
	if (mode === "waiting") {
		document.title = "正在上传 - Cap";
		return;
	}
	document.title = `正在上传 ${percent}% - Cap`;
};

const applyPercentDom = () => {
	const percentText = `${Math.floor(displayedPercent)}%`;
	if (percentText !== lastPercentText) {
		lastPercentText = percentText;
		percentValue.textContent = percentText;
	}
	const dashOffset =
		mode === "waiting"
			? ""
			: `${100 - Math.min(100, Math.max(0, displayedPercent))}`;
	if (dashOffset !== lastDashOffset) {
		lastDashOffset = dashOffset;
		squiggleProgress.style.strokeDashoffset = dashOffset;
	}
};

const syncFrame = () => {
	frameHandle = null;
	const delta = targetPercent - displayedPercent;
	displayedPercent =
		Math.abs(delta) < 0.05 ? targetPercent : displayedPercent + delta * 0.085;
	applyPercentDom();
	// Once a terminal status has settled there is nothing left to animate;
	// renderStatus restarts the loop when a new active status arrives.
	if (
		(mode === "completed" || mode === "error") &&
		displayedPercent === targetPercent
	) {
		return;
	}
	frameHandle = window.requestAnimationFrame(syncFrame);
};

const ensureFrameLoop = () => {
	if (frameHandle !== null) return;
	frameHandle = window.requestAnimationFrame(syncFrame);
};

const getOverallPercent = (status: ActiveStatus) => {
	if (status.uploadStatus?.status === "uploadingVideo") {
		return status.uploadStatus.progress;
	}
	if (!status.upload || status.upload.totalBytes === 0) return 0;
	return (status.upload.uploadedBytes / status.upload.totalBytes) * 100;
};

const hideErrorActions = () => {
	currentErrorVideoId = null;
	errorActions.hidden = true;
};

const renderActiveStatus = (status: ActiveStatus) => {
	hideErrorActions();
	shareLink.hidden = true;
	targetPercent = Math.max(
		targetPercent,
		Math.min(100, getOverallPercent(status)),
	);
	const totalBytes = status.upload?.totalBytes ?? 0;
	const uploadedBytes = status.upload?.uploadedBytes ?? 0;
	metaElement.textContent =
		totalBytes > 0
			? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
			: "";
	metaElement.hidden = totalBytes === 0;

	if (status.phase === "recording") {
		setMode("uploading");
		applyStageState(
			"recording",
			"仍在录制",
			"你的 Cap 视频正在录制过程中传输到云端。",
		);
		return;
	}
	if (status.phase === "paused") {
		setMode("uploading");
		applyStageState("paused", "录制已暂停", "已采集的内容会继续上传。");
		return;
	}

	const allSegmentsDone =
		status.upload !== undefined &&
		status.upload.totalChunks > 0 &&
		status.upload.completedChunks === status.upload.totalChunks;
	if (allSegmentsDone || targetPercent >= 99.5) {
		setMode("finalizing");
		applyStageState("finalizing", "即将完成", "正在合并所有内容…");
		return;
	}
	setMode("uploading");
	applyStageState(
		"uploading",
		"正在上传你的 Cap 视频",
		"准备好后会立即为你打开。",
	);
};

const renderCompleted = (
	status: Extract<RecordingStatus, { phase: "completed" }>,
) => {
	hideErrorActions();
	targetPercent = 100;
	setMode("completed");
	applyStageState("completed", "你的 Cap 视频已就绪", "正在为你打开…");
	metaElement.hidden = true;
	shareLink.href = status.shareUrl;
	shareLink.hidden = false;
	if (!redirecting) {
		redirecting = true;
		window.setTimeout(() => {
			window.location.replace(status.shareUrl);
		}, REDIRECT_DELAY_MS);
	}
};

const findFailedRecording = async (
	videoId: string | null,
): Promise<FailedRecording | null> => {
	if (!videoId) return null;
	const failed = await loadFailedRecordings().catch(
		() => [] as FailedRecording[],
	);
	return failed.find((entry) => entry.videoId === videoId) ?? null;
};

const fileExtensionForMimeType = (mimeType: string) =>
	mimeType.includes("webm") ? "webm" : "mp4";

const syncErrorActions = (status: ErrorStatus, videoId: string | null) => {
	if (!status.recoverable || !videoId) {
		hideErrorActions();
		return;
	}
	currentErrorVideoId = videoId;
	void findFailedRecording(videoId).then((entry) => {
		if (mode !== "error" || currentErrorVideoId !== videoId) return;
		errorActions.hidden = !entry;
	});
};

const renderError = (status: ErrorStatus) => {
	setMode("error");
	applyStageState(
		`error:${status.message}`,
		"上传需要处理",
		status.message || "上传时出现问题。",
	);
	const recordingId = status.videoId ?? urlVideoId;
	metaElement.textContent = recordingId ? `录制 ID：${recordingId}` : "";
	metaElement.hidden = !recordingId;
	// When the upload finished but the confirmation was lost, the video may
	// still process server-side; the link lets the user verify.
	if (status.shareUrl) {
		shareLink.href = status.shareUrl;
		shareLink.hidden = false;
	} else {
		shareLink.hidden = true;
	}
	syncErrorActions(status, recordingId ?? null);
};

const renderWaiting = () => {
	hideErrorActions();
	shareLink.hidden = true;
	setMode("waiting");
	applyStageState("waiting", "正在连接录制", "请稍候…");
};

const clearRetryPending = () => {
	retryPendingFreshStatus = false;
	if (retryWatchdog !== null) {
		window.clearTimeout(retryWatchdog);
		retryWatchdog = null;
	}
};

// Suppress the stale pre-retry error until the offscreen recorder publishes
// a fresh status; if none ever arrives, surface a failure rather than
// spinning forever.
const beginRetryPending = () => {
	retryPendingFreshStatus = true;
	if (retryWatchdog !== null) {
		window.clearTimeout(retryWatchdog);
	}
	retryWatchdog = window.setTimeout(() => {
		retryWatchdog = null;
		if (!retryPendingFreshStatus) return;
		retryPendingFreshStatus = false;
		renderRetryFailure(RETRY_SILENT_FAILURE_MESSAGE);
	}, RETRY_STATUS_TIMEOUT_MS);
};

const renderRetryFailure = (message: string) => {
	setMode("error");
	applyStageState(`error:${message}`, "上传需要处理", message);
	syncTabTitle();
};

const renderStatus = (status: RecordingStatus) => {
	if (retryPendingFreshStatus) {
		// The stale pre-retry error keeps echoing from session storage and the
		// status polls until the retry publishes its first status; anything
		// non-error is that fresh status.
		if (status.phase === "error") return;
		if (
			status.phase === "recording" ||
			status.phase === "paused" ||
			status.phase === "uploading" ||
			status.phase === "completed"
		) {
			clearRetryPending();
		}
	}
	if (status.phase === "completed") {
		renderCompleted(status);
	} else if (
		status.phase === "recording" ||
		status.phase === "paused" ||
		status.phase === "uploading"
	) {
		renderActiveStatus(status);
	} else if (status.phase === "error") {
		renderError(status);
	} else {
		renderWaiting();
	}
	syncTabTitle();
	ensureFrameLoop();
};

const retryUpload = async () => {
	const videoId = currentErrorVideoId;
	if (!videoId || retrying) return;
	retrying = true;
	retryButton.disabled = true;
	downloadButton.disabled = true;
	// Reset the displayed progress for the new attempt; the live broadcasts
	// and the session-storage mirror drive the UI from here, exactly as
	// during the original upload.
	targetPercent = 0;
	displayedPercent = 0;
	beginRetryPending();
	try {
		const response = await sendServiceWorkerMessage({
			target: "service-worker",
			type: "retry-upload",
			videoId,
		});
		clearRetryPending();
		if (response.ok && response.status) {
			renderStatus(response.status);
		} else if (!response.ok) {
			renderRetryFailure(response.error);
		}
	} catch {
		// The message channel dies when the service worker restarts mid-retry,
		// but the upload keeps running in the offscreen document and keeps
		// broadcasting. Let those broadcasts (or the watchdog) decide the
		// outcome instead of flashing a false failure. Re-arm the watchdog
		// only while no fresh status has arrived yet.
		if (retryPendingFreshStatus) {
			beginRetryPending();
		}
	} finally {
		retrying = false;
		retryButton.disabled = false;
		downloadButton.disabled = false;
	}
};

const downloadRecording = async () => {
	const videoId = currentErrorVideoId;
	if (!videoId) return;
	downloadButton.disabled = true;
	try {
		const entry = await findFailedRecording(videoId);
		if (!entry) throw new Error("录制数据已不可用。");
		// The spool lives in the extension-origin IndexedDB, which this page
		// shares with the offscreen recorder.
		const orphan = await recoverRecordingSpoolSession(entry.sessionId);
		if (!orphan || orphan.blob.size === 0) {
			throw new Error("录制数据已不可用。");
		}
		const url = URL.createObjectURL(orphan.blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `cap-recording-${videoId}.${fileExtensionForMimeType(entry.mimeType)}`;
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		detailElement.textContent = message;
		activeStateKey = `error:${message}`;
	} finally {
		downloadButton.disabled = false;
	}
};

retryButton.addEventListener("click", () => void retryUpload());
downloadButton.addEventListener("click", () => void downloadRecording());

const pollStatus = async () => {
	try {
		const response = await sendServiceWorkerMessage({
			target: "service-worker",
			type: "get-recording-status",
		});
		if (response.ok && response.status) {
			consecutivePollFailures = 0;
			renderStatus(response.status);
			return;
		}
		consecutivePollFailures += 1;
	} catch {
		consecutivePollFailures += 1;
	}
	if (consecutivePollFailures >= 10 && mode === "waiting") {
		detailElement.textContent = "仍在尝试连接 Cap 扩展…";
	}
};

chrome.runtime.onMessage.addListener((message) => {
	if (!isRecordingStatusBroadcast(message)) return false;
	if (!redirecting) {
		renderStatus(message.status);
	}
	return false;
});

// The service worker mirrors every status change into session storage, so
// the change events keep this page live without polling round trips.
chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "session" || !changes[RECORDING_STATE_KEY]) return;
	if (redirecting) return;
	void loadSharedRecordingState()
		.then((state) => {
			if (state && !redirecting) renderStatus(state.status);
		})
		.catch(() => undefined);
});

// Once the page settles in a terminal state there is nothing to reconcile:
// keep polling only while waiting/active (or while a retry awaits its first
// fresh status). Broadcasts and the session-storage mirror still repaint the
// page, so a settled error tab stops waking the service worker every 2s.
const shouldPoll = () => {
	if (redirecting || mode === "completed") return false;
	if (mode === "error") return retryPendingFreshStatus || retrying;
	return true;
};

renderWaiting();
syncTabTitle();
ensureFrameLoop();
void pollStatus();
window.setInterval(() => {
	if (shouldPoll()) {
		void pollStatus();
	}
}, POLL_INTERVAL_MS);
