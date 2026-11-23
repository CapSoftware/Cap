import {
	type AiGenerationLanguage,
	isAiGenerationLanguage,
} from "@cap/web-domain/src/Language";
import {
	uploadWebEditorAsset,
	type WebEditorImportedAsset,
} from "@/lib/editor-asset-upload-client";
import {
	generateWebEditorCaptions,
	type WebEditorCaptionData,
} from "@/lib/editor-caption-client";
import {
	uploadWebEditorFile,
	type WebEditorExportMetadata,
} from "@/lib/editor-export-upload-client";
import { validWebEditorTitle } from "@/lib/editor-recording-title";
import {
	CAP_BUNDLE_UNSUPPORTED,
	importWebEditorVideo,
	isCapBundleFile,
	registerWebEditorClip,
	type WebEditorImportedVideo,
	type WebEditorVideoImportProgress,
} from "@/lib/editor-video-import-client";
import { announceShareVideoUpdate } from "@/lib/share-video-updates";
import {
	type ClipRecorderContext,
	parseClipRecorderContext,
} from "./clip-recorder-context";

type BridgeRequest = {
	kind: "invoke" | "emit";
	id: number;
	name: string;
	args: unknown[];
};

type SaveStart =
	| { renderer: "farm"; shareUrl: string }
	| { renderer: "browser"; reason: string };

const CHANNEL_PATTERN = /^__CHANNEL__:(\d+)$/;
const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
const SAVE_UNREACHABLE =
	"Couldn't reach Cap. Check your connection and try again.";
const BROWSER_SAVE_REPORT_MS = 3000;
const UNSUPPORTED_ON_WEB: Record<string, string> = {
	exportVideo:
		"Sharing a rendered export isn't available on the web. Use Save.",
	uploadExportedVideo:
		"Sharing a rendered export isn't available on the web. Use Save.",
	"tauri:download_editor_bundle":
		"Project downloads aren't available on the web yet.",
	"tauri:webEditorBackgroundExport":
		"Background exports aren't available yet. Export on this device instead.",
	"tauri:webEditorSaveOnWorker":
		"Save couldn't finish on Cap's servers. Try again.",
};

export type EditorHostOptions = {
	videoId: string;
	userId: string;
	captionsEnabled: boolean;
	onClose: (reason?: "deleted") => void;
	onFailure: (error: Error) => void;
	onImportProgress?: (progress: WebEditorVideoImportProgress | null) => void;
	onOpenClipRecorder?: (context: ClipRecorderContext | null) => void;
	onImportNeedsReload?: () => Promise<void>;
	onUpgrade?: () => void;
	onProjectSaved?: (savedAt: string) => void;
	getProjectSavedAt?: () => string | null;
	getUnsavedProject?: () => Record<string, unknown> | null;
};

function exportChannelId(value: unknown) {
	if (typeof value !== "string") return null;
	const match = CHANNEL_PATTERN.exec(value);
	if (!match) return null;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) ? id : null;
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

function isExportMetadata(value: unknown): value is WebEditorExportMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		"duration" in value &&
		"width" in value &&
		"height" in value &&
		"fps" in value &&
		[value.duration, value.width, value.height, value.fps].every(
			(number) => typeof number === "number" && Number.isFinite(number),
		)
	);
}

function localExportUnavailableMessage(settings: unknown) {
	const format =
		typeof settings === "object" && settings !== null && "format" in settings
			? settings.format
			: null;
	const optimize =
		typeof settings === "object" &&
		settings !== null &&
		"optimize_filesize" in settings &&
		settings.optimize_filesize === true;
	if (format === "Gif") return "GIF export isn't available on the web yet.";
	if (optimize)
		return "Optimize file size isn't available on the web yet. Turn it off to export.";
	if (format === "Mov")
		return "Cursor-only export isn't available on the web yet.";
	return "This browser can't render the video. Try Chrome or Edge.";
}

class SaveRejected extends Error {}

export function webEditorSaveError(status: number) {
	if (status === 409) return "Your share link already shows this version";
	if (status === 403)
		return "Saving recordings of 5 minutes or longer, or with captions, needs Cap Pro";
	if (status === 404) return "This recording is no longer available";
	return "Save is unavailable right now. Try again, or use Download.";
}

