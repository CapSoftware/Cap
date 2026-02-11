export type CameraPreviewSize = "sm" | "lg";
export type CameraPreviewShape = "round" | "square" | "full";

export type VideoDimensions = {
	width: number;
	height: number;
};

export type CameraPosition = {
	x: number;
	y: number;
};

export type CameraState = {
	deviceId: string;
	size: CameraPreviewSize;
	shape: CameraPreviewShape;
	mirrored: boolean;
	position?: CameraPosition;
};

export const WINDOW_PADDING = 20;
export const BAR_HEIGHT = 52;

export const getPreviewMetrics = (
	previewSize: CameraPreviewSize,
	previewShape: CameraPreviewShape,
	dimensions: VideoDimensions | null,
) => {
	const base = previewSize === "sm" ? 230 : 400;

	if (!dimensions || dimensions.height === 0) {
		return { base, width: base, height: base, aspectRatio: 1 };
	}

	const aspectRatio = dimensions.width / dimensions.height;

	if (previewShape !== "full") {
		return { base, width: base, height: base, aspectRatio };
	}

	if (aspectRatio >= 1) {
		return { base, width: base * aspectRatio, height: base, aspectRatio };
	}

	return { base, width: base, height: base / aspectRatio, aspectRatio };
};

export type ShowCameraMessage = {
	type: "SHOW_CAMERA";
	state: CameraState;
};

export type HideCameraMessage = {
	type: "HIDE_CAMERA";
};

export type UpdateCameraMessage = {
	type: "UPDATE_CAMERA";
	state: Partial<CameraState>;
};

export type GetCameraStateMessage = {
	type: "GET_CAMERA_STATE";
};

export type PopupMessage =
	| ShowCameraMessage
	| HideCameraMessage
	| UpdateCameraMessage
	| GetCameraStateMessage;

export type InjectCameraMessage = {
	type: "INJECT_CAMERA";
	state: CameraState;
	lastFrameDataUrl?: string | null;
};

export type UpdateCameraContentMessage = {
	type: "UPDATE_CAMERA_CONTENT";
	state: Partial<CameraState>;
};

export type RemoveCameraMessage = {
	type: "REMOVE_CAMERA";
};

export type CaptureLastFrameMessage = {
	type: "CAPTURE_LAST_FRAME";
};

export type EnterCameraPipMessage = {
	type: "ENTER_CAMERA_PIP";
};

export type ExitCameraPipMessage = {
	type: "EXIT_CAMERA_PIP";
};

export type BackgroundToContentMessage =
	| InjectCameraMessage
	| UpdateCameraContentMessage
	| RemoveCameraMessage
	| CaptureLastFrameMessage
	| EnterCameraPipMessage
	| ExitCameraPipMessage;

export type CameraInitMessage = {
	type: "CAMERA_INIT";
	state: CameraInitState;
};

export type CameraUpdateMessage = {
	type: "CAMERA_UPDATE";
	state: Partial<CameraState>;
};

export type CameraResizeMessage = {
	type: "CAMERA_RESIZE";
	width: number;
	height: number;
};

export type CameraClosedMessage = {
	type: "CAMERA_CLOSED";
};

export type CameraReadyMessage = {
	type: "CAMERA_READY";
};

export type CameraInitState = CameraState & {
	lastFrameDataUrl?: string | null;
};

export type CameraCaptureFrameMessage = {
	type: "CAMERA_CAPTURE_FRAME";
};

export type CameraFrameCapturedMessage = {
	type: "CAMERA_FRAME_CAPTURED";
	dataUrl: string | null;
};

export type CameraStateChangedMessage = {
	type: "CAMERA_STATE_CHANGED";
	state: Partial<CameraState>;
};

export type CameraDragDeltaMessage = {
	type: "CAMERA_DRAG_DELTA";
	deltaX: number;
	deltaY: number;
};

export type CameraDragEndMessage = {
	type: "CAMERA_DRAG_END";
};

export type CameraEnterPipMessage = {
	type: "CAMERA_ENTER_PIP";
};

export type CameraExitPipMessage = {
	type: "CAMERA_EXIT_PIP";
};

export type IframeMessage =
	| CameraInitMessage
	| CameraUpdateMessage
	| CameraResizeMessage
	| CameraClosedMessage
	| CameraReadyMessage
	| CameraCaptureFrameMessage
	| CameraFrameCapturedMessage
	| CameraStateChangedMessage
	| CameraDragDeltaMessage
	| CameraDragEndMessage
	| CameraEnterPipMessage
	| CameraExitPipMessage;
