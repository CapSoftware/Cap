"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { CommentType } from "../../Share";
import { MediaCommentBody } from "../media-comment/MediaCommentBody";
import { isMediaComment } from "../media-comment/media-comment-types";
import { formatTimeAgo } from "../tabs/Activity/utils";
import { useTimelineActions, useTimelineState } from "./TimelineProvider";
import { formatClock } from "./timeline-format";
import { type BranchNode, branchComments } from "./timeline-layout";

interface TimelineMobileSheetProps {
	branches: readonly BranchNode<CommentType>[];
	onSeek: (time: number) => void;
}

/**
 * Touch replacement for the hover card. A hover card on a phone is a card that
 * never opens, so below `lg` a tap raises a dismissible bottom sheet instead.
 */
export function TimelineMobileSheet({
	branches,
	onSeek,
}: TimelineMobileSheetProps) {
	const { expandedId } = useTimelineState();
	const { setExpandedId } = useTimelineActions();
	const reduceMotion = useReducedMotion() ?? false;

	const node = expandedId
		? branches.find((branch) => branch.id === expandedId)
		: undefined;
	const comments = node ? branchComments(node) : [];
	const close = () => setExpandedId(null);

	return (
		<AnimatePresence>
			{node && (
				<motion.div
					key="timeline-sheet"
					className="fixed inset-0 z-[60] flex items-end lg:hidden"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: reduceMotion ? 0 : 0.16 }}
				>
					<button
						type="button"
						aria-label="Close comments"
						onClick={close}
						className="absolute inset-0 bg-black/30"
					/>

					<motion.div
						role="dialog"
						aria-label="Comments at this point"
						className="relative w-full rounded-t-2xl border-t border-gray-5 bg-white pb-[env(safe-area-inset-bottom)]"
						initial={reduceMotion ? { opacity: 0 } : { y: "100%" }}
						animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
						exit={reduceMotion ? { opacity: 0 } : { y: "100%" }}
						transition={
							reduceMotion
								? { duration: 0 }
								: { type: "spring", stiffness: 420, damping: 36 }
						}
						drag={reduceMotion ? false : "y"}
						dragConstraints={{ top: 0, bottom: 0 }}
						dragElastic={{ top: 0, bottom: 0.4 }}
						onDragEnd={(_event, info) => {
							if (info.offset.y > 80 || info.velocity.y > 500) close();
						}}
					>
						<div className="flex justify-center py-2">
							<span className="h-1 w-9 rounded-full bg-gray-5" />
						</div>

						<div className="max-h-[60vh] overflow-y-auto px-4 pb-4">
							<span className="block pb-2 text-[11px] font-medium uppercase tracking-wide text-gray-9">
								{formatClock(node.t)}
							</span>
							<ul className="flex flex-col gap-3">
								{comments.map((comment) => (
									<li key={comment.id} className="flex gap-2">
										<span className="block overflow-hidden rounded-full size-6 shrink-0">
											<SignedImageUrl
												image={comment.authorImage ?? null}
												name={comment.authorName || "Someone"}
												className="size-full"
												letterClass="text-[10px] font-medium"
											/>
										</span>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="truncate text-[13px] font-medium text-gray-12">
													{comment.authorName || "Someone"}
												</span>
												<span className="text-[11px] text-gray-9">
													{formatTimeAgo(new Date(comment.createdAt))}
												</span>
												<button
													type="button"
													onClick={() => {
														onSeek(comment.timestamp ?? node.t);
														close();
													}}
													className="ml-auto rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-gray-11 ring-1 ring-gray-4"
												>
													{formatClock(comment.timestamp ?? node.t)}
												</button>
											</div>
											{isMediaComment(comment) ? (
												<div className="pt-1">
													<MediaCommentBody comment={comment} />
												</div>
											) : (
												<p className="whitespace-pre-wrap break-words pt-0.5 text-sm text-gray-11">
													{comment.content}
												</p>
											)}
										</div>
									</li>
								))}
							</ul>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
