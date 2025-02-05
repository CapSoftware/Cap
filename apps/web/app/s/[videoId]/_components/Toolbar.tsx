"use client";
import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { useRouter } from "next/navigation";
import { Button } from "@cap/ui";
import toast from "react-hot-toast";
import { AuthOverlay } from "./AuthOverlay";
import { clientEnv } from "@cap/env";

// million-ignore
export const Toolbar = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  const { refresh } = useRouter();
  const [commentBoxOpen, setCommentBoxOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [showAuthOverlay, setShowAuthOverlay] = useState(false);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null
  );

  useEffect(() => {
    const checkForVideoElement = () => {
      const element = document.getElementById(
        "video-player"
      ) as HTMLVideoElement | null;
      if (element) {
        setVideoElement(element);
      } else {
        setTimeout(checkForVideoElement, 100); // Check again after 100ms
      }
    };

    checkForVideoElement();

    return () => {
      // Clean up any ongoing checks if component unmounts
    };
  }, []);

  const [currentEmoji, setCurrentEmoji] = useState<{
    emoji: string;
    id: number;
  } | null>(null);
  const clearEmojiTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (clearEmojiTimeout.current) {
        clearTimeout(clearEmojiTimeout.current);
      }
    };
  }, []);

  const getTimestamp = (): number => {
    if (videoElement) {
      return videoElement.currentTime;
    }
    console.warn("Video element not available, using default timestamp");
    return 0;
  };

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

    const timestamp = getTimestamp();
    console.log("Current timestamp:", timestamp);

    const response = await fetch(
      `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/video/comment`,
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

    try {
      const timestamp = getTimestamp();

      const response = await fetch("/api/video/comment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "text",
          content: comment,
          videoId: data.id,
          timestamp: timestamp || null,
          parentCommentId: null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Comment submission error:", errorData);
        return;
      }

      setComment("");
      setCommentBoxOpen(false);
      refresh();
    } catch (error) {
      console.error("Failed to submit comment:", error);
    }
  };

  const Emoji = ({ label, emoji }: { label: string; emoji: string }) => (
    <div className="relative w-fit">
      <button
        className="font-emoji text-xl sm:text-2xl leading-6 bg-transparent p-1 relative transition-bg-color duration-600 inline-flex justify-center items-center align-middle rounded-full ease-in-out hover:bg-gray-200 active:bg-gray-400 active:duration-0"
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

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "c" &&
        !commentBoxOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      ) {
        e.preventDefault();
        if (!user) {
          setShowAuthOverlay(true);
          return;
        }
        if (videoElement) {
          videoElement.pause();
        }
        setCommentBoxOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => {
      window.removeEventListener("keydown", handleKeyPress);
    };
  }, [commentBoxOpen, user, videoElement]);

  const handleCommentClick = () => {
    if (!user) {
      setShowAuthOverlay(true);
      return;
    }
    if (videoElement) {
      videoElement.pause();
    }
    setCommentBoxOpen(true);
  };

  return (
    <>
      <div
        className={`${
          !commentBoxOpen ? "max-w-[350px]" : "max-w-[500px]"
        } mx-auto`}
      >
        <div
          className={`new-card-style mx-auto transition-all ${
            commentBoxOpen === true && "w-full"
          }`}
        >
          <div className="flex">
            <div className="flex-grow p-1">
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
                      {videoElement && getTimestamp() > 0
                        ? `Comment at ${getTimestamp().toFixed(2)}`
                        : "Comment"}
                    </Button>
                    <Button
                      className="min-w-[100px]"
                      variant="white"
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
                <div className="grid items-center justify-center grid-flow-col">
                  {REACTIONS.map((reaction) => (
                    <Emoji
                      key={reaction.emoji}
                      emoji={reaction.emoji}
                      label={reaction.label}
                    />
                  ))}
                  <div className="w-[1px] bg-gray-200 h-[16px] mx-4"></div>
                  <div className="flex items-center">
                    <button
                      onClick={handleCommentClick}
                      className="font-medium bg-gray-200 py-1 px-3 relative transition-bg-color duration-600 flex justify-center items-center rounded-full ease-in-out hover:bg-gray-200 active:bg-gray-400 active:duration-0"
                    >
                      <span className="text-sm text-gray-500 font-medium">
                        Comment (c)
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AuthOverlay
        isOpen={showAuthOverlay}
        onClose={() => setShowAuthOverlay(false)}
      />
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
