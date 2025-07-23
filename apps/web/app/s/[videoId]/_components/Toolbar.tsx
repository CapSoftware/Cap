"use client";
import { userSelectProps } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Button } from "@cap/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthOverlay } from "./AuthOverlay";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";

const MotionButton = motion(Button);

// million-ignore
export const Toolbar = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  const router = useRouter();
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

  }, []);


  const getTimestamp = (): number => {
    if (videoElement) {
      return videoElement.currentTime;
    }
    console.warn("Video element not available, using default timestamp");
    return 0;
  };

  const handleEmojiClick = async (emoji: string) => {

    const timestamp = getTimestamp();

    const response = await fetch("/api/video/comment", {
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
    });

    if (response.status === 429) {
      toast.error("Too many requests - please try again later.");
      return;
    }

    if (!response.ok) {
      console.error("Failed to record emoji reaction");
      return;
    }

    router.refresh();
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

      router.refresh();
    } catch (error) {
      console.error("Failed to submit comment:", error);
    }
  };

  const Emoji = ({ label, emoji }: { label: string; emoji: string }) => (
    <motion.div layout className="relative size-10">
      <motion.button
        layout
        className="inline-flex relative justify-center items-center p-1 text-xl leading-6 align-middle bg-transparent rounded-full transition-colors ease-in-out size-full font-emoji sm:text-2xl duration-600 hover:bg-gray-200 active:bg-blue-500 active:duration-0"
        role="img"
        aria-label={label ? label : ""}
        aria-hidden={label ? "false" : "true"}
        onClick={() => handleEmojiClick(emoji)}
      >
        {emoji}
      </motion.button>
    </motion.div>
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
      <motion.div layout className="flex overflow-hidden p-2 mx-auto bg-white rounded-full max-w-fit">
        <AnimatePresence initial={false} mode="popLayout">
          {commentBoxOpen ? (
            <motion.div
              layout
              key="comment-box"
              initial={{ scale: 0.90 }}
              animate={{ scale: 1 }}
              className="flex justify-between items-center w-full"
            >
              <motion.input
                layout
                autoFocus
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment"
                className="flex-grow px-3 h-full outline-none"
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
              <motion.div layout="position" className="flex items-center space-x-2">
                <MotionButton
                  disabled={comment.length === 0}
                  variant="primary"
                  size="sm"
                  layout="position"
                  onClick={() => {
                    handleCommentSubmit();
                  }}
                >
                  {videoElement && getTimestamp() > 0
                    ? `Comment at ${getTimestamp().toFixed(2)}`
                    : "Comment"}
                </MotionButton>
                <MotionButton
                  variant="gray"
                  size="sm"
                  layout="position"
                  onClick={() => {
                    setCommentBoxOpen(false);
                    setComment("");
                  }}
                >
                  Cancel
                </MotionButton>
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              layout
              key="toolbar"
              initial={{ scale: 0.90 }}
              animate={{ scale: 1 }}
              className="grid grid-flow-col gap-2 justify-center items-center w-fit"
            >
              {REACTIONS.map((reaction) => (
                <Emoji
                  key={reaction.emoji}
                  emoji={reaction.emoji}
                  label={reaction.label}
                />
              ))}
              <motion.div className="w-px bg-gray-200 h-[16px] mx-4" />
              <MotionButton
                onClick={handleCommentClick}
                variant="dark"
                layout="position"
                kbd="c"
                size="sm"
              >
                Comment
              </MotionButton>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

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
