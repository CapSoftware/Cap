"use client";

import clsx from "clsx";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { AnchorLine, BranchNode, CommentCard, MicGlyph } from "./DemoBits";
import { DemoButton, DemoPanel } from "./DemoPanel";
import { DemoPlayhead, DemoStrip } from "./DemoStrip";
import type { DemoNode } from "./demo-layout";
import { MockFrame } from "./MockFrame";
import { DEMO_DURATION, type DemoComment, formatClock } from "./scene";

/** Where the reply lands: just after the dialog closes. */
const REPLY_AT = 96;
const MAX_TAKE = 8;

type Kind = "screen" | "camera" | "voice";
type Phase = "idle" | "recording" | "done";

const KINDS: { kind: Kind; label: string }[] = [
	{ kind: "screen", label: "Record screen" },
	{ kind: "camera", label: "Record camera" },
	{ kind: "voice", label: "Record voice note" },
];

/**
 * Answering in the same medium as the question. The capture is mimed — no
 * permission prompt, no camera, no upload — but the shape of the flow and where
 * the result lands are the real ones.
 */
export function ReplyDemo() {
	const reduceMotion = useReducedMotion() ?? false;
	const [phase, setPhase] = useState<Phase>("idle");
	const [kind, setKind] = useState<Kind>("screen");
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (phase !== "recording") return;
		const started = performance.now();
		const id = window.setInterval(() => {
			const seconds = (performance.now() - started) / 1000;
			if (seconds >= MAX_TAKE) {
				setElapsed(MAX_TAKE);
				setPhase("done");
				return;
			}
			setElapsed(seconds);
		}, 100);
		return () => window.clearInterval(id);
	}, [phase]);

	const reply: DemoComment = {
		id: "you",
		author: "You",
		initials: "Y",
		tone: "bg-gray-12",
		t: REPLY_AT,
		kind: kind === "voice" ? "voice" : "video",
		text: "Reply",
		mediaDuration: Math.max(1, Math.round(elapsed)),
	};

	const node: DemoNode = {
		comment: reply,
		lane: 0,
		percent: (REPLY_AT / DEMO_DURATION) * 100,
		count: 1,
		members: [reply],
	};

	return (
		<DemoPanel
			title="Reply with a recording"
			hint="Pick a way to answer. Nothing here touches your camera or microphone; it is a drawing of the flow."
			action={
				phase === "idle" ? undefined : (
					<DemoButton
						onClick={() => {
							setPhase("idle");
							setElapsed(0);
						}}
					>
						Start over
					</DemoButton>
				)
			}
			caption="The reply is a comment, not a second video: it lands on 1:36 of this recording, it shows up in the sidebar and in the notification, and it is deleted with the comment. Recording one needs you signed in, and the owner of the video on Cap Pro."
		>
			<div className="overflow-hidden rounded-xl border border-gray-4 bg-white">
				<div className="relative aspect-video bg-[hsl(224,71.4%,4.1%)]">
					<MockFrame time={REPLY_AT} className="absolute inset-0 size-full" />

					{phase === "recording" && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/45 p-4">
							<div className="w-full max-w-xs rounded-xl border border-white/15 bg-[hsl(224,71.4%,4.1%)] p-3 shadow-xl">
								<TakePreview kind={kind} reduceMotion={reduceMotion} />
								<div className="mt-3 flex items-center gap-2">
									<motion.span
										className="size-2 shrink-0 rounded-full bg-red-500"
										animate={
											reduceMotion ? undefined : { opacity: [1, 0.3, 1] }
										}
										transition={{ repeat: Infinity, duration: 1.2 }}
									/>
									<span className="font-mono text-[12px] tabular-nums text-white/80">
										{formatClock(elapsed)}
									</span>
									<button
										type="button"
										onClick={() => setPhase("done")}
										className="ml-auto rounded-full bg-white px-3 py-1 text-[12px] font-medium text-gray-12 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
									>
										Stop
									</button>
								</div>
							</div>
						</div>
					)}
				</div>

				<DemoStrip time={REPLY_AT} film waveform>
					<DemoPlayhead time={REPLY_AT} />
				</DemoStrip>

				<div className="relative" style={{ height: phase === "done" ? 53 : 0 }}>
					{phase === "done" && (
						<>
							<AnchorLine />
							<BranchNode node={node} active />
							<div
								className="absolute bottom-full z-40 mb-2 -translate-x-1/2"
								style={{
									left: `clamp(8.5rem, ${node.percent}%, 100% - 8.5rem)`,
								}}
							>
								<CommentCard comments={[reply]} />
							</div>
						</>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-2 border-t border-gray-4 bg-white px-2 py-2.5 sm:px-3">
					<div className="flex h-8 min-w-0 flex-1 items-center rounded-full border border-gray-5 px-3 text-[13px] text-gray-9">
						Comment at {formatClock(REPLY_AT)}
					</div>
					{KINDS.map((option) => (
						<button
							key={option.kind}
							type="button"
							disabled={phase === "recording"}
							aria-label={option.label}
							title={option.label}
							onClick={() => {
								setKind(option.kind);
								setElapsed(0);
								setPhase("recording");
							}}
							className={clsx(
								"flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
								phase === "recording"
									? "cursor-not-allowed border-gray-4 text-gray-8"
									: "border-gray-5 text-gray-11 hover:bg-gray-3 hover:text-gray-12",
							)}
						>
							<KindGlyph kind={option.kind} />
						</button>
					))}
				</div>
			</div>
		</DemoPanel>
	);
}

