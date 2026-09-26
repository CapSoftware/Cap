import {
	type AiGenerationLanguage,
	isAiGenerationLanguage,
} from "@cap/web-domain";
import {
	importWebEditorCap,
	type WebEditorCapImportProgress,
	type WebEditorImportedCap,
} from "@/lib/editor-cap-import-client";
import {
	generateWebEditorCaptions,
	type WebEditorCaptionData,
} from "@/lib/editor-caption-client";
import {
	uploadWebEditorExport,
	type WebEditorExportMetadata,
} from "@/lib/editor-export-upload-client";
import { startWebEditorPreparation } from "@/lib/editor-preparation-client";
import { validWebEditorTitle } from "@/lib/editor-recording-title";
import {
	importWebEditorVideo,
	type WebEditorImportedVideo,
	type WebEditorVideoImportProgress,
} from "@/lib/editor-video-import-client";

type SocketCredential = { url: string; ticket: string };

type SessionTickets = {
	frames: SocketCredential;
	audio: SocketCredential;
	events: SocketCredential;
	commands: SocketCredential;
};

type BridgeRequest = {
	kind: "invoke" | "emit";
	id: number;
	name: string;
	args: unknown[];
};

type CommandReply =
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; error: string }
	| { kind: "channel"; id: number; value: unknown };

type ExportProgress = { rendered_count: number; total_frames: number };
type ExportStatus = {
	id: string;
	status: "running" | "ready" | "error" | "canceled";
	format: "Mp4" | "Gif" | "Mov";
	progress: ExportProgress | null;
	error: string | null;
	downloadStartedAt: number | null;
	size: number | null;
	mediaMetadata: WebEditorExportMetadata | null;
};
type ActiveExport = {
	requestId: number;
	jobId: string | null;
	canceled: boolean;
	replied: boolean;
	controller: AbortController;
	finished: Promise<void>;
	finish: () => void;
};
type PreparedExport = {
	jobId: string;
	token: string;
	format: ExportStatus["format"];
	size: number;
	mediaMetadata: WebEditorExportMetadata | null;
};

function createActiveExport(requestId: number): ActiveExport {
	let finish: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return {
		requestId,
		jobId: null,
		canceled: false,
		replied: false,
		controller: new AbortController(),
		finished,
		finish,
	};
}

const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHANNEL_PATTERN = /^__CHANNEL__:(\d+)$/;
const EXPORT_START_TIMEOUT_MS = 20_000;
const EXPORT_CANCEL_TIMEOUT_MS = 10_000;
const AUDIO_CONTENT_TYPES: Record<string, string> = {
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
};
const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
};
const AUDIO_ASSET_PATH =
	/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/;
const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
type EditorAssetKind = "audio" | "image";

function isEditorAssetPreparation(value: unknown): value is {
	key: string;
	path: string;
	upload: {
		type: "put" | "driveResumable";
		url: string;
		headers: Record<string, string>;
	};
} {
	if (typeof value !== "object" || value === null) return false;
	if (!("key" in value) || typeof value.key !== "string") return false;
	if (!("path" in value) || typeof value.path !== "string") return false;
	if (
		!("upload" in value) ||
		typeof value.upload !== "object" ||
		value.upload === null
	)
		return false;
	return (
		"type" in value.upload &&
		(value.upload.type === "put" || value.upload.type === "driveResumable") &&
		"url" in value.upload &&
		typeof value.upload.url === "string" &&
		"headers" in value.upload &&
		typeof value.upload.headers === "object" &&
		value.upload.headers !== null
	);
}

function isExportStatus(value: unknown): value is ExportStatus {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("status" in value) ||
		!["running", "ready", "error", "canceled"].includes(String(value.status)) ||
		!("format" in value) ||
		!["Mp4", "Gif", "Mov"].includes(String(value.format)) ||
		!("error" in value) ||
		(value.error !== null && typeof value.error !== "string") ||
		!("downloadStartedAt" in value) ||
		(value.downloadStartedAt !== null &&
			typeof value.downloadStartedAt !== "number") ||
		!("size" in value) ||
		(value.size !== null &&
			(typeof value.size !== "number" ||
				!Number.isSafeInteger(value.size) ||
				value.size < 1 ||
				value.size > 12 * 1024 * 1024 * 1024)) ||
		!("mediaMetadata" in value) ||
		(value.mediaMetadata !== null &&
			(typeof value.mediaMetadata !== "object" ||
				value.mediaMetadata === null ||
				!("duration" in value.mediaMetadata) ||
				!("width" in value.mediaMetadata) ||
				!("height" in value.mediaMetadata) ||
				!("fps" in value.mediaMetadata) ||
				![
					value.mediaMetadata.duration,
					value.mediaMetadata.width,
					value.mediaMetadata.height,
					value.mediaMetadata.fps,
				].every((number) => typeof number === "number" && number > 0))) ||
		!("progress" in value)
	) {
		return false;
	}
	if (
		value.status === "ready" &&
		(value.size === null ||
			(value.format === "Mp4" && value.mediaMetadata === null))
	) {
		return false;
	}
	const progress = value.progress;
	return (
		progress === null ||
		(typeof progress === "object" &&
			progress !== null &&
			"rendered_count" in progress &&
			"total_frames" in progress &&
			typeof progress.rendered_count === "number" &&
			typeof progress.total_frames === "number" &&
			Number.isSafeInteger(progress.rendered_count) &&
			Number.isSafeInteger(progress.total_frames) &&
			progress.rendered_count >= 0 &&
			progress.total_frames >= progress.rendered_count)
	);
}

function exportChannelId(value: unknown) {
	if (typeof value !== "string") return null;
	const match = CHANNEL_PATTERN.exec(value);
	if (!match) return null;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) ? id : null;
}

function exportFileType(format: string) {
	return format === "Mp4" ? "mp4" : format === "Gif" ? "gif" : "mov";
}

function waitForExportPoll(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Export cancelled"));
			return;
		}
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, 200);
		const canceled = () => {
			window.clearTimeout(timer);
			reject(new Error("Export cancelled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

function isSocketCredential(value: unknown): value is SocketCredential {
	if (
		typeof value !== "object" ||
		value === null ||
		!("url" in value) ||
		!("ticket" in value) ||
		typeof value.url !== "string" ||
		typeof value.ticket !== "string" ||
		!TICKET_PATTERN.test(value.ticket)
	) {
		return false;
	}
	try {
		const url = new URL(value.url);
		return (
			(url.protocol === "wss:" ||
				(url.protocol === "ws:" &&
					["localhost", "127.0.0.1"].includes(url.hostname))) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

function isSessionTickets(value: unknown): value is SessionTickets {
	return (
		typeof value === "object" &&
		value !== null &&
		"frames" in value &&
		"audio" in value &&
		"events" in value &&
		"commands" in value &&
		isSocketCredential(value.frames) &&
		isSocketCredential(value.audio) &&
		isSocketCredential(value.events) &&
		isSocketCredential(value.commands)
	);
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value.kind === "invoke" || value.kind === "emit") &&
		"id" in value &&
		typeof value.id === "number" &&
		Number.isSafeInteger(value.id) &&
		"name" in value &&
		typeof value.name === "string" &&
		"args" in value &&
		Array.isArray(value.args)
	);
}

function isEditorMountReply(
	value: unknown,
): value is { kind: "mount"; status: "ready" | "error" } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "mount" &&
		"status" in value &&
		(value.status === "ready" || value.status === "error")
	);
}

function isCommandReply(value: unknown): value is CommandReply {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value.kind === "result" ||
			value.kind === "error" ||
			value.kind === "channel") &&
		"id" in value &&
		typeof value.id === "number" &&
		Number.isSafeInteger(value.id) &&
		(value.kind === "result" || value.kind === "channel"
			? "value" in value
			: "error" in value && typeof value.error === "string")
	);
}

async function openSocket(credential: SocketCredential, signal: AbortSignal) {
	if (signal.aborted) throw new Error("Editor bridge is closed");
	const socket = new WebSocket(credential.url, [
		"cap-editor-v1",
		`cap-editor-ticket.${credential.ticket}`,
	]);
	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				socket.removeEventListener("open", opened);
				socket.removeEventListener("error", failed);
				signal.removeEventListener("abort", canceled);
				if (error) reject(error);
				else resolve();
			};
			const opened = () => finish();
			const failed = () => finish(new Error("Editor socket connection failed"));
			const canceled = () => finish(new Error("Editor bridge is closed"));
			const timer = window.setTimeout(
				() => finish(new Error("Editor socket connection timed out")),
				10_000,
			);
			socket.addEventListener("open", opened);
			socket.addEventListener("error", failed);
			signal.addEventListener("abort", canceled, { once: true });
			if (signal.aborted) canceled();
		});
		if (signal.aborted) throw new Error("Editor bridge is closed");
		if (socket.protocol !== "cap-editor-v1") {
			throw new Error("Editor socket protocol was not accepted");
		}
		return socket;
	} catch (cause) {
		socket.close();
		throw cause;
	}
}

