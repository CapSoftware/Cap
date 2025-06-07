"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { CapCardAnalytics } from "@/app/dashboard/caps/components/CapCardAnalytics";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema } from "@cap/database/schema";
import { Button } from "@cap/ui";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "react-tooltip";
import { AuthOverlay } from "../AuthOverlay";

type CommentType = typeof commentsSchema.$inferSelect & {
  authorName?: string | null;
};

interface ActivityProps {
  analytics: {
    views: number;
    comments: number;
    reactions: number;
  };
  comments: CommentType[];
  user: typeof userSelectProps | null;
  onSeek?: (time: number) => void;
  videoId: string;
  isOwnerOrMember?: boolean;
}

export const Avatar: React.FC<{
  name: string | null | undefined;
  className?: string;
  letterClass?: string;
}> = ({ name, className = "", letterClass = "text-xs" }) => {
  const initial = name?.[0]?.toUpperCase() || "A";
  const bgColor = name ? "bg-gray-12" : "bg-gray-6";
  const textColor = name ? "text-gray-1" : "text-gray-12";

  return (
    <div
      className={clsx(
        "flex justify-center items-center rounded-full size-4",
        bgColor,
        className
      )}
    >
      <span className={clsx(letterClass, textColor)}>{initial}</span>
    </div>
  );
};

