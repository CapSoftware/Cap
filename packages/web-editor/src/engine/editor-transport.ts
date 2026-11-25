import { setServerExport } from "../app/routes/editor/export-location";
import { BrowserEditorCommands } from "./browser-editor-commands";
import {
	browserEditorPreviewConfig,
	pauseBrowserEditorPreview,
	playBrowserEditorPreview,
	renderBrowserEditorPreview,
	seekBrowserEditorPreview,
	setBrowserEditorPreviewConfig,
	setBrowserFrameLayoutListener,
	setBrowserPlaybackFrameListener,
} from "./browser-frame-socket";
import {
	BrowserLocalExportUnavailable,
	browserLocalExportEstimates,
	browserLocalExportPreview,
	cancelBrowserLocalExport,
	discardStoredBrowserExport,
	prewarmBrowserLocalExport,
	removeLeftoverBrowserExports,
	renderBrowserLocalExport,
	runBrowserLocalExport,
} from "./browser-local-export";
import { EditorCaptionCacheMemo } from "./caption-cache-memo";
import {
	editorChannelId,
	emitEditorChannel,
	serializeEditorChannel,
	unregisterEditorChannel,
} from "./channels";
import { stripEditorCaptionContent } from "./editor-caption-access";
import {
	compactEditorCaptionConfig,
	type EditorCaptionCache,
} from "./editor-caption-transport";
import { mapEditorImportedImages } from "./editor-file-mapping";
import { EXPORT_ASSET_FAILED } from "./editor-image-missing";
import {
	SHARE_RENDER_COMPRESSION,
	SHARE_RENDER_RESOLUTION,
	SHARE_RENDER_SOURCE_FPS,
} from "./share-render";
import type { FrameLayoutEvent } from "./types";

type BridgeReply =
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; error: string }
	| { kind: "channel"; id: number; value: unknown }
	| { kind: "event"; name: string; payload: unknown };

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	channelIds: number[];
};

function isBridgeReply(value: unknown): value is BridgeReply {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message.kind === "event") return typeof message.name === "string";
	if (message.kind === "result") return typeof message.id === "number";
	if (message.kind === "channel") {
		return typeof message.id === "number" && "value" in message;
	}
	return (
		message.kind === "error" &&
		typeof message.id === "number" &&
		typeof message.error === "string"
	);
}

const BROWSER_SAVE_SETTINGS = {
	format: "Mp4",
	fps: SHARE_RENDER_SOURCE_FPS,
	resolution_base: SHARE_RENDER_RESOLUTION,
	compression: SHARE_RENDER_COMPRESSION,
};

