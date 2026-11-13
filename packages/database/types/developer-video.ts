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

export interface DeveloperVideoSliceRendition {
	name: string;
	width: number;
	height: number;
	bandwidth: number;
	averageBandwidth: number;
	bytes: number;
	codecs: string | null;
}

export interface DeveloperVideoSliceResult {
	seconds: number;
	renditions: DeveloperVideoSliceRendition[];
	audioBytes: number;
}

// One stretch of the video encoded as its own ladder job. The job moves
// through the same states as a whole output and never becomes "unavailable".
export interface DeveloperVideoSlice {
	startSeconds: number;
	// Null on the last slice, which runs to the end of the video.
	durationSeconds: number | null;
	job: DeveloperVideoPartState;
	attempts: number;
	lostJobs: number;
	result?: DeveloperVideoSliceResult;
}

// Adaptive streaming encoded in slices on several workers. While it is
// "encoding" the hls part stays pending and playlists are built from the
// finished slices. "complete" means the whole ladder was written to `output`
// and the hls part points at it. "abandoned" means a slice could not be made
// and the hls part is encoded as one job instead.
export interface DeveloperVideoSlicedHls {
	state: "encoding" | "complete" | "abandoned";
	output: string;
	// Set when the first slice lands: whether the growing ladder is offered to
	// viewers, or held back until it is whole because the MP4 already plays.
	exposed: boolean | null;
	hasAudio: boolean;
	slices: DeveloperVideoSlice[];
	reason?: string;
}

export interface DeveloperVideoProcessingState {
	encodeId: string;
	startedAt: number;
	probe: DeveloperVideoProbe | null;
	probing?: { token: string; startedAt: number };
	hls: DeveloperVideoPartState;
	mp4: DeveloperVideoPartState;
	sliced?: DeveloperVideoSlicedHls;
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
