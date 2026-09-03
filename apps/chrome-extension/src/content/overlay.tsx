import { X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { isOverlayMessage } from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	loadLastWebcamPreviewFrame,
	loadOverlayUiState,
	loadSettings,
	loadSharedRecordingState,
	loadSharedUiState,
	loadWebcamPreviewDismissed,
	OVERLAY_UI_STATE_KEY,
	SETTINGS_KEY,
	SHARED_UI_STATE_KEY,
	saveLastWebcamPreviewFrame,
	saveSettings,
	updateOverlayUiState,
	updateSharedUiState,
	WEBCAM_PREVIEW_DISMISSED_KEY,
} from "../shared/storage";
import type {
	CameraPreviewEventRelay,
	ExtensionSettings,
	OverlayPosition,
	RecordingStatus,
	WebcamPosition,
	WebcamPreviewFrame,
	WebcamSettings,
	WebcamShape,
} from "../shared/types";
import {
	toSessionDescriptionInit,
	waitForIceGatheringComplete,
} from "../shared/webrtc";
import { ConfirmOverlay } from "./confirm-overlay";
import { CountdownOverlay } from "./countdown-overlay";
import overlayCss from "./overlay.css?inline";
import { RecordingBarOverlay } from "./recording-bar";
import { replayStartupMessages, setStartupMessages } from "./startup-messages";

const ROOT_ID = "cap-extension-recorder-overlay";
const WINDOW_PADDING = 20;
const BAR_HEIGHT = 52;
const createSecureToken = () => {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

const PREVIEW_TOKEN = createSecureToken();
const PREVIEW_URL = chrome.runtime.getURL("camera-preview.html");
const PREVIEW_SRC = `${PREVIEW_URL}#${encodeURIComponent(PREVIEW_TOKEN)}`;
const PREVIEW_ERROR_DELAY_MS = 1200;
const CAMERA_MIN_SIZE = 120;
const CAMERA_MAX_SIZE = 420;
const CAMERA_RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;
// Persisting every 700ms preview frame to session storage broadcasts a
// 10-30KB onChanged event to every open tab; the cached frame is only a
// placeholder, so a coarse cadence is plenty.
const FRAME_PERSIST_INTERVAL_MS = 5000;

// The extension iframes (camera preview, recorder panel) are web accessible,
// so the service worker only honours requests from frames whose URL-hash
// token was registered by this content script. Registration must complete
// before an iframe is rendered, otherwise its first camera connect races the
// registry write.
let overlayTokensRegistration: Promise<boolean> | null = null;

const ensureOverlayTokensRegistered = () => {
	overlayTokensRegistration ??= Promise.all(
		[PREVIEW_TOKEN].map((token) =>
			sendServiceWorkerMessage({
				target: "service-worker",
				type: "register-overlay-token",
				token,
			}),
		),
	)
		.then((responses) => {
			const registered = responses.every((response) => response.ok);
			if (!registered) {
				overlayTokensRegistration = null;
			}
			return registered;
		})
		.catch(() => {
			overlayTokensRegistration = null;
			return false;
		});
	return overlayTokensRegistration;
};
type VideoDimensions = {
	width: number;
	height: number;
};

type CameraResizeCorner = (typeof CAMERA_RESIZE_CORNERS)[number];

type CameraPreviewMetrics = {
	width: number;
	height: number;
	aspectRatio: number;
};

type CameraResizeSnapshot = {
	size: number;
	position: { x: number; y: number };
	metrics: CameraPreviewMetrics;
};

type CameraResizeStart = CameraResizeSnapshot & {
	corner: CameraResizeCorner;
	pointerId: number;
	clientX: number;
	clientY: number;
};

// Preview events (frames, drag, errors) arrive from the camera-preview
// iframe via the service worker relay (chrome.tabs.sendMessage), never via
// window.postMessage — the host page shares this window and could read
// webcam frames out of a postMessage stream.
type PreviewEventRelay = CameraPreviewEventRelay;

type PreviewParentMessage =
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

const classNames = (...values: Array<string | false | null | undefined>) =>
	values.filter(Boolean).join(" ");

const isPreviewEventRelay = (value: unknown): value is PreviewEventRelay => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PreviewEventRelay>;
	return (
		candidate.source === "cap-extension-camera-preview" &&
		candidate.token === PREVIEW_TOKEN &&
		!!candidate.event &&
		typeof candidate.event === "object"
	);
};

const getPreviewMetrics = (
	base: number,
	shape: WebcamShape,
	dimensions: VideoDimensions | null,
): CameraPreviewMetrics => {
	if (!dimensions || dimensions.height === 0) {
		return {
			width: base,
			height: base,
			aspectRatio: 1,
		};
	}

	const aspectRatio = dimensions.width / dimensions.height;

	if (shape !== "full") {
		return {
			width: base,
			height: base,
			aspectRatio,
		};
	}

	if (aspectRatio >= 1) {
		return {
			width: base * aspectRatio,
			height: base,
			aspectRatio,
		};
	}

	return {
		width: base,
		height: base / aspectRatio,
		aspectRatio,
	};
};

const getBorderRadius = (size: number, shape: WebcamShape) => {
	if (shape === "round") return "9999px";
	return size <= 230 ? "3rem" : "4rem";
};

const clampCameraSize = (size: number) =>
	Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));

const toOverlayPosition = (position: {
	x: number;
	y: number;
}): OverlayPosition => ({
	...position,
	viewportWidth: window.innerWidth,
	viewportHeight: window.innerHeight,
	updatedAt: Date.now(),
});

const isRecordingPreviewStatus = (status: RecordingStatus | undefined) =>
	status?.phase === "creating" ||
	status?.phase === "recording" ||
	status?.phase === "paused";

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

const stopStream = (stream: MediaStream | null) => {
	if (!stream) return;
	for (const track of stream.getTracks()) {
		track.stop();
	}
};

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

	if (!response.ok || !response.answer) {
		peer.close();
		throw new Error(response.ok ? "Missing camera answer" : response.error);
	}
	await peer.setRemoteDescription(response.answer);
	return {
		peer,
		stream: await remoteStreamPromise,
	};
};

