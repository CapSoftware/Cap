import type { developerVideos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	DEVELOPER_VIDEO_MP4_FILE,
	DEVELOPER_VIDEO_POSTER_FILE,
} from "./developer-video-plan";
import {
	developerVideoIsTakenDown,
	developerVideoPublicMetadata,
} from "./developer-video-takedown";

type DeveloperVideoRow = typeof developerVideos.$inferSelect;

export interface DeveloperVideoOutputs {
	hls: boolean;
	mp4: boolean;
	poster: boolean;
}

// A row read in full carries its metadata. A list that does not load
// metadata selects the takedown flag on its own instead.
type TakedownSource = { metadata: unknown } | { takenDown: boolean };

type PlayableFields = Pick<
	DeveloperVideoRow,
	"status" | "playbackId" | "processing"
> &
	TakedownSource;

export function developerVideoTakenDown(video: TakedownSource): boolean {
	return "takenDown" in video
		? video.takenDown
		: developerVideoIsTakenDown(video);
}

export function developerVideoOutputs(
	video: PlayableFields,
): DeveloperVideoOutputs {
	const processing = video.processing;
	if (
		video.status !== "ready" ||
		!video.playbackId ||
		!processing ||
		developerVideoTakenDown(video)
	) {
		return { hls: false, mp4: false, poster: false };
	}
	return {
		hls: processing.hls.state === "complete",
		mp4: processing.mp4.state === "complete",
		poster: processing.poster !== null,
	};
}

export function developerPlaybackBaseUrl(): string {
	const configured = serverEnv().INFRA_PLAYBACK_URL;
	const base = configured || `${serverEnv().WEB_URL}/api/developer/playback`;
	return base.replace(/\/+$/, "");
}

export function developerVideoPlaybackUrls(video: PlayableFields): {
	hlsUrl: string | null;
	mp4Url: string | null;
	posterUrl: string | null;
} {
	const outputs = developerVideoOutputs(video);
	const base = `${developerPlaybackBaseUrl()}/${video.playbackId}`;
	return {
		hlsUrl: outputs.hls ? `${base}/${DEVELOPER_VIDEO_MASTER_PLAYLIST}` : null,
		mp4Url: outputs.mp4 ? `${base}/${DEVELOPER_VIDEO_MP4_FILE}` : null,
		posterUrl: outputs.poster ? `${base}/${DEVELOPER_VIDEO_POSTER_FILE}` : null,
	};
}

export function developerVideoPageUrls(
	playbackId: string,
	webUrl: string = serverEnv().WEB_URL,
): { shareUrl: string; embedUrl: string } {
	const shareUrl = `${webUrl.replace(/\/+$/, "")}/dev/${playbackId}`;
	return { shareUrl, embedUrl: `${shareUrl}/embed` };
}

export type AgentDeveloperVideoRow = Pick<
	DeveloperVideoRow,
	| "id"
	| "appId"
	| "externalUserId"
	| "name"
	| "status"
	| "errorReason"
	| "playbackId"
	| "duration"
	| "width"
	| "height"
	| "fps"
	| "maxResolutionTier"
	| "renditions"
	| "transcriptionStatus"
	| "processing"
	| "createdAt"
	| "updatedAt"
> & { takenDown: boolean };

export function toAgentDeveloperVideo(video: AgentDeveloperVideoRow) {
	const status = developerVideoIsReady(video) ? "ready" : video.status;
	return {
		id: video.id,
		appId: video.appId,
		externalUserId: video.externalUserId,
		name: video.name,
		status,
		errorReason: status === "errored" ? video.errorReason : null,
		playbackId: video.playbackId,
		durationSeconds: video.duration,
		width: video.width,
		height: video.height,
		fps: video.fps,
		maxResolutionTier: video.maxResolutionTier,
		renditions: video.renditions ?? [],
		transcriptionStatus: video.transcriptionStatus,
		takenDown: video.takenDown,
		...developerVideoPlaybackUrls(video),
		...(video.playbackId
			? developerVideoPageUrls(video.playbackId)
			: { shareUrl: null, embedUrl: null }),
		createdAt: video.createdAt.toISOString(),
		updatedAt: video.updatedAt.toISOString(),
	};
}

export function serializeDeveloperVideo(video: DeveloperVideoRow) {
	const {
		processing: _processing,
		filesDeletedAt: _filesDeletedAt,
		s3Key: _s3Key,
		...fields
	} = video;
	return {
		...fields,
		metadata: developerVideoPublicMetadata(video.metadata),
		renditions: video.renditions ?? [],
		takenDown: developerVideoIsTakenDown(video),
		...developerVideoPlaybackUrls(video),
		...(video.playbackId
			? developerVideoPageUrls(video.playbackId)
			: { shareUrl: null, embedUrl: null }),
	};
}

// Videos uploaded before encoding existed have no playback id and no
// processing state. They were ready as soon as their upload completed, and
// they stay ready rather than reading as still uploading.
export function developerVideoIsReady(
	video: Pick<
		DeveloperVideoRow,
		"status" | "playbackId" | "processing" | "duration" | "width"
	>,
): boolean {
	if (video.status === "ready") return true;
	const legacy = video.playbackId === null && video.processing === null;
	return legacy && video.duration !== null && video.width !== null;
}

export function serializeDeveloperVideoStatus(video: DeveloperVideoRow) {
	return {
		id: video.id,
		externalUserId: video.externalUserId,
		duration: video.duration,
		width: video.width,
		height: video.height,
		transcriptionStatus: video.transcriptionStatus,
		ready: developerVideoIsReady(video),
		status: video.status,
		errorReason: video.errorReason,
		playbackId: video.playbackId,
		renditions: video.renditions ?? [],
		takenDown: developerVideoIsTakenDown(video),
		...developerVideoPlaybackUrls(video),
	};
}
