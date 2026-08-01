export const videoAnalyticsPlatform = (video: {
	metadata: unknown;
	source: { type: string };
}) => {
	const metadata =
		typeof video.metadata === "object" && video.metadata !== null
			? (video.metadata as Record<string, unknown>)
			: {};
	if (metadata.initiatingPlatform === "cli") return "cli" as const;
	if (
		metadata.source === "mobileUpload" ||
		metadata.source === "mobileCamera"
	) {
		return "mobile" as const;
	}
	if (
		video.source.type === "desktopMP4" ||
		video.source.type === "desktopSegments" ||
		video.source.type === "local"
	) {
		return "desktop" as const;
	}
	return "server" as const;
};
