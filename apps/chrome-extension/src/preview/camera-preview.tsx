import { PictureInPicture } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { toCameraDevices } from "../shared/devices";
import { sendServiceWorkerMessage } from "../shared/runtime";
import type {
	CameraPreviewErrorReason,
	CameraPreviewEvent,
	WebcamPreviewFrame,
	WebcamSettings,
} from "../shared/types";
import {
	toSessionDescriptionInit,
	waitForIceGatheringComplete,
} from "../shared/webrtc";
import "./styles.css";

const FRAME_CAPTURE_INTERVAL_MS = 700;
const FRAME_CAPTURE_MAX_WIDTH = 320;

type ParentMessage =
	| {
			source: "cap-extension-overlay";
			token: string;
			type: "settings";
			settings: WebcamSettings;
	  }
	| {
			source: "cap-extension-overlay";
			token: string;
			type: "toggle-pip";
	  }
	| {
			source: "cap-extension-overlay";
			token: string;
			type: "enter-pip";
	  }
	| {
			source: "cap-extension-overlay";
			token: string;
			type: "exit-auto-pip";
	  }
	| {
			source: "cap-extension-overlay";
			token: string;
			type: "stop";
	  };

const token = decodeURIComponent(window.location.hash.slice(1));

const isParentMessage = (value: unknown): value is ParentMessage => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ParentMessage>;
	return (
		candidate.source === "cap-extension-overlay" && candidate.token === token
	);
};

// Events for the embedding overlay travel over chrome.runtime via the
// service worker, never window.parent.postMessage: the parent window is the
// recorded web page, and a postMessage stream — webcam frames above all —
// would be readable by any listener that page installs. The service worker
// validates this frame's URL and registered token before relaying to the
// embedding tab's content script.
const postParent = (event: CameraPreviewEvent) => {
	chrome.runtime.sendMessage(
		{
			target: "service-worker",
			type: "camera-preview-event",
			token,
			event,
		},
		() => {
			void chrome.runtime.lastError;
		},
	);
};

const waitForRemoteStream = (peer: RTCPeerConnection) =>
	new Promise<MediaStream>((resolve, reject) => {
		let settled = false;
		const timeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("Camera preview timed out."));
		}, 10000);

		const finish = (stream: MediaStream) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			resolve(stream);
		};

		peer.addEventListener("track", (event) => {
			finish(event.streams[0] ?? new MediaStream([event.track]));
		});

		peer.addEventListener("connectionstatechange", () => {
			if (
				settled ||
				(peer.connectionState !== "failed" && peer.connectionState !== "closed")
			) {
				return;
			}
			settled = true;
			window.clearTimeout(timeout);
			reject(new Error("Camera preview connection failed."));
		});
	});

const connectCameraPreview = async (
	settings: WebcamSettings,
	sessionId: string,
) => {
	const peer = new RTCPeerConnection();
	peer.addTransceiver("video", { direction: "recvonly" });
	const remoteStreamPromise = waitForRemoteStream(peer);
	await peer.setLocalDescription(await peer.createOffer());
	await waitForIceGatheringComplete(peer);

	const response = await sendServiceWorkerMessage({
		target: "service-worker",
		type: "connect-camera-preview",
		sessionId,
		settings,
		offer: toSessionDescriptionInit(peer.localDescription),
	});

	if (!response.ok) {
		peer.close();
		throw new Error(response.error);
	}
	if (!response.answer) {
		peer.close();
		throw new Error("Camera preview did not return an answer.");
	}

	await peer.setRemoteDescription(response.answer);
	return {
		peer,
		stream: await remoteStreamPromise,
	};
};

let frameCanvas: HTMLCanvasElement | null = null;

const captureVideoFrame = (
	video: HTMLVideoElement,
): WebcamPreviewFrame | null => {
	if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
	frameCanvas ??= document.createElement("canvas");
	const scale = Math.min(1, FRAME_CAPTURE_MAX_WIDTH / video.videoWidth);
	const width = Math.max(1, Math.round(video.videoWidth * scale));
	const height = Math.max(1, Math.round(video.videoHeight * scale));
	frameCanvas.width = width;
	frameCanvas.height = height;
	const context = frameCanvas.getContext("2d");
	if (!context) return null;
	context.drawImage(video, 0, 0, width, height);
	return {
		dataUrl: frameCanvas.toDataURL("image/jpeg", 0.72),
		dimensions: {
			width: video.videoWidth,
			height: video.videoHeight,
		},
		capturedAt: Date.now(),
	};
};

