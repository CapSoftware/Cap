"use client";

import { Comment, type Video } from "@cap/web-domain";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { captureThumbnail } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-conversion";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../../Share";
import {
	dropLocalMediaUrl,
	remapLocalMediaUrl,
	setLocalMediaUrl,
} from "../../media-comment/local-media-urls";
import {
	clearUploadProgress,
	setUploadProgress,
} from "../../media-comment/upload-progress";
import type { RecordIntentKind } from "../TimelineComposer";
import { formatClock } from "../timeline-format";
import { CameraRecorderPanel } from "./CameraRecorderPanel";
import { normalizeCommentMedia } from "./convert-comment-media";
import { MediaPreviewPanel } from "./MediaPreviewPanel";
import { ScreenRecorderPanel } from "./ScreenRecorderPanel";
import {
	CommentMediaUploadError,
	uploadCommentMedia,
} from "./upload-comment-media";
import type { CommentRecording } from "./useCommentRecorder";
import type { VoiceRecording } from "./useVoiceRecorder";
import { VoiceRecorderPanel } from "./VoiceRecorderPanel";

export interface RecorderSurfaceProps {
	kind: RecordIntentKind;
	timestamp: number;
	videoId: Video.VideoId;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	onClose: () => void;
	/**
	 * "anchored": absolutely positioned above the mount point — the timeline
	 * composer, whose shelf is a positioned ancestor built for escaping cards.
	 * "floating": portaled to a fixed bottom-center bar, for composers living
	 * inside clipping containers (the sidebar's tab pane, the reaction bar).
	 */
	placement?: "anchored" | "floating";
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
			return "You're sending media comments too fast. Try again in a bit.";
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
	placement = "anchored",
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
			// An entry from the very start: the card reads 0% as "preparing" while
			// conversion and the thumbnail run, before any bytes move.
			setUploadProgress(tempId, 0);

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
					onProgress: (fraction) => setUploadProgress(tempId, fraction),
				});
				remapLocalMediaUrl(tempId, saved.id);
				clearUploadProgress(tempId);
				// clientKey keeps the real comment on the optimistic card's React
				// key, so the settle swaps data inside the same mounted card instead
				// of remounting it (which restarts playback and flashes the poster).
				onCommentSuccess?.({ ...(saved as CommentType), clientKey: tempId });
				return saved;
			})().catch((error) => {
				dropLocalMediaUrl(tempId);
				clearUploadProgress(tempId);
				throw error;
			});

			toast.promise(pipeline, {
				loading:
					input.mediaKind === "video"
						? "Sending video comment…"
						: "Sending voice note…",
				// 0 means "wasn't watching yet", not a chosen moment — no stamp.
				success:
					timestamp > 0
						? `Comment added at ${formatClock(timestamp)}`
						: "Comment added",
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

	// Retake goes back to the recorder for another take (camera re-opens its
	// preview, screen returns to its setup card) — closing the whole surface
	// here would turn "Retake" into a lie.
	const handleRetake = useCallback(() => {
		setPendingVideo(null);
	}, []);

	if (!user) return null;

	// AnimatePresence outlives the conditional child so the exit animation can
	// actually play when the panel swaps away.
	const panel = (
		<AnimatePresence>
			<motion.div
				key="recorder-surface"
				className={
					placement === "floating"
						? "fixed bottom-6 left-1/2 z-[60] max-w-[calc(100vw-1.5rem)]"
						: "absolute bottom-full left-1/2 z-50 mb-2"
				}
				// Centering rides in style, not className: motion owns the inline
				// transform while animating y/scale and silently drops a class-based
				// -translate-x-1/2 (the panel then hangs off the anchor's right).
				style={{ translateX: "-50%" }}
				initial={
					reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }
				}
				animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
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
						onDiscard={handleRetake}
					/>
				) : kind === "voice" ? (
					<VoiceRecorderPanel
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
				) : kind === "screen" ? (
					<ScreenRecorderPanel
						timestamp={timestamp}
						onFinish={handleVideoFinish}
						onCancel={handleCancel}
					/>
				) : null}
			</motion.div>
		</AnimatePresence>
	);

	// A composer inside a clipping container (sidebar tab pane, reaction bar)
	// can't host an absolutely-anchored card — the panel escapes to a fixed
	// bottom-center portal instead. This chunk is ssr:false, but guard document
	// anyway so the component stays render-safe wherever it's imported.
	return placement === "floating" && typeof document !== "undefined"
		? createPortal(panel, document.body)
		: panel;
}
