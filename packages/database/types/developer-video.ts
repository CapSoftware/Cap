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
	// The first slice carries the whole video's audio, which may be copied from
	// the source at its own rate instead of encoded at 128 kbps.
	audioBitrate?: number;
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
	// When every worker last answered busy to a start of this encode.
	busyAt?: number;
	// When the video became ready with an output still encoding. video.ready
	// is sent, and this removed, once the outputs settle. A video that became
	// ready without it was already announced, by this code or by older code.
	readyEventDueAt?: number;
	unavailableChecks: number;
	poster: { output: string } | null;
	bytes: {
		source: number;
		hls: number;
		mp4: number;
		poster: number;
	};
}

// A video Cap staff took down keeps its own metadata under this key. See
// developer-video-takedown.ts for why the flag lives in metadata.
export const DEVELOPER_VIDEO_TAKEDOWN_KEY = "__capTakedown";