const stopStream = (stream: MediaStream | null) => {
	if (!stream) return;
	for (const track of stream.getTracks()) {
		track.stop();
	}
};

const disconnectCameraPreview = (sessionId: string | null) => {
	if (!sessionId) return;
	void sendServiceWorkerMessage({
		target: "service-worker",
		type: "disconnect-camera-preview",
		sessionId,
	}).catch(() => undefined);
};

const isSameWebcamSettings = (
	current: WebcamSettings | null,
	next: WebcamSettings,
) =>
	current?.enabled === next.enabled &&
	current.deviceId === next.deviceId &&
	current.position === next.position &&
	current.size === next.size &&
	current.shape === next.shape &&
	current.mirror === next.mirror;

const getCameraErrorDetails = (
	error: unknown,
): { reason: CameraPreviewErrorReason; message: string } => {
	if (!(error instanceof Error)) {
		return { reason: "unknown", message: "Camera unavailable" };
	}
	const lowerMessage = error.message.toLowerCase();
	if (error.name === "NotAllowedError" || lowerMessage.includes("permission")) {
		return {
			reason: "permission",
			message:
				"Camera permission was dismissed. Select a camera again and choose Allow.",
		};
	}
	if (error.name === "NotFoundError") {
		return { reason: "not-found", message: "Selected camera was not found." };
	}
	if (error.name === "NotReadableError") {
		return { reason: "in-use", message: "Selected camera is already in use." };
	}
	return { reason: "unknown", message: error.message || "Camera unavailable" };
};

type AutoPictureInPictureVideo = HTMLVideoElement & {
	autoPictureInPicture?: boolean;
};

const publishCameraDevices = async () => {
	const devices = toCameraDevices(
		await navigator.mediaDevices.enumerateDevices(),
	);
	chrome.runtime.sendMessage(
		{
			target: "service-worker",
			type: "camera-devices-updated",
			devices,
		},
		() => undefined,
	);
};

