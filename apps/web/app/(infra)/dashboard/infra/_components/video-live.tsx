"use client";

import {
	type InfraVideoListItem,
	infraVideoDisplayState,
	infraVideoIsChanging,
} from "@/lib/infra-video-view";
import { useLiveRefresh } from "./live-refresh";
import { useLocalUpload, useUploadingVideoId } from "./uploads";
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
	const localUpload = useLocalUpload();
	return (
		<VideoStatus
			state={infraVideoDisplayState(video.state, localUpload(video.id))}
		/>
	);
}
