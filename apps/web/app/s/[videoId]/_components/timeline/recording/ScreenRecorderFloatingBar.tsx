"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { formatClock } from "../timeline-format";
import {
	type CommentRecording,
	useCommentRecorder,
} from "./useCommentRecorder";

/**
 * Screen replies show the browser's picker immediately, then collapse to a
 * small fixed bar so the author can switch tabs while recording. The browser's
 * own "Stop sharing" also ends the recording.
 */
export function ScreenRecorderFloatingBar({
	timestamp,
	onFinish,
	onCancel,
}: {
	timestamp: number;
	onFinish: (recording: CommentRecording) => void;
	onCancel: () => void;
}) {
	const [started, setStarted] = useState(false);
	const {
		phase,
		durationMs,
		micMuted,
		error,
		startScreen,
		toggleMic,
		stop,
		cancel,
	} = useCommentRecorder({ onFinish, onPickerCancelled: onCancel });

	useEffect(() => {
		if (!started) {
			setStarted(true);
			void startScreen();
		}
	}, [startScreen, started]);

	useEffect(() => {
		if (error) {
			const timer = setTimeout(onCancel, 2500);
			return () => clearTimeout(timer);
		}
	}, [error, onCancel]);

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	return (
		<AnimatePresence>
			{(phase === "recording" || error) && (
				<motion.div
					key="screen-bar"
					initial={{ opacity: 0, y: 16 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: 12 }}
					transition={{ type: "spring", stiffness: 420, damping: 34 }}
					className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2"
				>
					<div className="flex items-center gap-3 rounded-full border border-gray-5 bg-white py-2 pr-2 pl-4 shadow-[0_8px_24px_rgba(18,22,31,0.12)]">
						{error ? (
							<span className="text-xs text-gray-11">{error}</span>
						) : (
							<>
								<span className="flex items-center gap-2">
									<span className="relative flex size-2.5">
										<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
										<span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
									</span>
									<span className="font-mono text-xs tabular-nums text-gray-12">
										{formatClock(durationMs / 1000)}
									</span>
								</span>
								<span className="text-[11px] text-gray-9">
									Recording reply at {formatClock(timestamp)}
								</span>
								<button
									type="button"
									onClick={toggleMic}
									aria-label={
										micMuted ? "Unmute microphone" : "Mute microphone"
									}
									aria-pressed={micMuted}
									className={`flex size-8 items-center justify-center rounded-full ring-1 ring-gray-4 transition-colors ${
										micMuted
											? "bg-gray-3 text-gray-9"
											: "bg-gray-2 text-gray-12"
									}`}
								>
									<svg
										viewBox="0 0 16 16"
										className="size-3.5"
										fill="currentColor"
										aria-hidden="true"
									>
										<path d="M8 1.5A2.25 2.25 0 0 0 5.75 3.75v3.5a2.25 2.25 0 0 0 4.5 0v-3.5A2.25 2.25 0 0 0 8 1.5Z" />
										<path d="M3.75 6.75a.65.65 0 0 1 1.3 0v.5a2.95 2.95 0 0 0 5.9 0v-.5a.65.65 0 0 1 1.3 0v.5a4.25 4.25 0 0 1-3.6 4.2v1.55h1.6a.65.65 0 0 1 0 1.3h-4.5a.65.65 0 0 1 0-1.3h1.6v-1.55a4.25 4.25 0 0 1-3.6-4.2v-.5Z" />
										{micMuted && (
											<path
												d="M2 2l12 12"
												stroke="currentColor"
												strokeWidth="1.4"
												strokeLinecap="round"
											/>
										)}
									</svg>
								</button>
								<button
									type="button"
									onClick={handleCancel}
									className="h-8 rounded-full px-3 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
								>
									Discard
								</button>
								<button
									type="button"
									onClick={stop}
									className="flex h-8 items-center gap-1.5 rounded-full bg-gray-12 px-3.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
								>
									<span className="inline-flex size-2 rounded-sm bg-red-400" />
									Stop
								</button>
							</>
						)}
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