export class EditorHostBridge {
	private disposed = false;
	private readonly controller = new AbortController();
	private readonly videoId: string;
	private readonly sessionId: string;
	private readonly editorPath: string;
	private captionsEnabled: boolean;
	private port: MessagePort | null = null;
	private readonly pendingConfigWrites = new Set<Promise<unknown>>();
	private saveStatusRevision: string | null | undefined;
	private activeSavePublish: AbortController | null = null;
	private browserSave: { saveId: Promise<string | null> } | null = null;
	private browserSaveReportedAt = 0;
	private browserSaveReports: Promise<void> = Promise.resolve();
	private activeCaptions: {
		language: AiGenerationLanguage;
		promise: Promise<WebEditorCaptionData>;
	} | null = null;
	private activeVideoImport: Promise<WebEditorImportedVideo> | null = null;
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

	constructor(private readonly options: EditorHostOptions) {
		this.videoId = options.videoId;
		this.captionsEnabled = options.captionsEnabled;
		this.sessionId = `browser-${options.videoId}`;
		this.editorPath = `cap-web-editor://session/${this.sessionId}`;
	}

	private get videoPath() {
		return `/api/editor/videos/${encodeURIComponent(this.videoId)}`;
	}

	private reply(id: number, value: unknown) {
		this.port?.postMessage({ kind: "result", id, value });
	}

	private replyError(id: number, cause: unknown, fallback: string) {
		this.port?.postMessage({
			kind: "error",
			id,
			error: cause instanceof Error && cause.message ? cause.message : fallback,
		});
	}

