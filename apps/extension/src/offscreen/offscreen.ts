import type { OffscreenMessage } from "../lib/offscreen-messages";

let currentStream: MediaStream | null = null;
let hiddenVideo: HTMLVideoElement | null = null;

let frameChannel: BroadcastChannel | null = null;
let frameStreamingActive = false;
let frameIntervalId: ReturnType<typeof setInterval> | null = null;
let frameInFlight = false;

function createHiddenVideo(stream: MediaStream): HTMLVideoElement {
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.style.cssText =
		"position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
	video.srcObject = stream;
	document.body.appendChild(video);
	video.play().catch(() => {});
	return video;
}

function removeHiddenVideo(): void {
	if (hiddenVideo) {
		hiddenVideo.srcObject = null;
		hiddenVideo.remove();
		hiddenVideo = null;
	}
}

function ensureFrameChannel(): BroadcastChannel {
	if (!frameChannel) {
		frameChannel = new BroadcastChannel("cap-camera-frames");
		frameChannel.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (msg.type === "REQUEST_FRAMES") {
				startFrameStreaming();
			} else if (msg.type === "STOP_FRAMES") {
				stopFrameStreaming();
			}
		};
	}
	return frameChannel;
}

function startFrameStreaming(): void {
	stopFrameStreaming();
	if (!hiddenVideo) return;

	frameStreamingActive = true;
	frameInFlight = false;
	const channel = ensureFrameChannel();

	frameIntervalId = setInterval(() => {
		if (!frameStreamingActive) return;
		if (
			!hiddenVideo ||
			hiddenVideo.videoWidth === 0 ||
			hiddenVideo.videoHeight === 0
		) {
			return;
		}
		if (frameInFlight) return;

		frameInFlight = true;
		createImageBitmap(hiddenVideo)
			.then((bitmap) => {
				frameInFlight = false;
				if (!frameStreamingActive) {
					bitmap.close();
					return;
				}
				channel.postMessage({ type: "FRAME", bitmap });
				bitmap.close();
			})
			.catch(() => {
				frameInFlight = false;
			});
	}, 33);
}

function stopFrameStreaming(): void {
	frameStreamingActive = false;
	frameInFlight = false;
	if (frameIntervalId !== null) {
		clearInterval(frameIntervalId);
		frameIntervalId = null;
	}
}

async function startCamera(deviceId: string): Promise<void> {
	stopCamera();

	const stream = await navigator.mediaDevices.getUserMedia({
		video: { deviceId: { exact: deviceId } },
	});

	currentStream = stream;
	hiddenVideo = createHiddenVideo(stream);
}

function stopCamera(): void {
	stopFrameStreaming();

	if (currentStream) {
		for (const track of currentStream.getTracks()) {
			track.stop();
		}
		currentStream = null;
	}

	removeHiddenVideo();
}

async function switchCamera(deviceId: string): Promise<void> {
	if (currentStream) {
		for (const track of currentStream.getTracks()) {
			track.stop();
		}
	}

	const newStream = await navigator.mediaDevices.getUserMedia({
		video: { deviceId: { exact: deviceId } },
	});

	currentStream = newStream;

	if (hiddenVideo) {
		hiddenVideo.srcObject = newStream;
	} else {
		hiddenVideo = createHiddenVideo(newStream);
	}
}

function captureFrame(mirrored: boolean): string | null {
	if (
		!hiddenVideo ||
		hiddenVideo.videoWidth === 0 ||
		hiddenVideo.videoHeight === 0
	) {
		return null;
	}

	const maxSide = 420;
	const srcWidth = hiddenVideo.videoWidth;
	const srcHeight = hiddenVideo.videoHeight;
	const scale = Math.min(1, maxSide / Math.max(srcWidth, srcHeight));
	const width = Math.max(1, Math.round(srcWidth * scale));
	const height = Math.max(1, Math.round(srcHeight * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	if (mirrored) {
		ctx.translate(canvas.width, 0);
		ctx.scale(-1, 1);
	}

	ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", 0.7);
}

ensureFrameChannel();

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: ChromeMessageSender,
		sendResponse: ChromeMessageResponse,
	) => {
		const msg = message as OffscreenMessage;

		if (msg.type === "OFFSCREEN_START_CAMERA") {
			startCamera(msg.deviceId)
				.then(() => sendResponse({ ok: true }))
				.catch((err) => sendResponse({ ok: false, error: String(err) }));
			return true;
		}

		if (msg.type === "OFFSCREEN_STOP_CAMERA") {
			stopCamera();
			sendResponse({ ok: true });
			return;
		}

		if (msg.type === "OFFSCREEN_SWITCH_CAMERA") {
			switchCamera(msg.deviceId)
				.then(() => sendResponse({ ok: true }))
				.catch((err) => sendResponse({ ok: false, error: String(err) }));
			return true;
		}

		if (msg.type === "OFFSCREEN_CAPTURE_FRAME") {
			const dataUrl = captureFrame(msg.mirrored);
			sendResponse({ dataUrl });
			return;
		}

		return false;
	},
);
