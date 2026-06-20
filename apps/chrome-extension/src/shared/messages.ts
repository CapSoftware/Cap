import type {
	OffscreenRequest,
	OverlayMessage,
	RecordingStatusBroadcast,
	ServiceWorkerRequest,
} from "./types";

const hasType = (message: unknown): message is { type: string } =>
	!!message &&
	typeof message === "object" &&
	"type" in message &&
	typeof message.type === "string";

const hasTarget = <TTarget extends string>(
	message: unknown,
	target: TTarget,
): message is { target: TTarget; type: string } =>
	hasType(message) && "target" in message && message.target === target;

export const isServiceWorkerRequest = (
	message: unknown,
): message is ServiceWorkerRequest => hasTarget(message, "service-worker");

export const isOffscreenRequest = (
	message: unknown,
): message is OffscreenRequest => hasTarget(message, "offscreen");

export const isOverlayMessage = (message: unknown): message is OverlayMessage =>
	hasType(message) &&
	(message.type === "overlay-settings" ||
		message.type === "overlay-countdown" ||
		message.type === "overlay-confirm" ||
		message.type === "overlay-enter-auto-pip" ||
		message.type === "overlay-exit-auto-pip" ||
		message.type === "overlay-hide" ||
		message.type === "overlay-panel-toggle" ||
		message.type === "overlay-panel-hide");

export const isRecordingStatusBroadcast = (
	message: unknown,
): message is RecordingStatusBroadcast =>
	hasTarget(message, "recording-status") &&
	message.type === "recording-status-changed";