	private async currentPlan() {
		const requestSequence = ++this.planRequestSequence;
		this.activePlanRequests++;
		try {
			const response = await fetch(`${this.videoPath}/plan`, {
				cache: "no-store",
				signal: this.controller.signal,
			});
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

	async startSave(): Promise<SaveStart> {
		// The render is built from the stored project, so edits still being
		// written must land first.
		await Promise.allSettled([...this.pendingConfigWrites]);
		const savePath = `${this.videoPath}/save`;
		let target: Response;
		try {
			target = await fetch(savePath, {
				cache: "no-store",
				signal: this.controller.signal,
			});
		} catch {
			throw new Error(SAVE_UNREACHABLE);
		}
		if (!target.ok) throw new Error(webEditorSaveError(target.status));
		const plan: unknown = await target.json();
		if (
			typeof plan !== "object" ||
			plan === null ||
			!("renderer" in plan) ||
			(plan.renderer !== "farm" && plan.renderer !== "browser")
		) {
			throw new Error("Save response was invalid");
		}
		const reason =
			"reason" in plan && typeof plan.reason === "string" ? plan.reason : null;
		if (plan.renderer === "browser") {
			return {
				renderer: "browser",
				reason: reason ?? "The render farm is unavailable",
			};
		}
		try {
			const response = await fetch(savePath, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
				cache: "no-store",
				signal: this.controller.signal,
			});
			if ([403, 404, 409].includes(response.status))
				throw new SaveRejected(webEditorSaveError(response.status));
			if (!response.ok) {
				return {
					renderer: "browser",
					reason: `The render farm could not start the save (${response.status})`,
				};
			}
			const saved: unknown = await response.json();
			if (
				typeof saved !== "object" ||
				saved === null ||
				!("shareUrl" in saved) ||
				typeof saved.shareUrl !== "string"
			) {
				throw new SaveRejected("Save response was invalid");
			}
			return { renderer: "farm", shareUrl: saved.shareUrl };
		} catch (cause) {
			if (cause instanceof SaveRejected || this.disposed) throw cause;
			return {
				renderer: "browser",
				reason:
					cause instanceof Error
						? cause.message
						: "The render farm could not start the save",
			};
		}
	}

	private browserSaveId() {
		if (!this.browserSave) {
			const saveId = fetch(`${this.videoPath}/browser-save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
				cache: "no-store",
			})
				.then(async (response) => {
					if (!response.ok)
						throw new Error(webEditorSaveError(response.status));
					const value: unknown = await response.json();
					return typeof value === "object" &&
						value !== null &&
						"saveId" in value &&
						typeof value.saveId === "string"
						? value.saveId
						: null;
				})
				.catch(() => null);
			this.browserSave = { saveId };
		}
		return this.browserSave.saveId;
	}

	private putBrowserSave(
		saveId: string,
		body:
			| { progress: number }
			| { status: "published" }
			| { status: "error"; error: string },
	) {
		return fetch(`${this.videoPath}/browser-save`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ saveId, ...body }),
			cache: "no-store",
			keepalive: true,
		}).then(() => undefined);
	}

	// In order, so a late progress report can't reopen a finished Save.
	private queueBrowserSave(task: () => Promise<unknown>) {
		this.browserSaveReports = this.browserSaveReports.then(task).then(
			() => undefined,
			() => undefined,
		);
	}

	reportBrowserSave(progress: number | null, published = false) {
		const now = Date.now();
		if (progress !== null) {
			if (
				this.browserSave &&
				now - this.browserSaveReportedAt < BROWSER_SAVE_REPORT_MS
			)
				return;
			this.browserSaveReportedAt = now;
			const saveId = this.browserSaveId();
			this.queueBrowserSave(async () => {
				const id = await saveId;
				if (id) await this.putBrowserSave(id, { progress });
			});
			return;
		}
		const current = this.browserSave;
		this.browserSave = null;
		this.browserSaveReportedAt = 0;
		if (!current) return;
		this.queueBrowserSave(async () => {
			const id = await current.saveId;
			if (!id) return;
			await this.putBrowserSave(
				id,
				published
					? { status: "published" }
					: { status: "error", error: "Save stopped before it finished" },
			);
		});
	}

	private async publishRenderedSave(message: BridgeRequest) {
		const [file, metadata, channel] = message.args;
		const channelId = exportChannelId(channel);
		if (
			!(file instanceof Blob) ||
			!isExportMetadata(metadata) ||
			this.activeSavePublish
		) {
			this.replyError(
				message.id,
				null,
				"The rendered video could not be published",
			);
			return;
		}
		const controller = new AbortController();
		this.activeSavePublish = controller;
		const keepOpen = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", keepOpen);
		let published = false;
		try {
			const signal = AbortSignal.any([
				controller.signal,
				this.controller.signal,
			]);
			// Registers the Save, which also withdraws a farm render still
			// running for an earlier one so it can't replace this file.
			const saveId = await this.browserSaveId();
			if (!saveId) throw new Error("The rendered video could not be published");
			await uploadWebEditorFile(
				this.videoId,
				saveId,
				file,
				metadata,
				signal,
				(progress) => {
					this.reportBrowserSave(0.9 + progress.fraction * 0.1);
					if (channelId !== null)
						this.port?.postMessage({
							kind: "channel",
							id: channelId,
							value: { stage: "uploading", progress: progress.fraction },
						});
				},
			);
			published = true;
			announceShareVideoUpdate(this.videoId);
			this.reply(message.id, {
				shareUrl: new URL(
					`/s/${encodeURIComponent(this.videoId)}`,
					window.location.origin,
				).toString(),
			});
		} catch (cause) {
			this.replyError(
				message.id,
				this.disposed || controller.signal.aborted
					? new Error("Save was canceled")
					: cause,
				"The rendered video could not be published",
			);
		} finally {
			this.reportBrowserSave(null, published);
			window.removeEventListener("beforeunload", keepOpen);
			if (this.activeSavePublish === controller) this.activeSavePublish = null;
		}
	}

	private async handleSaveStatus(message: BridgeRequest) {
		try {
			const response = await fetch(
				`/api/videos/${encodeURIComponent(this.videoId)}/render-status`,
				{ cache: "no-store", signal: this.controller.signal },
			);
			if (!response.ok) throw new Error("Save status is unavailable");
			const value: unknown = await response.json();
			const revision =
				typeof value === "object" &&
				value !== null &&
				"revision" in value &&
				typeof value.revision === "string"
					? value.revision
					: null;
			if (
				this.saveStatusRevision !== undefined &&
				revision !== this.saveStatusRevision
			)
				announceShareVideoUpdate(this.videoId);
			this.saveStatusRevision = revision;
			this.reply(message.id, value);
		} catch (cause) {
			this.replyError(message.id, cause, "Save status is unavailable");
		}
	}

	private async handleDefaultStyle(message: BridgeRequest) {
		try {
			const request = message.args[0];
			let init: RequestInit = { method: "GET" };
			if (message.name === "tauri:webEditorSaveDefaultStyle") {
				if (
					message.args.length !== 1 ||
					typeof request !== "object" ||
					request === null ||
					!("config" in request)
				)
					throw new Error("Default style request was invalid");
				init =
					request.config === null
						? { method: "DELETE" }
						: {
								method: "PUT",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ config: request.config }),
							};
			}
			const response = await fetch("/api/editor/preferences/default-style", {
				...init,
				cache: "no-store",
				signal: this.controller.signal,
			});
			if (!response.ok)
				throw new Error(
					init.method === "GET"
						? "Default style could not be loaded."
						: "Default style could not be saved. Try again.",
				);
			const body: unknown = await response.json();
			this.reply(
				message.id,
				typeof body === "object" && body !== null && "style" in body
					? body.style
					: null,
			);
		} catch (cause) {
			this.replyError(
				message.id,
				cause,
				"Default style could not be saved. Try again.",
			);
		}
	}

	private async handleStoredDesktopBackground(message: BridgeRequest) {
		try {
			if (message.args.length !== 1 || message.args[0] !== undefined)
				throw new Error("Stored wallpaper request was invalid");
			const response = await fetch(`${this.videoPath}/assets`, {
				cache: "no-store",
				signal: this.controller.signal,
			});
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
			this.reply(message.id, stored.path);
		} catch (cause) {
			this.replyError(message.id, cause, "Stored wallpaper is unavailable");
		}
	}

	private async handleAssetImport(
		message: BridgeRequest,
		kind: "audio" | "image",
		pathOnly = false,
	) {
		try {
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Selected media file is invalid");
			const extension =
				/\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
			const imported: WebEditorImportedAsset = await uploadWebEditorAsset(
				this.videoId,
				kind,
				file,
				this.controller.signal,
				pathOnly
					? `current-desktop-background.${extension === "jpeg" ? "jpg" : extension}`
					: file.name,
			);
			this.reply(message.id, pathOnly ? imported.path : imported);
		} catch (cause) {
			this.replyError(message.id, cause, "Editor import failed");
		}
	}

	private importVideoFile(file: File) {
		if (this.activeVideoImport)
			throw new Error("Another video is still importing");
		const pending = importWebEditorVideo(
			file,
			this.videoId,
			this.controller.signal,
			(progress) => {
				this.options.onImportProgress?.(progress);
				this.port?.postMessage({
					kind: "event",
					name: "editorVideoImportProgress",
					payload: progress,
				});
			},
		);
		this.activeVideoImport = pending;
		return pending.finally(() => {
			if (!this.disposed) this.options.onImportProgress?.(null);
			if (this.activeVideoImport === pending) this.activeVideoImport = null;
		});
	}

	private async handleVideoImport(message: BridgeRequest) {
		try {
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Selected video file is invalid");
			this.reply(message.id, await this.importVideoFile(file));
		} catch (cause) {
			this.replyError(message.id, cause, "Video import failed");
		}
	}

	async addRecordedClip(
		displayFile: File,
		cameraFile: File | null,
		cameraOffsetMs: number,
	) {
		if (this.disposed) throw new Error("Editor bridge is closed");
		const display =
			this.clipImportCache.get(displayFile) ??
			(await this.importVideoFile(displayFile));
		this.clipImportCache.set(displayFile, display);
		const camera = cameraFile
			? (this.clipImportCache.get(cameraFile) ??
				(await this.importVideoFile(cameraFile)))
			: null;
		if (cameraFile && camera) this.clipImportCache.set(cameraFile, camera);
		await Promise.allSettled([...this.pendingConfigWrites]);
		await registerWebEditorClip(
			this.videoId,
			display,
			camera ? { video: camera, offsetMs: cameraOffsetMs } : null,
			this.controller.signal,
			this.options.getProjectSavedAt?.()
				? null
				: (this.options.getUnsavedProject?.() ?? null),
		);
	}

	private async handleRecordingClipImport(message: BridgeRequest) {
		try {
			const file = message.args[0];
			if (!(file instanceof File))
				throw new Error("Select a video file to import");
			if (isCapBundleFile(file)) throw new Error(CAP_BUNDLE_UNSUPPORTED);
			if (
				!file.type.startsWith("video/") &&
				!/\.(mp4|webm)$/i.test(file.name)
			) {
				throw new Error("Select an MP4 or WebM video to import");
			}
			await this.addRecordedClip(file, null, 0);
			this.reply(message.id, 1);
			const reload = this.options.onImportNeedsReload;
			if (reload) {
				void reload().catch((error) =>
					this.options.onFailure(
						error instanceof Error ? error : new Error(String(error)),
					),
				);
			}
		} catch (cause) {
			this.replyError(message.id, cause, "Clip import failed");
		}
	}

	private async handleCaptionTranscription(message: BridgeRequest) {
		let pro: boolean;
		try {
			pro = await this.currentPlan();
		} catch (cause) {
			this.replyError(message.id, cause, "Caption transcription failed");
			return;
		}
		if (!pro) {
			this.replyError(
				message.id,
				null,
				"Cap Pro is required for web editor captions",
			);
			return;
		}
		if (
			message.args[0] !== this.editorPath ||
			message.args.length !== 4 ||
			message.args.slice(1).some((value) => typeof value !== "string") ||
			!isAiGenerationLanguage(message.args[2])
		) {
			this.replyError(
				message.id,
				null,
				"Caption transcription request was invalid",
			);
			return;
		}
		const language = message.args[2];
		if (this.activeCaptions && this.activeCaptions.language !== language) {
			this.replyError(
				message.id,
				null,
				"Caption transcription is already running in another language",
			);
			return;
		}
		if (!this.activeCaptions) {
			const pending = generateWebEditorCaptions(
				this.videoId,
				this.controller.signal,
				language,
			);
			const settle = () => {
				if (this.activeCaptions?.promise === pending)
					this.activeCaptions = null;
			};
			this.activeCaptions = { language, promise: pending };
			void pending.then(settle, settle);
		}
		try {
			this.reply(message.id, await this.activeCaptions.promise);
		} catch (cause) {
			this.replyError(message.id, cause, "Caption transcription failed");
		}
	}

	private async handleTitle(message: BridgeRequest) {
		try {
			const prettyName = message.args[0];
			if (!validWebEditorTitle(prettyName))
				throw new Error("Recording title must be 5 to 100 characters");
			const response = await fetch(`${this.videoPath}/title`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prettyName }),
			});
			if (!response.ok)
				throw new Error(
					response.status === 409
						? "Recording title changed in another editor"
						: "Recording title could not be saved",
				);
			this.reply(message.id, null);
		} catch (cause) {
			this.replyError(message.id, cause, "Recording title could not be saved");
		}
	}

	private async handleDelete(message: BridgeRequest) {
		try {
			if (this.activeSavePublish)
				throw new Error("Wait for the save to finish before deleting");
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
			this.reply(message.id, null);
			this.options.onClose("deleted");
		} catch (cause) {
			this.replyError(message.id, cause, "Recording could not be deleted");
		}
	}

	private async handleProjectConfig(message: BridgeRequest) {
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
			const getSavedAt = this.options.getProjectSavedAt;
			const body = JSON.stringify({
				config,
				...(preserveExistingPaidCaptions
					? { preserveExistingPaidCaptions: true }
					: {}),
				...(getSavedAt ? { expectedSavedAt: getSavedAt() } : {}),
			});
			const request = fetch(`${this.videoPath}/config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body,
				keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024,
			});
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
				this.options.onProjectSaved?.(saved.savedAt);
			}
			this.reply(message.id, null);
		} catch (cause) {
			this.replyError(message.id, cause, "Editor edits could not be saved");
		}
	}

	private async handleRequest(message: BridgeRequest) {
		if (!this.port || this.disposed) return;
		const { name } = message;
		if (message.kind === "emit") {
			if (name !== "renderFrameEvent")
				this.port.postMessage({
					kind: "event",
					name,
					payload: message.args[0],
				});
			this.reply(message.id, null);
			if (name === "editor-close-approved") this.options.onClose();
			return;
		}
		const unsupported = UNSUPPORTED_ON_WEB[name];
		if (unsupported) {
			this.replyError(message.id, null, unsupported);
			return;
		}
		switch (name) {
			case "tauri:webEditorSave":
				try {
					this.reply(message.id, await this.startSave());
				} catch (cause) {
					this.replyError(message.id, cause, "Save failed");
				}
				return;
			case "tauri:webEditorPublishRendered":
				await this.publishRenderedSave(message);
				return;
			case "tauri:webEditorBrowserSaveProgress": {
				const [progress] = message.args;
				this.reportBrowserSave(
					typeof progress === "number" && progress >= 0 && progress <= 1
						? progress
						: null,
				);
				this.reply(message.id, null);
				return;
			}
			case "tauri:webEditorBrowserSaveChunk":
				this.reply(message.id, null);
				return;
			case "tauri:webEditorSaveStatus":
				await this.handleSaveStatus(message);
				return;
			case "tauri:webEditorDefaultStyle":
			case "tauri:webEditorSaveDefaultStyle":
				await this.handleDefaultStyle(message);
				return;
			case "tauri:webEditorStoredDesktopBackground":
				await this.handleStoredDesktopBackground(message);
				return;
			case "checkUpgradedAndUpdate":
				try {
					if (message.args.length !== 0)
						throw new Error("Recording plan request was invalid");
					this.reply(message.id, await this.currentPlan());
				} catch (cause) {
					this.replyError(message.id, cause, "Recording plan is unavailable");
				}
				return;
			case "showWindow":
				if (
					message.args.length !== 1 ||
					message.args[0] !== "Upgrade" ||
					!this.options.onUpgrade
				) {
					this.replyError(message.id, null, "Editor window is unavailable");
					return;
				}
				this.options.onUpgrade();
				this.reply(message.id, null);
				return;
			case "importAudioTrackFile":
				await this.handleAssetImport(message, "audio");
				return;
			case "importEditorImage":
				await this.handleAssetImport(message, "image");
				return;
			case "importCurrentDesktopBackground":
				await this.handleAssetImport(message, "image", true);
				return;
			case "importEditorVideo":
				await this.handleVideoImport(message);
				return;
			case "addExistingRecordingToEditor":
				await this.handleRecordingClipImport(message);
				return;
			case "openEditorRecordingMain":
				if (
					message.args.length !== 1 ||
					message.args[0] !== this.editorPath ||
					!this.options.onOpenClipRecorder
				) {
					this.replyError(message.id, null, "Editor recorder is unavailable");
					return;
				}
				this.options.onOpenClipRecorder(null);
				this.reply(message.id, null);
				return;
			case "tauri:webEditorOpenClipRecorder": {
				const context = parseClipRecorderContext(message.args[0]);
				if (!context || !this.options.onOpenClipRecorder) {
					this.replyError(message.id, null, "Editor recorder is unavailable");
					return;
				}
				this.options.onOpenClipRecorder(context);
				this.reply(message.id, null);
				return;
			}
			case "transcribeAudio":
				await this.handleCaptionTranscription(message);
				return;
			case "setPrettyName":
				await this.handleTitle(message);
				return;
			case "editorDeleteProject":
				await this.handleDelete(message);
				return;
			case "setProjectConfig":
				await this.handleProjectConfig(message);
				return;
			case "exportVideoToFile":
				this.replyError(
					message.id,
					new Error(localExportUnavailableMessage(message.args[2])),
					"Export failed",
				);
				return;
			case "generateExportPreviewFast":
			case "getExportEstimates":
				this.replyError(
					message.id,
					new Error(localExportUnavailableMessage(message.args[1])),
					"Export preview is unavailable",
				);
				return;
			case "cancelExportEstimates":
			case "beginExportSession":
			case "endExportSession":
				this.reply(message.id, null);
				return;
			case "cancelCurrentWindowExports":
				this.activeSavePublish?.abort();
				this.reply(message.id, null);
				return;
			case "globalMessageDialog": {
				const detail = message.args[0];
				window.alert(
					typeof detail === "string" ? detail : "Editor action failed",
				);
				this.reply(message.id, null);
				return;
			}
			default:
				this.replyError(
					message.id,
					null,
					`Browser editor command is unavailable: ${name}`,
				);
		}
	}

	async connect(iframe: HTMLIFrameElement) {
		if (this.disposed) throw new Error("Editor bridge is closed");
		if (!iframe.contentWindow) throw new Error("Editor frame is unavailable");
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
		try {
			iframe.contentWindow.postMessage(
				{
					kind: "cap-editor-connect",
					version: 1,
					videoId: this.videoId,
					userId: this.options.userId,
					captionsEnabled: this.captionsEnabled,
					assetBase: `${this.videoPath}/file?raw=1`,
					browserSessionId: this.sessionId,
				},
				window.location.origin,
				[channel.port2],
			);
		} catch {
			settleMount(new Error("Editor frame could not connect"));
		}
		await mounted;
		window.addEventListener("focus", this.refreshCaptionPlanFromPage, {
			signal: this.controller.signal,
		});
		document.addEventListener(
			"visibilitychange",
			this.refreshCaptionPlanFromVisibility,
			{ signal: this.controller.signal },
		);
	}

	requestClipRecorder() {
		this.postEvent("webEditorRequestClipRecorder");
	}

	notifyClipRecorderClosed() {
		this.postEvent("webEditorClipRecorderClosed");
	}

	private postEvent(name: string) {
		this.port?.postMessage({ kind: "event", name, payload: null });
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.abort();
		this.port?.close();
		this.port = null;
	}
}
