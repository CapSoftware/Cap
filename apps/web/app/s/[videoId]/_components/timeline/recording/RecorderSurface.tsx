"use client";

import { Comment, type Video } from "@cap/web-domain";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useCallback, useState } from "react";
import { toast } from "sonner";
import { captureThumbnail } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-conversion";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../../Share";
import {
	dropLocalMediaUrl,
	remapLocalMediaUrl,
	setLocalMediaUrl,
} from "../../media-comment/local-media-urls";
import type { RecordIntentKind } from "../TimelineComposer";
import { formatClock } from "../timeline-format";
import { CameraRecorderPanel } from "./CameraRecorderPanel";
import { normalizeCommentMedia } from "./convert-comment-media";
import { MediaPreviewPanel } from "./MediaPreviewPanel";
import { ScreenRecorderFloatingBar } from "./ScreenRecorderFloatingBar";
import {
	CommentMediaUploadError,
	uploadCommentMedia,
} from "./upload-comment-media";
import type { CommentRecording } from "./useCommentRecorder";
import type { VoiceRecording } from "./useVoiceRecorder";
import { VoiceRecorderBar } from "./VoiceRecorderBar";

export interface RecorderSurfaceProps {
	kind: RecordIntentKind;
	timestamp: number;
	videoId: Video.VideoId;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	onClose: () => void;
}

interface PendingVideo {
	blob: Blob;
	mime: string;
	durationSeconds: number;
	width?: number;
	height?: number;
	hasAudio: boolean;
}

const uploadErrorMessage = (error: unknown) => {
	if (error instanceof CommentMediaUploadError) {
		if (error.reason === "upgrade_required")
			return "Media comments aren't available on this video.";
		if (error.reason === "rate_limited")
			return "You're sending media comments too fast — try again in a bit.";
	}
	return "Couldn't send your recording. Please try again.";
};

/**
 * Lazy-loaded host for the three recording flows. Mounted by the timeline the
 * first time a record button is pressed; the capture hooks live in the child
 * components inside this chunk, so none of this code ships until then.
 */
