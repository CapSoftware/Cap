import { onCleanup } from "solid-js";

export type EditorSocketCredential = { url: string; ticket: string };

const frameSocketCredentials = new Map<string, string>();
const compressedFrameMagic = new Uint8Array([67, 65, 80, 80, 78, 71, 48, 49]);
const h264FrameMagic = new Uint8Array([67, 65, 80, 72, 50, 54, 52, 49]);
const bandwidthProbeMagic = new Uint8Array([67, 65, 80, 66, 65, 78, 68, 49]);
const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const rgbaCopyOptions = { format: "RGBA" as const };

type PixelCanvas = OffscreenCanvas | HTMLCanvasElement;
type PixelContext =
	| OffscreenCanvasRenderingContext2D
	| CanvasRenderingContext2D;

function createPixelCanvas(width: number, height: number) {
	if (typeof OffscreenCanvas !== "undefined") {
		try {
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context) return { canvas, context };
		} catch {}
	}
	if (typeof document === "undefined") {
		throw new Error("Editor frame canvas is unavailable");
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Editor frame canvas is unavailable");
	return {
		canvas,
		context,
	};
}

async function decodePngImage(bytes: Uint8Array<ArrayBuffer>) {
	const blob = new Blob([bytes], { type: "image/png" });
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(blob, {
			colorSpaceConversion: "none",
			premultiplyAlpha: "none",
		});
		return {
			image: bitmap as CanvasImageSource,
			width: bitmap.width,
			height: bitmap.height,
			dispose: () => bitmap.close(),
		};
	}
	if (
		typeof Image === "undefined" ||
		typeof URL.createObjectURL !== "function"
	) {
		throw new Error("Editor PNG frame decoder is unavailable");
	}
	const objectUrl = URL.createObjectURL(blob);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () =>
				reject(new Error("Editor PNG frame could not load"));
			image.src = objectUrl;
		});
		return {
			image: image as CanvasImageSource,
			width: image.naturalWidth,
			height: image.naturalHeight,
			dispose: () => URL.revokeObjectURL(objectUrl),
		};
	} catch (error) {
		URL.revokeObjectURL(objectUrl);
		throw error;
	}
}

type H264FramePacket = {
	sequence: number;
	isKeyframe: boolean;
	width: number;
	height: number;
	frameNumber: number;
	targetTimeNs: bigint;
	data: Uint8Array;
	displayEpoch: number;
};

function isH264Frame(buffer: ArrayBuffer) {
	if (buffer.byteLength < 41) return false;
	const bytes = new Uint8Array(buffer, 0, h264FrameMagic.length);
	return bytes.every((byte, index) => byte === h264FrameMagic[index]);
}

function isBandwidthProbe(buffer: ArrayBuffer) {
	if (buffer.byteLength !== 8 + 512 * 1024) return false;
	const bytes = new Uint8Array(buffer, 0, bandwidthProbeMagic.length);
	return bytes.every((byte, index) => byte === bandwidthProbeMagic[index]);
}

function parseH264Frame(buffer: ArrayBuffer): H264FramePacket {
	const header = new DataView(buffer, 0, 41);
	const sequence = Number(header.getBigUint64(8, true));
	const keyframe = header.getUint8(16);
	const width = header.getUint32(17, true);
	const height = header.getUint32(21, true);
	const frameNumber = header.getUint32(25, true);
	const targetTimeNs = header.getBigUint64(29, true);
	const length = header.getUint32(37, true);
	if (
		!Number.isSafeInteger(sequence) ||
		keyframe > 1 ||
		width < 1 ||
		height < 1 ||
		width > 3840 ||
		height > 2160 ||
		width * height * 4 > 32 * 1024 * 1024 ||
		length < 1 ||
		length > 8 * 1024 * 1024 ||
		buffer.byteLength !== 41 + length
	) {
		throw new Error("Editor H.264 frame was invalid");
	}
	return {
		sequence,
		isKeyframe: keyframe === 1,
		width,
		height,
		frameNumber,
		targetTimeNs,
		data: new Uint8Array(buffer, 41, length),
		displayEpoch: 0,
	};
}

function isCompressedFrame(buffer: ArrayBuffer) {
	if (buffer.byteLength < 48) return false;
	const bytes = new Uint8Array(buffer, 0, compressedFrameMagic.length);
	return bytes.every((byte, index) => byte === compressedFrameMagic[index]);
}

export function setEditorFrameSocketCredential(
	credential: EditorSocketCredential | null,
) {
	frameSocketCredentials.clear();
	if (!credential) return;
	const url = new URL(credential.url);
	if (
		(url.protocol !== "wss:" &&
			!(
				url.protocol === "ws:" &&
				["localhost", "127.0.0.1"].includes(url.hostname)
			)) ||
		url.username ||
		url.password ||
		!/^[A-Za-z0-9_-]{43}$/.test(credential.ticket)
	) {
		throw new Error("Invalid editor frame socket credential");
	}
	frameSocketCredentials.set(credential.url, credential.ticket);
}

