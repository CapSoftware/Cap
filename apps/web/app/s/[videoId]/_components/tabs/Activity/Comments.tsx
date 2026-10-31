// type-only on purpose: a value import of @cap/web-domain drags the whole
// effect runtime (~250 KB gz) into the share page's entry chunk. The branded
// ids carry no constraints, so plain casts replace `.make()` losslessly.
import type { Comment, User, Video } from "@cap/web-domain";
import { faCommentSlash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useSearchParams } from "next/navigation";
import type React from "react";
import {
	forwardRef,
	type PropsWithChildren,
	startTransition,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { deleteComment } from "@/actions/videos/delete-comment";
import { newComment } from "@/actions/videos/new-comment";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../../Share";
import { ActivityComposer } from "./ActivityComposer";
import CommentComponent from "./Comment";
import EmptyState from "./EmptyState";

const EMPTY_REPLIES: CommentType[] = [];

export const Comments = Object.assign(
	forwardRef<
		{ scrollToBottom: () => void },
		{
			setComments: React.Dispatch<React.SetStateAction<CommentType[]>>;
			videoId: Video.VideoId;
			optimisticComments: CommentType[];
			setOptimisticComments: (newComment: CommentType) => void;
			handleCommentSuccess: (comment: CommentType) => void;
			onSeek?: (time: number) => void;
			setShowAuthOverlay: (v: boolean) => void;
			commentsDisabled: boolean;
			ownerName?: string | null;
			canRecordMedia?: boolean;
		}
	>((props, ref) => {
		const {
			optimisticComments,
			setOptimisticComments,
			setComments,
			handleCommentSuccess,
			onSeek,
			commentsDisabled,
			videoId,
			setShowAuthOverlay,
		} = props;
		const commentParams = useSearchParams().get("comment");
		const replyParams = useSearchParams().get("reply");
		const user = useCurrentUser();

		const [replyingTo, setReplyingTo] = useState<Comment.CommentId | null>(
			null,
		);

		const commentsContainerRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			if (commentParams || replyParams) return;
			if (commentsContainerRef.current) {
				commentsContainerRef.current.scrollTop =
					commentsContainerRef.current.scrollHeight;
			}
		}, [commentParams, replyParams]);

		const scrollToBottom = useCallback(() => {
			if (commentsContainerRef.current) {
				commentsContainerRef.current.scrollTo({
					top: commentsContainerRef.current.scrollHeight,
					behavior: "smooth",
				});
			}
		}, []);

		useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

		const { rootComments, repliesByRoot } = useMemo(() => {
			const byId = new Map(
				optimisticComments.map((comment) => [comment.id, comment]),
			);
			const rootComments = optimisticComments.filter(
				(comment) => !comment.parentCommentId,
			);
			const rootIds = new Set(rootComments.map((comment) => comment.id));
			const repliesByRoot = new Map<Comment.CommentId, CommentType[]>();
			for (const comment of optimisticComments) {
				const parentId = comment.parentCommentId;
				if (!parentId) continue;
				const rootId = rootIds.has(parentId)
					? parentId
					: byId.get(parentId)?.parentCommentId;
				if (!rootId || !rootIds.has(rootId)) continue;
				const replies = repliesByRoot.get(rootId);
				if (replies) replies.push(comment);
				else repliesByRoot.set(rootId, [comment]);
			}
			return { rootComments, repliesByRoot };
		}, [optimisticComments]);

		const handleNewComment = async (content: string) => {
			if (!user) return;

			// Get current video time from the video element
			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const optimisticComment: CommentType = {
				id: `temp-${Date.now()}` as Comment.CommentId,
				authorId: user.id as User.UserId,
				authorName: user?.name,
				authorImage: user.imageUrl,
				content,
				createdAt: new Date(),
				videoId,
				parentCommentId: "" as Comment.CommentId,
				type: "text",
				timestamp: currentTime,
				updatedAt: new Date(),
				mediaKey: null,
				mediaDuration: null,
				mediaMeta: null,
				sending: true,
			};

			startTransition(() => {
				setOptimisticComments(optimisticComment);
			});

			try {
				const data = await newComment({
					content,
					videoId,
					authorImage: user.imageUrl,
					parentCommentId: "" as Comment.CommentId,
					type: "text",
					timestamp: currentTime,
				});
				handleCommentSuccess(data);
			} catch (error) {
				console.error("Error posting comment:", error);
			}
		};

		const handleReply = useCallback(
			async (content: string, replyingTo: Comment.CommentId) => {
				if (!user) return;

				const videoElement = document.querySelector(
					"video",
				) as HTMLVideoElement;
				const currentTime = videoElement?.currentTime || 0;

				const parentComment = optimisticComments.find(
					(c) => c.id === replyingTo,
				);
				const actualParentId = parentComment?.parentCommentId
					? parentComment.parentCommentId
					: replyingTo;

				const optimisticReply: CommentType = {
					id: `temp-reply-${Date.now()}` as Comment.CommentId,
					authorId: user.id,
					authorName: user.name,
					authorImage: user.imageUrl,
					content,
					createdAt: new Date(),
					videoId,
					parentCommentId: actualParentId,
					type: "text",
					timestamp: currentTime,
					updatedAt: new Date(),
					mediaKey: null,
					mediaDuration: null,
					mediaMeta: null,
					sending: true,
				};

				startTransition(() => {
					setOptimisticComments(optimisticReply);
				});

				try {
					const data = await newComment({
						content,
						videoId,
						parentCommentId: actualParentId,
						type: "text",
						timestamp: currentTime,
						authorImage: user.imageUrl,
					});

					handleCommentSuccess(data);

					const newReplyElement = document.getElementById(`comment-${data.id}`);
					if (newReplyElement) {
						newReplyElement.scrollIntoView({
							behavior: "smooth",
							block: "center",
						});
					}
					setReplyingTo(null);
				} catch (error) {
					console.error("Error posting reply:", error);
				}
			},
			[
				user,
				optimisticComments,
				videoId,
				setOptimisticComments,
				handleCommentSuccess,
			],
		);

		const handleCancelReply = useCallback(() => {
			setReplyingTo(null);
		}, []);

		const handleStartReply = useCallback(
			(id: Comment.CommentId) => {
				if (!user) setShowAuthOverlay(true);
				else setReplyingTo(id);
			},
			[user, setShowAuthOverlay],
		);

		const handleDeleteComment = useCallback(
			async (
				commentId: Comment.CommentId,
				parentId: Comment.CommentId | null,
			) => {
				try {
					await deleteComment({
						commentId,
						parentId,
						videoId,
					});
					setComments((prev) => prev.filter((c) => c.id !== commentId));
				} catch (error) {
					console.error("Failed to delete comment:", error);
				}
			},
			[videoId, setComments],
		);

		return (
			<Comments.Shell
				commentInputProps={{
					onSubmit: handleNewComment,
					disabled: commentsDisabled,
				}}
				setShowAuthOverlay={props.setShowAuthOverlay}
				commentsContainerRef={commentsContainerRef}
				videoId={props.videoId}
				ownerName={props.ownerName}
				canRecordMedia={props.canRecordMedia}
				onOptimisticComment={(comment) => {
					startTransition(() => {
						setOptimisticComments(comment);
					});
				}}
				onCommentSuccess={handleCommentSuccess}
			>
				{commentsDisabled ? (
					<div className="p-4 space-y-6 h-full">
						<EmptyState
							icon={<FontAwesomeIcon icon={faCommentSlash} />}
							commentsDisabled={commentsDisabled}
						/>
					</div>
				) : rootComments.length === 0 ? (
					<EmptyState />
				) : (
					<div className="p-4 space-y-6">
						{rootComments.map((comment) => {
							const replies = repliesByRoot.get(comment.id) ?? EMPTY_REPLIES;
							return (
								<CommentComponent
									// clientKey pins a just-uploaded comment to its optimistic
									// card's mount, so the settle can't restart its playback.
									key={comment.clientKey ?? comment.id}
									comment={comment}
									replies={replies}
									onReply={handleStartReply}
									replyingToId={
										replyingTo === comment.id ||
										replies.some((reply) => reply.id === replyingTo)
											? replyingTo
											: null
									}
									handleReply={handleReply}
									onCancelReply={handleCancelReply}
									onDelete={handleDeleteComment}
									onSeek={onSeek}
								/>
							);
						})}
					</div>
				)}
			</Comments.Shell>
		);
	}),
	{
		Shell: (
			props: PropsWithChildren<{
				setShowAuthOverlay: (v: boolean) => void;
				commentInputProps?: {
					onSubmit?: (content: string) => void;
					disabled?: boolean;
				};
				commentsContainerRef?: React.RefObject<HTMLDivElement | null>;
				videoId?: Video.VideoId;
				/** Whose video this is, for the composer's placeholder. */
				ownerName?: string | null;
				canRecordMedia?: boolean;
				onOptimisticComment?: (comment: CommentType) => void;
				onCommentSuccess?: (comment: CommentType) => void;
			}>,
		) => (
			<>
				<div
					ref={props.commentsContainerRef}
					className="overflow-y-auto flex-1 min-h-0"
				>
					{props.children}
				</div>

				{!props.commentInputProps?.disabled && props.videoId && (
					<div className="flex-none p-2 border-t border-gray-5 bg-gray-2">
						<ActivityComposer
							videoId={props.videoId}
							ownerName={props.ownerName}
							onSubmit={(content) =>
								props.commentInputProps?.onSubmit?.(content)
							}
							setShowAuthOverlay={props.setShowAuthOverlay}
							canRecordMedia={props.canRecordMedia}
							onOptimisticComment={props.onOptimisticComment}
							onCommentSuccess={props.onCommentSuccess}
						/>
					</div>
				)}
			</>
		),
		Skeleton: (props: { setShowAuthOverlay: (v: boolean) => void }) => (
			<Comments.Shell {...props} commentInputProps={{ disabled: true }} />
		),
	},
);
