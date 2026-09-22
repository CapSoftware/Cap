import { randomBytes } from "node:crypto";
import { addEditorAudioLibraryTrack } from "./editor-audio-library";
import { renderEditorClipThumbnail } from "./editor-clip-thumbnails";
import {
	dispatchEditorSocketCommand,
	type EditorCommandState,
	type EditorSocketReply,
	parseEditorSocketRequest,
} from "./editor-command-socket";
import {
	mapEditorConfigPaths,
	mapEditorInstanceConfigPaths,
} from "./editor-config-paths";
import {
	cancelEditorExportEstimate,
	getEditorExportEstimate,
} from "./editor-export-estimates";
import { renderEditorExportPreview } from "./editor-export-previews";
import { attachEditorSession, getEditorSession } from "./editor-sessions";
import {
	consumeEditorSocketTicket,
	type EditorSocketScope,
} from "./editor-socket-tickets";

export type EditorSocketConnection = {
	upstreamUrl: string;
	scope: EditorSocketScope;
	sessionId: string;
	upstream: WebSocket | null;
	commandState: EditorCommandState;
	commandQueue: Promise<void>;
	pendingCommands: number;
	abort: AbortController;
	frameMode: "png" | "h264" | "png-fallback";
	reducedBitrate: boolean;
	bandwidthProbeUsed: boolean;
};

const SOCKET_PATH =
	/^\/editor\/sessions\/((?:[a-z][a-z0-9-]{0,23}\.)?[0-9a-f-]{36})\/(frames|audio|events|commands)$/;
const FRAME_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const MAX_CROP_JPEG_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 64;
const H264_MODE = JSON.stringify({ mode: "h264" });
const PNG_MODE = JSON.stringify({ mode: "png" });
const LOW_BITRATE = JSON.stringify({ bitrate: "low" });
const HIGH_BITRATE = JSON.stringify({ bitrate: "high" });
const BANDWIDTH_PROBE_REQUEST = JSON.stringify({ probe: "bandwidth" });
const BANDWIDTH_PROBE = Buffer.concat([
	Buffer.from("CAPBAND1"),
	randomBytes(512 * 1024),
]);

export function handleEditorSocketUpgrade(
	request: Request,
	server: Bun.Server<EditorSocketConnection>,
) {
	const match = new URL(request.url).pathname.match(SOCKET_PATH);
	if (!match) return null;
	const sessionId = match[1];
	const scope = match[2] as EditorSocketScope;
	const native = consumeEditorSocketTicket(
		sessionId,
		scope,
		request.headers.get("origin"),
		request.headers.get("sec-websocket-protocol"),
	);
	if (!native) return new Response("Unauthorized", { status: 401 });
	const h264Hint =
		scope === "frames" &&
		request.headers
			.get("sec-websocket-protocol")
			?.split(",")
			.some((value) => value.trim() === "cap-editor-h264-v1") === true;
	const upstream = new URL(`/${scope}`, native.origin);
	upstream.protocol = "ws:";
	if (h264Hint) upstream.pathname = "/frames-h264";
	const accepted = server.upgrade(request, {
		data: {
			upstreamUrl: upstream.toString(),
			scope,
			sessionId,
			upstream: null,
			commandState: {
				frameNumber: 0,
				fps: 60,
				resolutionBase: { x: 960, y: 540 },
				captionsEnabled: native.captionsEnabled,
			},
			commandQueue: Promise.resolve(),
			pendingCommands: 0,
			abort: new AbortController(),
			frameMode: h264Hint ? "h264" : "png",
			reducedBitrate: h264Hint,
			bandwidthProbeUsed: false,
		},
		headers: { "Sec-WebSocket-Protocol": "cap-editor-v1" },
	});
	return accepted
		? undefined
		: new Response("WebSocket upgrade failed", { status: 400 });
}

function connectEditorUpstream(
	ws: Bun.ServerWebSocket<EditorSocketConnection>,
	url: string,
) {
	const previous = ws.data.upstream;
	const native = getEditorSession(ws.data.sessionId);
	if (!native) {
		ws.close(1011, "Editor session closed");
		return;
	}
	const upstream = native.connectSocket(url);
	upstream.binaryType = "arraybuffer";
	ws.data.upstream = upstream;
	if (previous && previous.readyState < 2) previous.close();
	upstream.onopen = () => {
		if (
			ws.data.upstream === upstream &&
			ws.data.frameMode === "h264" &&
			ws.data.reducedBitrate
		) {
			upstream.send(LOW_BITRATE);
		}
	};
	upstream.onmessage = (event: MessageEvent<unknown>) => {
		if (ws.data.upstream !== upstream || ws.readyState !== 1) return;
		if (!getEditorSession(ws.data.sessionId)) {
			ws.close(1011, "Editor session closed");
			return;
		}
		if (
			ws.data.scope === "frames" &&
			ws.data.frameMode === "h264" &&
			!ws.data.reducedBitrate &&
			ws.getBufferedAmount() > 1024 * 1024
		) {
			ws.data.reducedBitrate = true;
			if (upstream.readyState === WebSocket.OPEN) upstream.send(LOW_BITRATE);
		}
		if (ws.getBufferedAmount() > FRAME_BACKPRESSURE_BYTES) {
			if (ws.data.scope === "frames") {
				if (ws.data.frameMode === "h264") {
					ws.data.frameMode = "png-fallback";
					if (upstream.readyState === WebSocket.OPEN) upstream.send(PNG_MODE);
					ws.send(
						JSON.stringify({
							kind: "cap-h264-unavailable",
							error: "Editor preview connection is congested",
						}),
					);
				}
				return;
			}
			ws.close(1013, "Editor socket is congested");
			return;
		}
		const packet = event.data;
		if (
			typeof packet === "string" ||
			packet instanceof ArrayBuffer ||
			packet instanceof Uint8Array ||
			packet instanceof Blob
		) {
			ws.send(packet);
		}
	};
	upstream.onclose = () => {
		if (ws.data.upstream === upstream && ws.readyState === 1)
			ws.close(1011, "Editor renderer disconnected");
	};
	upstream.onerror = () => {
		if (ws.data.upstream === upstream && ws.readyState === 1)
			ws.close(1011, "Editor renderer unavailable");
	};
}