export default function RecorderSurface({
	kind,
	timestamp,
	videoId,
	onOptimisticComment,
	onCommentSuccess,
	onClose,
}: RecorderSurfaceProps) {
	const user = useCurrentUser();
	const reduceMotion = useReducedMotion() ?? false;
	const [pendingVideo, setPendingVideo] = useState<PendingVideo | null>(null);

	const send = useCallback(
		(input: {
			blob: Blob;
			mime: string;
			mediaKind: "video" | "audio";
			durationSeconds: number;
			width?: number;
			height?: number;
			waveform?: number[];
			hasAudio: boolean;
		}) => {
			if (!user) return;

			const tempId = Comment.CommentId.make(`temp-${Date.now()}`);
			setLocalMediaUrl(tempId, URL.createObjectURL(input.blob));

			const now = new Date();
			const optimistic: CommentType = {
				id: tempId,
				authorId: user.id,
				authorName: user.name,
				authorImage: user.imageUrl,
				content: "",
				createdAt: now,
				updatedAt: now,
				videoId,
				parentCommentId: Comment.CommentId.make(""),
				type: input.mediaKind,
				timestamp,
				// Placeholder so isMediaComment holds; playback comes from the local
				// blob registry until the real key exists.
				mediaKey: `local/${tempId}`,
				mediaDuration: input.durationSeconds,
				mediaMeta: {
					mime: input.mime,
					width: input.width,
					height: input.height,
					waveform: input.waveform,
				},
				sending: true,
			};
			onOptimisticComment?.(optimistic);

			const pipeline = (async () => {
				const normalized = await normalizeCommentMedia({
					blob: input.blob,
					mime: input.mime,
					kind: input.mediaKind,
					hasAudio: input.hasAudio,
				});
				const thumbnailBlob =
					input.mediaKind === "video"
						? await captureThumbnail(normalized.blob, {
								width: input.width,
								height: input.height,
							})
						: null;
				const saved = await uploadCommentMedia({
					videoId,
					blob: normalized.blob,
					mime: normalized.mime,
					kind: input.mediaKind,
					durationSeconds: input.durationSeconds,
					timestamp,
					parentCommentId: Comment.CommentId.make(""),
					width: input.width,
					height: input.height,
					waveform: input.waveform,
					thumbnailBlob,
					authorImage: user.imageUrl,
				});
				remapLocalMediaUrl(tempId, saved.id);
				onCommentSuccess?.(saved as CommentType);
				return saved;
			})().catch((error) => {
				dropLocalMediaUrl(tempId);
				throw error;
			});

			toast.promise(pipeline, {
				loading:
					input.mediaKind === "video"
						? "Sending video comment…"
						: "Sending voice note…",
				success: `Comment added at ${formatClock(timestamp)}`,
				error: uploadErrorMessage,
			});

			// An async transition keeps the optimistic entry applied for the whole
			// upload; a sync one settles immediately and the card would vanish
			// until the real comment lands.
			startTransition(async () => {
				await pipeline.catch(() => {});
			});

			// The surface unmounts now; the pipeline keeps running behind the toast.
			onClose();
		},
		[onClose, onCommentSuccess, onOptimisticComment, timestamp, user, videoId],
	);

	const handleVoiceFinish = useCallback(
		(recording: VoiceRecording) => {
			send({
				blob: recording.blob,
				mime: recording.mime,
				mediaKind: "audio",
				durationSeconds: recording.durationSeconds,
				waveform: recording.waveform,
				hasAudio: true,
			});
		},
		[send],
	);

	const handleVideoFinish = useCallback((recording: CommentRecording) => {
		setPendingVideo(recording);
	}, []);

	const handlePreviewSend = useCallback(() => {
		if (!pendingVideo) return;
		send({
			blob: pendingVideo.blob,
			mime: pendingVideo.mime,
			mediaKind: "video",
			durationSeconds: pendingVideo.durationSeconds,
			width: pendingVideo.width,
			height: pendingVideo.height,
			hasAudio: pendingVideo.hasAudio,
		});
	}, [pendingVideo, send]);

	const handleCancel = useCallback(() => {
		onClose();
	}, [onClose]);

	if (!user) return null;

	const anchored = kind !== "screen" || pendingVideo !== null;

	return (
		<>
			{anchored && (
				<AnimatePresence>
					<motion.div
						key="recorder-surface"
						className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2"
						initial={
							reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }
						}
						animate={
							reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
						}
						exit={
							reduceMotion
								? { opacity: 0, transition: { duration: 0 } }
								: { opacity: 0, scale: 0.95, transition: { duration: 0.12 } }
						}
						transition={
							reduceMotion
								? { duration: 0 }
								: { type: "spring", stiffness: 420, damping: 34 }
						}
					>
						{pendingVideo ? (
							<MediaPreviewPanel
								blob={pendingVideo.blob}
								durationSeconds={pendingVideo.durationSeconds}
								timestamp={timestamp}
								onSend={handlePreviewSend}
								onDiscard={handleCancel}
							/>
						) : kind === "voice" ? (
							<VoiceRecorderBar
								timestamp={timestamp}
								onFinish={handleVoiceFinish}
								onCancel={handleCancel}
							/>
						) : kind === "camera" ? (
							<CameraRecorderPanel
								timestamp={timestamp}
								onFinish={handleVideoFinish}
								onCancel={handleCancel}
							/>
						) : null}
					</motion.div>
				</AnimatePresence>
			)}

			{kind === "screen" && !pendingVideo && (
				<ScreenRecorderFloatingBar
					timestamp={timestamp}
					onFinish={handleVideoFinish}
					onCancel={handleCancel}
				/>
			)}
		</>
	);
}
