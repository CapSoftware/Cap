"use client";

import { Button } from "@cap/ui";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";
import { FREE_PLAN_MAX_RECORDING_MS } from "../components/web-recorder-dialog/web-recorder-constants";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

export const RecordVideoPage = () => {
	const checkingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const openDesktop = useCallback(() => {
		let handled = false;
		const onChange = () => {
			handled = true;
			document.removeEventListener("visibilitychange", onChange);
			window.removeEventListener("pagehide", onChange);
			window.removeEventListener("blur", onChange);
		};
		document.addEventListener("visibilitychange", onChange, { once: true });
		window.addEventListener("pagehide", onChange, { once: true });
		window.addEventListener("blur", onChange, { once: true });

		window.location.href = "cap-desktop://";

		if (checkingRef.current) clearTimeout(checkingRef.current);
		checkingRef.current = setTimeout(() => {
			if (!handled && document.visibilityState === "visible") {
				document.removeEventListener("visibilitychange", onChange);
				window.removeEventListener("pagehide", onChange);
				window.removeEventListener("blur", onChange);
				window.location.assign("/download");
			}
		}, 1500);
	}, []);

	return (
		<div
			className="flex flex-col flex-1 justify-center items-center w-full h-full"
			style={{ scrollbarGutter: "stable" }}
		>
			<div className="flex flex-col gap-3 justify-center items-center h-full text-center">
				<div className="w-full px-5">
					<div className="mx-auto w-full max-w-[560px]">
						<div className="flex flex-col items-center">
							<p className="max-w-md text-gray-10 text-md">
								Choose how you'd like to record your Cap
							</p>
						</div>
						<div className="flex flex-wrap gap-3 justify-center items-center mt-4">
							<Button
								onClick={openDesktop}
								className="flex relative gap-2 justify-center items-center"
								variant="primary"
							>
								<FontAwesomeIcon className="size-3.5" icon={faDownload} />
								Open Cap Desktop
							</Button>
							<p className="text-sm text-gray-10">or</p>
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
			q: "What is a Cap?",
			a: "A Cap is a quick video recording of your screen, camera, or both that you can share instantly with a link.",
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
			a: "On compatible browsers, selecting a camera opens a picture‑in‑picture window that’s captured when you record fullscreen. We recommend recording fullscreen to keep it on top. If PiP capture isn’t supported, your camera stays within the Cap recorder tab.",
		},
		{
			id: "what-can-i-record",
			q: "What can I record?",
			a: "You can record your entire screen, a specific window, a browser tab, or just your camera.",
		},
		{
			id: "system-audio",
			q: "Can I record system audio?",
			a: "Browsers limit system‑wide audio capture. Chrome can capture tab audio, but full system audio is best with Cap Desktop.",
		},
		{
			id: "install",
			q: "Do I need to install the app?",
			a: `No. You can record in your browser. For longer recordings, system audio, and advanced editing, use Cap Desktop. The Free plan supports up to ${freeMinutes} minutes per recording in the browser.`,
		},
	];

	return (
		<div className="mt-8 w-full max-w-[560px] px-5 text-left">
			<div className="divide-y divide-gray-4 rounded-lg border border-gray-4 bg-gray-2 w-full">
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
		<div className="p-3">
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
						className="overflow-hidden"
					>
						<div className="pt-2 text-sm text-gray-10">{content}</div>
					</motion.section>
				)}
			</AnimatePresence>
		</div>
	);
};
