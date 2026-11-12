import { developerVideoPlaybackUrls } from "./developer-video-api";
import {
	findPlayableVideo,
	PLAYBACK_ID_PATTERN,
} from "./developer-video-playback";
import { getInfraAppStanding } from "./infra-standing";

const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 9;
const UNEXPLAINED_FAILURE = "This video could not be processed.";

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
		| { kind: "failed"; reason: string }
		| { kind: "paused" }
	);

export async function loadDeveloperVideoPlayer(
	playbackId: string,
): Promise<DeveloperVideoPlayer | null> {
	if (!PLAYBACK_ID_PATTERN.test(playbackId)) return null;

	const video = await findPlayableVideo(playbackId);
	if (!video) return null;

	const { width, height } = video;
	const measured = width !== null && height !== null && width > 0 && height > 0;
	const frame: DeveloperVideoFrame = {
		name: video.name,
		width: measured ? width : DEFAULT_WIDTH,
		height: measured ? height : DEFAULT_HEIGHT,
	};

	const standing = await getInfraAppStanding(video.appId);
	if (standing.state === "paused") return { ...frame, kind: "paused" };

	if (video.status === "errored") {
		return {
			...frame,
			kind: "failed",
			reason: video.errorReason?.trim() || UNEXPLAINED_FAILURE,
		};
	}

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