export class EditorHostBridge {
	private disposed = false;
	private readonly controller = new AbortController();
	private readonly editorPath: string;
	private readonly browserSessionId: string;
	private workerSessionId: string | null = null;
	private workerProjectSavedAt: string | null = null;
	private workerCaptionPlan: boolean | null = null;
	private workerPreparationId: string | null = null;
	private pendingWorkerPreparation: Promise<void> | null = null;
	private pendingWorkerRelease: Promise<void> | null = null;
	private pendingWorkerAcquisition: Promise<void> = Promise.resolve();
	private readonly pendingConfigWrites = new Set<Promise<unknown>>();
	private workerIdleTimer: number | null = null;
	private activeWorkerUses = 0;
	private workerBundleDownloadUntil = 0;
	private activeProjectBundleDownloads = 0;
	private workerDownloadFrame: HTMLIFrameElement | null = null;
	private activeRecordingClipImports = 0;
	private port: MessagePort | null = null;
	private commands: WebSocket | null = null;
	private workerCommands: WebSocket | null = null;
	private workerCommandSessionId: string | null = null;
	private pendingWorkerCommandOpen: Promise<WebSocket> | null = null;
	private readonly workerCommandUses = new Set<number>();
	private workerEstimateGeneration = 0;
	private events: WebSocket | null = null;
	private audio: WebSocket | null = null;
	private readonly frameTickets = new Map<number, SocketCredential>();
	private readonly pendingMetaRequests = new Set<number>();
	private activeExport: ActiveExport | null = null;
	private preparedExport: PreparedExport | null = null;
	private canceledExportCleanup: Promise<void> | null = null;
	private activeShare: AbortController | null = null;
	private activeCaptions: {
		language: AiGenerationLanguage;
		promise: Promise<WebEditorCaptionData>;
	} | null = null;
	private activeVideoImport: Promise<WebEditorImportedVideo> | null = null;
	private activeCapImport: Promise<WebEditorImportedCap> | null = null;
	private activeAssetImports = 0;
	private readonly clipImportCache = new WeakMap<
		File,
		WebEditorImportedVideo
	>();
	private planRequestSequence = 0;
	private lastSuccessfulPlanRequestSequence = 0;
	private activePlanRequests = 0;
	private captionPlanRefreshPending = false;
	private captionPlanRefreshStartSequence = 0;
	private readonly refreshCaptionPlanFromPage = () => {
		if (!this.captionPlanRefreshPending) {
			this.captionPlanRefreshStartSequence = this.planRequestSequence + 1;
		}
		this.captionPlanRefreshPending = true;
		void this.currentPlan().catch(() => undefined);
	};
	private readonly refreshCaptionPlanFromVisibility = () => {
		if (!document.hidden) this.refreshCaptionPlanFromPage();
	};

	constructor(
		private readonly videoId: string,
		private sessionId: string,
		private readonly userId: string,
		private readonly onClose: (reason?: "deleted") => void,
		private readonly onFailure: (error: Error) => void,
		private readonly onImportProgress?: (
			progress:
				| WebEditorVideoImportProgress
				| WebEditorCapImportProgress
				| null,
		) => void,
		private readonly onOpenClipRecorder?: () => void,
		private readonly onImportNeedsReload?: () => Promise<void>,
		private captionsEnabled = false,
		private readonly onUpgrade?: () => void,
		private readonly onProjectSaved?: (savedAt: string) => void,
		private readonly getProjectSavedAt?: () => string | null,
		private readonly browserOnly = false,
	) {
		this.editorPath = `cap-web-editor://session/${sessionId}`;
		this.browserSessionId = sessionId;
	}

	private fail(error: Error) {
		if (this.disposed) return;
		this.dispose();
		this.onFailure(error);
	}

