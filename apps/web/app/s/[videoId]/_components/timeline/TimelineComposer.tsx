"use client";

import { Comment, type Video } from "@cap/web-domain";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useEffect, useState } from "react";
import { newComment } from "@/actions/videos/new-comment";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../Share";
import { AuthOverlay } from "../AuthOverlayLazy";
import { MicGlyph } from "./TimelineBranch";
import { useTimelineActions, useTimelineState } from "./TimelineProvider";
import {
	CARD_WIDTH,
	fractionInWindow,
	RAIL_PAD_X,
	usableWidth,
} from "./timeline-constants";
import { formatClock } from "./timeline-format";

/**
 * Recording kinds the composer can ask for. The timeline only expresses the
 * intent and the time it happened at; capture, upload and the optimistic media
 * comment all belong to whoever supplies `onRecordIntent`.
 */
export type RecordIntentKind = "screen" | "camera" | "voice";

export interface TimelineComposerProps {
	videoId: Video.VideoId;
	trackWidth: number;
	windowStart: number;
	windowEnd: number;
	/** Server's view of the viewer; the auth hook supplies who they are. */
	viewerSignedIn?: boolean;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	/** Overrides the locally owned auth dialog when the host has its own. */
	onRequestAuth?: () => void;
	/**
	 * Supplied by the recording phase. Until then the buttons stay out, but the
	 * row keeps its height so adding them later moves nothing.
	 */
	onRecordIntent?: (kind: RecordIntentKind, t: number) => void;
}

const RECORD_OPTIONS: { kind: RecordIntentKind; label: string }[] = [
	{ kind: "screen", label: "Record screen" },
	{ kind: "camera", label: "Record camera" },
	{ kind: "voice", label: "Record voice note" },
];

const clampCenter = (percent: number, trackWidth: number): number => {
	const x = RAIL_PAD_X + (percent / 100) * usableWidth(trackWidth);
	const half = CARD_WIDTH / 2;
	if (trackWidth < CARD_WIDTH + 16) return trackWidth / 2;
	return Math.min(Math.max(x, half + 8), trackWidth - half - 8);
};

/** Anchored "comment at this exact moment" card. */
export function TimelineComposer({
	videoId,
	trackWidth,
	windowStart,
	windowEnd,
	viewerSignedIn = false,
	onOptimisticComment,
	onCommentSuccess,
	onRequestAuth,
	onRecordIntent,
}: TimelineComposerProps) {
	const { composerAnchor } = useTimelineState();
	const { closeComposer } = useTimelineActions();
	const user = useCurrentUser();
	const reduceMotion = useReducedMotion() ?? false;
	const [value, setValue] = useState("");
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);

	// Both have to agree: the page was rendered for a signed-in viewer and the
	// client knows who that is.
	const canComment = viewerSignedIn && user !== null;
	const anchorTime = composerAnchor?.t ?? 0;

	useEffect(() => {
		if (!composerAnchor) setValue("");
	}, [composerAnchor]);

	const requestAuth = () => {
		if (onRequestAuth) onRequestAuth();
		else setShowAuthOverlay(true);
	};

	const submit = async () => {
		const content = value.trim();
		if (!content || !user || !canComment) return;

		const optimistic: CommentType = {
			id: Comment.CommentId.make(`temp-${Date.now()}`),
			authorId: user.id,
			authorName: user.name,
			authorImage: user.imageUrl,
			content,
			createdAt: new Date(),
			videoId,
			parentCommentId: Comment.CommentId.make(""),
			type: "text",
			timestamp: anchorTime,
			updatedAt: new Date(),
			mediaKey: null,
			mediaDuration: null,
			mediaMeta: null,
			sending: true,
		};

		onOptimisticComment?.(optimistic);
		setValue("");
		closeComposer();

		try {
			const saved = await newComment({
				content,
				videoId,
				authorImage: user.imageUrl,
				parentCommentId: Comment.CommentId.make(""),
				type: "text",
				timestamp: anchorTime,
			});
			startTransition(() => {
				onCommentSuccess?.(saved);
			});
		} catch (error) {
			console.error("Error posting comment:", error);
		}
	};

	// Clamped into the window: zooming past the anchor must slide the card to
	// the edge it left through, not off the deck.
	const percent = Math.min(
		100,
		Math.max(0, fractionInWindow(anchorTime, windowStart, windowEnd) * 100),
	);

	return (
		<>
			<AnimatePresence>
				{composerAnchor && (
					<motion.div
						layout
						key="timeline-composer"
						className="absolute bottom-full z-50 mb-2 w-72"
						style={{
							left: clampCenter(percent, trackWidth),
							translateX: "-50%",
						}}
						initial={
							reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 6 }
						}
						animate={
							reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
						}
						exit={
							reduceMotion
								? { opacity: 0, transition: { duration: 0 } }
								: { opacity: 0, scale: 0.94, transition: { duration: 0.12 } }
						}
						transition={
							reduceMotion
								? { duration: 0 }
								: { type: "spring", stiffness: 420, damping: 34 }
						}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								closeComposer();
							}
						}}
					>
						<div className="new-card-style flex flex-col gap-2 p-2.5">
							<div className="flex items-center gap-2">
								<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-gray-11 ring-1 ring-gray-4">
									{formatClock(anchorTime)}
								</span>
								<span className="text-xs text-gray-10">
									{canComment
										? "Comment at this moment"
										: "Join the conversation"}
								</span>
							</div>

							{canComment ? (
								<input
									// biome-ignore lint/a11y/noAutofocus: the composer is opened by an explicit click.
									autoFocus
									type="text"
									value={value}
									maxLength={255}
									placeholder="Add a comment"
									aria-label={`Comment at ${formatClock(anchorTime)}`}
									onChange={(event) => setValue(event.target.value)}
									onBlur={() => {
										if (!value.trim()) closeComposer();
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											void submit();
										}
									}}
									className="h-8 w-full rounded-lg bg-gray-2 px-2 text-sm text-gray-12 outline-none ring-1 ring-gray-4 placeholder:text-gray-9 focus:ring-blue-9"
								/>
							) : (
								<button
									type="button"
									onClick={requestAuth}
									className="h-8 w-full rounded-lg bg-gray-12 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
								>
									Sign in to comment
								</button>
							)}

							{/* Reserved even when empty so the recording phase can drop its
							    buttons in without the card changing height. preventDefault
							    keeps the focused (empty) input from blurring on the way to a
							    button — that blur closes the composer, and the click would
							    land on an unmounted node. */}
							<div
								className="flex h-8 items-center gap-1"
								onPointerDown={(event) => event.preventDefault()}
							>
								{onRecordIntent
									? RECORD_OPTIONS.map((option) => (
											<button
												key={option.kind}
												type="button"
												aria-label={option.label}
												title={option.label}
												onClick={() => {
													if (!canComment) {
														requestAuth();
														return;
													}
													onRecordIntent(option.kind, anchorTime);
												}}
												className="flex size-8 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12"
											>
												<RecordIcon kind={option.kind} />
											</button>
										))
									: null}
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{!onRequestAuth && (
				<AuthOverlay
					isOpen={showAuthOverlay}
					onClose={() => setShowAuthOverlay(false)}
				/>
			)}
		</>
	);
}

function RecordIcon({ kind }: { kind: RecordIntentKind }) {
	if (kind === "voice") return <MicGlyph />;
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
