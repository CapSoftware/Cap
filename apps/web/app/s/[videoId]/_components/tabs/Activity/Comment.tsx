import { userSelectProps } from "@cap/database/auth/session";
import { Avatar, Button } from "@cap/ui";
import { motion } from "framer-motion";
import React from "react";
import { Tooltip } from "@/components/Tooltip";

import clsx from "clsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faReply, faTrash } from "@fortawesome/free-solid-svg-icons";
import { CommentType } from "../../../Share";
import CommentInput from "./CommentInput";
import { formatTimeAgo, formatTimestamp } from "./utils";

const Comment: React.FC<{
  comment: CommentType;
  replies: CommentType[];
  onReply: (commentId: string) => void;
  replyingToId: string | null;
  handleReply: (content: string) => void;
  onCancelReply: () => void;
  onDelete: (commentId: string) => void;
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
    const nestedReplies =
      level === 0
        ? replies.filter((reply) => {
          if (reply.parentCommentId === comment.id) return true;
          const parentComment = replies.find(
            (r) => r.id === reply.parentCommentId
          );
          return parentComment && parentComment.parentCommentId === comment.id;
        })
        : [];

    const handleDelete = () => {
      if (window.confirm("Are you sure you want to delete this comment?")) {
        onDelete(comment.id);
      }
    };

    const canReply = true;
    const commentDate = new Date(comment.createdAt);

    return (
      <motion.div
        key={`comment-${comment.id}`}
        className={clsx(`space-y-3`, level > 0 ? "ml-8 border-l-2 border-gray-100 pl-4" : "", comment.sending ? "opacity-20" : "opacity-100")}
      >
        <div className="flex items-start space-x-2.5">
          <Avatar className="size-6" letterClass="text-sm" name={comment.authorName} />
          <div className="flex-1 p-3 rounded-xl border bg-gray-2 border-gray-3">
            <div className="flex items-center space-x-2">
              <p className="text-base font-medium text-gray-12">
                {comment.authorName || "Anonymous"}
              </p>
              <Tooltip content={formatTimestamp(commentDate)}>
                <p
                  className="text-sm text-gray-8"
                >
                  {formatTimeAgo(commentDate)}
                </p>
              </Tooltip>
              {comment.timestamp && (
                <button
                  onClick={() => onSeek?.(comment.timestamp!)}
                  className="text-sm text-blue-500 cursor-pointer hover:text-blue-700"
                >
                  {new Date(comment.timestamp * 1000).toISOString().substr(11, 8)}
                </button>
              )}
            </div>
            <p className="text-sm text-gray-11">{comment.content}</p>
            <div className="flex items-center pt-2 mt-2.5 space-x-3 border-t border-gray-3">
              {user && !isReplying && canReply && (
                <Tooltip content="Reply">
                  <Button
                    onClick={() => onReply(comment.id)}
                    size="icon"
                    variant="outline"
                    icon={<FontAwesomeIcon className="size-[10px]" icon={faReply} />}
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
                    icon={<FontAwesomeIcon className="size-[10px]" icon={faTrash} />}
                    className="text-[13px] p-0 size-6"
                  />
                </Tooltip>
              )}
            </div>
          </div>
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
              <Comment
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
      </motion.div>
    );
  };

export default Comment;