	private async tickets() {
		const response = await fetch(
			`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/tickets`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoId: this.videoId }),
				signal: this.controller.signal,
			},
		);
		if (!response.ok) throw new Error("Editor socket tickets are unavailable");
		const value: unknown = await response.json();
		if (!isSessionTickets(value)) {
			throw new Error("Editor socket tickets were invalid");
		}
		return value;
	}

	private async prepareWorkerSession(captionsEnabled: boolean) {
		const signal = this.controller.signal;
		const projectSavedAt = this.getProjectSavedAt?.() ?? null;
		const created = await startWebEditorPreparation(
			this.videoId,
			signal,
			() => undefined,
		);
		this.workerPreparationId = created.id;
		try {
			const deadline = Date.now() + 5 * 60 * 1000;
			while (!signal.aborted && Date.now() < deadline) {
				const response = await fetch(
					`/api/editor/preparations/${encodeURIComponent(created.id)}?videoId=${encodeURIComponent(this.videoId)}`,
					{ signal, cache: "no-store" },
				);
				if (!response.ok)
					throw new Error("Editor export preparation is unavailable");
				const status: unknown = await response.json();
				if (
					typeof status !== "object" ||
					status === null ||
					!("status" in status) ||
					typeof status.status !== "string"
				) {
					throw new Error("Editor export preparation status is invalid");
				}
				if (status.status === "ready") {
					if (
						!("sessionId" in status) ||
						typeof status.sessionId !== "string"
					) {
						throw new Error("Editor export session is unavailable");
					}
					this.sessionId = status.sessionId;
					this.workerSessionId = status.sessionId;
					this.workerProjectSavedAt = projectSavedAt;
					this.workerCaptionPlan = captionsEnabled;
					this.workerPreparationId = null;
					this.scheduleWorkerIdleRelease();
					return;
				}
				if (status.status !== "preparing") {
					throw new Error("Editor export preparation failed");
				}
				await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
			}
			throw new Error(
				signal.aborted
					? "Editor export preparation was canceled"
					: "Editor export preparation timed out",
			);
		} finally {
			if (this.workerPreparationId === created.id) {
				this.workerPreparationId = null;
				void fetch(
					`/api/editor/preparations/${encodeURIComponent(created.id)}?videoId=${encodeURIComponent(this.videoId)}`,
					{ method: "DELETE", keepalive: true },
				).catch(() => undefined);
			}
		}
	}

	private cancelWorkerIdleRelease() {
		if (this.workerIdleTimer === null) return;
		window.clearTimeout(this.workerIdleTimer);
		this.workerIdleTimer = null;
	}

	private holdWorkerSession() {
		this.activeWorkerUses++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeWorkerUses--;
			if (!this.disposed) this.scheduleWorkerIdleRelease();
		};
	}

	private scheduleWorkerIdleRelease() {
		if (!this.browserOnly || this.disposed || !this.workerSessionId) return;
		this.cancelWorkerIdleRelease();
		this.workerIdleTimer = window.setTimeout(() => {
			this.workerIdleTimer = null;
			if (
				Date.now() < this.workerBundleDownloadUntil ||
				this.activeProjectBundleDownloads > 0 ||
				this.activeExport ||
				this.preparedExport ||
				this.activeShare ||
				this.activeCaptions ||
				this.activeVideoImport ||
				this.activeCapImport ||
				this.activeAssetImports > 0 ||
				this.activeRecordingClipImports > 0 ||
				this.activeWorkerUses > 0 ||
				this.pendingWorkerPreparation
			) {
				this.scheduleWorkerIdleRelease();
				return;
			}
			void this.releaseWorkerSession().catch(() =>
				this.scheduleWorkerIdleRelease(),
			);
		}, 30_000);
	}

	private async releaseWorkerSession() {
		if (this.pendingWorkerRelease) return this.pendingWorkerRelease;
		const sessionId = this.workerSessionId;
		if (!sessionId) return;
		if (this.activeWorkerUses > 0) {
			throw new Error(
				"Finish the current editor operation before changing export sessions",
			);
		}
		this.cancelWorkerIdleRelease();
		const pending = (async () => {
			this.closeWorkerCommandSocket();
			const response = await fetch(
				`/api/editor/sessions/${encodeURIComponent(sessionId)}?videoId=${encodeURIComponent(this.videoId)}`,
				{ method: "DELETE", signal: this.controller.signal },
			);
			if (!response.ok && response.status !== 404) {
				throw new Error("Previous editor export session could not close");
			}
			if (this.workerSessionId === sessionId) {
				this.workerSessionId = null;
				this.workerProjectSavedAt = null;
				this.workerCaptionPlan = null;
				this.sessionId = this.browserSessionId;
			}
		})();
		this.pendingWorkerRelease = pending;
		try {
			await pending;
		} finally {
			if (this.pendingWorkerRelease === pending) {
				this.pendingWorkerRelease = null;
			}
		}
	}

	private closeWorkerCommandSocket() {
		const socket = this.workerCommands;
		this.workerCommands = null;
		this.workerCommandSessionId = null;
		if (socket) {
			socket.onclose = null;
			socket.close();
		}
		for (const id of [...this.workerCommandUses]) {
			this.releaseWorkerCommandUse(id);
			if (!this.disposed)
				this.port?.postMessage({
					kind: "error",
					id,
					error: "Editor export command disconnected",
				});
		}
	}

	private releaseWorkerCommandUse(id: number) {
		if (!this.workerCommandUses.delete(id)) return;
		this.activeWorkerUses--;
		if (!this.disposed) this.scheduleWorkerIdleRelease();
	}

	private async ensureWorkerCommandSocket() {
		const sessionId = this.workerSessionId;
		if (!sessionId) throw new Error("Editor export worker is unavailable");
		if (
			this.workerCommands?.readyState === WebSocket.OPEN &&
			this.workerCommandSessionId === sessionId
		) {
			return this.workerCommands;
		}
		if (!this.pendingWorkerCommandOpen) {
			const opening = (async () => {
				const tickets = await this.tickets();
				const socket = await openSocket(
					tickets.commands,
					this.controller.signal,
				);
				if (this.disposed || this.workerSessionId !== sessionId) {
					socket.close();
					throw new Error("Editor export worker changed");
				}
				this.workerCommands = socket;
				this.workerCommandSessionId = sessionId;
				socket.onmessage = (event: MessageEvent<unknown>) => {
					if (typeof event.data !== "string") return;
					let reply: unknown;
					try {
						reply = JSON.parse(event.data);
					} catch {
						return;
					}
					if (!isCommandReply(reply)) return;
					if (!this.workerCommandUses.has(reply.id)) return;
					if (reply.kind !== "channel") {
						this.releaseWorkerCommandUse(reply.id);
					}
					this.port?.postMessage(reply);
				};
				socket.onclose = () => {
					if (this.workerCommands === socket) this.closeWorkerCommandSocket();
				};
				return socket;
			})();
			this.pendingWorkerCommandOpen = opening;
			void opening.then(
				() => {
					if (this.pendingWorkerCommandOpen === opening)
						this.pendingWorkerCommandOpen = null;
				},
				() => {
					if (this.pendingWorkerCommandOpen === opening)
						this.pendingWorkerCommandOpen = null;
				},
			);
		}
		return this.pendingWorkerCommandOpen;
	}

	private async handleBrowserWorkerCommand(message: BridgeRequest) {
		if (message.kind !== "invoke") return;
		if (message.name === "cancelExportEstimates") {
			this.workerEstimateGeneration++;
		}
		const estimateGeneration = this.workerEstimateGeneration;
		if (message.name === "cancelExportEstimates" && !this.workerCommands) {
			this.port?.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		let release: (() => void) | null = null;
		try {
			if (
				message.name === "getExportEstimates" &&
				estimateGeneration !== this.workerEstimateGeneration
			) {
				throw new Error("Editor export estimate was canceled");
			}
			release = await this.ensureWorkerSession();
			if (
				message.name === "getExportEstimates" &&
				estimateGeneration !== this.workerEstimateGeneration
			) {
				throw new Error("Editor export estimate was canceled");
			}
			const socket = await this.ensureWorkerCommandSocket();
			if (
				message.name === "getExportEstimates" &&
				estimateGeneration !== this.workerEstimateGeneration
			) {
				throw new Error("Editor export estimate was canceled");
			}
			if (!this.port || this.disposed)
				throw new Error("Editor bridge is closed");
			const args = [...message.args];
			if (message.name === "getExportEstimates") {
				if (args.length !== 3 || args[0] !== this.editorPath)
					throw new Error("Editor export estimate request was invalid");
				args[0] = `cap-web-editor://session/${this.sessionId}`;
			}
			if (this.workerCommandUses.has(message.id))
				throw new Error("Editor export command is already running");
			this.workerCommandUses.add(message.id);
			release = null;
			try {
				socket.send(JSON.stringify({ ...message, args }));
			} catch (cause) {
				this.releaseWorkerCommandUse(message.id);
				throw cause;
			}
		} catch (cause) {
			release?.();
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error:
					cause instanceof Error
						? cause.message
						: "Editor export worker is unavailable",
			});
		}
	}

	private async ensureWorkerSession() {
		if (!this.browserOnly) return () => undefined;
		const previous = this.pendingWorkerAcquisition;
		let unlock: () => void = () => undefined;
		this.pendingWorkerAcquisition = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		this.cancelWorkerIdleRelease();
		await previous;
		try {
			return await this.acquireWorkerSession();
		} finally {
			unlock();
		}
	}

	private async acquireWorkerSession() {
		if (this.disposed) throw new Error("Editor bridge is closed");
		this.cancelWorkerIdleRelease();
		await this.pendingWorkerRelease;
		const captionsEnabled = await this.currentPlan();
		const projectSavedAt = this.getProjectSavedAt?.() ?? null;
		if (
			this.workerSessionId &&
			this.workerProjectSavedAt === projectSavedAt &&
			this.workerCaptionPlan === captionsEnabled
		) {
			this.scheduleWorkerIdleRelease();
			return this.holdWorkerSession();
		}
		if (!this.pendingWorkerPreparation) {
			const pending = (async () => {
				if (this.workerSessionId) {
					if (
						this.activeCaptions ||
						this.activeVideoImport ||
						this.activeCapImport ||
						this.activeAssetImports > 0 ||
						Date.now() < this.workerBundleDownloadUntil ||
						this.activeProjectBundleDownloads > 0 ||
						this.activeRecordingClipImports > 0 ||
						this.activeWorkerUses > 0 ||
						this.preparedExport ||
						this.activeShare
					) {
						throw new Error(
							"Finish the current editor operation before exporting new edits",
						);
					}
					await this.releaseWorkerSession();
				}
				await this.prepareWorkerSession(captionsEnabled);
				if (
					this.workerProjectSavedAt !== (this.getProjectSavedAt?.() ?? null)
				) {
					await this.releaseWorkerSession();
					throw new Error(
						"Editor changed during export preparation. Try again.",
					);
				}
			})();
			this.pendingWorkerPreparation = pending;
			void pending.then(
				() => {
					if (this.pendingWorkerPreparation === pending)
						this.pendingWorkerPreparation = null;
				},
				() => {
					if (this.pendingWorkerPreparation === pending)
						this.pendingWorkerPreparation = null;
				},
			);
		}
		await this.pendingWorkerPreparation;
		if (this.workerCaptionPlan !== (await this.currentPlan())) {
			if (this.activeWorkerUses === 0) await this.releaseWorkerSession();
			throw new Error(
				"Recording plan changed during export preparation. Try again.",
			);
		}
		this.scheduleWorkerIdleRelease();
		return this.holdWorkerSession();
	}

	private async currentPlan() {
		const requestSequence = ++this.planRequestSequence;
		this.activePlanRequests++;
		try {
			const response = await fetch(
				this.browserOnly
					? `/api/editor/videos/${encodeURIComponent(this.videoId)}/plan`
					: `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/plan?videoId=${encodeURIComponent(this.videoId)}`,
				{ cache: "no-store", signal: this.controller.signal },
			);
			if (!response.ok) throw new Error("Recording plan is unavailable");
			const value: unknown = await response.json();
			const plan =
				typeof value === "object" && value !== null && "pro" in value
					? value.pro
					: null;
			if (typeof plan !== "boolean") {
				throw new Error("Recording plan response was invalid");
			}
			if (requestSequence > this.lastSuccessfulPlanRequestSequence) {
				this.lastSuccessfulPlanRequestSequence = requestSequence;
				this.captionsEnabled = plan;
				if (
					this.captionPlanRefreshPending &&
					requestSequence >= this.captionPlanRefreshStartSequence &&
					!this.disposed
				) {
					this.port?.postMessage({
						kind: "event",
						name: "editorCaptionPlan",
						payload: plan,
					});
				}
			}
			return plan;
		} finally {
			this.activePlanRequests--;
			if (this.activePlanRequests === 0) {
				this.captionPlanRefreshPending = false;
			}
		}
	}

	private downloadWorkerFile(url: URL, fileName: string) {
		// Firefox can cancel page sockets on cross-origin attachment navigation:
		// https://bugzilla.mozilla.org/show_bug.cgi?id=896666
		if (!this.workerDownloadFrame) {
			const frame = document.createElement("iframe");
			frame.name = `cap-studio-download-${this.sessionId}`;
			frame.hidden = true;
			frame.setAttribute("aria-hidden", "true");
			document.body.append(frame);
			this.workerDownloadFrame = frame;
		}
		const link = document.createElement("a");
		link.href = url.toString();
		link.rel = "noreferrer";
		link.target = this.workerDownloadFrame.name;
		link.download = fileName;
		document.body.append(link);
		link.click();
		link.remove();
	}

	private exportPath(exportId?: string) {
		const root = `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/exports`;
		return exportId ? `${root}/${encodeURIComponent(exportId)}` : root;
	}

	private async cancelExportJob(exportId: string) {
		const controller = new AbortController();
		let timeoutId = 0;
		const deadline = new Promise<never>((_, reject) => {
			timeoutId = window.setTimeout(() => {
				reject(new Error("Editor export cancellation timed out"));
				controller.abort();
			}, EXPORT_CANCEL_TIMEOUT_MS);
		});
		try {
			await Promise.race([
				fetch(
					`${this.exportPath(exportId)}?videoId=${encodeURIComponent(this.videoId)}`,
					{ method: "DELETE", keepalive: true, signal: controller.signal },
				),
				deadline,
			]);
		} catch {
			return;
		} finally {
			window.clearTimeout(timeoutId);
		}
	}

	private async exportStatus(exportId: string, signal: AbortSignal) {
		const response = await fetch(
			`${this.exportPath(exportId)}?videoId=${encodeURIComponent(this.videoId)}`,
			{ signal, cache: "no-store" },
		);
		if (!response.ok) throw new Error("Editor export status is unavailable");
		const value: unknown = await response.json();
		if (!isExportStatus(value) || value.id !== exportId) {
			throw new Error("Editor export status was invalid");
		}
		return value;
	}

	private async renderExport(
		active: ActiveExport,
		channelId: number,
		settings: Record<string, unknown>,
	) {
		const startupController = new AbortController();
		const close = () => startupController.abort();
		this.controller.signal.addEventListener("abort", close, { once: true });
		if (this.controller.signal.aborted) close();
		let timeoutId = 0;
		const deadline = new Promise<never>((_, reject) => {
			timeoutId = window.setTimeout(() => {
				reject(new Error("Editor export creation timed out"));
				startupController.abort();
			}, EXPORT_START_TIMEOUT_MS);
		});
		const start = (async () => {
			const started = await fetch(this.exportPath(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoId: this.videoId, settings }),
				signal: startupController.signal,
			});
			if (!started.ok) {
				throw new Error(
					started.status === 400
						? "Editor export settings were invalid"
						: "Editor export could not start",
				);
			}
			const startValue: unknown = await started.json();
			if (
				typeof startValue !== "object" ||
				startValue === null ||
				!("id" in startValue) ||
				typeof startValue.id !== "string" ||
				!("status" in startValue) ||
				startValue.status !== "running"
			) {
				throw new Error("Editor export response was invalid");
			}
			active.jobId = startValue.id;
			if (startupController.signal.aborted) {
				void this.cancelExportJob(active.jobId);
				throw new Error("Editor export creation timed out");
			}
		})();
		try {
			await Promise.race([start, deadline]);
		} finally {
			window.clearTimeout(timeoutId);
			this.controller.signal.removeEventListener("abort", close);
		}
		if (!active.jobId) throw new Error("Editor export job was unavailable");
		if (active.canceled || this.disposed) throw new Error("Export cancelled");
		let lastRendered = -1;
		const renderDeadline = Date.now() + 20 * 60 * 1000;
		while (Date.now() < renderDeadline) {
			const status = await this.exportStatus(
				active.jobId,
				active.controller.signal,
			);
			if (status.progress && status.progress.rendered_count !== lastRendered) {
				lastRendered = status.progress.rendered_count;
				this.port?.postMessage({
					kind: "channel",
					id: channelId,
					value: {
						type: "FramesRendered",
						renderedCount: lastRendered,
						totalFrames: status.progress.total_frames,
					},
				});
			}
			if (status.status === "ready") {
				if (active.canceled || this.disposed)
					throw new Error("Export cancelled");
				return status;
			}
			if (status.status === "error")
				throw new Error(status.error || "Editor export failed");
			if (status.status === "canceled") throw new Error("Export cancelled");
			await waitForExportPoll(active.controller.signal);
		}
		throw new Error("Editor export timed out");
	}

	private async handleExport(message: BridgeRequest) {
		let reply: CommandReply;
		let releaseWorkerUse: (() => void) | null = null;
		await this.canceledExportCleanup;
		if (this.disposed || !this.port) return;
		if (this.activeExport || this.preparedExport) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Finish or cancel the current editor export first",
			});
			return;
		}
		const active = createActiveExport(message.id);
		this.activeExport = active;
		let downloaded = false;
		try {
			const [projectPath, channel, settings, fileName, fileType] = message.args;
			const channelId = exportChannelId(channel);
			if (
				projectPath !== this.editorPath ||
				channelId === null ||
				typeof settings !== "object" ||
				settings === null ||
				Array.isArray(settings) ||
				!("format" in settings) ||
				!["Mp4", "Gif", "Mov"].includes(String(settings.format)) ||
				typeof fileName !== "string" ||
				fileName.length === 0 ||
				fileName.length > 200 ||
				typeof fileType !== "string" ||
				fileType !== exportFileType(String(settings.format)) ||
				!fileName.endsWith(`.${fileType}`)
			) {
				throw new Error("Editor export request was invalid");
			}
			releaseWorkerUse = await this.ensureWorkerSession();
			await this.renderExport(
				active,
				channelId,
				settings as Record<string, unknown>,
			);
			if (!active.jobId) throw new Error("Editor export was unavailable");
			const ticketResponse = await fetch(
				`${this.exportPath(active.jobId)}/download-ticket`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ videoId: this.videoId, fileName }),
					signal: active.controller.signal,
				},
			);
			if (!ticketResponse.ok) throw new Error("Editor download is unavailable");
			const ticketValue: unknown = await ticketResponse.json();
			if (
				typeof ticketValue !== "object" ||
				ticketValue === null ||
				!("url" in ticketValue) ||
				typeof ticketValue.url !== "string"
			) {
				throw new Error("Editor download ticket was invalid");
			}
			const downloadUrl = new URL(ticketValue.url);
			if (
				(downloadUrl.protocol !== "https:" &&
					!(
						downloadUrl.protocol === "http:" &&
						["localhost", "127.0.0.1"].includes(downloadUrl.hostname)
					)) ||
				downloadUrl.pathname !==
					`/editor/sessions/${encodeURIComponent(this.sessionId)}/exports/${encodeURIComponent(active.jobId)}/download` ||
				downloadUrl.searchParams.size !== 1 ||
				!TICKET_PATTERN.test(downloadUrl.searchParams.get("ticket") ?? "")
			) {
				throw new Error("Editor download URL was invalid");
			}
			if (active.canceled || this.disposed) throw new Error("Export cancelled");
			this.downloadWorkerFile(downloadUrl, fileName);
			const downloadDeadline = Date.now() + 15_000;
			while (Date.now() < downloadDeadline) {
				const response = await fetch(
					`${this.exportPath(active.jobId)}?videoId=${encodeURIComponent(this.videoId)}`,
					{ signal: active.controller.signal, cache: "no-store" },
				).catch((cause: unknown) => {
					if (active.controller.signal.aborted) throw cause;
					return null;
				});
				if (!response) {
					await waitForExportPoll(active.controller.signal);
					continue;
				}
				if (response.status === 404) {
					downloaded = true;
					break;
				}
				if (!response.ok)
					throw new Error("Editor download status is unavailable");
				const statusValue: unknown = await response.json();
				if (!isExportStatus(statusValue) || statusValue.id !== active.jobId) {
					throw new Error("Editor download status was invalid");
				}
				if (statusValue.downloadStartedAt !== null) {
					downloaded = true;
					break;
				}
				await waitForExportPoll(active.controller.signal);
			}
			if (!downloaded) throw new Error("Browser download did not start");
			reply = { kind: "result", id: message.id, value: fileName };
		} catch (cause) {
			reply = {
				kind: "error",
				id: message.id,
				error:
					active.canceled || this.disposed
						? "Export cancelled"
						: cause instanceof Error
							? cause.message
							: "Editor export failed",
			};
		} finally {
			if (active.jobId && !downloaded) {
				await this.cancelExportJob(active.jobId);
			}
			if (this.activeExport === active) this.activeExport = null;
			releaseWorkerUse?.();
			active.finish();
		}
		if (!active.replied) this.port?.postMessage(reply);
	}

	private async handleProjectBundleDownload(message: BridgeRequest) {
		let reply: CommandReply;
		let bundleActive = false;
		let releaseWorkerUse: (() => void) | null = null;
		try {
			const argument = message.args[0];
			const projectPath = this.editorPath;
			if (
				message.args.length !== 1 ||
				typeof argument !== "object" ||
				argument === null ||
				Array.isArray(argument) ||
				!("path" in argument) ||
				(argument.path !== projectPath && argument.path !== `${projectPath}/`)
			)
				throw new Error("Editor bundle request was invalid");
			releaseWorkerUse = await this.ensureWorkerSession();
			this.activeProjectBundleDownloads++;
			bundleActive = true;
			this.cancelWorkerIdleRelease();
			const response = await fetch(
				`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/project-bundle/download-ticket`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ videoId: this.videoId }),
					signal: this.controller.signal,
				},
			);
			if (!response.ok) throw new Error("Recording bundle is unavailable");
			const value: unknown = await response.json();
			if (
				typeof value !== "object" ||
				value === null ||
				!("url" in value) ||
				typeof value.url !== "string"
			)
				throw new Error("Recording bundle ticket was invalid");
			const url = new URL(value.url);
			if (
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						["localhost", "127.0.0.1"].includes(url.hostname)
					)) ||
				url.username ||
				url.password ||
				url.hash ||
				url.pathname !==
					`/editor/sessions/${encodeURIComponent(this.sessionId)}/project-bundle/download` ||
				url.searchParams.size !== 1 ||
				!TICKET_PATTERN.test(url.searchParams.get("ticket") ?? "")
			)
				throw new Error("Recording bundle URL was invalid");
			if (this.disposed) throw new Error("Editor bridge is closed");
			this.downloadWorkerFile(url, "Cap Recording.capbundle");
			this.workerBundleDownloadUntil = Date.now() + 30_000;
			reply = { kind: "result", id: message.id, value: null };
		} catch (cause) {
			reply = {
				kind: "error",
				id: message.id,
				error:
					cause instanceof Error
						? cause.message
						: "Recording bundle is unavailable",
			};
		} finally {
			if (bundleActive) {
				this.activeProjectBundleDownloads--;
				this.scheduleWorkerIdleRelease();
			}
			releaseWorkerUse?.();
		}
		this.port?.postMessage(reply);
	}

	private async handleRenderExport(message: BridgeRequest) {
		let releaseWorkerUse: (() => void) | null = null;
		await this.canceledExportCleanup;
		if (this.disposed || !this.port) return;
		if (this.activeExport || this.preparedExport) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Finish or cancel the current editor export first",
			});
			return;
		}
		const active = createActiveExport(message.id);
		this.activeExport = active;
		try {
			const [projectPath, channel, settings] = message.args;
			const channelId = exportChannelId(channel);
			if (
				projectPath !== this.editorPath ||
				channelId === null ||
				typeof settings !== "object" ||
				settings === null ||
				Array.isArray(settings) ||
				!("format" in settings) ||
				!["Mp4", "Gif", "Mov"].includes(String(settings.format))
			) {
				throw new Error("Editor export request was invalid");
			}
			releaseWorkerUse = await this.ensureWorkerSession();
			const status = await this.renderExport(
				active,
				channelId,
				settings as Record<string, unknown>,
			);
			if (!active.jobId || status.size === null)
				throw new Error("Editor export was unavailable");
			const token = `cap-web-editor://export/${active.jobId}`;
			this.preparedExport = {
				jobId: active.jobId,
				token,
				format: status.format,
				size: status.size,
				mediaMetadata: status.mediaMetadata,
			};
			active.replied = true;
			this.port?.postMessage({ kind: "result", id: message.id, value: token });
		} catch (cause) {
			if (active.jobId) await this.cancelExportJob(active.jobId);
			if (!active.replied)
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						active.canceled || this.disposed
							? "Export cancelled"
							: cause instanceof Error
								? cause.message
								: "Editor export failed",
				});
		} finally {
			if (this.activeExport === active) this.activeExport = null;
			releaseWorkerUse?.();
			active.finish();
		}
	}

	private async handleShareExport(message: BridgeRequest) {
		const prepared = this.preparedExport;
		const [projectPath, mode, channel, organizationId] = message.args;
		const channelId = exportChannelId(channel);
		if (
			!prepared ||
			prepared.format !== "Mp4" ||
			!prepared.mediaMetadata ||
			projectPath !== this.editorPath ||
			channelId === null ||
			!(
				mode === "Reupload" ||
				(typeof mode === "object" && mode !== null && "Initial" in mode)
			) ||
			(organizationId !== null && typeof organizationId !== "string") ||
			this.activeShare
		) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Rendered recording is unavailable for sharing",
			});
			return;
		}
		const controller = new AbortController();
		this.activeShare = controller;
		try {
			if (
				prepared.mediaMetadata.duration >= 300 &&
				!(await this.currentPlan())
			) {
				throw new Error(
					"Cap Pro is required to share recordings longer than 5 minutes",
				);
			}
			await uploadWebEditorExport(
				this.videoId,
				this.sessionId,
				prepared.jobId,
				prepared.size,
				prepared.mediaMetadata,
				controller.signal,
				(progress) => {
					this.port?.postMessage({
						kind: "channel",
						id: channelId,
						value: { progress: progress.fraction },
					});
				},
			);
			if (controller.signal.aborted || this.disposed)
				throw new Error("Recording upload was canceled");
			const link = new URL(
				`/s/${encodeURIComponent(this.videoId)}`,
				window.location.origin,
			).toString();
			this.port?.postMessage({
				kind: "result",
				id: message.id,
				value: { Success: link },
			});
		} catch (cause) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error:
					cause instanceof Error ? cause.message : "Recording upload failed",
			});
		} finally {
			await this.cancelExportJob(prepared.jobId);
			if (this.preparedExport === prepared) this.preparedExport = null;
			if (this.activeShare === controller) this.activeShare = null;
		}
	}

	private async handleAssetImport(
		message: BridgeRequest,
		kind: EditorAssetKind,
		pathOnly = false,
	) {
		let active = false;
		let releaseWorkerUse: (() => void) | null = null;
		try {
			releaseWorkerUse = await this.ensureWorkerSession();
			this.activeAssetImports++;
			active = true;
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Selected media file is invalid");
			const extension =
				/\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
			const contentType =
				kind === "audio"
					? AUDIO_CONTENT_TYPES[extension]
					: IMAGE_CONTENT_TYPES[extension];
			if (
				!contentType ||
				file.size < 1 ||
				file.size > (kind === "audio" ? 32 : 64) * 1024 * 1024
			) {
				throw new Error(`Unsupported ${kind} file or file is too large`);
			}
			const assetPath = `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/assets`;
			const metadata = {
				kind,
				videoId: this.videoId,
				fileName: pathOnly
					? `current-desktop-background.${extension === "jpeg" ? "jpg" : extension}`
					: file.name,
				size: file.size,
				contentType,
			};
			const preparation = await fetch(assetPath, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
				signal: this.controller.signal,
			});
			if (!preparation.ok)
				throw new Error(
					`${kind === "audio" ? "Audio" : "Image"} upload could not start`,
				);
			const prepared: unknown = await preparation.json();
			if (!isEditorAssetPreparation(prepared)) {
				throw new Error("Editor upload target was invalid");
			}
			const expectedPath =
				kind === "audio" ? AUDIO_ASSET_PATH : IMAGE_ASSET_PATH;
			const expectedKey =
				kind === "audio"
					? `${this.userId}/${this.videoId}/editor-assets/${prepared.path.slice("assets/audio/".length)}`
					: `${this.userId}/${this.videoId}/editor-assets/images/${prepared.path.slice("content/images/".length)}`;
			if (prepared.key !== expectedKey || !expectedPath.test(prepared.path)) {
				throw new Error("Editor upload identity was invalid");
			}
			const uploadUrl = new URL(prepared.upload.url);
			if (
				(uploadUrl.protocol !== "https:" &&
					!(
						uploadUrl.protocol === "http:" &&
						["localhost", "127.0.0.1"].includes(uploadUrl.hostname)
					)) ||
				uploadUrl.username ||
				uploadUrl.password
			) {
				throw new Error("Editor upload URL was invalid");
			}
			const uploadHeaders = new Headers(prepared.upload.headers);
			if (prepared.upload.type === "driveResumable") {
				uploadHeaders.set(
					"Content-Range",
					`bytes 0-${file.size - 1}/${file.size}`,
				);
			}
			const uploaded = await fetch(uploadUrl, {
				method: "PUT",
				headers: uploadHeaders,
				body: file,
				credentials: "omit",
				signal: this.controller.signal,
			});
			if (!uploaded.ok)
				throw new Error(
					`${kind === "audio" ? "Audio" : "Image"} upload failed`,
				);
			const completed = await fetch(assetPath, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...metadata,
					key: prepared.key,
					path: prepared.path,
				}),
				signal: this.controller.signal,
			});
			if (!completed.ok)
				throw new Error(
					`${kind === "audio" ? "Audio" : "Image"} could not be added to the editor`,
				);
			const imported: unknown = await completed.json();
			if (
				typeof imported !== "object" ||
				imported === null ||
				!("path" in imported) ||
				imported.path !== prepared.path ||
				!("name" in imported) ||
				typeof imported.name !== "string" ||
				(kind === "audio"
					? !("duration" in imported) ||
						typeof imported.duration !== "number" ||
						!Number.isFinite(imported.duration) ||
						imported.duration <= 0
					: !("width" in imported) ||
						!("height" in imported) ||
						typeof imported.width !== "number" ||
						typeof imported.height !== "number" ||
						!Number.isInteger(imported.width) ||
						!Number.isInteger(imported.height) ||
						imported.width < 1 ||
						imported.height < 1 ||
						imported.width * imported.height > 16_777_216)
			) {
				throw new Error(`Imported ${kind} response was invalid`);
			}
			this.port?.postMessage({
				kind: "result",
				id: message.id,
				value: pathOnly ? imported.path : imported,
			});
		} catch (cause) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: cause instanceof Error ? cause.message : "Editor import failed",
			});
		} finally {
			if (active) this.activeAssetImports--;
			releaseWorkerUse?.();
		}
	}

	private importVideoFile(file: File) {
		if (this.activeVideoImport)
			throw new Error("Another video is still importing");
		const pending = importWebEditorVideo(
			file,
			this.videoId,
			this.userId,
			this.sessionId,
			this.controller.signal,
			(progress) => {
				this.onImportProgress?.(progress);
				this.port?.postMessage({
					kind: "event",
					name: "editorVideoImportProgress",
					payload: progress,
				});
			},
		);
		this.activeVideoImport = pending;
		return pending.finally(() => {
			if (!this.disposed) this.onImportProgress?.(null);
			if (this.activeVideoImport === pending) this.activeVideoImport = null;
		});
	}

	private async handleVideoImport(message: BridgeRequest) {
		let releaseWorkerUse: (() => void) | null = null;
		try {
			releaseWorkerUse = await this.ensureWorkerSession();
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Selected video file is invalid");
			const imported = await this.importVideoFile(file);
			this.port?.postMessage({
				kind: "result",
				id: message.id,
				value: imported,
			});
		} catch (error) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: error instanceof Error ? error.message : "Video import failed",
			});
		} finally {
			releaseWorkerUse?.();
		}
	}

	async addRecordedClip(
		displayFile: File,
		cameraFile: File | null,
		cameraOffsetMs: number,
	) {
		if (this.disposed) throw new Error("Editor bridge is closed");
		const releaseWorkerUse = await this.ensureWorkerSession();
		this.activeRecordingClipImports++;
		try {
			const imported =
				this.clipImportCache.get(displayFile) ??
				(await this.importVideoFile(displayFile));
			this.clipImportCache.set(displayFile, imported);
			const camera = cameraFile
				? (this.clipImportCache.get(cameraFile) ??
					(await this.importVideoFile(cameraFile)))
				: null;
			if (cameraFile && camera) this.clipImportCache.set(cameraFile, camera);
			const response = await fetch(
				`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/clips`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoId: this.videoId,
						path: imported.path,
						jobId: imported.jobId,
						...(camera
							? {
									camera: {
										path: camera.path,
										jobId: camera.jobId,
										offsetMs: cameraOffsetMs,
									},
								}
							: {}),
					}),
					signal: this.controller.signal,
				},
			);
			if (!response.ok)
				throw new Error(
					response.status === 409
						? "Editor changed while importing the clip. Try again."
						: "Imported clip could not be added to the timeline",
				);
			const value: unknown = await response.json();
			if (
				typeof value !== "object" ||
				value === null ||
				!("count" in value) ||
				value.count !== 1
			) {
				throw new Error("Imported clip registration was invalid");
			}
		} finally {
			this.activeRecordingClipImports--;
			releaseWorkerUse();
		}
	}

	private async handleRecordingClipImport(message: BridgeRequest) {
		let active = false;
		let releaseWorkerUse: (() => void) | null = null;
		try {
			releaseWorkerUse = await this.ensureWorkerSession();
			this.activeRecordingClipImports++;
			active = true;
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Select a Cap recording or MP4 file to import");
			let count = 1;
			if (/\.capbundle$/i.test(file.name)) {
				if (this.activeCapImport) {
					throw new Error("A Cap recording is already importing");
				}
				const pending = importWebEditorCap(
					file,
					this.videoId,
					this.userId,
					this.sessionId,
					this.controller.signal,
					(progress) => this.onImportProgress?.(progress),
				);
				this.activeCapImport = pending;
				let imported: WebEditorImportedCap;
				try {
					imported = await pending;
				} finally {
					if (this.activeCapImport === pending) this.activeCapImport = null;
					this.onImportProgress?.(null);
				}
				const response = await fetch(
					`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/cap-imports`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							videoId: this.videoId,
							path: imported.path,
							jobId: imported.jobId,
						}),
						signal: this.controller.signal,
					},
				);
				if (!response.ok) {
					throw new Error(
						response.status === 409
							? "Editor changed while importing the Cap recording. Try again."
							: "Cap recording could not be saved in the editor",
					);
				}
				const result: unknown = await response.json();
				if (
					typeof result !== "object" ||
					result === null ||
					!("count" in result) ||
					result.count !== imported.clipCount
				) {
					throw new Error("Cap recording import count was invalid");
				}
				count = imported.clipCount;
			} else if (/\.mp4$/i.test(file.name)) {
				await this.addRecordedClip(file, null, 0);
			} else {
				throw new Error("Select a Cap recording or MP4 file to import");
			}
			this.port?.postMessage({ kind: "result", id: message.id, value: count });
			if (this.onImportNeedsReload) {
				void this.onImportNeedsReload().catch((error) =>
					this.onFailure(
						error instanceof Error ? error : new Error(String(error)),
					),
				);
			}
		} catch (error) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: error instanceof Error ? error.message : "Clip import failed",
			});
		} finally {
			if (active) this.activeRecordingClipImports--;
			releaseWorkerUse?.();
		}
	}

	private async handleCaptionTranscription(message: BridgeRequest) {
		if (!(await this.currentPlan())) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Cap Pro is required for web editor captions",
			});
			return;
		}
		if (
			message.args[0] !== this.editorPath ||
			message.args.length !== 4 ||
			message.args.slice(1).some((value) => typeof value !== "string") ||
			!isAiGenerationLanguage(message.args[2])
		) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Caption transcription request was invalid",
			});
			return;
		}
		const language = message.args[2];
		if (this.activeCaptions && this.activeCaptions.language !== language) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error: "Caption transcription is already running in another language",
			});
			return;
		}
		if (!this.activeCaptions) {
			const releaseWorkerUse = await this.ensureWorkerSession();
			const pending = generateWebEditorCaptions(
				this.videoId,
				this.sessionId,
				this.controller.signal,
				language,
			);
			this.activeCaptions = { language, promise: pending };
			void pending.then(
				() => {
					if (this.activeCaptions?.promise === pending)
						this.activeCaptions = null;
					releaseWorkerUse();
				},
				() => {
					if (this.activeCaptions?.promise === pending)
						this.activeCaptions = null;
					releaseWorkerUse();
				},
			);
		}
		try {
			const captions = await this.activeCaptions.promise;
			this.port?.postMessage({
				kind: "result",
				id: message.id,
				value: captions,
			});
		} catch (cause) {
			this.port?.postMessage({
				kind: "error",
				id: message.id,
				error:
					cause instanceof Error
						? cause.message
						: "Caption transcription failed",
			});
		}
	}

	async connect(iframe: HTMLIFrameElement) {
		if (this.disposed) throw new Error("Editor bridge is closed");
		if (!iframe.contentWindow) throw new Error("Editor frame is unavailable");
		if (!this.browserOnly) {
			const tickets = await this.tickets();
			if (this.disposed) throw new Error("Editor bridge is closed");
			const opened = await Promise.allSettled([
				openSocket(tickets.commands, this.controller.signal),
				openSocket(tickets.events, this.controller.signal),
				openSocket(tickets.audio, this.controller.signal),
			]);
			if (
				this.disposed ||
				opened.some((result) => result.status === "rejected")
			) {
				for (const result of opened) {
					if (result.status === "fulfilled") result.value.close();
				}
				throw new Error(
					this.disposed
						? "Editor bridge is closed"
						: "Editor sockets could not connect",
				);
			}
			this.commands = opened[0].status === "fulfilled" ? opened[0].value : null;
			this.events = opened[1].status === "fulfilled" ? opened[1].value : null;
			this.audio = opened[2].status === "fulfilled" ? opened[2].value : null;
			if (!this.commands || !this.events || !this.audio) {
				throw new Error("Editor sockets are unavailable");
			}
		}
		const channel = new MessageChannel();
		this.port = channel.port1;
		let settleMount: (error?: Error) => void = () => undefined;
		const mounted = new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer = 0;
			const canceled = () => finish(new Error("Editor bridge is closed"));
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				this.controller.signal.removeEventListener("abort", canceled);
				if (error) reject(error);
				else resolve();
			};
			settleMount = finish;
			timer = window.setTimeout(
				() => finish(new Error("Editor took too long to load")),
				30_000,
			);
			this.controller.signal.addEventListener("abort", canceled, {
				once: true,
			});
			if (this.controller.signal.aborted) canceled();
		});
		this.port.onmessage = (event: MessageEvent<unknown>) => {
			if (isEditorMountReply(event.data)) {
				settleMount(
					event.data.status === "ready"
						? undefined
						: new Error("Editor could not load"),
				);
				return;
			}
			if (isBridgeRequest(event.data)) void this.handleRequest(event.data);
		};
		this.port.start();
		if (this.commands)
			this.commands.onmessage = (event: MessageEvent<unknown>) => {
				if (typeof event.data !== "string") return;
				let value: unknown;
				try {
					value = JSON.parse(event.data);
				} catch {
					this.fail(new Error("Editor command response was invalid"));
					return;
				}
				if (!isCommandReply(value)) return;
				if (value.kind === "channel") {
					this.port?.postMessage(value);
					return;
				}
				const isMeta = this.pendingMetaRequests.delete(value.id);
				const frames = this.frameTickets.get(value.id);
				this.frameTickets.delete(value.id);
				if (frames && value.kind === "result") {
					if (
						typeof value.value !== "object" ||
						value.value === null ||
						Array.isArray(value.value)
					) {
						this.fail(new Error("Editor instance response was invalid"));
						return;
					}
					this.port?.postMessage({
						kind: "result",
						id: value.id,
						value: {
							...value.value,
							framesSocketUrl: frames.url,
							frameSocketTicket: frames.ticket,
						},
					});
				} else if (
					isMeta &&
					value.kind === "result" &&
					typeof value.value === "object" &&
					value.value !== null &&
					!Array.isArray(value.value)
				) {
					const link = new URL(
						`/s/${encodeURIComponent(this.videoId)}`,
						window.location.origin,
					).toString();
					this.port?.postMessage({
						...value,
						value: {
							...value.value,
							sharing: { id: this.videoId, link },
						},
					});
				} else {
					this.port?.postMessage(value);
				}
			};
		if (this.events)
			this.events.onmessage = (event: MessageEvent<unknown>) => {
				if (typeof event.data !== "string") return;
				let value: unknown;
				try {
					value = JSON.parse(event.data);
				} catch {
					return;
				}
				if (
					typeof value !== "object" ||
					value === null ||
					!("event" in value) ||
					!("payload" in value) ||
					typeof value.event !== "string"
				) {
					return;
				}
				let payload = value.payload;
				if (
					value.event === "frameLayoutEvent" &&
					typeof payload === "object" &&
					payload !== null &&
					"outputWidth" in payload &&
					"outputHeight" in payload
				) {
					payload = {
						...payload,
						output_width: payload.outputWidth,
						output_height: payload.outputHeight,
					};
				}
				this.port?.postMessage({ kind: "event", name: value.event, payload });
			};
		if (this.audio) this.audio.binaryType = "arraybuffer";
		if (this.audio)
			this.audio.onmessage = (event: MessageEvent<unknown>) => {
				if (event.data instanceof ArrayBuffer) {
					this.port?.postMessage({ kind: "audio", packet: event.data }, [
						event.data,
					]);
				}
			};
		for (const socket of [this.commands, this.events, this.audio]) {
			if (socket) {
				socket.onclose = () =>
					this.fail(new Error("Editor session disconnected"));
			}
		}
		try {
			iframe.contentWindow.postMessage(
				{
					kind: "cap-editor-connect",
					version: 1,
					videoId: this.videoId,
					userId: this.userId,
					captionsEnabled: this.captionsEnabled,
					assetBase: this.browserOnly
						? `/api/editor/videos/${encodeURIComponent(this.videoId)}/file?raw=1`
						: `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/file?videoId=${encodeURIComponent(this.videoId)}`,
					...(this.browserOnly
						? { browserSessionId: this.browserSessionId }
						: {}),
				},
				window.location.origin,
				[channel.port2],
			);
		} catch {
			settleMount(new Error("Editor frame could not connect"));
		}
		await mounted;
		if (typeof window.addEventListener === "function") {
			window.addEventListener("focus", this.refreshCaptionPlanFromPage, {
				signal: this.controller.signal,
			});
		}
		if (
			typeof document !== "undefined" &&
			typeof document.addEventListener === "function"
		) {
			document.addEventListener(
				"visibilitychange",
				this.refreshCaptionPlanFromVisibility,
				{ signal: this.controller.signal },
			);
		}
	}

	private async handleRequest(message: BridgeRequest) {
		if (!this.port || this.disposed) return;
		if (
			this.browserOnly &&
			message.kind === "invoke" &&
			(message.name === "generateExportPreviewFast" ||
				message.name === "getExportEstimates" ||
				message.name === "cancelExportEstimates")
		) {
			await this.handleBrowserWorkerCommand(message);
			return;
		}
		if (message.kind === "invoke" && message.name === "tauri:webEditorSave") {
			let releaseWorkerUse: () => void = () => undefined;
			try {
				// The render is built from the stored project, so edits still being
				// written must land before the worker copy is (re)prepared from it.
				await Promise.allSettled([...this.pendingConfigWrites]);
				// The render project is built from the worker's prepared copy of
				// the recording, so a browser-only editor starts one first.
				releaseWorkerUse = await this.ensureWorkerSession();
				const response = await fetch(
					`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/save`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ videoId: this.videoId }),
						cache: "no-store",
						signal: this.controller.signal,
					},
				);
				if (!response.ok) throw new Error(webEditorSaveError(response.status));
				const saved: unknown = await response.json();
				if (
					typeof saved !== "object" ||
					saved === null ||
					!("shareUrl" in saved) ||
					typeof saved.shareUrl !== "string"
				) {
					throw new Error("Save response was invalid");
				}
				this.port?.postMessage({
					kind: "result",
					id: message.id,
					value: { shareUrl: saved.shareUrl },
				});
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error: cause instanceof Error ? cause.message : "Save failed",
				});
			} finally {
				releaseWorkerUse();
			}
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "tauri:webEditorSaveDefaultStyle"
		) {
			try {
				const request = message.args[0];
				if (
					message.args.length !== 1 ||
					typeof request !== "object" ||
					request === null ||
					!("config" in request)
				)
					throw new Error("Default style request was invalid");
				const response = await fetch("/api/editor/preferences/default-style", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ config: request.config }),
					cache: "no-store",
					signal: this.controller.signal,
				});
				if (!response.ok)
					throw new Error("Default style could not be saved. Try again.");
				this.port?.postMessage({ kind: "result", id: message.id, value: null });
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Default style could not be saved. Try again.",
				});
			}
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "tauri:webEditorBackgroundExport"
		) {
			let releaseWorkerUse: () => void = () => undefined;
			try {
				const settings = message.args[0];
				if (
					message.args.length !== 1 ||
					typeof settings !== "object" ||
					settings === null
				)
					throw new Error("Background export request was invalid");
				await Promise.allSettled([...this.pendingConfigWrites]);
				releaseWorkerUse = await this.ensureWorkerSession();
				const response = await fetch(
					`/api/editor/sessions/${encodeURIComponent(this.sessionId)}/background-exports`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ videoId: this.videoId, ...settings }),
						cache: "no-store",
						signal: this.controller.signal,
					},
				);
				if (!response.ok)
					throw new Error(webEditorBackgroundExportError(response.status));
				const started: unknown = await response.json();
				if (
					typeof started !== "object" ||
					started === null ||
					!("downloadUrl" in started) ||
					typeof started.downloadUrl !== "string"
				) {
					throw new Error("Background export response was invalid");
				}
				this.port?.postMessage({
					kind: "result",
					id: message.id,
					value: { downloadUrl: started.downloadUrl },
				});
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Background export could not start",
				});
			} finally {
				releaseWorkerUse();
			}
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "tauri:webEditorSaveStatus"
		) {
			try {
				const response = await fetch(
					`/api/videos/${encodeURIComponent(this.videoId)}/render-status`,
					{ cache: "no-store", signal: this.controller.signal },
				);
				if (!response.ok) throw new Error("Save status is unavailable");
				this.port?.postMessage({
					kind: "result",
					id: message.id,
					value: await response.json(),
				});
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Save status is unavailable",
				});
			}
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "tauri:webEditorStoredDesktopBackground"
		) {
			try {
				if (message.args.length !== 1 || message.args[0] !== undefined)
					throw new Error("Stored wallpaper request was invalid");
				const response = await fetch(
					this.browserOnly
						? `/api/editor/videos/${encodeURIComponent(this.videoId)}/assets`
						: `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/assets?videoId=${encodeURIComponent(this.videoId)}`,
					{ cache: "no-store", signal: this.controller.signal },
				);
				if (!response.ok) throw new Error("Stored wallpaper is unavailable");
				const stored: unknown = await response.json();
				if (
					typeof stored !== "object" ||
					stored === null ||
					!("path" in stored) ||
					(stored.path !== null &&
						(typeof stored.path !== "string" ||
							!IMAGE_ASSET_PATH.test(stored.path)))
				) {
					throw new Error("Stored wallpaper response was invalid");
				}
				this.port?.postMessage({
					kind: "result",
					id: message.id,
					value: stored.path,
				});
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Stored wallpaper is unavailable",
				});
			}
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "tauri:download_editor_bundle"
		) {
			await this.handleProjectBundleDownload(message);
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "checkUpgradedAndUpdate"
		) {
			try {
				if (message.args.length !== 0)
					throw new Error("Recording plan request was invalid");
				this.port.postMessage({
					kind: "result",
					id: message.id,
					value: await this.currentPlan(),
				});
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Recording plan is unavailable",
				});
			}
			return;
		}
		if (message.kind === "invoke" && message.name === "showWindow") {
			if (
				message.args.length !== 1 ||
				message.args[0] !== "Upgrade" ||
				!this.onUpgrade
			) {
				this.port.postMessage({
					kind: "error",
					id: message.id,
					error: "Editor window is unavailable",
				});
				return;
			}
			this.onUpgrade();
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (message.kind === "invoke" && message.name === "importAudioTrackFile") {
			await this.handleAssetImport(message, "audio");
			return;
		}
		if (message.kind === "invoke" && message.name === "importEditorImage") {
			await this.handleAssetImport(message, "image");
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "importCurrentDesktopBackground"
		) {
			await this.handleAssetImport(message, "image", true);
			return;
		}
		if (message.kind === "invoke" && message.name === "importEditorVideo") {
			await this.handleVideoImport(message);
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "addExistingRecordingToEditor"
		) {
			await this.handleRecordingClipImport(message);
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "openEditorRecordingMain"
		) {
			if (
				message.args.length !== 1 ||
				message.args[0] !== this.editorPath ||
				!this.onOpenClipRecorder
			) {
				this.port.postMessage({
					kind: "error",
					id: message.id,
					error: "Editor recorder is unavailable",
				});
				return;
			}
			this.onOpenClipRecorder();
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (message.kind === "invoke" && message.name === "transcribeAudio") {
			await this.handleCaptionTranscription(message);
			return;
		}
		if (message.kind === "invoke" && message.name === "setPrettyName") {
			try {
				const prettyName = message.args[0];
				if (!validWebEditorTitle(prettyName))
					throw new Error("Recording title must be 5 to 100 characters");
				const response = await fetch(
					this.browserOnly
						? `/api/editor/videos/${encodeURIComponent(this.videoId)}/title`
						: `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/meta`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...(this.browserOnly ? {} : { videoId: this.videoId }),
							prettyName,
						}),
					},
				);
				if (!response.ok)
					throw new Error(
						response.status === 409
							? "Recording title changed in another editor"
							: "Recording title could not be saved",
					);
				this.port?.postMessage({ kind: "result", id: message.id, value: null });
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Recording title could not be saved",
				});
			}
			return;
		}
		if (message.kind === "invoke" && message.name === "editorDeleteProject") {
			try {
				if (this.activeExport || this.activeShare)
					throw new Error(
						"Finish or cancel the current export before deleting",
					);
				const response = await fetch(
					`/api/video/delete?videoId=${encodeURIComponent(this.videoId)}`,
					{
						method: "DELETE",
						cache: "no-store",
						signal: this.controller.signal,
					},
				);
				if (!response.ok)
					throw new Error(
						response.status === 404
							? "Recording is no longer available"
							: "Recording could not be deleted",
					);
				this.port?.postMessage({ kind: "result", id: message.id, value: null });
				this.onClose("deleted");
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Recording could not be deleted",
				});
			}
			return;
		}
		if (message.kind === "invoke" && message.name === "exportVideoToFile") {
			await this.handleExport(message);
			return;
		}
		if (message.kind === "invoke" && message.name === "exportVideo") {
			await this.handleRenderExport(message);
			return;
		}
		if (message.kind === "invoke" && message.name === "uploadExportedVideo") {
			await this.handleShareExport(message);
			return;
		}
		if (
			message.kind === "invoke" &&
			(message.name === "beginExportSession" ||
				message.name === "endExportSession")
		) {
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (message.kind === "invoke" && message.name === "globalMessageDialog") {
			const detail = message.args[0];
			window.alert(
				typeof detail === "string" ? detail : "Editor action failed",
			);
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (
			message.kind === "invoke" &&
			message.name === "cancelCurrentWindowExports"
		) {
			const pending: Promise<void>[] = [];
			if (this.canceledExportCleanup) pending.push(this.canceledExportCleanup);
			if (this.activeExport) {
				const active = this.activeExport;
				active.canceled = true;
				active.controller.abort();
				if (!active.replied) {
					active.replied = true;
					this.port.postMessage({
						kind: "error",
						id: active.requestId,
						error: "Export cancelled",
					});
				}
				pending.push(active.finished);
			}
			this.activeShare?.abort();
			if (this.preparedExport) {
				pending.push(this.cancelExportJob(this.preparedExport.jobId));
				this.preparedExport = null;
			}
			if (pending.length > 0) {
				const cleanup = Promise.all(pending).then(() => undefined);
				this.canceledExportCleanup = cleanup;
				void cleanup.then(() => {
					if (this.canceledExportCleanup === cleanup)
						this.canceledExportCleanup = null;
				});
			}
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (message.kind === "emit" && message.name !== "renderFrameEvent") {
			this.port.postMessage({
				kind: "event",
				name: message.name,
				payload: message.args[0],
			});
			this.port.postMessage({ kind: "result", id: message.id, value: null });
			if (message.name === "editor-close-approved") this.onClose();
			return;
		}
		if (message.kind === "invoke" && message.name === "setProjectConfig") {
			try {
				const config = message.args[0];
				const preserveExistingPaidCaptions =
					message.args.length === 2 && message.args[1] === true;
				if (
					(message.args.length !== 1 && !preserveExistingPaidCaptions) ||
					typeof config !== "object" ||
					config === null ||
					Array.isArray(config)
				) {
					throw new Error("Editor project configuration was invalid");
				}
				const body = JSON.stringify({
					...(this.browserOnly ? {} : { videoId: this.videoId }),
					config,
					...(preserveExistingPaidCaptions
						? { preserveExistingPaidCaptions: true }
						: {}),
					...(this.getProjectSavedAt
						? { expectedSavedAt: this.getProjectSavedAt() }
						: {}),
				});
				const request = fetch(
					this.browserOnly
						? `/api/editor/videos/${encodeURIComponent(this.videoId)}/config`
						: `/api/editor/sessions/${encodeURIComponent(this.sessionId)}/config`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body,
						keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024,
					},
				);
				this.pendingConfigWrites.add(request);
				void request
					.finally(() => this.pendingConfigWrites.delete(request))
					.catch(() => undefined);
				const response = await request;
				if (!response.ok)
					throw new Error(
						response.status === 409
							? "webCaptionRef" in config
								? "Caption payload cache is unavailable"
								: "Editor changed in another tab or caption data is unavailable. Reload to continue."
							: "Editor edits could not be saved",
					);
				const saved: unknown = await response.json().catch(() => null);
				if (
					typeof saved === "object" &&
					saved !== null &&
					"savedAt" in saved &&
					typeof saved.savedAt === "string"
				) {
					this.onProjectSaved?.(saved.savedAt);
				}
				this.port?.postMessage({ kind: "result", id: message.id, value: null });
			} catch (cause) {
				this.port?.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Editor edits could not be saved",
				});
			}
			return;
		}
		if (message.name === "createEditorInstance") {
			try {
				const tickets = await this.tickets();
				if (this.disposed) return;
				this.frameTickets.set(message.id, tickets.frames);
			} catch (cause) {
				this.port.postMessage({
					kind: "error",
					id: message.id,
					error:
						cause instanceof Error
							? cause.message
							: "Editor frame socket ticket is unavailable",
				});
				return;
			}
		}
		if (!this.commands || this.commands.readyState !== WebSocket.OPEN) {
			this.port.postMessage({
				kind: "error",
				id: message.id,
				error: this.browserOnly
					? `Browser editor command is unavailable: ${message.name}`
					: "Editor command socket is disconnected",
			});
			return;
		}
		try {
			if (
				message.name === "getEditorMeta" ||
				message.name === "getRecordingMetaByPath"
			) {
				this.pendingMetaRequests.add(message.id);
			}
			this.commands.send(JSON.stringify(message));
		} catch (cause) {
			this.pendingMetaRequests.delete(message.id);
			this.port.postMessage({
				kind: "error",
				id: message.id,
				error: cause instanceof Error ? cause.message : "Editor command failed",
			});
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.closeWorkerCommandSocket();
		this.cancelWorkerIdleRelease();
		if (this.activeExport) {
			this.activeExport.canceled = true;
			this.activeExport.controller.abort();
		}
		this.controller.abort();
		this.workerDownloadFrame?.remove();
		this.workerDownloadFrame = null;
		if (this.browserOnly && this.workerSessionId) {
			void fetch(
				`/api/editor/sessions/${encodeURIComponent(this.workerSessionId)}?videoId=${encodeURIComponent(this.videoId)}`,
				{ method: "DELETE", keepalive: true },
			).catch(() => undefined);
		}
		this.port?.close();
		this.port = null;
		for (const socket of [this.commands, this.events, this.audio]) {
			if (socket) {
				socket.onclose = null;
				socket.close();
			}
		}
		this.commands = null;
		this.events = null;
		this.audio = null;
		this.frameTickets.clear();
		this.pendingMetaRequests.clear();
	}
}

function webEditorSaveError(status: number) {
	if (status === 400)
		return "This project uses something Save can't render yet. Use Export instead.";
	if (status === 403)
		return "Saving recordings of 5 minutes or longer, or with captions, needs Cap Pro";
	if (status === 404) return "This recording is no longer available";
	return "Save is unavailable right now. Try again, or use Export.";
}

function webEditorBackgroundExportError(status: number) {
	if (status === 400)
		return "This project uses something background export can't render yet. Export on this device instead.";
	if (status === 403)
		return "Exporting recordings of 5 minutes or longer, or with captions, in the background needs Cap Pro";
	if (status === 404) return "This recording is no longer available";
	return "Background export is unavailable right now. Try again, or export on this device.";
}