function asError(cause: unknown) {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type EditorSession = { videoId: string; sessionId: string };

export class PortEditorTransport {
	private nextId = 1;
	private disposed = false;
	private readonly pending = new Map<number, PendingRequest>();
	private savedCaptionCache: EditorCaptionCache | null = null;
	private readonly captionCacheMemo = new EditorCaptionCacheMemo();
	private planRequestSequence = 0;
	private readonly browserCommands: BrowserEditorCommands;
	private readonly listeners = new Map<
		string,
		Set<(payload: unknown) => void>
	>();

	private applyCaptionPlan(value: boolean) {
		const previous = window.capWebEditorCaptionsEnabled;
		window.capWebEditorCaptionsEnabled = value;
		if (previous !== value)
			window.dispatchEvent(new Event("cap-web-editor-captions-plan"));
	}

	constructor(
		private readonly port: MessagePort,
		session: EditorSession,
	) {
		this.browserCommands = new BrowserEditorCommands(
			session.videoId,
			session.sessionId,
		);
		removeLeftoverBrowserExports();
		port.onmessage = (event: MessageEvent<unknown>) => {
			if (!isBridgeReply(event.data)) return;
			const message = event.data;
			if (message.kind === "channel") {
				emitEditorChannel(message.id, message.value);
				return;
			}
			if (message.kind === "event") {
				if (
					message.name === "editorCaptionPlan" &&
					typeof message.payload === "boolean"
				) {
					this.planRequestSequence++;
					this.applyCaptionPlan(message.payload);
				}
				for (const listener of this.listeners.get(message.name) ?? []) {
					listener(message.payload);
				}
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) return;
			this.pending.delete(message.id);
			for (const channelId of request.channelIds) {
				unregisterEditorChannel(channelId);
			}
			if (message.kind === "result") request.resolve(message.value);
			else request.reject(new Error(message.error));
		};
		port.start();
	}

	private request(kind: "invoke" | "emit", name: string, args: unknown[]) {
		if (this.disposed) {
			return Promise.reject(new Error("Editor bridge is closed"));
		}
		if (kind === "invoke" && BrowserEditorCommands.supports(name)) {
			return this.browserCommands.invoke(name, args);
		}
		const id = this.nextId++;
		const prepared = args.map(serializeEditorChannel);
		const channelIds = prepared
			.map(editorChannelId)
			.filter((channelId): channelId is number => channelId !== null);
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, channelIds });
			try {
				this.port.postMessage({ kind, id, name, args: prepared });
			} catch (error) {
				try {
					if (!(error instanceof Error) || error.name !== "DataCloneError")
						throw error;
					const plain: unknown = JSON.parse(JSON.stringify(prepared));
					if (!Array.isArray(plain))
						throw new Error("Editor command arguments could not be serialized");
					this.port.postMessage({ kind, id, name, args: plain });
				} catch (cause) {
					this.pending.delete(id);
					for (const channelId of channelIds) {
						unregisterEditorChannel(channelId);
					}
					reject(asError(cause));
				}
			}
		});
	}

	private async local(name: string, args: unknown[]) {
		switch (name) {
			case "exportVideoToFile": {
				const [, channel, settings, fileName] = args;
				const channelId =
					typeof channel === "object" && channel !== null && "id" in channel
						? Number(channel.id)
						: null;
				if (!isRecord(settings) || typeof fileName !== "string") break;
				setServerExport(false);
				try {
					return {
						value: await runBrowserLocalExport(settings, channelId, fileName),
					};
				} catch (cause) {
					if (!(cause instanceof BrowserLocalExportUnavailable)) throw cause;
					console.warn("Cap local export unavailable, using the host", cause);
					setServerExport(true);
				}
				break;
			}
			case "tauri:webEditorSaveInBrowser":
				return { value: await this.saveInBrowser(args[0]) };
			case "tauri:webEditorPrewarmExport":
				prewarmBrowserLocalExport();
				return { value: null };
			case "cancelCurrentWindowExports":
				cancelBrowserLocalExport();
				break;
			case "generateExportPreviewFast": {
				const [frameTime, settings] = args;
				if (typeof frameTime !== "number" || !isRecord(settings)) break;
				return { value: await browserLocalExportPreview(frameTime, settings) };
			}
			case "getExportEstimates": {
				const [, settings] = args;
				if (!isRecord(settings)) break;
				return { value: await browserLocalExportEstimates(settings) };
			}
			case "cancelExportEstimates":
				return { value: null };
			case "startPlayback":
				playBrowserEditorPreview();
				return { value: null };
			case "stopPlayback":
				pauseBrowserEditorPreview();
				return { value: null };
			case "seekTo":
			case "setPlayheadPosition":
				if (typeof args[0] !== "number") break;
				await seekBrowserEditorPreview(args[0]);
				return { value: null };
		}
		return null;
	}

	private async saveInBrowser(request: unknown) {
		const channel =
			isRecord(request) && "channel" in request ? request.channel : null;
		const channelId =
			isRecord(channel) && typeof channel.id === "number" ? channel.id : null;
		let reportedAt = 0;
		const report = (progress: number | null) =>
			void this.request("invoke", "tauri:webEditorBrowserSaveProgress", [
				progress,
			]).catch(() => undefined);
		report(0);
		let rendered: Awaited<ReturnType<typeof renderBrowserLocalExport>>;
		try {
			rendered = await renderBrowserLocalExport(
				BROWSER_SAVE_SETTINGS,
				(renderedCount, totalFrames) => {
					if (totalFrames <= 0) return;
					const progress = renderedCount / totalFrames;
					if (channelId !== null)
						emitEditorChannel(channelId, { stage: "rendering", progress });
					if (Date.now() - reportedAt >= 1000) {
						reportedAt = Date.now();
						report(progress * 0.9);
					}
				},
			);
		} catch (cause) {
			report(null);
			if (cause instanceof BrowserLocalExportUnavailable)
				throw new Error(
					cause.message === EXPORT_ASSET_FAILED
						? "A file this project uses couldn't load. Try saving again."
						: "This browser can't render the video. Try Chrome or Edge, or use Download.",
				);
			throw cause;
		}
		try {
			if (rendered.mimeType !== "video/mp4") {
				report(null);
				throw new Error(
					"The rendered video is not an MP4. Use Download instead.",
				);
			}
			return await this.request("invoke", "tauri:webEditorPublishRendered", [
				new Blob([rendered.data], { type: "video/mp4" }),
				{
					duration: rendered.duration,
					width: rendered.width,
					height: rendered.height,
					fps: rendered.fps,
				},
				channel,
			]);
		} finally {
			discardStoredBrowserExport(rendered.storedFile);
		}
	}

	private previewConfig(config: unknown) {
		const mapped = mapEditorImportedImages(config);
		return window.capWebEditorCaptionsEnabled === false && isRecord(mapped)
			? { config: stripEditorCaptionContent(mapped), stripped: true }
			: { config: mapped, stripped: false };
	}

	async invoke(name: string, args: unknown[]) {
		const planRequestSequence =
			name === "checkUpgradedAndUpdate" ? ++this.planRequestSequence : 0;
		const handled = await this.local(name, args);
		if (handled) return handled.value;
		if (name === "updateProjectConfigInMemory" && args.length > 0) {
			const { config } = this.previewConfig(args[0]);
			await setBrowserEditorPreviewConfig(config);
			const [, frameNumber, fps, resolutionBase] = args;
			if (frameNumber != null && fps != null && resolutionBase != null) {
				await renderBrowserEditorPreview({
					frame_number: frameNumber,
					fps,
					resolution_base: resolutionBase,
				});
			}
			return null;
		}
		if (name === "setProjectConfig" && args.length > 0) {
			return this.saveProjectConfig(args[0]);
		}
		const value = await this.request("invoke", name, args);
		if (
			planRequestSequence > 0 &&
			planRequestSequence === this.planRequestSequence &&
			typeof value === "boolean"
		) {
			this.applyCaptionPlan(value);
		}
		if (name === "getDisplayFrameForCropping") return cropFrameJpeg(value);
		return value;
	}

	private async saveProjectConfig(input: unknown) {
		const { config, stripped } = this.previewConfig(input);
		const fullArgs = stripped ? [config, true] : [config];
		const captionCache = await this.captionCacheMemo.get(config);
		const compacted =
			captionCache &&
			this.savedCaptionCache?.ref === captionCache.ref &&
			isRecord(config)
				? [
						compactEditorCaptionConfig(config, captionCache),
						...fullArgs.slice(1),
					]
				: null;
		try {
			try {
				await this.request("invoke", "setProjectConfig", compacted ?? fullArgs);
			} catch (error) {
				if (
					!compacted ||
					!(error instanceof Error) ||
					!error.message.includes("Caption payload cache is unavailable")
				) {
					throw error;
				}
				await this.request("invoke", "setProjectConfig", fullArgs);
			}
			// A save lands seconds later on a poor link, by when the preview may
			// show newer edits, so it only seeds a preview that has no config yet:
			// a recording opened without one, saved before any edit reached it.
			if (browserEditorPreviewConfig() == null) {
				await setBrowserEditorPreviewConfig(config);
			}
			this.savedCaptionCache = captionCache;
			return null;
		} catch (error) {
			this.savedCaptionCache = null;
			throw error;
		}
	}

	emit(name: string, payload: unknown) {
		if (name === "renderFrameEvent") return renderBrowserEditorPreview(payload);
		return this.request("emit", name, [payload]).then(() => undefined);
	}

	listen(name: string, callback: (payload: unknown) => void) {
		let listeners = this.listeners.get(name);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(name, listeners);
		}
		listeners.add(callback);
		return () => {
			listeners.delete(callback);
			if (listeners.size === 0) this.listeners.delete(name);
		};
	}

	dispatchLocal(name: string, payload: unknown) {
		if (this.disposed) return;
		for (const listener of this.listeners.get(name) ?? []) listener(payload);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const request of this.pending.values()) {
			for (const channelId of request.channelIds) {
				unregisterEditorChannel(channelId);
			}
			request.reject(new Error("Editor bridge is closed"));
		}
		this.pending.clear();
		this.listeners.clear();
		this.browserCommands.dispose();
		this.captionCacheMemo.dispose();
		this.savedCaptionCache = null;
		this.port.close();
	}
}

