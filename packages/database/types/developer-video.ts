export const DEVELOPER_VIDEO_STATUSES = [
	"uploading",
	"processing",
	"ready",
	"errored",
] as const;

export type DeveloperVideoStatus = (typeof DEVELOPER_VIDEO_STATUSES)[number];

export const DEVELOPER_VIDEO_RESOLUTION_TIERS = [
	"1080p",
	"1440p",
	"2160p",
] as const;

export type DeveloperVideoResolutionTier =
	(typeof DEVELOPER_VIDEO_RESOLUTION_TIERS)[number];

export interface DeveloperVideoRendition {
	name: string;
	width: number;
	height: number;
	bitrate: number;
	bytes: number;
	codecs: string | null;
}

export type DeveloperVideoPart = "hls" | "mp4";

export type DeveloperVideoPartState =
	| { state: "pending" }
	| {
			state: "running";
			token: string;
			jobId: string | null;
			startedAt: number;
			checkedAt?: number;
			notFoundAt?: number;
	  }
	| { state: "complete"; output: string }
	| { state: "failed"; reason: string }
	| { state: "unavailable"; reason: string; retryAt: number };

export interface DeveloperVideoProbe {
	duration: number | null;
	width: number;
	height: number;
	fps: number | null;
}

export interface DeveloperVideoProcessingState {
	encodeId: string;
	startedAt: number;
	probe: DeveloperVideoProbe | null;
	probing?: { token: string; startedAt: number };
	hls: DeveloperVideoPartState;
	mp4: DeveloperVideoPartState;
	attempts: Record<DeveloperVideoPart, number>;
	lostJobs?: Partial<Record<DeveloperVideoPart, number>>;
	unavailableChecks: number;
	poster: { output: string } | null;
	bytes: {
		source: number;
		hls: number;
		mp4: number;
		poster: number;
	};
}
