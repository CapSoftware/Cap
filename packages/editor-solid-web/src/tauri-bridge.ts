import type {
	commands as desktopCommands,
	events as desktopEvents,
} from "../../../apps/desktop/src/utils/tauri";
import { stripEditorCaptionContent } from "../../../apps/web/lib/editor-caption-access";
import {
	compactEditorCaptionConfig,
	type EditorCaptionCache,
} from "../../../apps/web/lib/editor-caption-transport";
import { WebEditorAudio } from "./audio-player";
import { BrowserEditorCommands } from "./browser-editor-commands";
import {
	browserEditorPreviewEnabled,
	pauseBrowserEditorPreview,
	playBrowserEditorPreview,
	renderBrowserEditorPreview,
	seekBrowserEditorPreview,
	setBrowserEditorPreviewConfig,
	setBrowserPlaybackFrameListener,
} from "./browser-frame-socket";
import { EditorCaptionCacheMemo } from "./caption-cache-memo";
import {
	editorChannelId,
	emitEditorChannel,
	serializeEditorChannel,
	unregisterEditorChannel,
} from "./channels";
import { mapEditorImportedImages } from "./editor-file-mapping";
import { takeEditorSelectedFile } from "./tauri-dialog";
import { Store } from "./tauri-store";
import { setEditorFrameSocketCredential } from "./websocket";

export type * from "../../../apps/desktop/src/utils/tauri";

type BridgeReply =
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; error: string }
	| { kind: "channel"; id: number; value: unknown }
	| { kind: "event"; name: string; payload: unknown }
	| { kind: "audio"; packet: ArrayBuffer };

type PendingRequest = {
	name: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	channelIds: number[];
};

function isBridgeReply(value: unknown): value is BridgeReply {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message.kind === "event") {
		return typeof message.name === "string";
	}
	if (message.kind === "audio") {
		return message.packet instanceof ArrayBuffer;
	}
	if (message.kind === "result") {
		return typeof message.id === "number";
	}
	if (message.kind === "channel") {
		return typeof message.id === "number" && "value" in message;
	}
	return (
		message.kind === "error" &&
		typeof message.id === "number" &&
		typeof message.error === "string"
	);
}

export class PortEditorTransport {
	private nextId = 1;
	private disposed = false;
	private audioPlaying = false;
	private readonly audio = new WebEditorAudio();
	private readonly pending = new Map<number, PendingRequest>();
	private nativeCaptionCache: EditorCaptionCache | null = null;
	private savedCaptionCache: EditorCaptionCache | null = null;
	private readonly captionCacheMemo = new EditorCaptionCacheMemo();
	private planRequestSequence = 0;
	private readonly browserCommands: BrowserEditorCommands | null;
	private readonly listeners = new Map<
		string,
		Set<(payload: unknown) => void>
	>();

	constructor(
		private readonly port: MessagePort,
		browserSession?: { videoId: string; sessionId: string },
	) {
		this.browserCommands = browserSession
			? new BrowserEditorCommands(
					browserSession.videoId,
					browserSession.sessionId,
				)
			: null;
		port.onmessage = (event: MessageEvent<unknown>) => {
			if (!isBridgeReply(event.data)) return;
			const message = event.data;
			if (message.kind === "channel") {
				emitEditorChannel(message.id, message.value);
				return;
			}
			if (message.kind === "event") {
				for (const listener of this.listeners.get(message.name) ?? []) {
					listener(message.payload);
				}
				return;
			}
			if (message.kind === "audio") {
				if (this.audioPlaying) this.audio.push(message.packet);
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) return;
			this.pending.delete(message.id);
			for (const channelId of request.channelIds) {
				unregisterEditorChannel(channelId);
			}
			if (message.kind === "result") {
				if (request.name === "createEditorInstance") {
					const value = message.value;
					if (
						typeof value !== "object" ||
						value === null ||
						!("framesSocketUrl" in value) ||
						!("frameSocketTicket" in value) ||
						typeof value.framesSocketUrl !== "string" ||
						typeof value.frameSocketTicket !== "string"
					) {
						request.reject(new Error("Editor frame socket ticket is missing"));
						return;
					}
					try {
						setEditorFrameSocketCredential({
							url: value.framesSocketUrl,
							ticket: value.frameSocketTicket,
						});
					} catch (cause) {
						request.reject(
							cause instanceof Error ? cause : new Error(String(cause)),
						);
						return;
					}
					const instance: Record<string, unknown> = { ...value };
					delete instance.frameSocketTicket;
					if (
						browserEditorPreviewEnabled() &&
						"savedProjectConfig" in value &&
						typeof value.savedProjectConfig === "object" &&
						value.savedProjectConfig !== null &&
						!Array.isArray(value.savedProjectConfig)
					) {
						const mapped = mapEditorImportedImages(value.savedProjectConfig);
						const config =
							window.capWebEditorCaptionsEnabled === true
								? mapped
								: stripEditorCaptionContent(mapped as Record<string, unknown>);
						void setBrowserEditorPreviewConfig(config).then(
							() => request.resolve(instance),
							(cause: unknown) =>
								request.reject(
									cause instanceof Error ? cause : new Error(String(cause)),
								),
						);
						return;
					}
					request.resolve(instance);
				} else {
					request.resolve(message.value);
				}
			} else request.reject(new Error(message.error));
		};
		port.start();
	}

