import type { userSelectProps } from "@cap/database/auth/session";
import { Comment } from "@cap/web-domain";
import { Avatar, Button } from "@cap/ui";
import { faReply, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import clsx from "clsx";
import { motion } from "framer-motion";
import { useSearchParams } from "next/navigation";
import type React from "react";
import { Tooltip } from "@/components/Tooltip";
import type { CommentType } from "../../../Share";
import CommentInput from "./CommentInput";
import { formatTimeAgo, formatTimestamp } from "./utils";

const CommentComponent: React.FC<{
	comment: CommentType;
	replies: CommentType[];
	onReply: (commentId: Comment.CommentId) => void;
	replyingToId: Comment.CommentId | null;
	handleReply: (content: string) => void;
	onCancelReply: () => void;
	onDelete: (
		commentId: Comment.CommentId,
		parentId?: Comment.CommentId,
	) => void;
	user: typeof userSelectProps | null;
	level?: number;
	onSeek?: (time: number) => void;
}> = ({
	comment,
	replies,
	onReply,
	replyingToId,
	handleReply,
	onCancelReply,
	onDelete,
	user,
	level = 0,
	onSeek,
}) => {
	const isReplying = replyingToId === comment.id;
	const isOwnComment = user?.id === comment.authorId;
	const commentParams = useSearchParams().get("comment");
	const replyParams = useSearchParams().get("reply");
	const nestedReplies =
		level === 0
			? replies.filter((reply) => {
					if (reply.parentCommentId === comment.id) return true;
					const parentComment = replies.find(
						(r) => r.id === reply.parentCommentId,
					);
					return parentComment && parentComment.parentCommentId === comment.id;
				})
			: [];

	const handleDelete = () => {
		if (
			comment.parentCommentId &&
			window.confirm("Are you sure you want to delete this comment?")
		) {
			onDelete(comment.id, comment.parentCommentId);
		}
	};

	const canReply = true;
	const commentDate = new Date(comment.createdAt);

	return (
		<div
			id={`comment-${comment.id}`}
			key={`comment-${comment.id}`}
			className={clsx(
				`space-y-3`,
				level > 0 ? "ml-8 border-l-2 border-gray-100 pl-4" : "",
				comment.sending ? "opacity-20" : "opacity-100",
			)}
		>
			<div className="flex items-start space-x-2.5">
				<Avatar
					className="size-6"
					letterClass="text-sm"
					name={comment.authorName}
				/>
				<motion.div
					viewport={{
						once: true,
					}}
					whileInView={{
						scale:
							(commentParams || replyParams) === comment.id ? [1, 1.08, 1] : 1,
						borderColor:
							(commentParams || replyParams) === comment.id
								? ["#EEEEEE", "#1696e0"]
								: "#EEEEEE",
						backgroundColor:
							(commentParams || replyParams) === comment.id
								? ["#F9F9F9", "#EDF6FF"]
								: " #F9F9F9",
					}}
					transition={{ duration: 0.75, ease: "easeInOut", delay: 0.15 }}
					className={"flex-1 p-3 rounded-xl border border-gray-3 bg-gray-2"}
				>
					<div className="flex gap-3 justify-between items-center">
						<p className="text-sm font-medium truncate text-gray-12">
							{comment.authorName || "Anonymous"}
						</p>
						<div className="flex gap-2 items-center text-nowrap min-w-fit">
							<Tooltip content={formatTimestamp(commentDate)}>
								<p className="text-xs text-gray-8">
									{formatTimeAgo(commentDate)}
								</p>
							</Tooltip>
							{comment.timestamp !== null && (
								<button
									type="button"
									onClick={() => {
										onSeek?.(Number(comment.timestamp));
									}}
									className="text-xs text-blue-500 cursor-pointer hover:text-blue-700"
								>
									{new Date(comment.timestamp * 1000)
										.toISOString()
										.substr(11, 8)}
								</button>
							)}
						</div>
					</div>
					<p className="mt-2 text-sm text-gray-11">{comment.content}</p>
					<div className="flex items-center pt-2 mt-2.5 space-x-3 border-t border-gray-3">
						{user && !isReplying && canReply && (
							<Tooltip content="Reply">
								<Button
									onClick={() => onReply(comment.id)}
									size="icon"
									variant="outline"
									icon={
										<FontAwesomeIcon className="size-[10px]" icon={faReply} />
									}
									className="text-[13px] p-0 size-6"
								/>
							</Tooltip>
						)}
						{isOwnComment && (
							<Tooltip content="Delete comment">
								<Button
									onClick={handleDelete}
									size="icon"
									variant="outline"
									icon={
										<FontAwesomeIcon className="size-[10px]" icon={faTrash} />
									}
									className="text-[13px] p-0 size-6"
								/>
							</Tooltip>
						)}
					</div>
				</motion.div>
			</div>

			{isReplying && canReply && (
				<div className="ml-5">
					<CommentInput
						onSubmit={handleReply}
						onCancel={onCancelReply}
						placeholder="Write a reply..."
						showCancelButton={true}
						user={user}
						autoFocus={true}
					/>
				</div>
			)}

			{nestedReplies.length > 0 && (
				<div className="mt-3 space-y-3">
					{nestedReplies.map((reply) => (
						<CommentComponent
							key={reply.id}
							comment={reply}
							replies={replies}
							onReply={onReply}
							replyingToId={replyingToId}
							handleReply={handleReply}
							onCancelReply={onCancelReply}
							onDelete={onDelete}
							user={user}
							level={1}
							onSeek={onSeek}
						/>
					))}
				</div>
			)}
		</div>
	);
};

export default CommentComponent;
