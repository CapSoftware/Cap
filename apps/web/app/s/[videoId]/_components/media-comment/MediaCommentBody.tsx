"use client";

import { useLocalMediaUrl } from "./local-media-urls";
import type { MediaComment } from "./media-comment-types";
import { useMainVideoInterlock } from "./media-playback-registry";
import { VideoCommentCard } from "./VideoCommentCard";
import { VoiceNotePill } from "./VoiceNotePill";

export interface MediaCommentBodyProps {
	comment: MediaComment;
	/**
	 * Blob URL for a just-recorded optimistic comment; preferred over the
	 * network URL so the author sees their recording instantly.
	 */
	localUrl?: string;
	className?: string;
	/** Fewer waveform bars / tighter sizing for narrow containers. */
	compact?: boolean;
}

export const MediaCommentBody = ({
	comment,
	localUrl,
	className,
	compact,
}: MediaCommentBodyProps) => {
	// Refcounted: N mounted bodies still cost one main-video listener.
	useMainVideoInterlock();
	// Optimistic cards play the author's own recording from the local blob
	// registry until the uploaded copy is servable.
	const registryUrl = useLocalMediaUrl(comment.id);
	const effectiveLocalUrl = localUrl ?? registryUrl;

	if (comment.type === "video")
		return (
			<VideoCommentCard
				comment={comment}
				localUrl={effectiveLocalUrl}
				className={className}
			/>
		);

	return (
		<VoiceNotePill
			comment={comment}
			localUrl={effectiveLocalUrl}
			compact={compact}
			className={className}
		/>
	);
};