	private request(kind: "invoke" | "emit", name: string, args: unknown[]) {
		if (this.disposed) {
			return Promise.reject(new Error("Editor bridge is closed"));
		}
		if (
			kind === "invoke" &&
			this.browserCommands &&
			BrowserEditorCommands.supports(name)
		) {
			return this.browserCommands.invoke(name, args);
		}
		const id = this.nextId++;
		const prepared = args.map(serializeEditorChannel);
		const channelIds = prepared
			.map(editorChannelId)
			.filter((channelId): channelId is number => channelId !== null);
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { name, resolve, reject, channelIds });
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
					reject(cause instanceof Error ? cause : new Error(String(cause)));
				}
			}
		});
	}

	async invoke(name: string, args: unknown[]) {
		const planRequestSequence =
			name === "checkUpgradedAndUpdate" ? ++this.planRequestSequence : 0;
		if (name === "performHapticFeedback") return null;
		if (name === "saveFileDialog") {
			const fileName = args[0];
			const fileType = args[1];
			if (
				typeof fileName !== "string" ||
				typeof fileType !== "string" ||
				!/^[^/\\]{1,140}\.(srt|vtt)$/.test(fileName) ||
				fileName.split("").some((character) => {
					const code = character.charCodeAt(0);
					return code < 32 || code === 127;
				}) ||
				!fileName.endsWith(`.${fileType}`)
			) {
				throw new Error("Invalid caption download name");
			}
			return `cap-web-editor://download/${encodeURIComponent(fileName)}`;
		}
		if (name === "generateZoomSegmentsFromClicks") {
			const settings = await (await Store.load("store")).get<{
				defaultZoomAmount?: number | null;
			}>("general_settings");
			const amount = settings?.defaultZoomAmount;
			args = [
				typeof amount === "number" &&
				Number.isFinite(amount) &&
				amount >= 0.1 &&
				amount <= 10
					? amount
					: 2,
			];
		}
		const isConfigCommand =
			name === "setProjectConfig" || name === "updateProjectConfigInMemory";
		let captionCache: EditorCaptionCache | null = null;
		let fullConfigArgs: unknown[] | null = null;
		let compacted = false;
		if (isConfigCommand && args.length > 0) {
			const mapped = mapEditorImportedImages(args[0]);
			const stripForFree =
				typeof window !== "undefined" &&
				window.capWebEditorCaptionsEnabled === false &&
				typeof mapped === "object" &&
				mapped !== null &&
				!Array.isArray(mapped);
			const config = stripForFree
				? stripEditorCaptionContent(mapped as Record<string, unknown>)
				: mapped;
			args =
				name === "setProjectConfig" && stripForFree
					? [config, true]
					: [config, ...args.slice(1)];
			fullConfigArgs = args;
			if (
				name === "updateProjectConfigInMemory" &&
				browserEditorPreviewEnabled()
			) {
				await setBrowserEditorPreviewConfig(config);
				if (args[1] !== null && args[2] !== null && args[3] !== null) {
					await renderBrowserEditorPreview({
						frame_number: args[1],
						fps: args[2],
						resolution_base: args[3],
					});
				}
				return null;
			}
			captionCache = await this.captionCacheMemo.get(args[0]);
			const previous =
				name === "setProjectConfig"
					? this.savedCaptionCache
					: this.nativeCaptionCache;
			if (
				captionCache &&
				previous?.ref === captionCache.ref &&
				typeof args[0] === "object" &&
				args[0] !== null &&
				!Array.isArray(args[0])
			) {
				args = [
					compactEditorCaptionConfig(
						args[0] as Record<string, unknown>,
						captionCache,
					),
					...args.slice(1),
				];
				compacted = true;
			}
		}
		if (
			(name === "importAudioTrackFile" ||
				name === "importEditorImage" ||
				name === "importEditorVideo" ||
				name === "importCurrentDesktopBackground" ||
				name === "addExistingRecordingToEditor") &&
			typeof args[0] === "string"
		) {
			const file = takeEditorSelectedFile(args[0]);
			if (!file) throw new Error("Selected media file is unavailable");
			args = [file];
		}
		if (name === "startPlayback") {
			if (browserEditorPreviewEnabled()) {
				playBrowserEditorPreview();
				this.audioPlaying = false;
				return null;
			} else {
				await this.audio.start();
				this.audioPlaying = true;
			}
		} else if (name === "stopPlayback") {
			this.audioPlaying = false;
			this.audio.stop();
			if (browserEditorPreviewEnabled()) {
				pauseBrowserEditorPreview();
				return null;
			}
		} else if (name === "seekTo" && this.audioPlaying) {
			this.audio.reset();
		}
		if (
			(name === "seekTo" || name === "setPlayheadPosition") &&
			browserEditorPreviewEnabled() &&
			typeof args[0] === "number"
		) {
			await seekBrowserEditorPreview(args[0]);
			return null;
		}
		try {
			let value: unknown;
			try {
				value = await this.request("invoke", name, args);
			} catch (error) {
				if (
					!isConfigCommand ||
					!compacted ||
					!fullConfigArgs ||
					!(error instanceof Error) ||
					!error.message.includes("Caption payload cache is unavailable")
				) {
					throw error;
				}
				value = await this.request("invoke", name, fullConfigArgs);
			}
			if (isConfigCommand) {
				if (name === "setProjectConfig") this.savedCaptionCache = captionCache;
				else this.nativeCaptionCache = captionCache;
				if (browserEditorPreviewEnabled()) {
					await setBrowserEditorPreviewConfig(fullConfigArgs?.[0] ?? args[0]);
				}
			}
			if (
				planRequestSequence > 0 &&
				planRequestSequence === this.planRequestSequence &&
				typeof value === "boolean"
			) {
				const previous = window.capWebEditorCaptionsEnabled;
				window.capWebEditorCaptionsEnabled = value;
				if (previous !== value)
					window.dispatchEvent(new Event("cap-web-editor-captions-plan"));
			}
			if (name === "getDisplayFrameForCropping") {
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
			return value;
		} catch (error) {
			if (isConfigCommand) {
				if (name === "setProjectConfig") this.savedCaptionCache = null;
				else this.nativeCaptionCache = null;
			}
			if (name === "startPlayback") {
				this.audioPlaying = false;
				this.audio.stop();
				if (browserEditorPreviewEnabled()) pauseBrowserEditorPreview();
			}
			throw error;
		}
	}

	emit(name: string, payload: unknown) {
		if (name === "renderFrameEvent" && browserEditorPreviewEnabled()) {
			return renderBrowserEditorPreview(payload);
		}
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

	browserPlaybackFrame(frameNumber: number) {
		if (this.disposed) return;
		for (const listener of this.listeners.get("editorStateChanged") ?? []) {
			listener({ playhead_position: frameNumber });
		}
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
		this.audioPlaying = false;
		this.audio.dispose();
		this.browserCommands?.dispose();
		this.captionCacheMemo.dispose();
		this.nativeCaptionCache = null;
		this.savedCaptionCache = null;
		this.port.close();
	}
}

let transport: PortEditorTransport | null = null;

export function setEditorTransport(next: PortEditorTransport | null) {
	transport?.dispose();
	transport = next;
	setBrowserPlaybackFrameListener(
		next ? (frameNumber) => next.browserPlaybackFrame(frameNumber) : null,
	);
}

function editorTransport() {
	if (!transport) throw new Error("Editor bridge is unavailable");
	return transport;
}

export function listenEditorEvent(
	name: string,
	callback: (payload: unknown) => void,
) {
	return Promise.resolve(editorTransport().listen(name, callback));
}

export function emitEditorEvent(name: string, payload?: unknown) {
	return editorTransport().emit(name, payload);
}

export function invokeEditorTauriCommand<T>(name: string, args?: unknown) {
	return editorTransport().invoke(`tauri:${name}`, [args]) as Promise<T>;
}

export function importEditorBrowserImage(file: File) {
	return editorTransport().invoke("importEditorImage", [file]) as Promise<{
		path: string;
	}>;
}

export const commands = new Proxy({} as typeof desktopCommands, {
	get(_target, property) {
		if (typeof property !== "string") return undefined;
		return (...args: unknown[]) => editorTransport().invoke(property, args);
	},
});

function editorEvent(name: string) {
	const event = () => event;
	event.listen = (callback: (event: { payload: unknown }) => void) =>
		Promise.resolve(
			editorTransport().listen(name, (payload) => callback({ payload })),
		);
	event.once = (callback: (event: { payload: unknown }) => void) => {
		const unlisten = editorTransport().listen(name, (payload) => {
			unlisten();
			callback({ payload });
		});
		return Promise.resolve(unlisten);
	};
	event.emit = (payload?: unknown) => editorTransport().emit(name, payload);
	return event;
}

export const events = new Proxy({} as typeof desktopEvents, {
	get(_target, property) {
		if (typeof property !== "string") return undefined;
		return editorEvent(property);
	},
});