function App() {
	const [settings, setSettings] = useState<WebcamSettings | null>(null);
	const [isInPictureInPicture, setIsInPictureInPicture] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const peerRef = useRef<RTCPeerConnection | null>(null);
	const activeDeviceRef = useRef<string | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const sessionCounterRef = useRef(0);
	const autoPictureInPictureRef = useRef(false);
	const autoPictureInPictureEnabledRef = useRef(false);
	const previewEnabled = Boolean(settings?.enabled && settings.deviceId);
	const isPictureInPictureSupported =
		typeof document !== "undefined" && document.pictureInPictureEnabled;

	const publishPreviewFrame = useCallback(() => {
		const currentVideo = videoRef.current;
		if (!currentVideo) return;
		const frame = captureVideoFrame(currentVideo);
		if (!frame) return;
		postParent({
			type: "frame",
			frame,
		});
	}, []);

	const setAutomaticPictureInPicture = useCallback((enabled: boolean) => {
		autoPictureInPictureEnabledRef.current = enabled;
		const currentVideo = videoRef.current as AutoPictureInPictureVideo | null;
		if (currentVideo && "autoPictureInPicture" in currentVideo) {
			currentVideo.autoPictureInPicture = enabled;
		}

		try {
			navigator.mediaSession?.setActionHandler(
				"enterpictureinpicture" as MediaSessionAction,
				enabled
					? async () => {
							const video = videoRef.current;
							if (!video || document.pictureInPictureElement) return;
							try {
								autoPictureInPictureRef.current = true;
								await video.requestPictureInPicture();
							} catch {
								autoPictureInPictureRef.current = false;
							}
						}
					: null,
			);
		} catch {}
	}, []);

	const stopPreview = useCallback(() => {
		setAutomaticPictureInPicture(false);
		if (
			videoRef.current &&
			document.pictureInPictureElement === videoRef.current
		) {
			document.exitPictureInPicture().catch(() => undefined);
		}
		stopStream(streamRef.current);
		peerRef.current?.close();
		disconnectCameraPreview(sessionIdRef.current);
		peerRef.current = null;
		streamRef.current = null;
		activeDeviceRef.current = null;
		sessionIdRef.current = null;
		videoRef.current?.removeAttribute("src");
		if (videoRef.current) {
			videoRef.current.srcObject = null;
		}
		setIsInPictureInPicture(false);
		postParent({
			type: "pip-state",
			active: false,
			supported: isPictureInPictureSupported,
		});
	}, [isPictureInPictureSupported, setAutomaticPictureInPicture]);

	const enterPictureInPicture = useCallback(
		async (auto: boolean) => {
			const currentVideo = videoRef.current;
			if (auto) {
				setAutomaticPictureInPicture(true);
			}
			if (!currentVideo || !isPictureInPictureSupported) return;

			try {
				if (document.pictureInPictureElement === currentVideo) {
					if (!auto) autoPictureInPictureRef.current = false;
					return;
				}
				if (document.pictureInPictureElement) return;
				await currentVideo.requestPictureInPicture();
				autoPictureInPictureRef.current = auto;
			} catch {
				autoPictureInPictureRef.current = false;
			}
		},
		[isPictureInPictureSupported, setAutomaticPictureInPicture],
	);

	const exitAutoPictureInPicture = useCallback(async () => {
		setAutomaticPictureInPicture(false);
		const currentVideo = videoRef.current;
		if (
			!currentVideo ||
			!autoPictureInPictureRef.current ||
			document.pictureInPictureElement !== currentVideo
		) {
			return;
		}

		try {
			await document.exitPictureInPicture();
		} catch {
			autoPictureInPictureRef.current = false;
		}
	}, [setAutomaticPictureInPicture]);

	const togglePictureInPicture = useCallback(async () => {
		const currentVideo = videoRef.current;
		if (!currentVideo || !isPictureInPictureSupported) return;

		try {
			setAutomaticPictureInPicture(false);
			autoPictureInPictureRef.current = false;
			if (document.pictureInPictureElement === currentVideo) {
				await document.exitPictureInPicture();
			} else {
				await currentVideo.requestPictureInPicture();
			}
		} catch {
			autoPictureInPictureRef.current = false;
		}
	}, [isPictureInPictureSupported, setAutomaticPictureInPicture]);

	useEffect(() => {
		postParent({
			type: "ready",
		});
		postParent({
			type: "pip-state",
			active: false,
			supported: isPictureInPictureSupported,
		});
	}, [isPictureInPictureSupported]);

	useEffect(() => {
		// Control messages arrive over chrome.runtime, which the host page (and
		// other extensions) cannot speak — window messages were forgeable since
		// the token is readable from the iframe src in the page DOM. The token
		// check scopes the runtime broadcast to this tab's preview.
		const handleMessage = (message: unknown) => {
			if (!isParentMessage(message)) return false;

			if (message.type === "settings") {
				const nextSettings = message.settings;
				setSettings((current) =>
					isSameWebcamSettings(current, nextSettings) ? current : nextSettings,
				);
				window.setTimeout(publishPreviewFrame, 0);
				return false;
			}

			if (message.type === "toggle-pip") {
				void togglePictureInPicture();
				return false;
			}

			if (message.type === "enter-pip") {
				void enterPictureInPicture(true);
				return false;
			}

			if (message.type === "exit-auto-pip") {
				void exitAutoPictureInPicture();
				return false;
			}

			setSettings(null);
			stopPreview();
			return false;
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [
		enterPictureInPicture,
		exitAutoPictureInPicture,
		publishPreviewFrame,
		stopPreview,
		togglePictureInPicture,
	]);

	useEffect(() => {
		if (!previewEnabled || !settings) {
			stopPreview();
			return;
		}

		let disposed = false;

		const startPreview = async () => {
			const peerActive =
				peerRef.current &&
				peerRef.current.connectionState !== "closed" &&
				peerRef.current.connectionState !== "failed" &&
				peerRef.current.connectionState !== "disconnected";
			if (
				streamRef.current &&
				peerActive &&
				activeDeviceRef.current === settings.deviceId
			) {
				if (
					videoRef.current &&
					videoRef.current.srcObject !== streamRef.current
				) {
					videoRef.current.srcObject = streamRef.current;
				}
				await videoRef.current?.play().catch(() => undefined);
				return;
			}

			stopPreview();
			const sessionId = `${token}:${Date.now()}:${sessionCounterRef.current + 1}`;
			sessionCounterRef.current += 1;
			sessionIdRef.current = sessionId;
			postParent({
				type: "session",
				sessionId,
			});

			try {
				const { peer, stream } = await connectCameraPreview(
					settings,
					sessionId,
				);

				if (disposed || sessionIdRef.current !== sessionId) {
					peer.close();
					stopStream(stream);
					disconnectCameraPreview(sessionId);
					return;
				}

				peerRef.current = peer;
				streamRef.current = stream;
				activeDeviceRef.current = settings.deviceId;

				if (videoRef.current) {
					videoRef.current.srcObject = stream;
					if (autoPictureInPictureEnabledRef.current) {
						setAutomaticPictureInPicture(true);
					}
					await videoRef.current.play().catch(() => undefined);
				}
				publishPreviewFrame();
				await publishCameraDevices().catch(() => undefined);
			} catch (error) {
				if (!disposed) {
					const details = getCameraErrorDetails(error);
					stopPreview();
					postParent({
						type: "error",
						reason: details.reason,
						message: details.message,
					});
				}
			}
		};

		void startPreview();

		return () => {
			disposed = true;
		};
	}, [
		previewEnabled,
		publishPreviewFrame,
		settings,
		setAutomaticPictureInPicture,
		stopPreview,
	]);

	useEffect(() => {
		if (!previewEnabled) return;
		const interval = window.setInterval(
			publishPreviewFrame,
			FRAME_CAPTURE_INTERVAL_MS,
		);
		return () => window.clearInterval(interval);
	}, [previewEnabled, publishPreviewFrame]);

	useEffect(() => {
		if (!videoRef.current || !isPictureInPictureSupported) {
			return;
		}

		const currentVideo = videoRef.current;
		const handlePipEnter = () => {
			setIsInPictureInPicture(true);
			postParent({
				type: "pip-state",
				active: true,
				supported: true,
			});
		};
		const handlePipLeave = () => {
			autoPictureInPictureRef.current = false;
			setAutomaticPictureInPicture(false);
			setIsInPictureInPicture(false);
			postParent({
				type: "pip-state",
				active: false,
				supported: true,
			});
		};

		currentVideo.addEventListener("enterpictureinpicture", handlePipEnter);
		currentVideo.addEventListener("leavepictureinpicture", handlePipLeave);

		return () => {
			currentVideo.removeEventListener("enterpictureinpicture", handlePipEnter);
			currentVideo.removeEventListener("leavepictureinpicture", handlePipLeave);
		};
	}, [isPictureInPictureSupported, setAutomaticPictureInPicture]);

	useEffect(() => {
		return () => {
			stopPreview();
		};
	}, [stopPreview]);

	return (
		<div
			className="camera-preview-root"
			onPointerEnter={() => {
				postParent({ type: "pointer-presence", inside: true });
			}}
			onPointerLeave={() => {
				postParent({ type: "pointer-presence", inside: false });
			}}
			onPointerDown={(event) => {
				if ((event.target as HTMLElement).closest("[data-pip-control]")) {
					return;
				}
				event.preventDefault();
				postParent({
					type: "drag-start",
					clientX: event.clientX,
					clientY: event.clientY,
				});
			}}
			onPointerUp={() => {
				postParent({ type: "drag-end" });
			}}
			onPointerCancel={() => {
				postParent({ type: "drag-end" });
			}}
		>
			<video
				ref={videoRef}
				autoPlay
				playsInline
				muted
				disablePictureInPicture={false}
				controlsList="nodownload nofullscreen noremoteplayback"
				data-pip={isInPictureInPicture ? "true" : "false"}
				data-mirror={settings?.mirror ? "true" : "false"}
				onLoadedMetadata={() => {
					const currentVideo = videoRef.current;
					if (!currentVideo) return;
					if (currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
						postParent({
							type: "metadata",
							dimensions: {
								width: currentVideo.videoWidth,
								height: currentVideo.videoHeight,
							},
						});
						publishPreviewFrame();
					}
				}}
				onLoadedData={publishPreviewFrame}
				onPlaying={publishPreviewFrame}
			/>
			{isPictureInPictureSupported && !isInPictureInPicture ? (
				<button
					type="button"
					className="camera-preview-pip-button"
					data-pip-control
					aria-label="Open Picture in Picture"
					title="Picture in Picture"
					onClick={togglePictureInPicture}
				>
					<PictureInPicture size={20} aria-hidden />
				</button>
			) : null}
		</div>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