function OverlayApp() {
	const [extensionSettings, setExtensionSettings] =
		useState<ExtensionSettings | null>(null);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [persistedWebcamPosition, setPersistedWebcamPosition] =
		useState<OverlayPosition | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [activeResizeCorner, setActiveResizeCorner] =
		useState<CameraResizeCorner | null>(null);
	const [videoDimensions, setVideoDimensions] =
		useState<VideoDimensions | null>(null);
	const [lastPreviewFrame, setLastPreviewFrame] =
		useState<WebcamPreviewFrame | null>(null);
	const [livePreviewReady, setLivePreviewReady] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [showPreviewError, setShowPreviewError] = useState(false);
	const [iframeReady, setIframeReady] = useState(false);
	const [parentPipActive, setParentPipActive] = useState(false);
	const [framePipActive, setFramePipActive] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewPointerInside, setPreviewPointerInside] = useState(false);
	const [recordingPreviewActive, setRecordingPreviewActive] = useState(false);
	const [recorderPanelOpen, setRecorderPanelOpen] = useState(false);
	const [previewTokenReady, setPreviewTokenReady] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const windowRef = useRef<HTMLDivElement>(null);
	const cameraShellRef = useRef<HTMLDivElement>(null);
	const cameraFrameRef = useRef<HTMLDivElement>(null);
	const pipVideoRef = useRef<HTMLVideoElement>(null);
	const pipPeerRef = useRef<RTCPeerConnection | null>(null);
	const pipStreamRef = useRef<MediaStream | null>(null);
	const pipSettingsRef = useRef<WebcamSettings | null>(null);
	const previewSessionIdRef = useRef<string | null>(null);
	const webcamRef = useRef<WebcamSettings | null>(null);
	const settingsRef = useRef<ExtensionSettings | null>(null);
	const positionRef = useRef<{ x: number; y: number } | null>(null);
	const videoDimensionsRef = useRef<VideoDimensions | null>(null);
	const dragStartRef = useRef({ x: 0, y: 0 });
	const dragFrameRef = useRef<number | null>(null);
	const isDraggingRef = useRef(false);
	const cameraResizeStartRef = useRef<CameraResizeStart | null>(null);
	const cameraResizePreviewRef = useRef<CameraResizeSnapshot | null>(null);
	const cameraResizeFrameRef = useRef<number | null>(null);
	const framePipActiveRef = useRef(false);
	const recordingPreviewActiveRef = useRef(false);
	const previewOpenRef = useRef(false);
	const livePreviewReadyRef = useRef(false);
	const previewDismissedRef = useRef(false);
	const lastFrameRef = useRef<WebcamPreviewFrame | null>(null);
	const lastFrameSavedAtRef = useRef(0);
	const startupReplayedRef = useRef(false);
	const webcam = extensionSettings?.webcam ?? null;
	const previewEnabled = Boolean(webcam?.enabled && previewOpen);
	const isInPictureInPicture = parentPipActive || framePipActive;
	const parentPipSupported =
		typeof document !== "undefined" && document.pictureInPictureEnabled;

	// Control messages travel over chrome.runtime instead of window.postMessage:
	// the host page can read the iframe token from the DOM and post forged
	// window messages, but it cannot speak chrome.runtime at all. The preview
	// filters on the token, so only this tab's iframe reacts.
	const postPreviewMessage = useCallback((message: PreviewParentMessage) => {
		chrome.runtime.sendMessage(message, () => {
			void chrome.runtime.lastError;
		});
	}, []);

	const persistPreviewFrame = useCallback(
		(frame: WebcamPreviewFrame | null, force: boolean) => {
			if (!frame) return;
			const now = Date.now();
			if (
				!force &&
				now - lastFrameSavedAtRef.current < FRAME_PERSIST_INTERVAL_MS
			) {
				return;
			}
			lastFrameSavedAtRef.current = now;
			void saveLastWebcamPreviewFrame(frame).catch(() => undefined);
		},
		[],
	);

	const disconnectParentPipPreview = useCallback(() => {
		pipPeerRef.current?.close();
		stopStream(pipStreamRef.current);
		pipPeerRef.current = null;
		pipStreamRef.current = null;
		pipSettingsRef.current = null;
		const video = pipVideoRef.current;
		if (video) {
			video.srcObject = null;
			video.removeAttribute("src");
		}
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "disconnect-camera-preview",
			sessionId: `${PREVIEW_TOKEN}:pip`,
		}).catch(() => undefined);
	}, []);

	const disconnectPreviewSession = useCallback(() => {
		const sessionId = previewSessionIdRef.current;
		previewSessionIdRef.current = null;
		if (!sessionId) return;
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "disconnect-camera-preview",
			sessionId,
		}).catch(() => undefined);
	}, []);

	const stopLocalPreview = useCallback(() => {
		previewOpenRef.current = false;
		setPreviewOpen(false);
		setPreviewPointerInside(false);
		setLivePreviewReady(false);
		// Surface the freshest captured frame as the placeholder for the next
		// time the preview opens (state updates are skipped while live).
		if (lastFrameRef.current) {
			setLastPreviewFrame(lastFrameRef.current);
			persistPreviewFrame(lastFrameRef.current, true);
		}
		disconnectParentPipPreview();
		disconnectPreviewSession();
		postPreviewMessage({
			source: "cap-extension-overlay",
			token: PREVIEW_TOKEN,
			type: "stop",
		});
	}, [
		disconnectParentPipPreview,
		disconnectPreviewSession,
		persistPreviewFrame,
		postPreviewMessage,
	]);

	const applyWebcamSettings = useCallback(
		(getNext: (current: WebcamSettings) => WebcamSettings) => {
			setExtensionSettings((current) => {
				if (!current) return current;
				const next = {
					...current,
					webcam: getNext(current.webcam),
				};
				void saveSettings(next)
					.then(() =>
						sendServiceWorkerMessage({
							target: "service-worker",
							type: "settings-updated",
							settings: next,
						}),
					)
					.catch(() => undefined);
				return next;
			});
		},
		[],
	);

	useEffect(() => {
		webcamRef.current = webcam;
	}, [webcam]);

	useEffect(() => {
		settingsRef.current = extensionSettings;
	}, [extensionSettings]);

	useEffect(() => {
		positionRef.current = position;
	}, [position]);

	useEffect(() => {
		videoDimensionsRef.current = videoDimensions;
	}, [videoDimensions]);

	useEffect(() => {
		framePipActiveRef.current = framePipActive;
	}, [framePipActive]);

	useEffect(() => {
		recordingPreviewActiveRef.current = recordingPreviewActive;
	}, [recordingPreviewActive]);

	useEffect(() => {
		previewOpenRef.current = previewOpen;
	}, [previewOpen]);

	useEffect(() => {
		livePreviewReadyRef.current = livePreviewReady;
	}, [livePreviewReady]);

	useEffect(() => {
		let disposed = false;
		loadLastWebcamPreviewFrame()
			.then((frame) => {
				if (!disposed) setLastPreviewFrame(frame);
			})
			.catch(() => undefined);

		return () => {
			disposed = true;
		};
	}, []);

	// The preview iframe and the PiP fallback may only start once the service
	// worker knows this page's tokens; an unregistered frame is refused camera
	// access.
	useEffect(() => {
		if (!previewEnabled || previewTokenReady) return;
		let disposed = false;
		void ensureOverlayTokensRegistered().then((registered) => {
			if (!disposed && registered) setPreviewTokenReady(true);
		});
		return () => {
			disposed = true;
		};
	}, [previewEnabled, previewTokenReady]);

	useEffect(() => {
		let disposed = false;

		const syncOverlayUiState = () => {
			loadOverlayUiState()
				.then((state) => {
					if (!disposed) setPersistedWebcamPosition(state.webcamPosition);
				})
				.catch(() => undefined);
		};

		const syncSettingsState = () => {
			Promise.all([loadSettings(), loadWebcamPreviewDismissed()])
				.then(([nextSettings, dismissed]) => {
					if (disposed) return;
					previewDismissedRef.current = dismissed;
					setExtensionSettings(nextSettings);
					if (
						dismissed ||
						!nextSettings.webcam.enabled ||
						!nextSettings.webcam.deviceId
					) {
						setRecordingPreviewActive(false);
						setLivePreviewReady(false);
						stopLocalPreview();
					}
				})
				.catch(() => undefined);
		};

		const syncPreviewDismissedState = () => {
			loadWebcamPreviewDismissed()
				.then((dismissed) => {
					if (disposed) return;
					previewDismissedRef.current = dismissed;
					if (dismissed) {
						setRecordingPreviewActive(false);
						setLivePreviewReady(false);
						stopLocalPreview();
					}
				})
				.catch(() => undefined);
		};

		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName === "local" && changes[OVERLAY_UI_STATE_KEY]) {
				syncOverlayUiState();
			}
			if (areaName === "local" && changes[SETTINGS_KEY]) {
				syncSettingsState();
			}
			if (areaName === "session" && changes[WEBCAM_PREVIEW_DISMISSED_KEY]) {
				syncPreviewDismissedState();
			}
		};

		syncOverlayUiState();
		syncPreviewDismissedState();
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			disposed = true;
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, [stopLocalPreview]);

	useEffect(() => {
		let disposed = false;
		Promise.all([
			sendServiceWorkerMessage({
				target: "service-worker",
				type: "get-overlay-settings",
			}),
			loadWebcamPreviewDismissed(),
		])
			.then(([response, dismissed]) => {
				if (!disposed && response.ok && response.settings) {
					previewDismissedRef.current = dismissed;
					setExtensionSettings(response.settings);
					const previewActive = isRecordingPreviewStatus(response.status);
					setRecordingPreviewActive(previewActive);
					// A replayed startup message (the lazy-load trigger) may have
					// already opened the preview before this sync resolves, so only
					// ever turn it on here.
					if (!dismissed && previewActive) setPreviewOpen(true);
				}
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, []);

	useEffect(() => {
		let disposed = false;
		const syncSharedUi = () => {
			loadSharedUiState()
				.then((state) => {
					if (!disposed) setRecorderPanelOpen(state.panelOpen);
				})
				.catch(() => undefined);
		};
		syncSharedUi();
		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName === "session" && changes[SHARED_UI_STATE_KEY]) {
				syncSharedUi();
			}
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			disposed = true;
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);

	useEffect(() => {
		let disposed = false;

		const syncPreviewForVisibility = () => {
			if (document.visibilityState !== "visible") {
				return;
			}

			// Tab switches are frequent, so read settings and the session-storage
			// status mirror instead of a get-overlay-settings round trip that
			// would wake the MV3 service worker on every visibility flip. The
			// recording bar's slow poll keeps the mirror reconciled while active.
			Promise.all([
				loadSettings(),
				loadSharedRecordingState(),
				loadWebcamPreviewDismissed(),
			])
				.then(([nextSettings, sharedState, dismissed]) => {
					if (disposed) return;
					previewDismissedRef.current = dismissed;
					const previewActive = isRecordingPreviewStatus(sharedState?.status);
					setExtensionSettings(nextSettings);
					if (dismissed) {
						setRecordingPreviewActive(false);
						stopLocalPreview();
						return;
					}
					if (previewActive) {
						setRecordingPreviewActive(true);
						setPreviewOpen(true);
						return;
					}
					if (recordingPreviewActiveRef.current) {
						setRecordingPreviewActive(false);
						stopLocalPreview();
					}
				})
				.catch(() => undefined);
		};

		document.addEventListener("visibilitychange", syncPreviewForVisibility);
		window.addEventListener("focus", syncPreviewForVisibility);
		return () => {
			disposed = true;
			document.removeEventListener(
				"visibilitychange",
				syncPreviewForVisibility,
			);
			window.removeEventListener("focus", syncPreviewForVisibility);
		};
	}, [stopLocalPreview]);

	useEffect(() => {
		const handleMessage = (
			message: unknown,
			_sender: chrome.runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
		) => {
			if (!isOverlayMessage(message)) return false;

			sendResponse({ ok: true });

			if (message.type === "overlay-panel-toggle") {
				void updateSharedUiState((current) => ({
					...current,
					panelOpen: !current.panelOpen,
					readyBarDismissed: current.panelOpen
						? current.readyBarDismissed
						: false,
					updatedAt: Date.now(),
				}))
					.then((state) => setRecorderPanelOpen(state.panelOpen))
					.catch(() => undefined);
				return false;
			}

			if (message.type === "overlay-panel-hide") {
				void updateSharedUiState((current) => ({
					...current,
					panelOpen: false,
					updatedAt: Date.now(),
				}))
					.then((state) => setRecorderPanelOpen(state.panelOpen))
					.catch(() => undefined);
				return false;
			}

			if (message.type === "overlay-hide") {
				recordingPreviewActiveRef.current = false;
				setRecordingPreviewActive(false);
				stopLocalPreview();
				return false;
			}

			if (message.type === "overlay-enter-auto-pip") {
				// Only one Picture in Picture surface may drive at a time; racing
				// the parent fallback video against the preview iframe flips PiP
				// on and off and leaves the badge state inconsistent.
				const current = webcamRef.current;
				const frameLive =
					previewOpenRef.current &&
					livePreviewReadyRef.current &&
					Boolean(current?.enabled && current.deviceId);
				if (frameLive) {
					postPreviewMessage({
						source: "cap-extension-overlay",
						token: PREVIEW_TOKEN,
						type: "enter-pip",
					});
					return false;
				}
				const video = pipVideoRef.current;
				if (video && parentPipSupported) {
					void video
						.play()
						.then(() => video.requestPictureInPicture())
						.catch(() => undefined);
				}
				return false;
			}

			if (message.type === "overlay-exit-auto-pip") {
				const video = pipVideoRef.current;
				if (video && document.pictureInPictureElement === video) {
					void document.exitPictureInPicture().catch(() => undefined);
				}
				postPreviewMessage({
					source: "cap-extension-overlay",
					token: PREVIEW_TOKEN,
					type: "exit-auto-pip",
				});
				return false;
			}

			if (message.type !== "overlay-settings") return false;

			if (previewDismissedRef.current) return false;

			const webcamSettings = message.settings;
			const sameLivePreview =
				previewOpenRef.current &&
				livePreviewReadyRef.current &&
				isSameWebcamSettings(webcamRef.current, webcamSettings);
			if (!sameLivePreview) {
				setLivePreviewReady(false);
			} else {
				// A restarted service worker loses which tab owns the live preview,
				// so re-announce readiness whenever it pushes the same settings.
				void sendServiceWorkerMessage({
					target: "service-worker",
					type: "webcam-preview-ready",
				}).catch(() => undefined);
			}
			setPreviewError(null);
			setShowPreviewError(false);
			setPreviewOpen(true);
			recordingPreviewActiveRef.current = message.recording;
			setRecordingPreviewActive(message.recording);
			if (settingsRef.current) {
				setExtensionSettings({
					...settingsRef.current,
					webcam: webcamSettings,
				});
			} else {
				sendServiceWorkerMessage({
					target: "service-worker",
					type: "get-overlay-settings",
				})
					.then((response) => {
						if (response.ok && response.settings) {
							setExtensionSettings({
								...response.settings,
								webcam: webcamSettings,
							});
						}
					})
					.catch(() => undefined);
			}
			return false;
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		if (!startupReplayedRef.current) {
			startupReplayedRef.current = true;
			replayStartupMessages(handleMessage);
		}
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [parentPipSupported, postPreviewMessage, stopLocalPreview]);

	const beginDrag = useCallback((clientX: number, clientY: number) => {
		isDraggingRef.current = true;
		setIsDragging(true);
		const currentPosition = positionRef.current;
		dragStartRef.current = {
			x: clientX - (currentPosition?.x ?? 0),
			y: clientY - (currentPosition?.y ?? 0),
		};
	}, []);

	const applyDragTransform = useCallback(() => {
		dragFrameRef.current = null;
		const element = windowRef.current;
		const next = positionRef.current;
		if (!element || !next) return;
		element.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
	}, []);

	// Dragging writes the transform straight to the DOM inside one rAF per
	// frame; going through React state for every pointermove made the preview
	// visibly lag behind the cursor.
	const moveDrag = useCallback(
		(clientX: number, clientY: number) => {
			const webcamSettings = webcamRef.current;
			if (!isDraggingRef.current || !webcamSettings) return;

			const metrics = getPreviewMetrics(
				webcamSettings.size,
				webcamSettings.shape,
				videoDimensionsRef.current,
			);
			const totalHeight = metrics.height + BAR_HEIGHT;
			const maxX = Math.max(0, window.innerWidth - metrics.width);
			const maxY = Math.max(0, window.innerHeight - totalHeight);
			const nextX = clientX - dragStartRef.current.x;
			const nextY = clientY - dragStartRef.current.y;

			positionRef.current = {
				x: Math.max(0, Math.min(nextX, maxX)),
				y: Math.max(0, Math.min(nextY, maxY)),
			};
			dragFrameRef.current ??= window.requestAnimationFrame(applyDragTransform);
		},
		[applyDragTransform],
	);

	const endDrag = useCallback(() => {
		if (!isDraggingRef.current) return;
		isDraggingRef.current = false;
		setIsDragging(false);
		if (dragFrameRef.current !== null) {
			window.cancelAnimationFrame(dragFrameRef.current);
			dragFrameRef.current = null;
			applyDragTransform();
		}
		const nextPosition = positionRef.current;
		if (!nextPosition) return;
		setPosition(nextPosition);
		void updateOverlayUiState((current) => ({
			...current,
			webcamPosition: toOverlayPosition(nextPosition),
		}))
			.then((state) => setPersistedWebcamPosition(state.webcamPosition))
			.catch(() => undefined);
	}, [applyDragTransform]);

	const applyCameraResizePreview = useCallback(() => {
		cameraResizeFrameRef.current = null;
		const preview = cameraResizePreviewRef.current;
		const cameraWindow = windowRef.current;
		const cameraShell = cameraShellRef.current;
		const cameraFrame = cameraFrameRef.current;
		const shape = webcamRef.current?.shape;
		if (!preview || !cameraWindow || !cameraShell || !cameraFrame || !shape) {
			return;
		}

		const borderRadius = getBorderRadius(preview.size, shape);
		cameraWindow.style.transform = `translate3d(${preview.position.x}px, ${preview.position.y}px, 0)`;
		cameraWindow.style.width = `${preview.metrics.width}px`;
		cameraWindow.style.height = `${preview.metrics.height + BAR_HEIGHT}px`;
		cameraWindow.style.borderRadius = borderRadius;
		cameraShell.style.borderRadius = borderRadius;
		cameraFrame.style.width = `${preview.metrics.width}px`;
		cameraFrame.style.height = `${preview.metrics.height}px`;
		cameraFrame.style.borderRadius = borderRadius;
	}, []);

	const handleCameraResizeStart =
		(corner: CameraResizeCorner) =>
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const webcamSettings = webcamRef.current;
			const currentPosition = positionRef.current;
			if (
				event.button !== 0 ||
				!event.isPrimary ||
				!webcamSettings ||
				!currentPosition
			) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			event.currentTarget.setPointerCapture(event.pointerId);
			const metrics = getPreviewMetrics(
				webcamSettings.size,
				webcamSettings.shape,
				videoDimensionsRef.current,
			);
			const snapshot = {
				size: webcamSettings.size,
				position: currentPosition,
				metrics,
			};
			cameraResizeStartRef.current = {
				...snapshot,
				corner,
				pointerId: event.pointerId,
				clientX: event.clientX,
				clientY: event.clientY,
			};
			cameraResizePreviewRef.current = snapshot;
			setActiveResizeCorner(corner);
		};

	const handleCameraResizeMove = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const start = cameraResizeStartRef.current;
			const webcamSettings = webcamRef.current;
			if (!start || !webcamSettings || event.pointerId !== start.pointerId) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			const deltaX = event.clientX - start.clientX;
			const deltaY = event.clientY - start.clientY;
			const horizontalDelta = start.corner.includes("e") ? deltaX : -deltaX;
			const verticalDelta = start.corner.includes("s") ? deltaY : -deltaY;
			const nextSize = clampCameraSize(
				Math.round(start.size + Math.max(horizontalDelta, verticalDelta)),
			);
			const nextMetrics = getPreviewMetrics(
				nextSize,
				webcamSettings.shape,
				videoDimensionsRef.current,
			);
			const nextX =
				start.position.x +
				(start.corner.includes("w")
					? start.metrics.width - nextMetrics.width
					: 0);
			const nextY =
				start.position.y +
				(start.corner.includes("n")
					? start.metrics.height - nextMetrics.height
					: 0);
			const position = {
				x: Math.max(0, Math.min(nextX, window.innerWidth - nextMetrics.width)),
				y: Math.max(
					0,
					Math.min(nextY, window.innerHeight - nextMetrics.height - BAR_HEIGHT),
				),
			};

			positionRef.current = position;
			cameraResizePreviewRef.current = {
				size: nextSize,
				position,
				metrics: nextMetrics,
			};
			cameraResizeFrameRef.current ??= window.requestAnimationFrame(
				applyCameraResizePreview,
			);
		},
		[applyCameraResizePreview],
	);

	const endCameraResize = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const start = cameraResizeStartRef.current;
			if (!start || event.pointerId !== start.pointerId) return;

			event.preventDefault();
			event.stopPropagation();
			cameraResizeStartRef.current = null;
			if (cameraResizeFrameRef.current !== null) {
				window.cancelAnimationFrame(cameraResizeFrameRef.current);
				cameraResizeFrameRef.current = null;
			}
			applyCameraResizePreview();
			const preview = cameraResizePreviewRef.current;
			cameraResizePreviewRef.current = null;
			setActiveResizeCorner(null);
			if (!preview) return;

			positionRef.current = preview.position;
			setPosition(preview.position);
			const persistedPosition = toOverlayPosition(preview.position);
			setPersistedWebcamPosition(persistedPosition);
			applyWebcamSettings((current) => ({
				...current,
				size: preview.size,
			}));
			void updateOverlayUiState((current) => ({
				...current,
				webcamPosition: persistedPosition,
			}))
				.then((state) => setPersistedWebcamPosition(state.webcamPosition))
				.catch(() => undefined);
		},
		[applyCameraResizePreview, applyWebcamSettings],
	);

	const toPagePoint = useCallback((clientX: number, clientY: number) => {
		const rect = iframeRef.current?.getBoundingClientRect();
		if (rect) {
			return {
				x: rect.left + clientX,
				y: rect.top + clientY,
			};
		}
		const currentPosition = positionRef.current ?? { x: 0, y: 0 };
		return {
			x: clientX + currentPosition.x,
			y: clientY + currentPosition.y + BAR_HEIGHT,
		};
	}, []);

	useEffect(() => {
		const handlePreviewEvent = (message: unknown) => {
			if (!isPreviewEventRelay(message)) return false;
			const event = message.event;

			if (event.type === "ready") {
				setIframeReady(true);
				const current = webcamRef.current;
				if (current?.enabled && current.deviceId) {
					postPreviewMessage({
						source: "cap-extension-overlay",
						token: PREVIEW_TOKEN,
						type: "settings",
						settings: current,
					});
				}
				return false;
			}

			if (event.type === "metadata") {
				setVideoDimensions(event.dimensions);
				setPreviewError(null);
				setShowPreviewError(false);
				return false;
			}

			if (event.type === "session") {
				previewSessionIdRef.current = event.sessionId;
				return false;
			}

			if (event.type === "frame") {
				const wasLive = livePreviewReadyRef.current;
				lastFrameRef.current = event.frame;
				// The cached frame only paints while the live iframe is hidden,
				// so skip the full overlay re-render on every 700ms frame once
				// the preview is live; the freshest frame is flushed from the
				// ref when the preview stops.
				if (!wasLive) {
					setLastPreviewFrame(event.frame);
					setLivePreviewReady(true);
					livePreviewReadyRef.current = true;
					setPreviewError(null);
					setShowPreviewError(false);
					void sendServiceWorkerMessage({
						target: "service-worker",
						type: "webcam-preview-ready",
					}).catch(() => undefined);
				}
				persistPreviewFrame(event.frame, !wasLive);
				return false;
			}

			if (event.type === "drag-start") {
				const point = toPagePoint(event.clientX, event.clientY);
				beginDrag(point.x, point.y);
				return false;
			}

			if (event.type === "pointer-presence") {
				setPreviewPointerInside(event.inside && previewOpenRef.current);
				return false;
			}

			if (event.type === "drag-move") {
				const point = toPagePoint(event.clientX, event.clientY);
				moveDrag(point.x, point.y);
				return false;
			}

			if (event.type === "drag-end") {
				endDrag();
				return false;
			}

			if (event.type === "error") {
				setVideoDimensions(null);
				setLivePreviewReady(false);
				setPreviewError(event.message);
				setShowPreviewError(false);
				void sendServiceWorkerMessage({
					target: "service-worker",
					type: "webcam-preview-error",
					reason: event.reason,
					message: event.message,
				}).catch(() => undefined);
				return false;
			}

			setFramePipActive(event.active);
			return false;
		};

		chrome.runtime.onMessage.addListener(handlePreviewEvent);
		return () => chrome.runtime.onMessage.removeListener(handlePreviewEvent);
	}, [
		beginDrag,
		endDrag,
		moveDrag,
		persistPreviewFrame,
		postPreviewMessage,
		toPagePoint,
	]);

	useEffect(() => {
		if (!previewEnabled) {
			if (cameraResizeFrameRef.current !== null) {
				window.cancelAnimationFrame(cameraResizeFrameRef.current);
				cameraResizeFrameRef.current = null;
			}
			cameraResizeStartRef.current = null;
			cameraResizePreviewRef.current = null;
			setActiveResizeCorner(null);
			setPreviewPointerInside(false);
			setIframeReady(false);
			setVideoDimensions(null);
			setLivePreviewReady(false);
			setPreviewError(null);
			setShowPreviewError(false);
			setFramePipActive(false);
			postPreviewMessage({
				source: "cap-extension-overlay",
				token: PREVIEW_TOKEN,
				type: "stop",
			});
		}
	}, [postPreviewMessage, previewEnabled]);

	useEffect(() => {
		if (!previewError || !previewEnabled || livePreviewReady) return;
		const timeout = window.setTimeout(
			() => setShowPreviewError(true),
			PREVIEW_ERROR_DELAY_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [livePreviewReady, previewEnabled, previewError]);

	useEffect(() => {
		if (!iframeReady || !previewEnabled || !webcam) return;
		postPreviewMessage({
			source: "cap-extension-overlay",
			token: PREVIEW_TOKEN,
			type: "settings",
			settings: webcam,
		});
	}, [iframeReady, postPreviewMessage, previewEnabled, webcam]);

	useEffect(() => {
		if (!previewEnabled || !previewTokenReady || !webcam) {
			disconnectParentPipPreview();
			return;
		}

		let disposed = false;
		const sessionId = `${PREVIEW_TOKEN}:pip`;

		const connect = async () => {
			const peerActive =
				pipPeerRef.current &&
				pipPeerRef.current.connectionState !== "closed" &&
				pipPeerRef.current.connectionState !== "failed" &&
				pipPeerRef.current.connectionState !== "disconnected";
			if (
				pipStreamRef.current &&
				peerActive &&
				pipSettingsRef.current &&
				isSameWebcamSettings(pipSettingsRef.current, webcam)
			) {
				if (
					pipVideoRef.current &&
					pipVideoRef.current.srcObject !== pipStreamRef.current
				) {
					pipVideoRef.current.srcObject = pipStreamRef.current;
				}
				await pipVideoRef.current?.play().catch(() => undefined);
				return;
			}

			disconnectParentPipPreview();

			try {
				const { peer, stream } = await connectCameraPreview(webcam, sessionId);
				if (disposed) {
					peer.close();
					stopStream(stream);
					void sendServiceWorkerMessage({
						target: "service-worker",
						type: "disconnect-camera-preview",
						sessionId,
					}).catch(() => undefined);
					return;
				}

				pipPeerRef.current = peer;
				pipStreamRef.current = stream;
				pipSettingsRef.current = webcam;
				if (pipVideoRef.current) {
					pipVideoRef.current.srcObject = stream;
					await pipVideoRef.current.play().catch(() => undefined);
				}
			} catch {
				if (!disposed) {
					disconnectParentPipPreview();
				}
			}
		};

		void connect();

		return () => {
			disposed = true;
		};
	}, [disconnectParentPipPreview, previewEnabled, previewTokenReady, webcam]);

	useEffect(() => {
		const video = pipVideoRef.current;
		if (!video || !parentPipSupported) return;

		const handleEnter = () => {
			setParentPipActive(true);
		};
		const handleLeave = () => {
			setParentPipActive(false);
		};

		video.addEventListener("enterpictureinpicture", handleEnter);
		video.addEventListener("leavepictureinpicture", handleLeave);
		return () => {
			video.removeEventListener("enterpictureinpicture", handleEnter);
			video.removeEventListener("leavepictureinpicture", handleLeave);
		};
	}, [parentPipSupported]);

	const clampPosition = useCallback(
		(previous: { x: number; y: number } | null) => {
			if (!previewEnabled || !webcam) return previous;
			const metrics = getPreviewMetrics(
				webcam.size,
				webcam.shape,
				videoDimensions,
			);
			const totalHeight = metrics.height + BAR_HEIGHT;
			const maxX = Math.max(0, window.innerWidth - metrics.width);
			const maxY = Math.max(0, window.innerHeight - totalHeight);
			const defaultX = webcam.position.includes("left")
				? WINDOW_PADDING
				: window.innerWidth - metrics.width - WINDOW_PADDING;
			const defaultY = webcam.position.includes("top")
				? WINDOW_PADDING
				: window.innerHeight - totalHeight - WINDOW_PADDING;
			const nextX = previous?.x ?? defaultX;
			const nextY = previous?.y ?? defaultY;

			return {
				x: Math.max(0, Math.min(nextX, maxX)),
				y: Math.max(0, Math.min(nextY, maxY)),
			};
		},
		[previewEnabled, webcam, videoDimensions],
	);

	const positionPrefRef = useRef<WebcamPosition | null>(null);

	useEffect(() => {
		const positionPref = webcam?.position ?? null;
		const prefChanged =
			positionPrefRef.current !== null &&
			positionPrefRef.current !== positionPref;
		positionPrefRef.current = positionPref;
		if (prefChanged) {
			void updateOverlayUiState((current) => ({
				...current,
				webcamPosition: null,
			}))
				.then((state) => setPersistedWebcamPosition(state.webcamPosition))
				.catch(() => undefined);
		}
		setPosition((previous) => clampPosition(prefChanged ? null : previous));
	}, [clampPosition, webcam?.position]);

	useEffect(() => {
		if (!persistedWebcamPosition || isDragging || activeResizeCorner) return;
		setPosition(
			clampPosition({
				x: persistedWebcamPosition.x,
				y: persistedWebcamPosition.y,
			}),
		);
	}, [activeResizeCorner, clampPosition, isDragging, persistedWebcamPosition]);

	useEffect(() => {
		const handleResize = () => {
			setPosition(clampPosition);
		};
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [clampPosition]);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if ((event.target as HTMLElement).closest("[data-controls]")) {
				return;
			}
			event.stopPropagation();
			event.preventDefault();
			// Capture the pointer so the drag keeps receiving events even while
			// the cursor passes over the preview iframe (a separate document).
			event.currentTarget.setPointerCapture(event.pointerId);
			beginDrag(event.clientX, event.clientY);
		},
		[beginDrag],
	);

	const handlePointerMove = useCallback(
		(event: PointerEvent) => {
			moveDrag(event.clientX, event.clientY);
		},
		[moveDrag],
	);

	useEffect(() => {
		if (!isDragging) return;

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", endDrag);
		window.addEventListener("pointercancel", endDrag);
		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", endDrag);
			window.removeEventListener("pointercancel", endDrag);
		};
	}, [endDrag, handlePointerMove, isDragging]);

	const handleClose = useCallback(() => {
		previewDismissedRef.current = true;
		stopLocalPreview();
		setRecordingPreviewActive(false);
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "close-webcam-preview",
		}).catch(() => undefined);
	}, [stopLocalPreview]);

	const updateShape = useCallback(() => {
		applyWebcamSettings((current) => ({
			...current,
			shape:
				current.shape === "round"
					? "square"
					: current.shape === "square"
						? "full"
						: "round",
		}));
	}, [applyWebcamSettings]);

	const handleTogglePictureInPicture = useCallback(() => {
		const video = pipVideoRef.current;
		if (video && document.pictureInPictureElement === video) {
			void document.exitPictureInPicture().catch(() => undefined);
			return;
		}

		const current = webcamRef.current;
		const frameLive =
			previewOpenRef.current &&
			livePreviewReadyRef.current &&
			Boolean(current?.enabled && current.deviceId);
		if (framePipActiveRef.current || frameLive) {
			postPreviewMessage({
				source: "cap-extension-overlay",
				token: PREVIEW_TOKEN,
				type: "toggle-pip",
			});
			return;
		}

		if (!video || !parentPipSupported) return;
		void (async () => {
			try {
				await video.play().catch(() => undefined);
				await video.requestPictureInPicture();
			} catch {}
		})();
	}, [parentPipSupported, postPreviewMessage]);

	const handlePreviewLoad = useCallback(() => {
		const current = webcamRef.current;
		if (!current?.enabled || !current.deviceId) return;

		postPreviewMessage({
			source: "cap-extension-overlay",
			token: PREVIEW_TOKEN,
			type: "settings",
			settings: current,
		});
	}, [postPreviewMessage]);

	const metricsDimensions =
		videoDimensions ?? lastPreviewFrame?.dimensions ?? null;
	const isResizing = activeResizeCorner !== null;
	const renderSize = isResizing
		? (cameraResizePreviewRef.current?.size ?? webcam?.size)
		: webcam?.size;
	const metrics = webcam
		? getPreviewMetrics(
				renderSize ?? webcam.size,
				webcam.shape,
				metricsDimensions,
			)
		: null;
	const totalHeight = metrics ? metrics.height + BAR_HEIGHT : 0;
	const borderRadius = webcam
		? getBorderRadius(renderSize ?? webcam.size, webcam.shape)
		: "0";
	const renderPosition =
		(isDragging || isResizing ? positionRef.current : position) ?? position;

	const cameraWindow = previewEnabled &&
		previewTokenReady &&
		webcam &&
		renderPosition &&
		metrics && (
			<div
				ref={windowRef}
				className={classNames(
					"cap-extension-camera-window",
					isDragging && "is-dragging",
					isResizing && "is-resizing",
					previewPointerInside && "is-preview-hovered",
				)}
				data-camera-preview
				role="dialog"
				style={{
					transform: `translate3d(${renderPosition.x}px, ${renderPosition.y}px, 0)`,
					width: `${metrics.width}px`,
					height: `${totalHeight}px`,
					borderRadius,
				}}
				onPointerDown={handlePointerDown}
			>
				<div
					ref={cameraShellRef}
					className="cap-extension-camera-shell"
					style={{ borderRadius }}
				>
					<div
						ref={cameraFrameRef}
						className={classNames(
							"cap-extension-camera-frame",
							webcam.shape === "round" ? "is-round" : "is-rounded",
							livePreviewReady && "is-live",
							isInPictureInPicture && "is-pip",
						)}
						style={{
							width: `${metrics.width}px`,
							height: `${metrics.height}px`,
							borderRadius,
						}}
					>
						<button
							type="button"
							className="cap-extension-camera-dismiss-btn"
							aria-label="Close camera preview"
							title="Close camera"
							data-controls
							onClick={(e) => {
								e.stopPropagation();
								handleClose();
							}}
						>
							<X size={14} aria-hidden />
						</button>
						{lastPreviewFrame ? (
							<img
								src={lastPreviewFrame.dataUrl}
								alt=""
								aria-hidden
								className={classNames(
									"cap-extension-camera-last-frame",
									livePreviewReady && "is-hidden",
									webcam.mirror && "is-mirrored",
								)}
							/>
						) : null}
						<iframe
							ref={iframeRef}
							src={PREVIEW_SRC}
							title="Cap camera preview"
							allow="camera; microphone; autoplay; picture-in-picture"
							className="cap-extension-camera-iframe"
							onLoad={handlePreviewLoad}
						/>
						{!livePreviewReady && !showPreviewError ? (
							<div className="cap-extension-camera-loading" aria-hidden>
								<span />
							</div>
						) : null}
						{previewError && showPreviewError ? (
							<div className="cap-extension-camera-error">{previewError}</div>
						) : null}
						{isInPictureInPicture ? (
							<div className="cap-extension-camera-pip-active">
								<div>
									<span>Picture in Picture active</span>
									<button
										type="button"
										aria-label="Exit Picture in Picture"
										onClick={handleTogglePictureInPicture}
									>
										<X size={12} aria-hidden />
									</button>
								</div>
							</div>
						) : null}
					</div>
					<div className="cap-extension-camera-resize-layer" data-controls>
						{CAMERA_RESIZE_CORNERS.map((corner) => (
							<button
								key={corner}
								type="button"
								tabIndex={-1}
								className={classNames(
									"cap-extension-camera-resize-handle",
									`is-${corner}`,
									activeResizeCorner === corner && "is-active",
								)}
								aria-label={`Resize camera from ${corner}`}
								title="Drag to resize camera"
								data-camera-resize-handle
								data-camera-resize-ne={corner === "ne" ? "" : undefined}
								onPointerDown={handleCameraResizeStart(corner)}
								onPointerMove={handleCameraResizeMove}
								onPointerUp={endCameraResize}
								onPointerCancel={endCameraResize}
								onLostPointerCapture={endCameraResize}
							/>
						))}
					</div>
				</div>
			</div>
		);

	return (
		<>
			{cameraWindow}
			<video
				ref={pipVideoRef}
				className="cap-extension-parent-pip-video"
				autoPlay
				playsInline
				muted
				disablePictureInPicture={false}
				controlsList="nodownload nofullscreen noremoteplayback"
			/>
			<RecordingBarOverlay
				recorderPanelOpen={recorderPanelOpen}
				webcam={webcam}
				microphone={extensionSettings?.microphone ?? null}
				onToggleWebcam={() => {
					if (!webcam) return;
					const nextEnabled = !webcam.enabled;
					previewDismissedRef.current = !nextEnabled;
					setRecordingPreviewActive(nextEnabled);
					setPreviewOpen(nextEnabled);
					if (!nextEnabled) {
						stopLocalPreview();
					}
					applyWebcamSettings((current) => ({
						...current,
						enabled: nextEnabled,
					}));
				}}
				onUpdateWebcamShape={updateShape}
				onToggleMicrophone={() => {
					if (!extensionSettings) return;
					const nextEnabled = !extensionSettings.microphone.enabled;
					setExtensionSettings((current) => {
						if (!current) return current;
						return {
							...current,
							microphone: { ...current.microphone, enabled: nextEnabled },
						};
					});
					void saveSettings({
						...extensionSettings,
						microphone: {
							...extensionSettings.microphone,
							enabled: nextEnabled,
						},
					}).catch(() => undefined);
					void sendServiceWorkerMessage({
						target: "service-worker",
						type: "toggle-microphone-mute",
						muted: !nextEnabled,
					}).catch(() => undefined);
				}}
			/>
			<CountdownOverlay />
			<ConfirmOverlay />
			{isDragging ? (
				<button
					type="button"
					className="cap-extension-drag-surface"
					tabIndex={-1}
					aria-label="Move camera preview"
					onPointerMove={(event) => moveDrag(event.clientX, event.clientY)}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				/>
			) : null}
		</>
	);
}