interface CommentInputProps {
  onSubmit: (content: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  showCancelButton?: boolean;
  buttonLabel?: string;
  user?: typeof userSelectProps | null;
  autoFocus?: boolean;
}

const CommentInput: React.FC<CommentInputProps> = ({
  onSubmit,
  onCancel,
  placeholder,
  showCancelButton = false,
  buttonLabel = "Reply",
  user,
  autoFocus = false,
}) => {
  const [content, setContent] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (content.trim()) {
      onSubmit(content);
      setContent("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex items-start space-x-3">
      <div className="flex-1">
        <div className="p-4 rounded-lg bg-gray-1">
          <textarea
            ref={inputRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || "Leave a comment"}
            className="w-full text-[15px] leading-[22px] text-gray-12 bg-transparent focus:outline-none"
          />
          <div className="flex mt-2 space-x-2">
            <Button size="sm" variant="primary" onClick={() => handleSubmit()}>
              {buttonLabel}
            </Button>
            {showCancelButton && onCancel && (
              <Button size="sm" variant="white" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const formatTimestamp = (date: Date) => {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
};

const formatTimeAgo = (date: Date) => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return "now";

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return `${diffInDays}d ago`;

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) return `${diffInMonths}mo ago`;

  const diffInYears = Math.floor(diffInDays / 365);
  return `${diffInYears}y ago`;
};

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
      id={`comment-${comment.id}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.2 }}
      className={`space-y-3 ${
        level > 0 ? "ml-8 border-l-2 border-gray-100 pl-4" : ""
      }`}
    >
      <div className="flex items-start space-x-3">
        <Avatar name={comment.authorName} />
        <div className="flex-1">
          <div className="flex items-center space-x-2">
            <span className="font-medium text-gray-12">
              {comment.authorName || "Anonymous"}
            </span>
            <span
              className="text-sm text-gray-8"
              data-tooltip-id={`comment-${comment.id}-timestamp`}
              data-tooltip-content={formatTimestamp(commentDate)}
            >
              {formatTimeAgo(commentDate)}
            </span>
            <Tooltip id={`comment-${comment.id}-timestamp`} />
            {comment.timestamp && (
              <button
                onClick={() => onSeek?.(comment.timestamp!)}
                className="text-sm text-blue-500 cursor-pointer hover:text-blue-700"
              >
                {new Date(comment.timestamp * 1000).toISOString().substr(11, 8)}
              </button>
            )}
          </div>
          <p className="mt-1 text-gray-700">{comment.content}</p>
          <div className="flex items-center mt-2 space-x-4">
            {user && !isReplying && canReply && (
              <button
                onClick={() => onReply(comment.id)}
                className="text-sm text-gray-1 hover:text-gray-700"
              >
                Reply
              </button>
            )}
            {isOwnComment && (
              <button
                onClick={handleDelete}
                className="text-sm text-red-500 hover:text-red-700"
              >
                Delete
              </button>
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

const EmptyState = () => (
  <motion.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    className="flex flex-col justify-center items-center p-8 h-full text-center"
  >
    <div className="space-y-2 text-gray-300">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="mx-auto w-8 h-8"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
        />
      </svg>
      <h3 className="text-sm font-medium text-gray-12">No comments yet</h3>
      <p className="text-sm text-gray-10">
        Be the first to share your thoughts!
      </p>
    </div>
  </motion.div>
);

export const Activity: React.FC<ActivityProps> = ({
  analytics: initialAnalytics,
  comments: initialComments,
  user,
  onSeek,
  videoId,
  isOwnerOrMember = false,
}) => {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [comments, setComments] = useState(initialComments);
  const [optimisticComments, setOptimisticComments] = useState<CommentType[]>(
    []
  );
  const [showAuthOverlay, setShowAuthOverlay] = useState(false);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const commentsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const result = await getVideoAnalytics(videoId);

        setAnalytics({
          views: result.count === 0 ? comments.length : result.count,
          comments: comments.length,
          reactions: 0,
        });
      } catch (error) {
        console.error("Error fetching analytics:", error);
      }
    };

    fetchAnalytics();
  }, [videoId, comments.length]);

  useEffect(() => {
    if (commentsContainerRef.current) {
      commentsContainerRef.current.scrollTop =
        commentsContainerRef.current.scrollHeight;
    }
  }, []);

  const scrollToBottom = () => {
    if (commentsContainerRef.current) {
      commentsContainerRef.current.scrollTo({
        top: commentsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  const addOptimisticComment = (newComment: CommentType) => {
    setOptimisticComments((prev) => [...prev, newComment]);
    setTimeout(scrollToBottom, 100);
  };

  const handleNewComment = async (content: string) => {
    const optimisticComment: CommentType = {
      id: `temp-${Date.now()}`,
      authorId: user?.id || "anonymous",
      authorName: user?.name || "Anonymous",
      content,
      createdAt: new Date(),
      videoId,
      parentCommentId: "",
      type: "text",
      timestamp: null,
      updatedAt: new Date(),
    };

    addOptimisticComment(optimisticComment);

    try {
      const response = await fetch("/api/video/comment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "text",
          content,
          videoId,
          parentCommentId: "",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to post comment");
      }

      const data = await response.json();

      setOptimisticComments((prev) =>
        prev.filter((c) => c.id !== optimisticComment.id)
      );

      setComments((prev) => [...prev, data]);
    } catch (error) {
      console.error("Error posting comment:", error);
      setOptimisticComments((prev) =>
        prev.filter((c) => c.id !== optimisticComment.id)
      );
    }
  };

  const handleReply = async (content: string) => {
    if (!replyingTo) return;

    const parentComment = comments.find((c) => c.id === replyingTo);
    const actualParentId = parentComment?.parentCommentId
      ? parentComment.parentCommentId
      : replyingTo;

    const optimisticReply: CommentType = {
      id: `temp-${Date.now()}`,
      authorId: user?.id || "anonymous",
      authorName: user?.name || "Anonymous",
      content,
      createdAt: new Date(),
      videoId: comments[0]?.videoId || "",
      parentCommentId: actualParentId,
      type: "text",
      timestamp: null,
      updatedAt: new Date(),
    };

    addOptimisticComment(optimisticReply);

    try {
      const response = await fetch("/api/video/comment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "text",
          content,
          videoId: comments[0]?.videoId,
          parentCommentId: actualParentId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to post reply");
      }

      const data = await response.json();

      setOptimisticComments((prev) =>
        prev.filter((c) => c.id !== optimisticReply.id)
      );

      setComments((prev) => [...prev, data]);

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
      setOptimisticComments((prev) =>
        prev.filter((c) => c.id !== optimisticReply.id)
      );
    }
  };

  const handleCancelReply = () => {
    setReplyingTo(null);
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      const response = await fetch(
        `/api/video/comment/delete?commentId=${commentId}`,
        {
          method: "DELETE",
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete comment");
      }

      // Remove the comment and its replies from the state
      setComments((prev) =>
        prev.filter(
          (comment) =>
            comment.id !== commentId && comment.parentCommentId !== commentId
        )
      );
    } catch (error) {
      console.error("Error deleting comment:", error);
      // You might want to show an error toast here
    }
  };

  const allComments = [...comments, ...optimisticComments];
  const rootComments = allComments.filter(
    (comment) => !comment.parentCommentId || comment.parentCommentId === ""
  );

  return (
    <div className="flex flex-col h-full">
      {user && isOwnerOrMember && (
        <div className="flex-none border-b border-gray-200">
          <div className="flex justify-between p-4">
            <CapCardAnalytics
              capId={videoId}
              displayCount={analytics.views}
              totalComments={analytics.comments}
              totalReactions={analytics.reactions}
            />
          </div>
        </div>
      )}

      <div
        ref={commentsContainerRef}
        className="overflow-y-auto flex-1 min-h-0"
      >
        {rootComments.length === 0 && optimisticComments.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="p-4 space-y-6">
            <AnimatePresence mode="sync">
              {rootComments
                .sort(
                  (a, b) =>
                    new Date(a.createdAt).getTime() -
                    new Date(b.createdAt).getTime()
                )
                .map((comment) => (
                  <Comment
                    key={comment.id}
                    comment={comment}
                    replies={allComments.sort(
                      (a, b) =>
                        new Date(a.createdAt).getTime() -
                        new Date(b.createdAt).getTime()
                    )}
                    onReply={(id) => {
                      if (!user) {
                        setShowAuthOverlay(true);
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
            </AnimatePresence>
          </div>
        )}
      </div>

      <div className="flex-none p-4 border-t border-gray-200 bg-gray-1">
        {user ? (
          <CommentInput
            onSubmit={handleNewComment}
            placeholder="Leave a comment"
            buttonLabel="Comment"
            user={user}
          />
        ) : (
          <div
            onClick={() => setShowAuthOverlay(true)}
            className="p-4 rounded-lg transition-colors cursor-pointer bg-gray-1 hover:bg-gray-200"
          >
            <span className="text-[15px] leading-[22px] text-gray-1">
              Sign in to leave a comment
            </span>
          </div>
        )}
      </div>

      <AuthOverlay
        isOpen={showAuthOverlay}
        onClose={() => setShowAuthOverlay(false)}
      />
    </div>
  );
};
