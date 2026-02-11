export type OffscreenStartCameraMessage = {
	type: "OFFSCREEN_START_CAMERA";
	deviceId: string;
};

export type OffscreenStopCameraMessage = {
	type: "OFFSCREEN_STOP_CAMERA";
};

export type OffscreenSwitchCameraMessage = {
	type: "OFFSCREEN_SWITCH_CAMERA";
	deviceId: string;
};

export type OffscreenCaptureFrameMessage = {
	type: "OFFSCREEN_CAPTURE_FRAME";
	mirrored: boolean;
};

export type OffscreenMessage =
	| OffscreenStartCameraMessage
	| OffscreenStopCameraMessage
	| OffscreenSwitchCameraMessage
	| OffscreenCaptureFrameMessage;
