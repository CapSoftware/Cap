"use client";

import {
	type InfraVideoListItem,
	infraVideoIsChanging,
} from "@/lib/infra-video-view";
import { useLiveRefresh } from "./live-refresh";
import { useUploadingVideoId } from "./uploads";
import { VideoStatus } from "./video-status";

type Watched = Pick<InfraVideoListItem, "id" | "state" | "createdAt">;

export function useWatchVideos(videos: readonly Watched[]) {
	const uploadingId = useUploadingVideoId();
	useLiveRefresh(
		videos.some(
			(video) =>
				video.id !== uploadingId && infraVideoIsChanging(video, Date.now()),
		),
	);
	return uploadingId;
}

export function WatchVideos({ videos }: { videos: Watched[] }) {
	useWatchVideos(videos);
	return null;
}

export function LiveVideoStatus({ video }: { video: Watched }) {
	return (
		<VideoStatus
			state={video.state}
			uploadingHere={useUploadingVideoId() === video.id}
		/>
	);
}
