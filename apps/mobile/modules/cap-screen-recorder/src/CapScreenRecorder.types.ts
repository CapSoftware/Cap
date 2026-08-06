import type { ViewProps } from "react-native";

export type CapScreenRecorderStatus =
	| "missing"
	| "prepared"
	| "recording"
	| "uploading"
	| "finished"
	| "uploaded"
	| "cancelled"
	| "failed";

export type CapScreenRecorderAvailability = {
	available: boolean;
	minimumSystemVersion: string;
	reason: string | null;
};

export type CapScreenRecorderSegment = {
	track: "video" | "audio";
	type: "initialization" | "media";
	index: number;
	uri: string;
	durationSeconds: number;
	byteLength: number;
};

export type CapScreenRecorderUpdates = {
	status: CapScreenRecorderStatus;
	segments: CapScreenRecorderSegment[];
	durationSeconds: number | null;
	totalBytes: number;
	error: string | null;
};

export type PrepareScreenRecordingOptions = {
	recordingId: string;
	width: number;
	height: number;
	videoBitrate: number;
	segmentDurationSeconds: number;
	maximumDurationSeconds: number | null;
};

export type CapScreenRecorderViewProps = ViewProps & {
	enabled?: boolean;
};