function cropFrameJpeg(value: unknown) {
	if (value instanceof Uint8Array) {
		if (
			value.byteLength < 4 ||
			value.byteLength > 16 * 1024 * 1024 ||
			value[0] !== 0xff ||
			value[1] !== 0xd8
		) {
			throw new Error("Crop frame response is not a JPEG");
		}
		return value;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("jpegBase64" in value) ||
		typeof value.jpegBase64 !== "string" ||
		value.jpegBase64.length > 2_800_000
	) {
		throw new Error("Crop frame response is invalid");
	}
	const jpeg = Uint8Array.from(atob(value.jpegBase64), (byte) =>
		byte.charCodeAt(0),
	);
	if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
		throw new Error("Crop frame response is not a JPEG");
	}
	return jpeg;
}

let transport: PortEditorTransport | null = null;

export function setEditorTransport(next: PortEditorTransport | null) {
	transport?.dispose();
	transport = next;
	setBrowserPlaybackFrameListener(
		next
			? (frameNumber) =>
					next.dispatchLocal("editorStateChanged", {
						playhead_position: frameNumber,
					})
			: null,
	);
	setBrowserFrameLayoutListener(
		next
			? (layout: FrameLayoutEvent) =>
					next.dispatchLocal("frameLayoutEvent", layout)
			: null,
	);
}

export function editorTransport() {
	if (!transport) throw new Error("Editor bridge is unavailable");
	return transport;
}
