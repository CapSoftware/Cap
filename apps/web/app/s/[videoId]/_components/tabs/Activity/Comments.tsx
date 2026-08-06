import { Comment, User, type Video } from "@cap/web-domain";
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

		const rootComments = optimisticComments.filter(
			(comment) => !comment.parentCommentId || comment.parentCommentId === "",
		);

		const handleNewComment = async (content: string) => {
			if (!user) return;

			// Get current video time from the video element
			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const optimisticComment: CommentType = {
				id: Comment.CommentId.make(`temp-${Date.now()}`),
				authorId: User.UserId.make(user.id),
				authorName: user?.name,
				authorImage: user.imageUrl,
				content,
				createdAt: new Date(),
				videoId: props.videoId,
				parentCommentId: Comment.CommentId.make(""),
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
					videoId: props.videoId,
					authorImage: user.imageUrl,
					parentCommentId: Comment.CommentId.make(""),
					type: "text",
					timestamp: currentTime,
				});
				handleCommentSuccess(data);
			} catch (error) {
				console.error("Error posting comment:", error);
			}
		};

		const handleReply = async (content: string) => {
			if (!replyingTo || !user) return;

			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const parentComment = optimisticComments.find((c) => c.id === replyingTo);
			const actualParentId = parentComment?.parentCommentId
				? parentComment.parentCommentId
				: replyingTo;

			const optimisticReply: CommentType = {
				id: Comment.CommentId.make(`temp-reply-${Date.now()}`),
				authorId: user.id,
				authorName: user.name,
				authorImage: user.imageUrl,
				content,
				createdAt: new Date(),
				videoId: props.videoId,
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
					videoId: props.videoId,
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
		};

		const handleCancelReply = () => {
			setReplyingTo(null);
		};

		const handleDeleteComment = async (
			commentId: Comment.CommentId,
			parentId: Comment.CommentId | null,
		) => {
			try {
				await deleteComment({
					commentId,
					parentId,
					videoId: props.videoId,
				});
				setComments((prev) => prev.filter((c) => c.id !== commentId));
			} catch (error) {
				console.error("Failed to delete comment:", error);
			}
		};

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
						{rootComments.map((comment) => (
							<CommentComponent
								// clientKey pins a just-uploaded comment to its optimistic
								// card's mount, so the settle can't restart its playback.
								key={comment.clientKey ?? comment.id}
								comment={comment}
								replies={optimisticComments}
								onReply={(id) => {
									if (!user) {
										props.setShowAuthOverlay(true);
									} else {
										setReplyingTo(id);
									}
								}}
								replyingToId={replyingTo}
								handleReply={handleReply}
								onCancelReply={handleCancelReply}
								onDelete={handleDeleteComment}
								onSeek={onSeek}
							/>
						))}
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
