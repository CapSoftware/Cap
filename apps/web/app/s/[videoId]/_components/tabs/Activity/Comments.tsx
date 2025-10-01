import type { userSelectProps } from "@cap/database/auth/session";
import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useSearchParams } from "next/navigation";
import type React from "react";
import {
	type ComponentProps,
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
import type { CommentType } from "../../../Share";
import Comment from "./Comment";
import CommentInput from "./CommentInput";
import EmptyState from "./EmptyState";

export const Comments = Object.assign(
	forwardRef<
		{ scrollToBottom: () => void },
		{
			setComments: React.Dispatch<React.SetStateAction<CommentType[]>>;
			user: typeof userSelectProps | null;
			videoId: Video.VideoId;
			optimisticComments: CommentType[];
			setOptimisticComments: (newComment: CommentType) => void;
			handleCommentSuccess: (comment: CommentType) => void;
			onSeek?: (time: number) => void;
			setShowAuthOverlay: (v: boolean) => void;
		}
	>((props, ref) => {
		const {
			optimisticComments,
			setOptimisticComments,
			setComments,
			handleCommentSuccess,
			onSeek,
		} = props;
		const commentParams = useSearchParams().get("comment");
		const replyParams = useSearchParams().get("reply");

		const { user } = props;
		const [replyingTo, setReplyingTo] = useState<string | null>(null);

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
			// Get current video time from the video element
			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const optimisticComment: CommentType = {
				id: `temp-${Date.now()}`,
				authorId: user?.id || "anonymous",
				authorName: user?.name || "Anonymous",
				content,
				createdAt: new Date(),
				videoId: props.videoId,
				parentCommentId: "",
				type: "text",
				timestamp: currentTime,
				updatedAt: new Date(),
				sending: true,
			};

			startTransition(() => {
				setOptimisticComments(optimisticComment);
			});

			try {
				const data = await newComment({
					content,
					videoId: props.videoId,
					parentCommentId: "",
					type: "text",
					timestamp: currentTime,
				});
				handleCommentSuccess(data);
			} catch (error) {
				console.error("Error posting comment:", error);
			}
		};

		const handleReply = async (content: string) => {
			if (!replyingTo) return;
			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const parentComment = optimisticComments.find((c) => c.id === replyingTo);
			const actualParentId = parentComment?.parentCommentId
				? parentComment.parentCommentId
				: replyingTo;

			const optimisticReply: CommentType = {
				id: `temp-reply-${Date.now()}`,
				authorId: user?.id || "anonymous",
				authorName: user?.name || "Anonymous",
				content,
				createdAt: new Date(),
				videoId: props.videoId,
				parentCommentId: actualParentId,
				type: "text",
				timestamp: currentTime,
				updatedAt: new Date(),
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
			commentId: string,
			parentId?: string,
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
				commentInputProps={{ onSubmit: handleNewComment }}
				setShowAuthOverlay={props.setShowAuthOverlay}
				user={user}
				commentsContainerRef={commentsContainerRef}
			>
				{rootComments.length === 0 ? (
					<EmptyState />
				) : (
					<div className="p-4 space-y-6">
						{rootComments.map((comment) => (
							<Comment
								key={comment.id}
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
								user={user}
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
				user: typeof userSelectProps | null;
				setShowAuthOverlay: (v: boolean) => void;
				commentInputProps?: Omit<
					ComponentProps<typeof CommentInput>,
					"user" | "placholder" | "buttonLabel"
				>;
				commentsContainerRef?: React.RefObject<HTMLDivElement | null>;
			}>,
		) => (
			<>
				<div
					ref={props.commentsContainerRef}
					className="overflow-y-auto flex-1 min-h-0"
				>
					{props.children}
				</div>

				<div className="flex-none p-2 border-t border-gray-5 bg-gray-2">
					{props.user ? (
						<CommentInput
							{...props.commentInputProps}
							placeholder="Leave a comment"
							buttonLabel="Comment"
							user={props.user}
						/>
					) : (
						<Button
							className="min-w-full"
							variant="primary"
							onClick={() => props.setShowAuthOverlay(true)}
						>
							Sign in to leave a comment
						</Button>
					)}
				</div>
			</>
		),
		Skeleton: (props: {
			user: typeof userSelectProps | null;
			setShowAuthOverlay: (v: boolean) => void;
		}) => <Comments.Shell {...props} commentInputProps={{ disabled: true }} />,
	},
);
