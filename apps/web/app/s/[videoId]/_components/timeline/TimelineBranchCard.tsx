"use client";

import { motion } from "motion/react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { CommentType } from "../../Share";
import { MediaCommentBody } from "../media-comment/MediaCommentBody";
import { isMediaComment } from "../media-comment/media-comment-types";
import { formatTimeAgo } from "../tabs/Activity/utils";
import {
	CARD_WIDTH,
	NODE_SIZE,
	RAIL_PAD_X,
	usableWidth,
} from "./timeline-constants";
import { formatClock } from "./timeline-format";
import type { BranchNode } from "./timeline-layout";

interface TimelineBranchCardProps {
	node: BranchNode<CommentType>;
	percent: number;
	stem: number;
	/** Live height of the comments shelf the card's `bottom` is measured from. */
	shelfHeight: number;
	trackWidth: number;
	replyCounts: ReadonlyMap<string, number>;
	reduceMotion: boolean;
	pinned: boolean;
	onSeek: (time: number) => void;
	onPin: (id: string) => void;
	onKeepOpen: () => void;
	onClose: () => void;
}

/** Keep the card inside the band no matter how close to the edge the node is. */
const clampCenter = (percent: number, trackWidth: number): number => {
	const x = RAIL_PAD_X + (percent / 100) * usableWidth(trackWidth);
	const half = CARD_WIDTH / 2;
	if (trackWidth < CARD_WIDTH + 16) return trackWidth / 2;
	return Math.min(Math.max(x, half + 8), trackWidth - half - 8);
};

/**
 * The hover/pinned card. Opens upward out of the comments surface, over the
 * transport and the strip: the surface is under a hundred pixels tall and a
 * comment body is not.
 */
export function TimelineBranchCard({
	node,
	percent,
	stem,
	shelfHeight,
	trackWidth,
	replyCounts,
	reduceMotion,
	pinned,
	onSeek,
	onPin,
	onKeepOpen,
	onClose,
}: TimelineBranchCardProps) {
	const center = clampCenter(percent, trackWidth);
	const spring = reduceMotion
		? { duration: 0 }
		: ({ type: "spring", stiffness: 420, damping: 34 } as const);

	return (
		<motion.div
			data-timeline-card=""
			className="pointer-events-auto absolute z-40 w-72"
			style={{
				left: center,
				bottom: shelfHeight - stem + NODE_SIZE / 2 + 8,
				translateX: "-50%",
			}}
			initial={
				reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }
			}
			animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
			exit={
				reduceMotion
					? { opacity: 0, transition: { duration: 0 } }
					: { opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }
			}
			transition={spring}
			onPointerEnter={onKeepOpen}
			onPointerLeave={pinned ? undefined : onClose}
		>
			<div className="new-card-style overflow-hidden p-3">
				{node.kind === "single" ? (
					<SingleCard
						comment={node.comment}
						t={node.t}
						replies={replyCounts.get(node.comment.id) ?? 0}
						reduceMotion={reduceMotion}
						onSeek={onSeek}
					/>
				) : (
					<ClusterCard
						comments={node.comments}
						onPick={(comment) => {
							onSeek(comment.timestamp ?? node.t);
							onPin(comment.id);
						}}
					/>
				)}
			</div>
		</motion.div>
	);
}

function SingleCard({
	comment,
	t,
	replies,
	reduceMotion,
	onSeek,
}: {
	comment: CommentType;
	t: number;
	replies: number;
	reduceMotion: boolean;
	onSeek: (time: number) => void;
}) {
	const name = comment.authorName || "Someone";

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<motion.span
					layoutId={reduceMotion ? undefined : `branch-${comment.id}`}
					className="block overflow-hidden rounded-full size-6 shrink-0"
				>
					<SignedImageUrl
						image={comment.authorImage ?? null}
						name={name}
						className="size-full"
						letterClass="text-[10px] font-medium"
					/>
				</motion.span>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-12">
					{name}
				</span>
				<span className="text-[11px] text-gray-9">
					{formatTimeAgo(new Date(comment.createdAt))}
				</span>
				<button
					type="button"
					onClick={() => onSeek(t)}
					className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-gray-11 ring-1 ring-gray-4 transition-colors hover:bg-gray-3 hover:text-gray-12"
				>
					{formatClock(t)}
				</button>
			</div>

			{isMediaComment(comment) ? (
				<MediaCommentBody comment={comment} />
			) : (
				<p className="whitespace-pre-wrap break-words text-sm text-gray-11">
					{comment.content}
				</p>
			)}

			{replies > 0 && (
				<span className="text-xs text-gray-9">
					{replies} {replies === 1 ? "reply" : "replies"}
				</span>
			)}
		</div>
	);
}

function ClusterCard({
	comments,
	onPick,
}: {
	comments: readonly CommentType[];
	onPick: (comment: CommentType) => void;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-9">
				{comments.length} comments
			</span>
			{comments.map((comment) => (
				<button
					key={comment.id}
					type="button"
					onClick={() => onPick(comment)}
					className="flex items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-gray-2"
				>
					<span className="block overflow-hidden rounded-full size-5 shrink-0">
						<SignedImageUrl
							image={comment.authorImage ?? null}
							name={comment.authorName || "Someone"}
							className="size-full"
							letterClass="text-[9px] font-medium"
						/>
					</span>
					<span className="min-w-0 flex-1 truncate text-[13px] text-gray-11">
						<span className="font-medium text-gray-12">
							{comment.authorName || "Someone"}
						</span>{" "}
						{isMediaComment(comment)
							? comment.type === "video"
								? "sent a video"
								: "sent a voice note"
							: comment.content}
					</span>
					<span className="font-mono text-[11px] tabular-nums text-gray-9">
						{formatClock(comment.timestamp ?? 0)}
					</span>
				</button>
			))}
		</div>
	);
}
