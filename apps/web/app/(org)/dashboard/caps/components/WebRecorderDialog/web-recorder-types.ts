export type RecorderPhase =
	| "idle"
	| "recording"
	| "paused"
	| "creating"
	| "converting"
	| "uploading"
	| "completed"
	| "error";

export type RecorderErrorEvent = Event & { error?: DOMException };

type VideoNamespace = typeof import("@cap/web-domain").Video;
export type PresignedPost = VideoNamespace["PresignedPost"]["Type"];
export type VideoId = VideoNamespace["VideoId"]["Type"];
