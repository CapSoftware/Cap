const HOST_ID = "cap-camera-preview-host";

let shadowHost: HTMLElement | null = null;
let iframe: HTMLIFrameElement | null = null;
let dragState: {
	isDragging: boolean;
	startX: number;
	startY: number;
	offsetX: number;
	offsetY: number;
} = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };

function getDefaultPosition() {
	return {
		x: window.innerWidth - 270,
		y: window.innerHeight - 320,
	};
}

function createCameraOverlay(state: {
	deviceId: string;
	size: string;
	shape: string;
	mirrored: boolean;
}) {
	if (document.getElementById(HOST_ID)) return;

	shadowHost = document.createElement("div");
	shadowHost.id = HOST_ID;
	shadowHost.style.cssText =
		"position:fixed;z-index:2147483647;border:none;pointer-events:auto;";

	const pos = getDefaultPosition();
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
			width: 100%;
			height: 100%;
			cursor: move;
			user-select: none;
		}
		iframe {
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

	const cameraUrl = chrome.runtime.getURL("camera.html");
	iframe = document.createElement("iframe");
	iframe.src = cameraUrl;
	iframe.allow = "camera;autoplay;picture-in-picture";
	iframe.style.cssText =
		"width:100%;height:100%;border:none;background:transparent;";

	iframe.addEventListener("load", () => {
		if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage({ type: "CAMERA_INIT", state }, "*");
		}
	});

	container.appendChild(iframe);
	shadow.appendChild(container);

	container.addEventListener("mousedown", onDragStart);
	document.addEventListener("mousemove", onDragMove);
	document.addEventListener("mouseup", onDragEnd);

	document.body.appendChild(shadowHost);
}

function removeCameraOverlay() {
	if (shadowHost) {
		shadowHost.remove();
		shadowHost = null;
		iframe = null;
	}
	document.removeEventListener("mousemove", onDragMove);
	document.removeEventListener("mouseup", onDragEnd);
}

function onDragStart(e: MouseEvent) {
	if (!shadowHost) return;

	const target = e.composedPath()[0] as HTMLElement;
	if (target.tagName === "IFRAME") return;

	e.preventDefault();
	e.stopPropagation();

	const rect = shadowHost.getBoundingClientRect();
	dragState = {
		isDragging: true,
		startX: e.clientX,
		startY: e.clientY,
		offsetX: e.clientX - rect.left,
		offsetY: e.clientY - rect.top,
	};
}

function onDragMove(e: MouseEvent) {
	if (!dragState.isDragging || !shadowHost) return;

	e.preventDefault();

	const newX = e.clientX - dragState.offsetX;
	const newY = e.clientY - dragState.offsetY;

	const maxX = window.innerWidth - shadowHost.offsetWidth;
	const maxY = window.innerHeight - shadowHost.offsetHeight;

	shadowHost.style.left = `${Math.max(0, Math.min(newX, maxX))}px`;
	shadowHost.style.top = `${Math.max(0, Math.min(newY, maxY))}px`;
}

function onDragEnd() {
	dragState.isDragging = false;
}

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: ChromeMessageSender,
		sendResponse: ChromeMessageResponse,
	) => {
		const msg = message as {
			type: string;
			state?: Record<string, unknown>;
		};

		if (msg.type === "INJECT_CAMERA" && msg.state) {
			createCameraOverlay(
				msg.state as {
					deviceId: string;
					size: string;
					shape: string;
					mirrored: boolean;
				},
			);
			sendResponse({ ok: true });
			return;
		}

		if (
			msg.type === "UPDATE_CAMERA_CONTENT" &&
			msg.state &&
			iframe?.contentWindow
		) {
			iframe.contentWindow.postMessage(
				{ type: "CAMERA_UPDATE", state: msg.state },
				"*",
			);
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
	},
);

window.addEventListener("message", (event) => {
	if (event.source !== iframe?.contentWindow) return;

	const msg = event.data as { type: string; width?: number; height?: number };

	if (msg.type === "CAMERA_RESIZE" && shadowHost) {
		const width = msg.width ?? 250;
		const height = msg.height ?? 302;
		shadowHost.style.width = `${width}px`;
		shadowHost.style.height = `${height}px`;
	}

	if (msg.type === "CAMERA_CLOSED") {
		removeCameraOverlay();
		chrome.runtime.sendMessage({ type: "HIDE_CAMERA" });
	}
});
