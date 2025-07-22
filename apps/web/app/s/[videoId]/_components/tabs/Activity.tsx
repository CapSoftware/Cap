"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { revalidateVideoPath } from "@/actions/revalidate-video";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema } from "@cap/database/schema";
import { Avatar, Button } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
  ComponentProps,
  PropsWithChildren,
  Suspense,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Tooltip } from "react-tooltip";

import { AuthOverlay } from "../AuthOverlay";
import clsx from "clsx";
import { useRouter } from "next/navigation";

type CommentType = typeof commentsSchema.$inferSelect & {
  authorName?: string | null;
};

interface ActivityProps {
  views: MaybePromise<number>;
  comments: MaybePromise<CommentType[]>;
  user: typeof userSelectProps | null;
  onSeek?: (time: number) => void;
  videoId: string;
  isOwnerOrMember?: boolean;
}

interface CommentInputProps {
  onSubmit?: (content: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  showCancelButton?: boolean;
  buttonLabel?: string;
  user?: typeof userSelectProps | null;
  autoFocus?: boolean;
  disabled?: boolean;
}

const CommentInput: React.FC<CommentInputProps> = ({
  onSubmit,
  onCancel,
  placeholder,
  showCancelButton = false,
  buttonLabel = "Reply",
  user,
  autoFocus = false,
  disabled,
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
      onSubmit?.(content);
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
        <div className="p-2 rounded-lg bg-gray-1">
          <textarea
            ref={inputRef}
            value={content}
            disabled={disabled}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || "Leave a comment"}
            className="w-full text-[15px] leading-[22px] text-gray-12 bg-transparent focus:outline-none"
          />
          <div className="flex mt-2 space-x-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => handleSubmit()}
              disabled={disabled}
            >
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
        className={clsx(`space-y-3`, level > 0 ? "ml-8 border-l-2 border-gray-100 pl-4" : "")}
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
  <div className="flex flex-col justify-center items-center p-8 h-full text-center animate-in fade-in">
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
  </div>
);

export const Activity = Object.assign(
  ({ user, videoId, isOwnerOrMember = false, ...props }: ActivityProps) => {
    const initialComments =
      props.comments instanceof Promise ? use(props.comments) : props.comments;

    // Lift comments state up so both Analytics and Comments can share it
    const [comments, setComments] = useState(initialComments);

    return (
      <Activity.Shell
        analytics={
          <Suspense fallback={<CapCardAnalytics.Skeleton />}>
            <Analytics
              videoId={videoId}
              views={props.views}
              comments={comments}
            />
          </Suspense>
        }
        user={user}
        isOwnerOrMember={isOwnerOrMember}
      >
        {({ setShowAuthOverlay }) => (
          <Comments
            comments={comments}
            setComments={setComments}
            user={user}
            videoId={videoId}
            setShowAuthOverlay={setShowAuthOverlay}
          />
        )}
      </Activity.Shell>
    );
  },
  {
    Shell: (props: {
      analytics?: JSX.Element;
      user: typeof userSelectProps | null;
      isOwnerOrMember: boolean;
      children?: (props: {
        setShowAuthOverlay: (show: boolean) => void;
      }) => JSX.Element;
    }) => {
      const [showAuthOverlay, setShowAuthOverlay] = useState(false);

      return (
        <div className="flex flex-col h-full">
          {props.user && props.isOwnerOrMember && (
            <div className="flex flex-row items-center p-4 h-12 border-b border-gray-200">
              {props.analytics}
            </div>
          )}

          {props.children?.({ setShowAuthOverlay })}

          <AuthOverlay
            isOpen={showAuthOverlay}
            onClose={() => setShowAuthOverlay(false)}
          />
        </div>
      );
    },
    Skeleton: (props: {
      user: typeof userSelectProps | null;
      isOwnerOrMember: boolean;
    }) => (
      <Activity.Shell {...props} analytics={<CapCardAnalytics.Skeleton />}>
        {({ setShowAuthOverlay }) => (
          <Comments.Skeleton
            setShowAuthOverlay={setShowAuthOverlay}
            user={props.user}
          />
        )}
      </Activity.Shell>
    ),
  }
);

function Analytics(props: {
  videoId: string;
  views: MaybePromise<number>;
  comments: CommentType[];
}) {
  const [views, setViews] = useState(
    props.views instanceof Promise ? use(props.views) : props.views
  );

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const result = await getVideoAnalytics(props.videoId);

        setViews(result.count);
      } catch (error) {
        console.error("Error fetching analytics:", error);
      }
    };

    fetchAnalytics();
  }, [props.videoId]);

  const totalComments = useMemo(
    () => props.comments.filter((c) => c.type === "text").length,
    [props.comments]
  );

  const totalReactions = useMemo(
    () => props.comments.filter((c) => c.type === "emoji").length,
    [props.comments]
  );

  return (
    <CapCardAnalytics
      capId={props.videoId}
      displayCount={views}
      totalComments={totalComments}
      totalReactions={totalReactions}
    />
  );
}

const Comments = Object.assign(
  (props: {
    comments: CommentType[]; // Changed from MaybePromise since parent resolves it
    setComments: React.Dispatch<React.SetStateAction<CommentType[]>>; // Added setComments prop
    user: typeof userSelectProps | null;
    videoId: string;
    onSeek?: (time: number) => void;
    setShowAuthOverlay: (v: boolean) => void;
  }) => {
    // Use shared state from parent instead of local state
    const { comments, setComments } = props;
    const router = useRouter();

    const { user } = props;
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [optimisticComments, setOptimisticComments] = useState<CommentType[]>(
      []
    );

    const allComments = [...comments, ...optimisticComments];
    const rootComments = allComments.filter(
      (comment) => !comment.parentCommentId || comment.parentCommentId === ""
    );

    const commentsContainerRef = useRef<HTMLDivElement>(null);

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
        videoId: props.videoId,
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
            videoId: props.videoId,
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

        await revalidateVideoPath(props.videoId);
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
                    onSeek={props.onSeek}
                  />
                ))}
            </AnimatePresence>
          </div>
        )}
      </Comments.Shell>
    );
  },
  {
    Shell: (
      props: PropsWithChildren<{
        user: typeof userSelectProps | null;
        setShowAuthOverlay: (v: boolean) => void;
        commentInputProps?: Omit<
          ComponentProps<typeof CommentInput>,
          "user" | "placholder" | "buttonLabel"
        >;
        commentsContainerRef?: React.RefObject<HTMLDivElement>;
      }>
    ) => (
      <>
        <div
          ref={props.commentsContainerRef}
          className="overflow-y-auto flex-1 min-h-0"
        >
          {props.children}
        </div>

        <div className="flex-none p-2 border-t border-gray-200 bg-gray-1">
          {props.user ? (
            <CommentInput
              {...props.commentInputProps}
              placeholder="Leave a comment"
              buttonLabel="Comment"
              user={props.user}
            />
          ) : (
            <Button className="min-w-full" variant="primary" onClick={() => props.setShowAuthOverlay(true)}>
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
  }
);
