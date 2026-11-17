"use client";

import { AlignLeft, ListOrdered, ScrollText } from "lucide-react";
import type { ReactNode } from "react";
import { CapLogoMark } from "../demo/capIcons";
import { AI_COPY, copyOf } from "./copy";
import { CANVAS, type Scene, Showcase, seg, TONES } from "./kit";
import { Avatar, RecordingFrame } from "./share";

export { CANVAS };

const SURFACE = { x: 70, y: 34, w: 900, h: 470 } as const;
const PLAYER = { x: 32, y: 32, w: 520 } as const;
const PANEL = { x: 572, y: 32, w: 296, h: 406 } as const;
const VIDEO_H = Math.round((PLAYER.w - 16) * (9 / 16));

const DURATION = 24;

const fmt = (s: number) =>
	`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const SUMMARY =
	"Richie walks through sending invoice #1042 to Northwind Labs in the new flow. He picks the client, adds two line items for a total of $4,200, and sends it in under thirty seconds.";

const AI_TITLE = "Sending an invoice in Ledgerly";
const RAW_TITLE = "Recording 2026-10-25 at 10.41";

const CHAPTERS = [
	[0, "Opening a new invoice"],
	[6, "Choosing the client"],
	[11, "Adding the line items"],
	[19, "Sending it to Northwind"],
] as const;

const LINES = [
	[2, "So this is the new invoice flow."],
	[6, "First, pick the client, so Northwind Labs."],
	[11, "Then add your line items, the retainer and the study."],
	[16, "The total updates as you go, $4,200."],
	[19, "And hit send. That's the whole thing."],
] as const;

const Surface = ({ children }: { children: ReactNode }) => (
	<div
		className="absolute overflow-hidden rounded-[22px] shadow-[0_0_0_1px_rgba(120,72,16,0.06)]"
		style={{
			left: SURFACE.x,
			top: SURFACE.y,
			width: SURFACE.w,
			height: SURFACE.h,
			background:
				"radial-gradient(120% 90% at 0% 0%, #FFE7C2 0%, transparent 60%), radial-gradient(110% 100% at 100% 100%, #FFD3C4 0%, transparent 55%), linear-gradient(135deg, #FFF1DC 0%, #FFE6D2 100%)",
		}}
	>
		{children}
	</div>
);

const Player = ({
	seconds,
	playing,
	title,
	ticks = 0,
	caption,
	chapter,
}: {
	seconds: number;
	playing: boolean;
	title: ReactNode;
	ticks?: number;
	caption?: string;
	chapter?: string;
}) => {
	const progress = Math.min(1, seconds / DURATION);
	return (
		<div
			className="absolute rounded-[16px] bg-white p-2 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_30px_60px_-30px_rgba(120,60,20,0.45)]"
			style={{ left: PLAYER.x, top: PLAYER.y, width: PLAYER.w }}
		>
			<div className="flex items-center gap-2.5 px-2 pb-2.5 pt-1.5">
				<Avatar size={26} />
				<div className="min-w-0 leading-tight">
					<div className="truncate text-[15px] text-[#1C1C1C]">{title}</div>
					<div className="text-[11.5px] text-[#8F8F8F]">Richie · just now</div>
				</div>
			</div>
			<div
				className="relative overflow-hidden rounded-[10px] bg-black"
				style={{ height: VIDEO_H }}
			>
				<RecordingFrame playing={playing} pageScale={0.52} />
				{chapter ? (
					<div
						key={chapter}
						className="ht-fade-in absolute left-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[12px] text-white"
					>
						{chapter}
					</div>
				) : null}
				{caption ? (
					<div className="absolute inset-x-0 bottom-3 flex justify-center">
						<span
							key={caption}
							className="ht-fade-in rounded-[7px] bg-black/90 px-2.5 py-1 text-[14px] font-bold text-white"
						>
							{caption}
						</span>
					</div>
				) : null}
			</div>
			<div className="px-2 pb-1.5 pt-3">
				<div className="relative h-[5px] rounded-full bg-[#EEEEEE]">
					<div
						className="absolute inset-y-0 left-0 rounded-full bg-[#3B82F6]"
						style={{ width: `${progress * 100}%` }}
					/>
					{CHAPTERS.slice(1, Math.max(1, ticks)).map(([at]) => (
						<span
							key={at}
							className="ht-pop-in absolute top-1/2 h-[11px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1C1C1C]"
							style={{ left: `${(at / DURATION) * 100}%` }}
						/>
					))}
					<span
						className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1.5px_#3B82F6,0_1px_3px_rgba(0,0,0,0.2)]"
						style={{ left: `${progress * 100}%` }}
					/>
				</div>
				<div className="mt-2 flex justify-between text-[11px] tabular-nums text-[#8F8F8F]">
					<span>{fmt(seconds)}</span>
					<span>{fmt(DURATION)}</span>
				</div>
			</div>
		</div>
	);
};

const Panel = ({
	heading,
	status,
	children,
}: {
	heading: string;
	status?: ReactNode;
	children: ReactNode;
}) => (
	<div
		className="absolute flex flex-col overflow-hidden rounded-[16px] bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_30px_60px_-30px_rgba(120,60,20,0.45)]"
		style={{
			left: PANEL.x,
			top: PANEL.y,
			width: PANEL.w,
			height: PANEL.h,
		}}
	>
		<div className="flex items-center justify-between border-b border-[#F0F0F0] px-4 py-3">
			<span className="flex items-center gap-2 text-[15px] font-medium text-[#1C1C1C]">
				<CapLogoMark className="size-4" />
				{heading}
			</span>
			{status}
		</div>
		<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
	</div>
);

const Writing = () => (
	<span className="inline-flex items-center gap-1.5 text-[11.5px] text-[#8F8F8F]">
		<span className="relative flex size-1.5">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-[#F59E0B] opacity-60" />
			<span className="relative inline-flex size-1.5 rounded-full bg-[#F59E0B]" />
		</span>
		Writing
	</span>
);

const Done = ({ label }: { label: string }) => (
	<span className="ht-fade-in text-[11.5px] text-[#16A34A]">{label}</span>
);

const Typed = ({ text, k }: { text: string; k: number }) => {
	const n = Math.round(text.length * Math.min(1, Math.max(0, k)));
	return (
		<>
			{text.slice(0, n)}
			{n > 0 && n < text.length ? (
				<span className="ml-px inline-block h-[0.95em] w-[1.5px] translate-y-[2px] bg-current" />
			) : null}
		</>
	);
};

const SummaryView = ({ t, playing }: { t: number; playing: boolean }) => {
	const titleK = seg(t, 500, 1300);
	const bodyK = Math.min(1, Math.max(0, (t - 1400) / 3400));
	const done = bodyK >= 1;
	return (
		<Surface>
			<Player
				seconds={2 + t / 1000}
				playing={playing}
				title={
					titleK <= 0 ? (
						<span className="text-[#8F8F8F]">{RAW_TITLE}</span>
					) : (
						<Typed text={AI_TITLE} k={titleK} />
					)
				}
			/>
			<Panel
				heading="Summary"
				status={done ? <Done label="Ready" /> : <Writing />}
			>
				<div className="px-4 py-3.5">
					<div className="text-[11.5px] text-[#8F8F8F]">Title</div>
					<div className="mt-1 min-h-[21px] text-[14px] font-medium text-[#1C1C1C]">
						<Typed text={AI_TITLE} k={titleK} />
					</div>
					<div className="mt-4 text-[11.5px] text-[#8F8F8F]">Summary</div>
					<p className="mt-1 text-[14px] leading-[1.6] text-[#1C1C1C]">
						<Typed text={SUMMARY} k={bodyK} />
					</p>
				</div>
			</Panel>
		</Surface>
	);
};

const ChaptersView = ({ t, playing }: { t: number; playing: boolean }) => {
	const shown = Math.min(
		CHAPTERS.length,
		Math.floor(Math.max(0, t - 300) / 280) + 1,
	);
	const target = 2;
	const clickAt = 2600;
	const clicked = t > clickAt;
	const start = CHAPTERS[target]?.[0] ?? 0;
	const seconds = clicked ? start + (t - clickAt) / 1000 : 1 + t / 1000;
	const active = clicked
		? target
		: CHAPTERS.findLastIndex(([at]) => at <= seconds);
	const tap = (t - clickAt + 150) / 520;
	return (
		<Surface>
			<Player
				seconds={seconds}
				playing={playing}
				title={AI_TITLE}
				ticks={shown}
				chapter={CHAPTERS[active]?.[1]}
			/>
			<Panel
				heading="Chapters"
				status={
					shown < CHAPTERS.length ? (
						<Writing />
					) : (
						<Done label={`${CHAPTERS.length} chapters`} />
					)
				}
			>
				<div className="p-2">
					{CHAPTERS.slice(0, shown).map(([at, title], i) => (
						<div
							key={at}
							className="ht-pop-in relative flex h-[46px] items-center gap-3 overflow-hidden rounded-[10px] px-3 transition-colors duration-300"
							style={{
								background: i === active ? "#FFF4E2" : "transparent",
							}}
						>
							<span className="w-9 text-[12px] tabular-nums text-[#B45309]">
								{fmt(at)}
							</span>
							<span className="text-[14px] text-[#1C1C1C]">{title}</span>
							{i === target && tap > 0 && tap < 1 ? (
								<span
									className="pointer-events-none absolute left-1/2 top-1/2 size-10 rounded-full bg-[rgba(245,158,11,0.3)]"
									style={{
										transform: `translate(-50%, -50%) scale(${0.5 + tap})`,
										opacity: 1 - tap,
									}}
								/>
							) : null}
						</div>
					))}
				</div>
			</Panel>
		</Surface>
	);
};

const TranscriptView = ({ t, playing }: { t: number; playing: boolean }) => {
	const seconds = Math.min(23.5, 1.5 + t / 260);
	const current = LINES.findLastIndex(([at]) => at <= seconds);
	return (
		<Surface>
			<Player
				seconds={seconds}
				playing={playing}
				title={AI_TITLE}
				caption={LINES[current]?.[1]}
			/>
			<Panel heading="Transcript" status={<Done label="Searchable" />}>
				<div className="px-2 py-2">
					{LINES.map(([at, text], i) => (
						<div
							key={at}
							className="flex items-baseline gap-2.5 rounded-[10px] px-2.5 py-2 transition-colors duration-300"
							style={{
								background: i === current ? "#FFF4E2" : "transparent",
							}}
						>
							<span className="w-8 shrink-0 text-[11px] tabular-nums text-[#B45309]">
								{fmt(at)}
							</span>
							<span
								className="text-[13.5px] leading-[1.5] transition-colors duration-300"
								style={{ color: i === current ? "#1C1C1C" : "#8F8F8F" }}
							>
								{text}
							</span>
						</div>
					))}
				</div>
			</Panel>
		</Surface>
	);
};

const scene = (
	key: string,
	icon: ReactNode,
	duration: number,
	pose: number,
	View: Scene["View"],
): Scene => {
	const copy = copyOf(AI_COPY, key);
	return {
		key,
		label: copy.label,
		icon,
		lead: copy.lead,
		body: copy.body,
		duration,
		pose,
		View,
	};
};

const SCENES: Scene[] = [
	scene("summary", <AlignLeft />, 6400, 5600, SummaryView),
	scene("chapters", <ListOrdered />, 6200, 4000, ChaptersView),
	scene("transcript", <ScrollText />, 6000, 3000, TranscriptView),
];

export const AiStage = () => <Showcase scenes={SCENES} tone={TONES.ai} />;
