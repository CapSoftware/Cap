import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { isAbandonedEditorReplacementUpload } from "@/lib/editor-session";
import { editorSourcesUploaded } from "@/lib/editor-sources-ready";
import { measureMissingVideoDuration } from "@/lib/editor-video-duration";
import { getEditSourceKey, isEditSourceKey } from "@/lib/video-edit-processing";
import {
	areEditSpecsEquivalent,
	createIdentityEditSpec,
} from "@/lib/video-edits";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";
import { EditProcessing } from "./EditProcessing";
import { EditUpgradeGate } from "./EditUpgradeGate";
import { EditVideoClient } from "./EditVideoClient";
import { EditRecovery } from "./edit-recovery";

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

export default async function EditVideoPage(props: {
	params: Promise<{ videoId: string }>;
	searchParams?: Promise<{ from?: string | string[] }>;
}) {
	const params = await props.params;
	const justRecorded = (await props.searchParams)?.from === "recording";
	const videoId = Video.VideoId.make(params.videoId);
	const user = await getCurrentUser();

	if (!user) notFound();

	const [video] = await db()
		.select({
			id: videos.id,
			name: videos.name,
			ownerId: videos.ownerId,
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			source: videos.source,
			metadata: videos.metadata,
			isScreenshot: videos.isScreenshot,
			transcriptionStatus: videos.transcriptionStatus,
			uploadPhase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));

	if (
		!video ||
		video.ownerId !== user.id ||
		video.isScreenshot ||
		!isMp4BackedVideo(video.source)
	) {
		notFound();
	}
	// Straight after recording, people who can't open the editor land on the
	// share page rather than an upgrade wall.
	if (
		justRecorded &&
		!isWebStudioEnabledForEmail(user.email) &&
		!userIsPro(user)
	) {
		redirect(`/s/${videoId}`);
	}

	if (
		video.uploadPhase &&
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId,
			rawFileKey: video.rawFileKey,
		})
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
	const [existingEdit] = await db()
		.select({
			editSpec: videoEdits.editSpec,
			sourceKey: videoEdits.sourceKey,
		})
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	if (
		video.uploadPhase &&
		["uploading", "processing", "generating_thumbnail", "error"].includes(
			video.uploadPhase,
		) &&
		!isAbandonedEditorReplacementUpload(
			video.ownerId,
			videoId,
			video.uploadPhase,
			video.rawFileKey,
			video.uploadUpdatedAt,
		)
	) {
		// The studio reads the raw sources, so a recording opens as soon as
		// they're uploaded rather than after the share video finishes processing.
		if (
			!existingEdit &&
			isWebStudioEnabledForEmail(user.email) &&
			(video.duration ?? 0) > 0 &&
			editorSourcesUploaded(video.metadata, video.uploadPhase)
		) {
			redirect(
				`/s/${videoId}/edit/studio${justRecorded ? "?from=recording" : ""}`,
			);
		}
		return <EditProcessing videoId={videoId} justRecorded={justRecorded} />;
	}
	const duration =
		video.duration && video.duration > 0
			? video.duration
			: await measureMissingVideoDuration(videoId);
	if (!duration) notFound();

	const hasExistingEdits = existingEdit
		? !areEditSpecsEquivalent(
				existingEdit.editSpec,
				createIdentityEditSpec(existingEdit.editSpec.sourceDuration),
			)
		: false;
	const editorSources = video.metadata?.editorSources;
	const hasStudioSource = existingEdit
		? existingEdit.sourceKey === getEditSourceKey(video.ownerId, videoId)
		: editorSources == null ||
			(editorSources.version === 1 &&
				Boolean(editorSources.display) &&
				Number.isSafeInteger(editorSources.display.size) &&
				(editorSources.display.size ?? 0) > 0);
	if (
		isWebStudioEnabledForEmail(user.email) &&
		hasStudioSource &&
		!video.metadata?.editProcessing
	) {
		redirect(
			`/s/${videoId}/edit/studio${justRecorded ? "?from=recording" : ""}`,
		);
	}
	if (!userIsPro(user)) {
		return <EditUpgradeGate />;
	}

	return (
		<EditVideoClient
			hasExistingEdits={hasExistingEdits}
			video={{
				id: video.id,
				name: video.name,
				ownerId: video.ownerId,
				duration,
				width: video.width,
				height: video.height,
				transcriptionStatus: video.transcriptionStatus,
			}}
		/>
	);
}