function KindGlyph({ kind }: { kind: Kind }) {
	if (kind === "voice") return <MicGlyph />;
	if (kind === "camera") {
		return (
			<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
				<title>Camera</title>
				<rect x="1.5" y="4" width="9" height="8" rx="2" />
				<path d="M11.5 7.4l2.6-1.7c.3-.2.7 0 .7.4v3.8c0 .4-.4.6-.7.4l-2.6-1.7V7.4Z" />
			</svg>
		);
	}
	return (
		<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
			<title>Screen</title>
			<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm3.5 9.5h5a.5.5 0 1 1 0 1h-5a.5.5 0 0 1 0-1Z" />
		</svg>
	);
}

/** What the recorder shows you mid-take, per kind. */
function TakePreview({
	kind,
	reduceMotion,
}: {
	kind: Kind;
	reduceMotion: boolean;
}) {
	if (kind === "voice") {
		return (
			<div className="flex h-20 items-center justify-center gap-1.5">
				{[0, 1, 2, 3, 4, 5, 6].map((index) => (
					<motion.span
						key={index}
						className="w-1.5 rounded-full bg-blue-9"
						style={{ height: 44 }}
						initial={{ scaleY: 0.3 }}
						animate={
							reduceMotion
								? { scaleY: 0.6 }
								: { scaleY: [0.25, 1, 0.4, 0.8, 0.3] }
						}
						transition={
							reduceMotion
								? { duration: 0 }
								: {
										repeat: Infinity,
										duration: 1.4,
										delay: index * 0.11,
										ease: "easeInOut",
									}
						}
					/>
				))}
			</div>
		);
	}

	if (kind === "camera") {
		return (
			<div className="flex h-20 items-center justify-center rounded-lg bg-white/10">
				<svg viewBox="0 0 48 48" className="h-16" aria-hidden>
					<title>Camera preview</title>
					<circle cx="24" cy="18" r="7.5" fill="rgba(255,255,255,0.5)" />
					<path
						d="M9 44c1.5-9 7.8-13.5 15-13.5S37.5 35 39 44Z"
						fill="rgba(255,255,255,0.5)"
					/>
				</svg>
			</div>
		);
	}

	return (
		<div className="relative h-20 overflow-hidden rounded-lg">
			<MockFrame time={REPLY_AT + 6} className="absolute inset-0 size-full" />
			<div className="absolute inset-0 ring-2 ring-inset ring-red-500/70" />
		</div>
	);
}
