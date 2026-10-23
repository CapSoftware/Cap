import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	getEditProcessingState,
	matchesEditOperation,
} from "./video-edit-operation";

interface EditProgress {
	videoId: string;
	jobId: string;
	phase: string;
	progress: number;
	message?: string;
	error?: string;
	metadata?: { duration: number; width: number; height: number; fps: number };
}

export async function applyEditProgress(
	payload: EditProgress,
	token: string | null,
	startedAt: string | null,
) {
	return db().transaction(async (tx) => {
		const [video] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, payload.videoId as Video.VideoId))
			.for("update");
		const state = getEditProcessingState(video?.metadata ?? null);
		if (!token && !state) {
			if (
				video &&
				"outputKey" in video.source &&
				video.source.outputKey?.startsWith(
					`${video.ownerId}/${video.id}/.recording/outputs/edit-`,
				)
			) {
				const [currentUpload] = await tx
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id))
					.for("update");
				if (
					!currentUpload ||
					currentUpload.rawFileKey ===
						`${video.ownerId}/${video.id}/source/original.mp4`
				)
					return true;
			}
			return false;
		}
		if (!video || !state || !token || !startedAt) return true;
		const [upload] = await tx
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, video.id))
			.for("update");
		if (
			!upload ||
			!matchesEditOperation(video, upload, state.sourceKey, {
				token,
				startedAt,
			}) ||
			state.dispatch === "pending" ||
			(state.jobId && state.jobId !== payload.jobId)
		)
			return true;
		if (upload.phase === "complete" || upload.phase === "error") return true;
		const complete = payload.phase === "complete";
		const failed = payload.phase === "error" || payload.phase === "cancelled";
		if (
			complete &&
			(!payload.metadata ||
				![
					payload.metadata.duration,
					payload.metadata.width,
					payload.metadata.height,
					payload.metadata.fps,
				].every((value) => Number.isFinite(value) && value > 0))
		) {
			throw new Error("Edit completion is missing valid media metadata");
		}
		await tx
			.update(videos)
			.set({
				metadata: {
					...video.metadata,
					editProcessing: {
						...state,
						dispatch: "accepted",
						jobId: payload.jobId,
						...(complete && payload.metadata
							? {
									renderedMetadata: {
										duration: payload.metadata.duration,
										width: payload.metadata.width,
										height: payload.metadata.height,
										fps: payload.metadata.fps,
									},
								}
							: {}),
					},
				},
			})
			.where(eq(videos.id, video.id));

		await tx
			.update(videoUploads)
			.set({
				phase: complete ? "complete" : failed ? "error" : "processing",
				processingProgress: complete
					? 100
					: Number.isFinite(payload.progress)
						? Math.round(Math.max(0, Math.min(100, payload.progress)))
						: 0,
				processingMessage: payload.message,
				processingError: failed
					? payload.error || payload.message || "Video edit failed"
					: null,
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, video.id));
		return true;
	});
}
