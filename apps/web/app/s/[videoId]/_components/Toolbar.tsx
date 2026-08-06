import { Button } from "@cap/ui";
import { Comment } from "@cap/web-domain";
import { AnimatePresence, motion } from "motion/react";
import dynamic from "next/dynamic";
import { startTransition, useEffect, useState } from "react";
import { newComment } from "@/actions/videos/new-comment";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../Share";
import type { VideoData } from "../types";
import { AuthOverlay } from "./AuthOverlay";
import { RecordActionButtons } from "./media-comment/record-actions";
import type { RecordIntentKind } from "./timeline/TimelineComposer";

// Capture and upload code stays out of the page bundle until someone records.
const RecorderSurface = dynamic(
	() => import("./timeline/recording/RecorderSurface"),
	{ ssr: false },
);

const MotionButton = motion.create(Button);

// million-ignore
interface ToolbarProps {
	data: VideoData;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	disableComments?: boolean;
	disableReactions?: boolean;
	/** Owner is on Pro and the viewer is signed in; uploads re-check server-side. */
	canRecordMedia?: boolean;
}

interface EmojiButtonProps {
	label: string;
	emoji: string;
	onClick: () => void;
}

const EmojiButton = ({ label, emoji, onClick }: EmojiButtonProps) => (
	<motion.div layout className="relative size-10">
		<motion.button
			layout
			className="inline-flex relative justify-center items-center p-1 text-xl leading-6 align-middle bg-transparent rounded-full transition-colors ease-in-out size-full font-emoji sm:text-2xl duration-600 hover:bg-gray-200 active:bg-blue-500 active:duration-0"
			role="img"
			aria-label={label ? label : ""}
			aria-hidden={label ? "false" : "true"}
			onClick={onClick}
		>
			{emoji}
		</motion.button>
	</motion.div>
);

export const Toolbar = ({
	data,
	onOptimisticComment,
	onCommentSuccess,
	disableComments,
	disableReactions,
	canRecordMedia = false,
}: ToolbarProps) => {
	const user = useCurrentUser();
	const [commentBoxOpen, setCommentBoxOpen] = useState(false);
	const [comment, setComment] = useState("");
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);
	const [recordIntent, setRecordIntent] = useState<{
		kind: RecordIntentKind;
		t: number;
	} | null>(null);
	const canComment = !disableComments;
	const canReact = !disableReactions;

	const startRecording = (kind: RecordIntentKind) => {
		// Anchor to the playhead like a text comment, pause, and fold the box
		// away — the floating recorder takes over from here.
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		const t = data.isScreenshot ? 0 : videoElement?.currentTime || 0;
		videoElement?.pause();
		setCommentBoxOpen(false);
		setComment("");
		setRecordIntent({ kind, t });
	};

	const handleEmojiClick = async (emoji: string) => {
		if (!canReact || !user) return;
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		const currentTime = data.isScreenshot
			? null
			: videoElement?.currentTime || 0;
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
			mediaKey: null,
			mediaDuration: null,
			mediaMeta: null,
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
		if (!canComment || comment.length === 0 || !user) {
			return;
		}
		const videoElement = document.querySelector("video") as HTMLVideoElement;
		const currentTime = data.isScreenshot
			? null
			: videoElement?.currentTime || 0;
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
			mediaKey: null,
			mediaDuration: null,
			mediaMeta: null,
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

	useEffect(() => {
		if (!canComment) return;

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
	}, [canComment, commentBoxOpen, user]);

	const handleCommentClick = () => {
		if (!canComment) return;
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

	if (!canComment && !canReact) {
		return null;
	}

	return (
		<>
			<motion.div
				layout
				className="flex overflow-hidden p-2 mx-auto max-w-full bg-white rounded-full border border-gray-5 md:max-w-fit"
			>
				<AnimatePresence initial={false} mode="popLayout">
					{commentBoxOpen && canComment ? (
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
								{canRecordMedia && (
									// preventDefault on the way down: the input is focused, and
									// letting its blur run first would shuffle layout under the
									// click. Screen/camera/voice replies from right here.
									<div
										className="flex items-center gap-0.5 pr-1"
										onPointerDown={(event) => event.preventDefault()}
									>
										<RecordActionButtons onSelect={startRecording} />
									</div>
								)}
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
							{canReact && (
								<div className="flex gap-2 justify-evenly items-center w-full md:w-fit md:justify-center">
									{REACTIONS.map((reaction) => (
										<EmojiButton
											key={reaction.emoji}
											emoji={reaction.emoji}
											label={reaction.label}
											onClick={() => handleEmojiClick(reaction.emoji)}
										/>
									))}
								</div>
							)}

							{canReact && canComment && (
								<motion.div className="hidden sm:block w-px bg-gray-5 h-[16px] mx-4" />
							)}

							{canComment && (
								<div
									className={
										canReact ? "ml-auto w-full sm:w-auto" : "w-full sm:w-auto"
									}
								>
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
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>

			{recordIntent && (
				<RecorderSurface
					kind={recordIntent.kind}
					timestamp={recordIntent.t}
					videoId={data.id}
					onOptimisticComment={onOptimisticComment}
					onCommentSuccess={onCommentSuccess}
					onClose={() => setRecordIntent(null)}
					// The toolbar pill clips overflow and sits mid-page; the panel
					// belongs on the fixed bottom-center spot with the screen bar.
					placement="floating"
				/>
			)}

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
