"use client";

import type { Video } from "@cap/web-domain";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { CommentType } from "../../../Share";
import { useOptionalPlayback } from "../../playback/PlaybackContext";
import type { RecordIntentKind } from "../../timeline/TimelineComposer";
import CommentInput from "./CommentInput";

// Same deal as the timeline: capture and upload code only loads once someone
// presses record.
const RecorderSurface = dynamic(
	() => import("../../timeline/recording/RecorderSurface"),
	{ ssr: false },
);

const RECORD_OPTIONS: { kind: RecordIntentKind; label: string }[] = [
	{ kind: "screen", label: "Record screen" },
	{ kind: "camera", label: "Record camera" },
	{ kind: "voice", label: "Record voice note" },
];

interface ActivityComposerProps {
	videoId: Video.VideoId;
	/** Whose video this is, for the placeholder. */
	ownerName?: string | null;
	disabled?: boolean;
	onSubmit: (content: string) => void;
	setShowAuthOverlay: (show: boolean) => void;
	/** Owner is on Pro and the viewer is signed in; the upload path re-checks. */
	canRecordMedia?: boolean;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
}

/**
 * The panel's composer, pinned above the comment list. Leading with it (rather
 * than parking it under the scroll) means the primary action is the first thing
 * in the sidebar and an empty panel reads as an invitation.
 */
export function ActivityComposer({
	videoId,
	ownerName,
	disabled,
	onSubmit,
	setShowAuthOverlay,
	canRecordMedia = false,
	onOptimisticComment,
	onCommentSuccess,
}: ActivityComposerProps) {
	const user = useCurrentUser();
	const playback = useOptionalPlayback();
	const [recordIntent, setRecordIntent] = useState<{
		kind: RecordIntentKind;
		t: number;
	} | null>(null);

	const startRecording = useCallback(
		(kind: RecordIntentKind) => {
			// Anchor to wherever the viewer is watching, same as a text comment,
			// and get out of the way of whatever they are about to record.
			const t = playback?.getCurrentTime() ?? 0;
			playback?.pause();
			setRecordIntent({ kind, t });
		},
		[playback],
	);

	// Signed out: the same shape as the real composer rather than a solid
	// sign-in bar, so the panel still opens on an invitation to write.
	if (!user) {
		return (
			<button
				type="button"
				onClick={() => setShowAuthOverlay(true)}
				className="flex w-full items-center gap-2 p-2 text-left rounded-lg border transition-colors bg-gray-1 border-gray-5 hover:border-gray-6"
			>
				<span className="flex justify-center items-center rounded-full size-7 shrink-0 bg-gray-4 text-gray-10">
					<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
						<title>Viewer</title>
						<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.2c-2.6 0-4.8 1.5-4.8 3.3 0 .6.5 1 1.1 1h7.4c.6 0 1.1-.4 1.1-1 0-1.8-2.2-3.3-4.8-3.3Z" />
					</svg>
				</span>
				<span className="flex-1 text-sm truncate text-gray-8">
					{ownerName ? `Respond to ${ownerName}...` : "Leave a comment"}
				</span>
				<span className="text-xs font-medium shrink-0 text-blue-9">
					Sign in
				</span>
			</button>
		);
	}

	return (
		<>
			<CommentInput
				collapsible
				onSubmit={onSubmit}
				disabled={disabled}
				placeholder={
					ownerName ? `Respond to ${ownerName}...` : "Leave a comment"
				}
				buttonLabel="Comment"
				avatar={
					<SignedImageUrl
						image={user.imageUrl}
						name={user.name ?? "You"}
						className="size-7 rounded-full"
						letterClass="text-[11px] font-medium"
					/>
				}
				actions={
					canRecordMedia
						? RECORD_OPTIONS.map((option) => (
								<button
									key={option.kind}
									type="button"
									aria-label={option.label}
									title={option.label}
									disabled={disabled}
									onClick={() => startRecording(option.kind)}
									className="flex size-8 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-50"
								>
									<RecordIcon kind={option.kind} />
								</button>
							))
						: null
				}
			/>

			{recordIntent && (
				<RecorderSurface
					kind={recordIntent.kind}
					timestamp={recordIntent.t}
					videoId={videoId}
					onOptimisticComment={onOptimisticComment}
					onCommentSuccess={onCommentSuccess}
					onClose={() => setRecordIntent(null)}
				/>
			)}
		</>
	);
}

function RecordIcon({ kind }: { kind: RecordIntentKind }) {
	if (kind === "voice") {
		return (
			<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
				<title>Voice</title>
				<path d="M8 2a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V4a2 2 0 0 0-2-2ZM4.4 7.4a.6.6 0 0 0-1.2 0 4.8 4.8 0 0 0 4.2 4.76V13.4H5.8a.6.6 0 1 0 0 1.2h4.4a.6.6 0 1 0 0-1.2H8.6v-1.24a4.8 4.8 0 0 0 4.2-4.76.6.6 0 1 0-1.2 0 3.6 3.6 0 1 1-7.2 0Z" />
			</svg>
		);
	}
	if (kind === "camera") {
		return (
			<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
				<title>Camera</title>
				<path d="M2.5 4A1.5 1.5 0 0 0 1 5.5v5A1.5 1.5 0 0 0 2.5 12h6A1.5 1.5 0 0 0 10 10.5v-5A1.5 1.5 0 0 0 8.5 4h-6Zm9.2 2.4 2.6-1.5c.3-.2.7 0 .7.4v5.4c0 .4-.4.6-.7.4l-2.6-1.5V6.4Z" />
			</svg>
		);
	}
	return (
		<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
			<title>Screen</title>
			<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm3.2 9.4h5.6a.6.6 0 1 1 0 1.2H5.2a.6.6 0 1 1 0-1.2Z" />
		</svg>
	);
}
