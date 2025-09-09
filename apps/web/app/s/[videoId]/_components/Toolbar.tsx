import type { userSelectProps } from "@cap/database/auth/session";
import type { videos } from "@cap/database/schema";
import { Button } from "@cap/ui";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useEffect, useState } from "react";
import { newComment } from "@/actions/videos/new-comment";
import type { CommentType } from "../Share";
import { AuthOverlay } from "./AuthOverlay";

const MotionButton = motion.create(Button);

// million-ignore
interface ToolbarProps {
	data: typeof videos.$inferSelect;
	user: typeof userSelectProps | null;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
}

export const Toolbar = ({
	data,
	user,
	onOptimisticComment,
	onCommentSuccess,
}: ToolbarProps) => {
	const [commentBoxOpen, setCommentBoxOpen] = useState(false);
	const [comment, setComment] = useState("");
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);
	const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
		null,
	);

	useEffect(() => {
		const checkForVideoElement = () => {
			const element = document.getElementById(
				"video-player",
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
		const optimisticComment: CommentType = {
			id: `temp-${Date.now()}`,
			authorId: user?.id || "anonymous",
			authorName: user?.name || "Anonymous",
			content: emoji,
			createdAt: new Date(),
			videoId: data.id,
			parentCommentId: "",
			type: "emoji",
			timestamp: null,
			updatedAt: new Date(),
			sending: true,
		};

		onOptimisticComment?.(optimisticComment);

		try {
			const newCommentData = await newComment({
				content: emoji,
				videoId: data.id,
				parentCommentId: "",
				type: "emoji",
			});
			startTransition(() => {
				onCommentSuccess?.(newCommentData);
			});
		} catch (error) {
			console.error("Error posting comment:", error);
		} finally {
			setCommentBoxOpen(false);
			setComment("");
		}
	};

	const handleCommentSubmit = async () => {
		if (comment.length === 0) {
			return;
		}

		const optimisticComment: CommentType = {
			id: `temp-${Date.now()}`,
			authorId: user?.id || "anonymous",
			authorName: user?.name || "Anonymous",
			content: comment,
			createdAt: new Date(),
			videoId: data.id,
			parentCommentId: "",
			type: "text",
			timestamp: null,
			updatedAt: new Date(),
			sending: true,
		};

		onOptimisticComment?.(optimisticComment);

		try {
			const newCommentData = await newComment({
				content: comment,
				videoId: data.id,
				parentCommentId: "",
				type: "text",
			});
			startTransition(() => {
				onCommentSuccess?.(newCommentData);
			});
		} catch (error) {
			console.error("Error posting comment:", error);
		} finally {
			setCommentBoxOpen(false);
			setComment("");
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
			<motion.div
				layout
				className="flex overflow-hidden p-2 mx-auto max-w-full bg-white rounded-full border border-gray-5 md:max-w-fit"
			>
				<AnimatePresence initial={false} mode="popLayout">
					{commentBoxOpen ? (
						<motion.div
							layout
							key="comment-box"
							initial={{ scale: 0.9 }}
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
							<motion.div
								layout="position"
								className="flex items-center space-x-2"
							>
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
							initial={{ scale: 0.9 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0.9 }}
							transition={{ duration: 0.2, ease: "easeInOut" }}
							className="flex flex-col gap-2 items-center mx-auto w-full md:justify-center sm:grid sm:grid-flow-col md:w-fit min-h-[28px]"
						>
							{/* Emoji reactions row */}
							<div className="flex gap-2 justify-evenly items-center w-full md:w-fit md:justify-center">
								{REACTIONS.map((reaction) => (
									<Emoji
										key={reaction.emoji}
										emoji={reaction.emoji}
										label={reaction.label}
									/>
								))}
							</div>

							{/* Separator - hidden on mobile, visible on desktop */}
							<motion.div className="hidden sm:block w-px bg-gray-5 h-[16px] mx-4" />

							{/* Comment button - full width on mobile, normal on desktop */}
							<div className="ml-auto w-full sm:w-auto">
								<MotionButton
									onClick={handleCommentClick}
									variant="dark"
									layout="position"
									kbd="c"
									size="sm"
									className="mx-auto w-fit"
								>
									Comment
								</MotionButton>
							</div>
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
