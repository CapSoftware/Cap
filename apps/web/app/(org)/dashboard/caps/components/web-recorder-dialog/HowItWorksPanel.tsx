"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
	ArrowLeftIcon,
	LayersIcon,
	LinkIcon,
	PictureInPictureIcon,
} from "lucide-react";
import { TRACK_COLORS } from "./RecorderStage";

const HOW_IT_WORKS_ITEMS = [
	{
		title: "Every source on its own track",
		description:
			"Your screen, camera, microphone and system audio are saved separately, so in the editor you can move or resize the camera, trim either one, or turn a track off.",
		Icon: LayersIcon,
		color: TRACK_COLORS.camera,
	},
	{
		title: "Pick what to share",
		description:
			"After you click Start, your browser asks which screen, window or tab to record. Choose it and click Share. The camera preview hides so it never lands in the screen track.",
		Icon: PictureInPictureIcon,
		color: TRACK_COLORS.screen,
	},
	{
		title: "Shared the moment you stop",
		description:
			"Everything uploads while you record. When you stop, the editor opens and your link is already live. Save publishes your edits to the same link.",
		Icon: LinkIcon,
		color: TRACK_COLORS.mic,
	},
] as const satisfies Array<{
	title: string;
	description: string;
	Icon: LucideIcon;
	color: string;
}>;

interface HowItWorksPanelProps {
	open: boolean;
	onClose: () => void;
}

export const HowItWorksPanel = ({ open, onClose }: HowItWorksPanelProps) => {
	return (
		<AnimatePresence mode="wait">
			{open && (
				<motion.div
					key="web-recorder-how-it-works"
					initial={{ opacity: 0, y: -12 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -12 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
					className="absolute inset-0 z-40 flex flex-col gap-5 rounded-2xl bg-gray-2 p-5"
				>
					<div className="flex items-center justify-between">
						<button
							type="button"
							onClick={onClose}
							className="flex items-center gap-1.5 text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
						>
							<ArrowLeftIcon className="size-4" />
							Back
						</button>
						<h2 className="text-base font-semibold text-gray-12">
							How it works
						</h2>
						<span className="h-9 w-9" aria-hidden />
					</div>
					<div className="flex-1 min-h-0 overflow-y-auto pr-1 pb-1">
						<div className="space-y-4">
							{HOW_IT_WORKS_ITEMS.map(({ title, description, Icon, color }) => (
								<div
									key={title}
									className="rounded-xl border border-gray-4 bg-gray-1 p-4"
								>
									<div className="flex items-start gap-4">
										<div
											className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
											style={{ backgroundColor: `${color}1f`, color }}
										>
											<Icon className="size-5" aria-hidden />
										</div>
										<div className="flex-1 space-y-1.5">
											<h3 className="text-sm font-semibold text-gray-12">
												{title}
											</h3>
											<p className="text-xs leading-relaxed text-gray-11">
												{description}
											</p>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
