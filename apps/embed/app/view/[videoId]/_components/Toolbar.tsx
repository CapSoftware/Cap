"use client";
import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { useRouter } from "next/navigation";
import { Button } from "@cap/ui";
import toast from "react-hot-toast";

// million-ignore
export const Toolbar = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  const { refresh, push } = useRouter();
  const [commentBoxOpen, setCommentBoxOpen] = useState(false);
  const [comment, setComment] = useState("");
  const videoElement = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    videoElement.current = document.getElementById(
      "video-player"
    ) as HTMLVideoElement;
  }, []);

  const [currentEmoji, setCurrentEmoji] = useState<{
    emoji: string;
    id: number;
  } | null>(null);
  const clearEmojiTimeout = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (clearEmojiTimeout.current) {
        clearTimeout(clearEmojiTimeout.current);
      }
    };
  }, []);

  const timestamp =
    videoElement && videoElement.current ? videoElement.current.currentTime : 0;

  const handleEmojiClick = async (emoji: string) => {
    // Clear any existing timeout
    if (clearEmojiTimeout.current) {
      clearTimeout(clearEmojiTimeout.current);
    }

    // Set the current emoji with a unique identifier
    setCurrentEmoji({ emoji, id: Date.now() });

    // Remove the emoji after the animation duration
    clearEmojiTimeout.current = setTimeout(() => {
      setCurrentEmoji(null);
    }, 3000);

    const videoElement = document.getElementById(
      "video-player"
    ) as HTMLVideoElement;
    console.log("videoElement", videoElement.currentTime);
    const timestamp = videoElement ? videoElement.currentTime : 0;

    console.log("timestamp", timestamp);

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_WEB_URL}/api/video/comment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "emoji",
          content: emoji,
          videoId: data.id,
          parentCommentId: null,
          timestamp: timestamp,
        }),
      }
    );

    if (response.status === 429) {
      toast.error("Too many requests - please try again later.");
      return;
    }

    if (!response.ok) {
      console.error("Failed to record emoji reaction");
    }

    refresh();
  };

  const handleCommentSubmit = async () => {
    if (comment.length === 0) {
      return;
    }

    const response = await fetch("/api/video/comment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "text",
        content: comment,
        videoId: data.id,
        parentCommentId: null,
        timestamp: timestamp,
      }),
    });

    if (!response.ok) {
      console.error("Failed to record comment");
    }

    setComment("");
    setCommentBoxOpen(false);

    refresh();
  };

  const Emoji = ({ label, emoji }: { label: string; emoji: string }) => (
    <div className="relative w-fit">
      <button
        className="font-emoji text-2xl leading-6 bg-transparent p-1 relative transition-bg-color duration-600 inline-flex justify-center items-center align-middle rounded-full ease-in-out hover:bg-gray-200 active:bg-gray-400 active:duration-0"
        role="img"
        aria-label={label ? label : ""}
        aria-hidden={label ? "false" : "true"}
        onClick={() => handleEmojiClick(emoji)}
      >
        {emoji}
        {currentEmoji && currentEmoji.emoji === emoji && (
          <span
            key={currentEmoji.id}
            className="font-emoji absolute -top-10 left-0 right-0 mx-auto animate-flyEmoji duration-3000"
          >
            {currentEmoji.emoji}
          </span>
        )}
      </button>
    </div>
  );

  return (
    <>
      <div
        className={`bg-white border border-gray-200 rounded-full mx-auto shadow-lg transition-all ${
          commentBoxOpen === true && "w-full"
        }`}
      >
        <div
          className={`${
            commentBoxOpen === true ? "flex w-full" : "grid"
          } items-center justify-start`}
        >
          <div className="w-full p-2">
            {commentBoxOpen === true ? (
              <div className="w-full flex items-center justify-between">
                <input
                  autoFocus
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment"
                  className="flex-grow h-full outline-none px-3"
                  maxLength={255}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCommentSubmit();
                    }
                    if (e.key === "Escape") {
                      setCommentBoxOpen(false);
                      setComment("");
                    }
                  }}
                />
                <div className="flex items-center space-x-2">
                  <Button
                    className="min-w-[160px]"
                    disabled={comment.length === 0}
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      handleCommentSubmit();
                    }}
                  >
                    Comment at {timestamp.toFixed(2)}
                  </Button>
                  <Button
                    className="min-w-[100px]"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setCommentBoxOpen(false);
                      setComment("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid items-center justify-start grid-flow-col">
                {REACTIONS.map((reaction) => (
                  <Emoji
                    key={reaction.emoji}
                    emoji={reaction.emoji}
                    label={reaction.label}
                  />
                ))}
                <div className="w-[2px] bg-gray-200 h-full mx-2"></div>
                <div className="flex items-center">
                  <button
                    onClick={() => {
                      if (!user) {
                        push(`/login?next=${window.location.pathname}`);
                        return;
                      }
                      const videoElement = document.getElementById(
                        "video-player"
                      ) as HTMLVideoElement;
                      videoElement.pause();
                      setCommentBoxOpen(true);
                    }}
                    className="text-xs sm:text-sm font-medium bg-transparent py-1 px-2 relative transition-bg-color duration-600 flex justify-center items-center rounded-full ease-in-out hover:bg-gray-200 active:bg-gray-400 active:duration-0"
                  >
                    <MessageSquare className="w-[22px] h-auto" />
                    <span className="ml-1">Comment</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

const REACTIONS = [
  {
    emoji: "😂",
    label: "joy",
  },
  {
    emoji: "😍",
    label: "love",
  },
  {
    emoji: "😮",
    label: "wow",
  },
  {
    emoji: "🙌",
    label: "yay",
  },
  {
    emoji: "👍",
    label: "up",
  },
  {
    emoji: "👎",
    label: "down",
  },
];
