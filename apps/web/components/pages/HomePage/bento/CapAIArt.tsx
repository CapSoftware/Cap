"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BookOpen, Captions, FileText, Sparkles, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const STATES = ["title", "summary", "chapters", "transcript"] as const;

const TITLE_TEXT = "How to ship a feature in 24 hours";

const SUMMARY_LINES = [
	"Walks through a complete feature lifecycle",
	"From initial spec to production deploy",
	"Includes testing, review & rollout steps",
];

const CHAPTERS = [
	{ time: "0:00", label: "Defining the scope" },
	{ time: "1:24", label: "Writing the spec" },
	{ time: "3:47", label: "Building & testing" },
];

const TRANSCRIPT_ROWS = [
	{ time: "0:12", text: "Let's start by scoping the feature clearly" },
	{ time: "0:28", text: "so the team knows exactly what to build" },
	{ time: "0:41", text: "and what to leave for a future iteration." },
	{ time: "0:55", text: "First, write a one-pager with the goal" },
	{ time: "1:08", text: "success criteria and non-goals defined." },
];

function TitleCard({ reduced }: { reduced: boolean }) {
	const [displayed, setDisplayed] = useState(reduced ? TITLE_TEXT : "");
	const idx = useRef(0);

	useEffect(() => {
		if (reduced) return;
		idx.current = 0;
		setDisplayed("");
		const id = setInterval(() => {
			idx.current += 2;
			setDisplayed(TITLE_TEXT.slice(0, idx.current));
			if (idx.current >= TITLE_TEXT.length) clearInterval(id);
		}, 25);
		return () => clearInterval(id);
	}, [reduced]);

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-1.5 text-blue-500">
				<Type size={13} />
				<span className="text-xs font-medium">Title</span>
			</div>
			<p className="text-gray-12 text-sm font-semibold leading-snug min-h-[3.5rem]">
				{displayed}
				{!reduced && displayed.length < TITLE_TEXT.length && (
					<motion.span
						animate={{ opacity: [1, 0] }}
						transition={{ repeat: Infinity, duration: 0.5 }}
						className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 align-middle"
					/>
				)}
			</p>
		</div>
	);
}

function SummaryCard() {
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-1.5 text-blue-500">
				<FileText size={13} />
				<span className="text-xs font-medium">Summary</span>
			</div>
			<div className="flex flex-col gap-2">
				{SUMMARY_LINES.map((line, i) => (
					<motion.div
						key={line}
						initial={{ width: "0%" }}
						animate={{ width: "100%" }}
						transition={{ delay: i * 0.12, duration: 0.4, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<p className="text-gray-10 text-xs leading-relaxed whitespace-nowrap">
							{line}
						</p>
					</motion.div>
				))}
			</div>
		</div>
	);
}

function ChaptersCard() {
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-1.5 text-blue-500">
				<BookOpen size={13} />
				<span className="text-xs font-medium">Chapters</span>
			</div>
			<div className="flex flex-col gap-1.5">
				{CHAPTERS.map((ch, i) => (
					<motion.div
						key={ch.time}
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ delay: i * 0.15, duration: 0.3 }}
						className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${i === 1 ? "bg-gray-2 border-l-2 border-blue-500" : ""}`}
					>
						<span className="text-gray-9 text-[10px] font-mono w-8 shrink-0">
							{ch.time}
						</span>
						<span
							className={`text-xs ${i === 1 ? "text-gray-12 font-medium" : "text-gray-10"}`}
						>
							{ch.label}
						</span>
					</motion.div>
				))}
			</div>
		</div>
	);
}

function TranscriptCard() {
	return (
		<div className="flex flex-col gap-3 p-4 overflow-hidden">
			<div className="flex items-center gap-1.5 text-blue-500">
				<Captions size={13} />
				<span className="text-xs font-medium">Transcript</span>
			</div>
			<motion.div
				animate={{ y: [0, -52] }}
				transition={{ duration: 2.2, ease: "linear", repeat: 0 }}
				className="flex flex-col gap-2"
			>
				{TRANSCRIPT_ROWS.map((row) => (
					<div key={row.time} className="flex items-start gap-2">
						<span className="text-gray-9 text-[10px] font-mono w-8 shrink-0 pt-0.5">
							{row.time}
						</span>
						<span className="text-gray-10 text-xs leading-relaxed">
							{row.text}
						</span>
					</div>
				))}
			</motion.div>
		</div>
	);
}

interface ArtProps {
	className?: string;
}

const CapAIArt = ({ className }: ArtProps) => {
	const reduced = useReducedMotion() ?? false;
	const [stateIdx, setStateIdx] = useState(0);

	useEffect(() => {
		if (reduced) return;
		const id = setInterval(() => {
			setStateIdx((prev) => (prev + 1) % STATES.length);
		}, 2200);
		return () => clearInterval(id);
	}, [reduced]);

	const current = STATES[stateIdx];

	return (
		<div
			className={`relative flex flex-col items-center justify-center overflow-hidden bg-gray-1 ${className ?? ""}`}
		>
			<motion.div
				animate={reduced ? {} : { x: [0, 22, 0], y: [0, -14, 0] }}
				transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
				className="pointer-events-none absolute left-6 top-8 h-28 w-28 rounded-full bg-blue-500 opacity-10 blur-2xl"
			/>
			<motion.div
				animate={reduced ? {} : { x: [0, -18, 0], y: [0, 18, 0] }}
				transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
				className="pointer-events-none absolute bottom-8 right-6 h-28 w-28 rounded-full opacity-10 blur-2xl"
				style={{ background: "#8b5cf6" }}
			/>

			<div className="relative z-10 flex w-full flex-col items-center gap-3 px-4">
				<div className="flex items-center gap-1.5 self-start rounded-full border border-gray-5 bg-gray-2 px-2.5 py-1">
					<motion.div
						animate={reduced ? {} : { opacity: [0.6, 1, 0.6] }}
						transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
					>
						<Sparkles size={11} className="text-blue-500" />
					</motion.div>
					<span className="text-gray-12 text-[11px] font-medium">Cap AI</span>
				</div>

				<div className="w-full rounded-xl border border-gray-5 bg-gray-1 shadow-sm min-h-[140px]">
					<AnimatePresence mode="wait">
						<motion.div
							key={current}
							initial={{ opacity: 0, y: reduced ? 0 : 6 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: reduced ? 0 : -6 }}
							transition={reduced ? { duration: 0 } : { duration: 0.25 }}
						>
							{current === "title" && <TitleCard reduced={reduced} />}
							{current === "summary" && <SummaryCard />}
							{current === "chapters" && <ChaptersCard />}
							{current === "transcript" && <TranscriptCard />}
						</motion.div>
					</AnimatePresence>
				</div>

				<div className="flex gap-1.5 self-center">
					{STATES.map((s, i) => (
						<div
							key={s}
							className={`h-1 rounded-full transition-all duration-300 ${i === stateIdx ? "w-4 bg-blue-500" : "w-1 bg-gray-5"}`}
						/>
					))}
				</div>
			</div>
		</div>
	);
};

export default CapAIArt;
