import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { reconcileStaleEditUpload } from "@/lib/video-edit-processing";
import { EditUpgradeGate } from "./EditUpgradeGate";
import { EditVideoClient } from "./EditVideoClient";

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

export default async function EditVideoPage(props: {
	params: Promise<{ videoId: string }>;
}) {
	const params = await props.params;
	const videoId = Video.VideoId.make(params.videoId);
	const user = await getCurrentUser();

	if (!user) notFound();

	await reconcileStaleEditUpload(videoId);

	const [video] = await db()
		.select({
			id: videos.id,
			name: videos.name,
			ownerId: videos.ownerId,
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			source: videos.source,
			isScreenshot: videos.isScreenshot,
			uploadPhase: videoUploads.phase,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));

	if (
		!video ||
		video.ownerId !== user.id ||
		video.isScreenshot ||
		!isMp4BackedVideo(video.source) ||
		!video.duration ||
		video.duration <= 0
	) {
		notFound();
	}

	if (!userIsPro(user)) {
		return <EditUpgradeGate />;
	}

	if (
		video.uploadPhase &&
		["uploading", "processing", "generating_thumbnail"].includes(
			video.uploadPhase,
		)
	) {
		notFound();
	}

	return (
		<EditVideoClient
			video={{
				id: video.id,
				name: video.name,
				ownerId: video.ownerId,
				duration: video.duration,
				width: video.width,
				height: video.height,
			}}
		/>
	);
}
