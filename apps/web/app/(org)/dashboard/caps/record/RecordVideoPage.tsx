"use client";

import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { FREE_PLAN_MAX_RECORDING_MS } from "../components/web-recorder-dialog/web-recorder-constants";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

export const RecordVideoPage = () => {
	return (
		<div
			className="flex flex-col flex-1 justify-center items-center w-full h-full"
			style={{ scrollbarGutter: "stable" }}
		>
			<div className="w-full flex flex-col gap-3 justify-center items-center h-full text-center">
				<div className="w-full px-5">
					<div className="mx-auto w-full max-w-[560px] min-w-0">
						<div className="flex flex-col items-center">
							<p className="max-w-md text-gray-10 text-md">
								Choose how you'd like to record your video
							</p>
						</div>
						<div className="flex flex-wrap gap-3 justify-center items-center mt-4">
							<WebRecorderDialog />
						</div>
						<FaqAccordion />
					</div>
				</div>
			</div>
		</div>
	);
};

const FaqAccordion = () => {
	const freeMinutes = Math.floor(FREE_PLAN_MAX_RECORDING_MS / 60000);
	const items = [
		{
			id: "what-is-cap",
			q: "What is a recording?",
			a: "A recording is a quick video capture of your screen, camera, or both that you can share instantly with a link.",
		},
		{
			id: "how-it-works",
			q: "How does it work?",
			a: "On compatible browsers, your capture uploads in the background while you record. Otherwise it records first and uploads immediately after you stop, so your link is ready right away.",
		},
		{
			id: "browsers",
			q: "Which browsers are recommended?",
			a: "We recommend Google Chrome or other Chromium‑based browsers for the most reliable recording and upload behavior. Most modern browsers are supported, but capabilities can vary.",
		},
		{
			id: "pip",
			q: "How do I keep my webcam visible?",
			a: "On compatible browsers, selecting a camera opens a picture-in-picture window that is captured when you record fullscreen. We recommend recording fullscreen to keep it on top. If PiP capture is not supported, your camera stays within the recorder tab.",
		},
		{
			id: "what-can-i-record",
			q: "What can I record?",
			a: "You can record your entire screen, a specific window, a browser tab, or just your camera.",
		},
		{
			id: "system-audio",
			q: "Can I record system audio?",
			a: "Browsers limit system-wide audio capture. Browser support can vary by operating system.",
		},
		{
			id: "install",
			q: "Do I need to install the app?",
			a: `No. You can record in your browser. The Free plan supports up to ${freeMinutes} minutes per recording in the browser.`,
		},
	];

	return (
		<div className="mt-8 text-left">
			<div className="w-full min-w-0 divide-y divide-gray-4 rounded-lg border border-gray-4 bg-gray-2">
				{items.map((it) => (
					<AccordionItem key={it.id} title={it.q} content={it.a} />
				))}
			</div>
		</div>
	);
};

const AccordionItem = ({
	title,
	content,
}: {
	title: string;
	content: string;
}) => {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const headerId = useId();

	return (
		<div className="p-3 w-full">
			<button
				id={headerId}
				aria-controls={contentId}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				type="button"
				className="flex w-full items-center justify-between gap-3 text-left"
			>
				<span className="text-sm font-medium text-gray-12">{title}</span>
				<ChevronDown
					className="size-4 shrink-0 text-gray-10 transition-transform duration-200"
					style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
				/>
			</button>
			<AnimatePresence initial={false}>
				{open && (
					<motion.section
						id={contentId}
						aria-labelledby={headerId}
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.18 }}
						className="overflow-hidden w-full"
					>
						<div className="pt-2 text-sm text-gray-10">{content}</div>
					</motion.section>
				)}
			</AnimatePresence>
		</div>
	);
};