const isExtensionContextValid = () => {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
};

const TEARDOWN_EVENT = "cap-extension-overlay-teardown";

const watchExtensionContext = (root: HTMLElement, teardown: () => void) => {
	const interval = window.setInterval(() => {
		if (!isExtensionContextValid()) {
			window.clearInterval(interval);
			teardown();
			root.remove();
		}
	}, 5000);
	return () => window.clearInterval(interval);
};

const mountOverlay = () => {
	// Re-initializing this module (extension reload loads a fresh copy in a
	// new isolated world) must fully unmount the previous React tree:
	// removing only its DOM node would leak the tree's chrome listeners,
	// polls, and clock timers for the rest of the page's life. The teardown
	// event reaches the prior execution's listener through the shared DOM.
	const existingRoot = document.getElementById(ROOT_ID);
	if (existingRoot) {
		existingRoot.dispatchEvent(new Event(TEARDOWN_EVENT));
		existingRoot.remove();
	}

	const root = document.createElement("div");
	root.id = ROOT_ID;
	root.dataset.capMounted = "true";
	const shadow = root.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = overlayCss;
	const app = document.createElement("div");
	shadow.append(style, app);
	document.documentElement.append(root);
	const reactRoot = createRoot(app);
	reactRoot.render(<OverlayApp />);
	const unmount = () => {
		try {
			reactRoot.unmount();
		} catch {}
	};
	const stopWatching = watchExtensionContext(root, unmount);
	root.addEventListener(
		TEARDOWN_EVENT,
		() => {
			stopWatching();
			unmount();
		},
		{ once: true },
	);
};

let initialized = false;

// This module is lazily imported by the bootstrap content script, which is
// the only manifest-declared script; nothing mounts as an import side
// effect. The bootstrap passes along any service-worker messages it
// acknowledged while the module was downloading so they replay into the
// freshly mounted tree.
export const init = (pendingMessages: readonly unknown[] = []) => {
	if (initialized) return;
	initialized = true;
	setStartupMessages(pendingMessages);
	if (document.documentElement) {
		mountOverlay();
	} else {
		document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
	}
};
