import type {
	BackgroundToContentMessage,
	CameraInitState,
	CameraPosition,
	CameraState,
	IframeMessage,
} from "../lib/messages";

const globalScope = globalThis as unknown as {
	__capCameraContentScriptLoaded?: boolean;
};
const alreadyLoaded = globalScope.__capCameraContentScriptLoaded === true;
if (!alreadyLoaded) globalScope.__capCameraContentScriptLoaded = true;

const HOST_ID = "cap-camera-preview-host";

let shadowHost: HTMLElement | null = null;
let iframe: HTMLIFrameElement | null = null;
let placeholderImage: HTMLImageElement | null = null;
let overlayPosition: CameraPosition | null = null;

let pendingInitState: CameraInitState | null = null;

function getDefaultPosition() {
	return {
		x: window.innerWidth - 270,
		y: window.innerHeight - 320,
	};
}

function clampPosition(
	position: CameraPosition,
	width: number,
	height: number,
): CameraPosition {
	const maxX = Math.max(0, window.innerWidth - width);
	const maxY = Math.max(0, window.innerHeight - height);

	return {
		x: Math.max(0, Math.min(position.x, maxX)),
		y: Math.max(0, Math.min(position.y, maxY)),
	};
}

function applyOverlayPosition(position: CameraPosition) {
	if (!shadowHost) return;

	overlayPosition = position;
	shadowHost.style.left = `${position.x}px`;
	shadowHost.style.top = `${position.y}px`;
}

function ensureOverlayPosition() {
	if (!shadowHost) return;

	const left = Number.parseFloat(shadowHost.style.left || "0");
	const top = Number.parseFloat(shadowHost.style.top || "0");
	const next = clampPosition(
		{ x: Number.isFinite(left) ? left : 0, y: Number.isFinite(top) ? top : 0 },
		shadowHost.offsetWidth,
		shadowHost.offsetHeight,
	);
	applyOverlayPosition(next);
}

function createCameraOverlay(
	state: CameraState,
	lastFrameDataUrl?: string | null,
) {
	if (document.getElementById(HOST_ID)) return;

	shadowHost = document.createElement("div");
	shadowHost.id = HOST_ID;
	shadowHost.style.cssText =
		"position:fixed;z-index:2147483647;border:none;pointer-events:auto;";

	const initialWidth = 250;
	const initialHeight = 302;
	const pos = clampPosition(
		state.position ?? getDefaultPosition(),
		initialWidth,
		initialHeight,
	);
	overlayPosition = pos;
	shadowHost.style.left = `${pos.x}px`;
	shadowHost.style.top = `${pos.y}px`;
	shadowHost.style.width = "250px";
	shadowHost.style.height = "302px";

	const shadow = shadowHost.attachShadow({ mode: "open" });

	const style = document.createElement("style");
	style.textContent = `
		:host {
			all: initial;
		}
		.cap-camera-container {
			position: relative;
			width: 100%;
			height: 100%;
			cursor: grab;
			user-select: none;
		}
		.cap-camera-placeholder {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			object-fit: cover;
			pointer-events: none;
			transition: opacity 0.3s ease-out;
		}
		iframe {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			border: none;
			background: transparent;
			pointer-events: auto;
		}
	`;
	shadow.appendChild(style);

	const container = document.createElement("div");
	container.className = "cap-camera-container";

	if (lastFrameDataUrl) {
		placeholderImage = document.createElement("img");
		placeholderImage.className = "cap-camera-placeholder";
		placeholderImage.src = lastFrameDataUrl;
		placeholderImage.style.borderRadius =
			state.shape === "round" ? "9999px" : "3rem";
		container.appendChild(placeholderImage);
	}

	const cameraUrl = chrome.runtime.getURL("camera.html");
	iframe = document.createElement("iframe");
	iframe.src = cameraUrl;
	iframe.allow = "camera;autoplay;picture-in-picture;auto-picture-in-picture";
	iframe.style.cssText =
		"width:100%;height:100%;border:none;background:transparent;";

	pendingInitState = {
		...state,
		lastFrameDataUrl: lastFrameDataUrl ?? null,
	};

	container.appendChild(iframe);
	shadow.appendChild(container);

	document.body.appendChild(shadowHost);
	requestAnimationFrame(ensureOverlayPosition);
}

