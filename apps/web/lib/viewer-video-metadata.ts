import type { VideoMetadata } from "@cap/database/types";

export function withoutCreatorClient<
	T extends { metadata: VideoMetadata | null },
>(video: T): T {
	if (!video.metadata?.desktopClient) return video;
	const { desktopClient: _desktopClient, ...metadata } = video.metadata;
	return { ...video, metadata };
}
