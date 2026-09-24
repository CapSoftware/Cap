import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getEditSourceKey, isEditSourceKey } from "@/lib/video-edit-processing";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";
import { EditProcessing } from "../EditProcessing";
import { EditRecovery } from "../edit-recovery";
import { StudioEditorClient } from "./StudioEditorClient";

export default async function StudioEditorPage(props: {
	params: Promise<{ videoId: string }>;
}) {
	const { videoId: rawVideoId } = await props.params;
	const videoId = Video.VideoId.make(rawVideoId);
	const user = await getCurrentUser();
	if (!user || !isWebStudioEnabledForEmail(user.email)) notFound();
	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			duration: videos.duration,
			isScreenshot: videos.isScreenshot,
			source: videos.source,
			metadata: videos.metadata,
			uploadPhase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));
	if (
		!video ||
		video.ownerId !== user.id ||
		video.isScreenshot ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4")
	) {
		notFound();
	}
	if (
		video.metadata?.editProcessing ||
		(video.uploadPhase &&
			isEditSourceKey({
				ownerId: video.ownerId,
				videoId,
				rawFileKey: video.rawFileKey,
			}))
	) {
		return (
			<EditRecovery
				videoId={videoId}
				canRestore={
					!video.metadata?.editProcessing &&
					process.env.CAP_LEGACY_EDIT_RECOVERY === "enabled"
				}
			/>
		);
	}
	if (
		video.uploadPhase &&
		["uploading", "processing", "generating_thumbnail", "error"].includes(
			video.uploadPhase,
		)
	) {
		return <EditProcessing videoId={videoId} />;
	}
	const editorSources = video?.metadata?.editorSources;
	const [existingEdit] = await db()
		.select({ sourceKey: videoEdits.sourceKey })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	const hasStudioSource = existingEdit
		? existingEdit.sourceKey === getEditSourceKey(user.id, videoId)
		: editorSources == null ||
			(editorSources.version === 1 &&
				Boolean(editorSources.display) &&
				Number.isSafeInteger(editorSources.display.size) &&
				(editorSources.display.size ?? 0) > 0);
	if (!video.duration || video.duration <= 0 || !hasStudioSource) {
		notFound();
	}
	return (
		<StudioEditorClient
			videoId={video.id}
			userId={user.id}
			captionsEnabled={userIsPro(user)}
			savedAt={video.metadata?.webEditorProject?.savedAt ?? null}
			preparingTitle={video.name}
			preparingDuration={video.duration}
			preparingTracks={
				editorSources?.camera ||
				video.metadata?.webEditorClips?.items.some((clip) => clip.cameraPath)
					? ["display", "camera"]
					: ["display"]
			}
		/>
	);
}