function removeCameraOverlay() {
	pendingInitState = null;

	if (shadowHost) {
		shadowHost.remove();
		shadowHost = null;
		iframe = null;
		placeholderImage = null;
		overlayPosition = null;
	}
}

if (!alreadyLoaded) {
	chrome.runtime.onMessage.addListener(
		(
			message: unknown,
			_sender: ChromeMessageSender,
			sendResponse: ChromeMessageResponse,
		) => {
			const msg = message as BackgroundToContentMessage;

			if (msg.type === "INJECT_CAMERA") {
				createCameraOverlay(msg.state, msg.lastFrameDataUrl ?? null);
				sendResponse({ ok: true });
				return;
			}

			if (msg.type === "UPDATE_CAMERA_CONTENT" && msg.state) {
				if (msg.state.position) {
					applyOverlayPosition(
						clampPosition(
							msg.state.position,
							shadowHost?.offsetWidth ?? 0,
							shadowHost?.offsetHeight ?? 0,
						),
					);
				}

				if (iframe?.contentWindow) {
					const iframeMsg: IframeMessage = {
						type: "CAMERA_UPDATE",
						state: msg.state,
					};
					iframe.contentWindow.postMessage(iframeMsg, "*");
				}
				sendResponse({ ok: true });
				return;
			}

			if (msg.type === "REMOVE_CAMERA") {
				if (iframe?.contentWindow) {
					iframe.contentWindow.postMessage({ type: "CAMERA_DESTROY" }, "*");
				}
				setTimeout(removeCameraOverlay, 50);
				sendResponse({ ok: true });
				return;
			}

			if (msg.type === "ENTER_CAMERA_PIP") {
				if (iframe?.contentWindow) {
					const iframeMsg: IframeMessage = { type: "CAMERA_ENTER_PIP" };
					iframe.contentWindow.postMessage(iframeMsg, "*");
				}
				sendResponse({ ok: true });
				return;
			}

			if (msg.type === "EXIT_CAMERA_PIP") {
				if (iframe?.contentWindow) {
					const iframeMsg: IframeMessage = { type: "CAMERA_EXIT_PIP" };
					iframe.contentWindow.postMessage(iframeMsg, "*");
				}
				sendResponse({ ok: true });
				return;
			}
		},
	);

	window.addEventListener("message", (event) => {
		if (event.source !== iframe?.contentWindow) return;

		const msg = event.data as IframeMessage;

		if (msg.type === "CAMERA_RESIZE" && shadowHost) {
			const width = msg.width || 250;
			const height = msg.height || 302;
			shadowHost.style.width = `${width}px`;
			shadowHost.style.height = `${height}px`;
			ensureOverlayPosition();
		}

		if (msg.type === "CAMERA_CLOSED") {
			removeCameraOverlay();
			chrome.runtime.sendMessage({ type: "HIDE_CAMERA" });
		}

		if (msg.type === "CAMERA_READY") {
			if (pendingInitState && iframe?.contentWindow) {
				const initMsg: IframeMessage = {
					type: "CAMERA_INIT",
					state: pendingInitState,
				};
				iframe.contentWindow.postMessage(initMsg, "*");
				pendingInitState = null;
			}
			if (placeholderImage) {
				placeholderImage.style.opacity = "0";
				const img = placeholderImage;
				setTimeout(() => {
					img.remove();
					if (placeholderImage === img) placeholderImage = null;
				}, 300);
			}
		}

		if (msg.type === "CAMERA_STATE_CHANGED") {
			chrome.runtime.sendMessage({ type: "UPDATE_CAMERA", state: msg.state });
		}

		if (msg.type === "CAMERA_DRAG_DELTA") {
			if (!shadowHost) return;
			const current = overlayPosition ?? getDefaultPosition();
			const next = clampPosition(
				{ x: current.x + msg.deltaX, y: current.y + msg.deltaY },
				shadowHost.offsetWidth,
				shadowHost.offsetHeight,
			);
			applyOverlayPosition(next);
		}

		if (msg.type === "CAMERA_DRAG_END") {
			if (!overlayPosition) return;
			chrome.runtime.sendMessage({
				type: "UPDATE_CAMERA",
				state: { position: overlayPosition },
			});
		}
	});
}
