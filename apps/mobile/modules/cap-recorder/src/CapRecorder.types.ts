import type { NativeSyntheticEvent, ViewProps } from "react-native";

export type CapRecorderFacing = "front" | "back";

export type CapRecorderSegmentEvent = {
	track: "video" | "audio";
	type: "initialization" | "media";
	index: number;
	uri: string;
	durationSeconds: number;
	byteLength: number;
};

export type CapRecorderStopResult = {
	durationSeconds: number;
	segmentCount: number;
	totalBytes: number;
};

export type CapRecorderErrorEvent = {
	message: string;
};

export type CapRecorderViewRef = {
	startRecording(options: {
		recordingId: string;
		videoBitrate: number;
		segmentDurationSeconds: number;
	}): Promise<void>;
	stopRecording(): Promise<CapRecorderStopResult>;
};

export type CapRecorderViewProps = ViewProps & {
	active?: boolean;
	facing?: CapRecorderFacing;
	onCameraReady?: () => void;
	onRecordingSegment?: (
		event: NativeSyntheticEvent<CapRecorderSegmentEvent>,
	) => void;
	onRecordingError?: (
		event: NativeSyntheticEvent<CapRecorderErrorEvent>,
	) => void;
};