export function createWS(url: string) {
	const ticket = frameSocketCredentials.get(url);
	if (!ticket) throw new Error("Editor frame socket credential is unavailable");
	frameSocketCredentials.delete(url);
	const socket = new WebSocket(url, [
		"cap-editor-v1",
		`cap-editor-ticket.${ticket}`,
	]);
	socket.binaryType = "arraybuffer";
	let canvas: PixelCanvas | null = null;
	let context: PixelContext | null = null;
	let latest: ArrayBuffer | null = null;
	let decoding = false;
	let h264Requested =
		typeof VideoDecoder !== "undefined" &&
		typeof EncodedVideoChunk !== "undefined" &&
		typeof VideoFrame !== "undefined";
	let h264Decoder: VideoDecoder | null = null;
	let h264Dimensions: { width: number; height: number } | null = null;
	let h264Sequence: number | null = null;
	let h264ConfigGeneration = 0;
	let h264DisplayEpoch = 0;
	let h264LowRequested = false;
	let bandwidthProbeStartedAt: number | null = null;
	let h264FirstPacketTime: number | null = null;
	let h264FirstTargetNs: bigint | null = null;
	let h264LastTargetNs: bigint | null = null;
	let pendingH264: H264FramePacket[] = [];
	const h264Metadata = new Map<number, H264FramePacket>();
	let latestDecoded: { frame: VideoFrame; packet: H264FramePacket } | null =
		null;
	let copyingDecoded = false;
	let h264Canvas: PixelCanvas | null = null;
	let h264Context: PixelContext | null = null;
	const copyDecodedFrameWithCanvas = (
		frame: VideoFrame,
		packet: H264FramePacket,
		destination: Uint8Array,
	) => {
		if (
			!h264Canvas ||
			h264Canvas.width !== packet.width ||
			h264Canvas.height !== packet.height
		) {
			const surface = createPixelCanvas(packet.width, packet.height);
			h264Canvas = surface.canvas;
			h264Context = surface.context;
		}
		if (!h264Context)
			throw new Error("Editor H.264 frame conversion is unavailable");
		h264Context.drawImage(frame, 0, 0, packet.width, packet.height);
		destination.set(
			h264Context.getImageData(0, 0, packet.width, packet.height).data,
		);
	};
	const decode = async (buffer: ArrayBuffer) => {
		const footerOffset = buffer.byteLength - 24;
		const meta = new DataView(buffer, footerOffset, 24);
		const width = meta.getUint32(8, true);
		const height = meta.getUint32(4, true);
		const rowBytes = width * 4;
		const pngBytes = new Uint8Array(
			buffer,
			compressedFrameMagic.length,
			footerOffset - compressedFrameMagic.length,
		);
		if (
			width < 1 ||
			height < 1 ||
			width > 3840 ||
			height > 2160 ||
			rowBytes * height > 32 * 1024 * 1024 ||
			pngBytes.length > 8 * 1024 * 1024 ||
			!pngMagic.every((byte, index) => pngBytes[index] === byte)
		) {
			throw new Error("Editor frame was invalid");
		}
		const decoded = await decodePngImage(pngBytes);
		try {
			if (decoded.width !== width || decoded.height !== height) {
				throw new Error("Editor frame dimensions changed");
			}
			if (!canvas || canvas.width !== width || canvas.height !== height) {
				const surface = createPixelCanvas(width, height);
				canvas = surface.canvas;
				context = surface.context;
			}
			if (!context) throw new Error("Editor frame decoder is unavailable");
			context.clearRect(0, 0, width, height);
			context.drawImage(decoded.image, 0, 0);
			const pixels = context.getImageData(0, 0, width, height).data;
			const raw = new ArrayBuffer(pixels.length + 24);
			const rawBytes = new Uint8Array(raw);
			rawBytes.set(pixels);
			rawBytes.set(new Uint8Array(buffer, footerOffset, 24), pixels.length);
			new DataView(raw, pixels.length, 24).setUint32(0, rowBytes, true);
			return raw;
		} finally {
			decoded.dispose();
		}
	};
	const drain = async () => {
		try {
			while (latest && socket.readyState === WebSocket.OPEN) {
				const packet = latest;
				latest = null;
				const raw = await decode(packet);
				if (!latest && socket.readyState === WebSocket.OPEN) {
					socket.dispatchEvent(new MessageEvent("message", { data: raw }));
				}
			}
		} catch {
			socket.close(4003, "Invalid editor frame");
		} finally {
			decoding = false;
		}
	};
	const fallbackToPng = (reason: string) => {
		if (!h264Requested) return;
		console.warn("Editor H.264 preview switched to PNG", reason);
		h264Requested = false;
		h264ConfigGeneration++;
		h264Decoder?.close();
		h264Decoder = null;
		h264Dimensions = null;
		pendingH264 = [];
		h264Metadata.clear();
		latestDecoded?.frame.close();
		latestDecoded = null;
		if (socket.readyState === WebSocket.OPEN) socket.send('{"mode":"png"}');
	};
	const drainDecoded = async () => {
		try {
			while (latestDecoded && h264Requested) {
				const decoded = latestDecoded;
				latestDecoded = null;
				const { frame, packet } = decoded;
				const generation = h264ConfigGeneration;
				try {
					if (
						frame.displayWidth !== packet.width ||
						frame.displayHeight !== packet.height
					) {
						throw new Error("Editor H.264 frame dimensions changed");
					}
					const pixelBytes = packet.width * packet.height * 4;
					const raw = new ArrayBuffer(pixelBytes + 24);
					const pixels = new Uint8Array(raw, 0, pixelBytes);
					let directCopy = false;
					try {
						if (frame.allocationSize(rgbaCopyOptions) === pixelBytes) {
							const layouts = await frame.copyTo(pixels, rgbaCopyOptions);
							directCopy =
								layouts.length === 1 && layouts[0]?.stride === packet.width * 4;
						}
					} catch {}
					if (!directCopy) copyDecodedFrameWithCanvas(frame, packet, pixels);
					const footer = new DataView(raw, pixelBytes, 24);
					footer.setUint32(0, packet.width * 4, true);
					footer.setUint32(4, packet.height, true);
					footer.setUint32(8, packet.width, true);
					footer.setUint32(12, packet.frameNumber, true);
					footer.setBigUint64(16, packet.targetTimeNs, true);
					if (
						!latestDecoded &&
						!decoding &&
						h264Requested &&
						generation === h264ConfigGeneration &&
						packet.displayEpoch === h264DisplayEpoch &&
						socket.readyState === WebSocket.OPEN
					) {
						socket.dispatchEvent(new MessageEvent("message", { data: raw }));
					}
				} finally {
					frame.close();
				}
			}
		} catch (error) {
			fallbackToPng(
				error instanceof Error ? error.message : "Frame copy failed",
			);
		} finally {
			copyingDecoded = false;
		}
	};
	const decodeH264 = (packet: H264FramePacket) => {
		const decoder = h264Decoder;
		const dimensions = h264Dimensions;
		if (!decoder || !dimensions) {
			pendingH264.push(packet);
			if (pendingH264.length > 16)
				fallbackToPng("H.264 decoder configuration was delayed");
			return;
		}
		if (
			packet.width !== dimensions.width ||
			packet.height !== dimensions.height
		) {
			fallbackToPng("H.264 preview dimensions changed");
			return;
		}
		if (
			(h264Sequence !== null && packet.sequence !== h264Sequence + 1) ||
			(h264Sequence === null && !packet.isKeyframe)
		) {
			fallbackToPng("H.264 preview packet sequence was interrupted");
			return;
		}
		if (decoder.decodeQueueSize > 32 || h264Metadata.size > 64) {
			fallbackToPng("H.264 decoder queue was overloaded");
			return;
		}
		h264Sequence = packet.sequence;
		h264Metadata.set(packet.sequence, packet);
		try {
			decoder.decode(
				new EncodedVideoChunk({
					type: packet.isKeyframe ? "key" : "delta",
					timestamp: packet.sequence,
					data: packet.data,
				}),
			);
		} catch (error) {
			fallbackToPng(
				error instanceof Error ? error.message : "H.264 decode failed",
			);
		}
	};
	const configureH264 = async (
		codec: string,
		width: number,
		height: number,
	) => {
		const generation = ++h264ConfigGeneration;
		h264Decoder?.close();
		h264Decoder = null;
		h264Dimensions = null;
		h264Sequence = null;
		h264FirstPacketTime = null;
		h264FirstTargetNs = null;
		h264LastTargetNs = null;
		h264Metadata.clear();
		pendingH264 = [];
		try {
			const configuration: VideoDecoderConfig = {
				codec,
				codedWidth: width,
				codedHeight: height,
				optimizeForLatency: true,
				hardwareAcceleration: "no-preference",
			};
			const support = await VideoDecoder.isConfigSupported(configuration);
			if (!h264Requested || generation !== h264ConfigGeneration) return;
			if (!support.supported) {
				fallbackToPng("H.264 codec is unsupported");
				return;
			}
			h264Dimensions = { width, height };
			h264Decoder = new VideoDecoder({
				output(frame) {
					const packet = h264Metadata.get(frame.timestamp);
					if (
						!packet ||
						!h264Requested ||
						generation !== h264ConfigGeneration ||
						packet.displayEpoch !== h264DisplayEpoch
					) {
						frame.close();
						return;
					}
					h264Metadata.delete(frame.timestamp);
					latestDecoded?.frame.close();
					latestDecoded = { frame, packet };
					if (!copyingDecoded) {
						copyingDecoded = true;
						void drainDecoded();
					}
				},
				error(error) {
					fallbackToPng(error.message);
				},
			});
			h264Decoder.configure(configuration);
			for (const packet of pendingH264) decodeH264(packet);
			pendingH264 = [];
		} catch (error) {
			fallbackToPng(
				error instanceof Error ? error.message : "H.264 configuration failed",
			);
		}
	};
	socket.addEventListener("open", () => {
		if (h264Requested) {
			socket.send('{"mode":"h264"}');
			socket.send('{"bitrate":"low"}');
			h264LowRequested = true;
			bandwidthProbeStartedAt = performance.now();
			socket.send('{"probe":"bandwidth"}');
		}
	});
	socket.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (event.data instanceof ArrayBuffer && isBandwidthProbe(event.data)) {
			event.stopImmediatePropagation();
			if (bandwidthProbeStartedAt !== null && h264Requested) {
				const elapsedMs = Math.max(
					1,
					performance.now() - bandwidthProbeStartedAt,
				);
				const measuredMbps = (512 * 1024 * 8 * 1000) / elapsedMs / 1_000_000;
				if (measuredMbps > 12 && socket.readyState === WebSocket.OPEN) {
					socket.send('{"bitrate":"high"}');
					h264LowRequested = false;
				}
			}
			bandwidthProbeStartedAt = null;
			return;
		}
		if (typeof event.data === "string" && h264Requested) {
			let value: unknown;
			try {
				value = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!value || typeof value !== "object" || !("kind" in value)) return;
			if (value.kind === "cap-h264-unavailable") {
				event.stopImmediatePropagation();
				fallbackToPng("H.264 preview became unavailable");
				return;
			}
			if (value.kind === "cap-h264-config") {
				event.stopImmediatePropagation();
				const codec = "codec" in value ? value.codec : null;
				const width = "width" in value ? value.width : null;
				const height = "height" in value ? value.height : null;
				if (
					typeof codec !== "string" ||
					!/^avc1\.[0-9a-f]{6}$/i.test(codec) ||
					typeof width !== "number" ||
					typeof height !== "number" ||
					width < 1 ||
					height < 1 ||
					width > 3840 ||
					height > 2160 ||
					width * height * 4 > 32 * 1024 * 1024
				) {
					fallbackToPng("H.264 configuration was invalid");
					return;
				}
				void configureH264(codec, width, height);
				return;
			}
		}
		if (event.data instanceof ArrayBuffer && isH264Frame(event.data)) {
			event.stopImmediatePropagation();
			if (!h264Requested) return;
			try {
				const packet = parseH264Frame(event.data);
				packet.displayEpoch = h264DisplayEpoch;
				const now = performance.now();
				if (
					h264LastTargetNs !== null &&
					(packet.targetTimeNs < h264LastTargetNs ||
						packet.targetTimeNs - h264LastTargetNs > 2_000_000_000n)
				) {
					h264FirstPacketTime = null;
					h264FirstTargetNs = null;
				}
				if (h264FirstPacketTime === null || h264FirstTargetNs === null) {
					h264FirstPacketTime = now;
					h264FirstTargetNs = packet.targetTimeNs;
				}
				h264LastTargetNs = packet.targetTimeNs;
				const mediaElapsedMs =
					Number(packet.targetTimeNs - h264FirstTargetNs) / 1_000_000;
				if (
					!h264LowRequested &&
					now - h264FirstPacketTime - mediaElapsedMs > 500 &&
					socket.readyState === WebSocket.OPEN
				) {
					h264LowRequested = true;
					socket.send('{"bitrate":"low"}');
				}
				decodeH264(packet);
			} catch (error) {
				fallbackToPng(
					error instanceof Error ? error.message : "H.264 packet was invalid",
				);
			}
			return;
		}
		if (!(event.data instanceof ArrayBuffer) || !isCompressedFrame(event.data))
			return;
		event.stopImmediatePropagation();
		if (h264Requested) {
			h264DisplayEpoch++;
			latestDecoded?.frame.close();
			latestDecoded = null;
		}
		latest = event.data;
		if (!decoding) {
			decoding = true;
			void drain();
		}
	});
	onCleanup(() => {
		h264ConfigGeneration++;
		h264Requested = false;
		h264Decoder?.close();
		latestDecoded?.frame.close();
		canvas = null;
		context = null;
		h264Canvas = null;
		h264Context = null;
		socket.close();
	});
	return socket;
}
