import { Button } from "@cap/ui";
import { Comment } from "@cap/web-domain";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useEffect, useState } from "react";
import { newComment } from "@/actions/videos/new-comment";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../Share";
import type { VideoData } from "../types";
import { AuthOverlay } from "./AuthOverlay";

const MotionButton = motion.create(Button);

// million-ignore
interface ToolbarProps {
	data: VideoData;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	disableReactions?: boolean;
}

export const Toolbar = ({
	data,
	onOptimisticComment,
	onCommentSuccess,
	disableReactions,
}: ToolbarProps) => {
	const user = useCurrentUser();
	const [commentBoxOpen, setCommentBoxOpen] = useState(false);
	const [comment, setComment] = useState("");
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);

	const handleEmojiClick = async (emoji: string) => {
		if (!user) return;
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		const currentTime = videoElement?.currentTime || 0;
		const optimisticComment: CommentType = {
			id: Comment.CommentId.make(`temp-${Date.now()}`),
			authorId: user.id,
			authorName: user.name,
			authorImage: user.imageUrl,
			content: emoji,
			createdAt: new Date(),
			videoId: data.id,
			parentCommentId: Comment.CommentId.make(""),
			type: "emoji",
			timestamp: currentTime,
			updatedAt: new Date(),
			sending: true,
		};

		onOptimisticComment?.(optimisticComment);

		try {
			const newCommentData = await newComment({
				content: emoji,
				videoId: data.id,
				authorImage: user.imageUrl,
				parentCommentId: Comment.CommentId.make(""),
				type: "emoji",
				timestamp: currentTime,
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
		if (comment.length === 0 || !user) {
			return;
		}
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		const currentTime = videoElement?.currentTime || 0;
		const optimisticComment: CommentType = {
			id: Comment.CommentId.make(`temp-${Date.now()}`),
			authorId: user.id,
			authorName: user.name,
			authorImage: user.imageUrl,
			content: comment,
			createdAt: new Date(),
			videoId: data.id,
			parentCommentId: Comment.CommentId.make(""),
			type: "text",
			timestamp: currentTime,
			updatedAt: new Date(),
			sending: true,
		};

		onOptimisticComment?.(optimisticComment);

		try {
			const newCommentData = await newComment({
				content: comment,
				videoId: data.id,
				authorImage: user.imageUrl,
				parentCommentId: Comment.CommentId.make(""),
				type: "text",
				timestamp: currentTime,
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
				const videoElement = document.querySelector(
					"video",
				) as HTMLVideoElement;
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
	}, [commentBoxOpen, user]);

	const handleCommentClick = () => {
		if (!user) {
			setShowAuthOverlay(true);
			return;
		}
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		if (videoElement) {
			videoElement.pause();
		}
		setCommentBoxOpen(true);
	};

	if (disableReactions) {
		return null;
	}

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
									Comment
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
