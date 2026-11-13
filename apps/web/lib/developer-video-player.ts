import { developerVideoPlaybackUrls } from "./developer-video-api";
import {
	findPlayableVideo,
	PLAYBACK_ID_PATTERN,
} from "./developer-video-playback";
import { redriveDeveloperVideoProcessing } from "./developer-video-start";
import { developerVideoRedrive } from "./developer-video-state";
import { getInfraAppStanding } from "./infra-standing";

const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 9;

interface DeveloperVideoFrame {
	name: string;
	width: number;
	height: number;
}

export type DeveloperVideoPlayer = DeveloperVideoFrame &
	(
		| {
				kind: "playing";
				source: { hls?: string; mp4?: string };
				poster: string | null;
		  }
		| { kind: "processing"; uploading: boolean }
		| { kind: "failed" }
		| { kind: "paused" }
	);

type PlayableVideo = NonNullable<Awaited<ReturnType<typeof findPlayableVideo>>>;

function frameOf({ name, width, height }: PlayableVideo): DeveloperVideoFrame {
	const measured = width !== null && height !== null && width > 0 && height > 0;
	return {
		name,
		width: measured ? width : DEFAULT_WIDTH,
		height: measured ? height : DEFAULT_HEIGHT,
	};
}

// The same guarded retry the read API runs. Without it a video whose
// processing never started, or stalled, would wait on this page forever
// unless its owner happened to poll the API.
async function redriveStalled(video: PlayableVideo, playbackId: string) {
	if (!developerVideoRedrive(video, Date.now())) return video;
	const started = await redriveDeveloperVideoProcessing(video.id);
	return started ? findPlayableVideo(playbackId) : video;
}

export async function loadDeveloperVideoPlayer(
	playbackId: string,
): Promise<DeveloperVideoPlayer | null> {
	if (!PLAYBACK_ID_PATTERN.test(playbackId)) return null;

	const found = await findPlayableVideo(playbackId);
	if (!found) return null;

	const standing = await getInfraAppStanding(found.appId);
	if (standing.state === "paused") return { ...frameOf(found), kind: "paused" };

	const video = await redriveStalled(found, playbackId);
	if (!video) return null;
	const frame = frameOf(video);

	if (video.status === "errored") return { ...frame, kind: "failed" };

	const { hlsUrl, mp4Url, posterUrl } = developerVideoPlaybackUrls(video);
	if (hlsUrl || mp4Url) {
		return {
			...frame,
			kind: "playing",
			source: { hls: hlsUrl ?? undefined, mp4: mp4Url ?? undefined },
			poster: posterUrl,
		};
	}

	return {
		...frame,
		kind: "processing",
		uploading: video.status === "uploading",
	};
}