export const editorWebSocketHandler: Bun.WebSocketHandler<EditorSocketConnection> =
	{
		data: {} as EditorSocketConnection,
		message(ws, message) {
			if (ws.data.scope === "frames") {
				if (typeof message !== "string") {
					ws.close(1008, "Invalid editor frame mode");
					return;
				}
				if (message === H264_MODE && ws.data.frameMode === "png") {
					ws.data.frameMode = "h264";
					const upstream = new URL(ws.data.upstreamUrl);
					upstream.pathname = "/frames-h264";
					connectEditorUpstream(ws, upstream.toString());
					return;
				}
				if (message === H264_MODE && ws.data.frameMode === "h264") {
					return;
				}
				if (
					message === BANDWIDTH_PROBE_REQUEST &&
					!ws.data.bandwidthProbeUsed
				) {
					ws.data.bandwidthProbeUsed = true;
					ws.send(BANDWIDTH_PROBE);
					return;
				}
				if (message === LOW_BITRATE && ws.data.frameMode === "h264") {
					ws.data.reducedBitrate = true;
					if (ws.data.upstream?.readyState === WebSocket.OPEN)
						ws.data.upstream.send(message);
					return;
				}
				if (message === HIGH_BITRATE && ws.data.frameMode === "h264") {
					ws.data.reducedBitrate = false;
					if (ws.data.upstream?.readyState === WebSocket.OPEN)
						ws.data.upstream.send(message);
					return;
				}
				if (
					message === PNG_MODE &&
					(ws.data.frameMode === "h264" || ws.data.frameMode === "png-fallback")
				) {
					if (ws.data.frameMode === "png-fallback") return;
					ws.data.frameMode = "png-fallback";
					if (ws.data.upstream?.readyState === WebSocket.OPEN)
						ws.data.upstream.send(message);
					return;
				}
				ws.close(1008, "Invalid editor frame mode");
				return;
			}
			if (ws.data.scope !== "commands") {
				ws.close(1008, "Editor sockets are read-only");
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(
					typeof message === "string"
						? message
						: Buffer.from(message).toString("utf8"),
				);
			} catch {
				ws.close(1008, "Invalid editor command");
				return;
			}
			const command = parseEditorSocketRequest(value);
			if (!command) {
				ws.close(1008, "Invalid editor command");
				return;
			}
			if (ws.data.pendingCommands >= MAX_PENDING_COMMANDS) {
				ws.close(1013, "Editor command queue is full");
				return;
			}
			ws.data.pendingCommands++;
			const parallelRead =
				command.kind === "invoke" &&
				(command.name === "getMicWaveforms" ||
					command.name === "getSystemAudioWaveforms" ||
					command.name === "getClipThumbnail" ||
					command.name === "generateExportPreviewFast" ||
					command.name === "getExportEstimates" ||
					command.name === "cancelExportEstimates");
			const commandTask = (
				parallelRead ? Promise.resolve() : ws.data.commandQueue
			)
				.then(async () => {
					const native = getEditorSession(ws.data.sessionId);
					if (!native) {
						ws.close(1011, "Editor session closed");
						return;
					}
					ws.data.commandState.captionsEnabled = native.captionsEnabled;
					let reply: EditorSocketReply;
					try {
						if (
							command.kind === "invoke" &&
							command.name === "getClipThumbnail"
						) {
							if (command.args.length !== 2)
								throw new Error("Invalid clip thumbnail request");
							reply = {
								kind: "result",
								id: command.id,
								value: await renderEditorClipThumbnail(
									native,
									command.args[0],
									command.args[1],
									ws.data.abort.signal,
								),
							};
						} else if (
							command.kind === "invoke" &&
							command.name === "getDisplayFrameForCropping"
						) {
							const fps = command.args[0];
							if (
								command.args.length !== 1 ||
								typeof fps !== "number" ||
								!Number.isInteger(fps) ||
								fps < 1 ||
								fps > 60
							) {
								throw new Error("Invalid crop frame rate");
							}
							const response = await native.request(`/crop-frame?fps=${fps}`, {
								signal: AbortSignal.any([
									ws.data.abort.signal,
									AbortSignal.timeout(30_000),
								]),
							});
							if (
								!response.ok ||
								response.headers.get("content-type") !== "image/jpeg"
							) {
								throw new Error(
									`Crop frame request failed: ${response.status}`,
								);
							}
							const contentLength = response.headers.get("content-length");
							if (
								contentLength &&
								Number(contentLength) > MAX_CROP_JPEG_BYTES
							) {
								throw new Error("Crop frame is too large");
							}
							const jpeg = Buffer.from(await response.arrayBuffer());
							if (jpeg.length < 4 || jpeg.length > MAX_CROP_JPEG_BYTES) {
								throw new Error("Crop frame is unavailable or too large");
							}
							reply = {
								kind: "result",
								id: command.id,
								value: { jpegBase64: jpeg.toString("base64") },
							};
						} else if (
							command.kind === "invoke" &&
							command.name === "generateExportPreviewFast"
						) {
							reply = {
								kind: "result",
								id: command.id,
								value: await renderEditorExportPreview(
									ws.data.sessionId,
									native,
									command.args[0],
									command.args[1],
									ws.data.abort.signal,
								),
							};
						} else if (
							command.kind === "invoke" &&
							command.name === "getExportEstimates"
						) {
							reply = {
								kind: "result",
								id: command.id,
								value: await getEditorExportEstimate(
									ws.data.sessionId,
									native,
									command.args,
									ws.data.abort.signal,
									(id, value) => {
										if (ws.readyState === 1)
											ws.send(JSON.stringify({ kind: "channel", id, value }));
									},
								),
							};
						} else if (
							command.kind === "invoke" &&
							command.name === "addAudioLibraryTrack"
						) {
							if (command.args.length !== 1)
								throw new Error("Invalid library track request");
							reply = {
								kind: "result",
								id: command.id,
								value: await addEditorAudioLibraryTrack(
									native.projectPath,
									command.args[0],
								),
							};
						} else if (
							command.kind === "invoke" &&
							command.name === "cancelExportEstimates"
						) {
							cancelEditorExportEstimate(ws.data.sessionId);
							reply = { kind: "result", id: command.id, value: null };
						} else {
							reply = await dispatchEditorSocketCommand(
								ws.data.sessionId,
								command,
								ws.data.commandState,
								async (path, method, body, eventOnly) => {
									const nativeBody =
										path === "/config/memory" && method === "PUT"
											? mapEditorConfigPaths(body, "native", native.projectPath)
											: body;
									const headers = new Headers();
									if (nativeBody !== undefined)
										headers.set("Content-Type", "application/json");
									if (eventOnly)
										headers.set("Accept", "application/vnd.cap.editor-event");
									const response = await native.request(path, {
										method,
										headers,
										...(nativeBody === undefined
											? {}
											: { body: JSON.stringify(nativeBody) }),
										signal: AbortSignal.any([
											ws.data.abort.signal,
											AbortSignal.timeout(parallelRead ? 60_000 : 10_000),
										]),
									});
									if (!response.ok) {
										throw new Error(
											`Editor renderer request failed: ${response.status}`,
										);
									}
									if (response.status === 204) return null;
									if (eventOnly) {
										await response.body?.cancel();
										return null;
									}
									const value: unknown = await response.json();
									if (path === "/instance")
										return mapEditorInstanceConfigPaths(
											value,
											"browser",
											native.projectPath,
										);
									if (path === "/config")
										return mapEditorConfigPaths(
											value,
											"browser",
											native.projectPath,
										);
									return value;
								},
							);
						}
					} catch (cause) {
						reply = {
							kind: "error",
							id: command.id,
							error:
								cause instanceof Error
									? cause.message
									: "Editor command failed",
						};
					}
					if (ws.readyState === 1) ws.send(JSON.stringify(reply));
				})
				.catch((error) => {
					if (ws.readyState !== 1) return;
					console.error("Editor socket command failed", error);
					ws.close(1011, "Editor command unavailable");
				})
				.finally(() => {
					ws.data.pendingCommands--;
				});
			if (!parallelRead) ws.data.commandQueue = commandTask;
		},
		open(ws) {
			if (!attachEditorSession(ws.data.sessionId)) {
				ws.close(1011, "Editor session closed");
				return;
			}
			if (ws.data.scope === "commands") return;
			if (ws.data.upstream) return;
			connectEditorUpstream(ws, ws.data.upstreamUrl);
		},
		close(ws) {
			ws.data.abort.abort();
			const upstream = ws.data.upstream;
			ws.data.upstream = null;
			if (upstream && upstream.readyState < 2) upstream.close();
		},
		maxPayloadLength: MAX_COMMAND_BYTES,
		backpressureLimit: FRAME_BACKPRESSURE_BYTES,
		closeOnBackpressureLimit: false,
	};
