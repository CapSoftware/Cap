"use client";

import { classNames } from "@cap/utils/helpers";
import type { ReactNode } from "react";
import { INVOICE, InvoicePage, PRESENTER, Webcam } from "./subjects";

export const SHARE_W = 1200;
export const SHARE_URL = "Cap.so/s/m4k8x2qz";
export const CAP_TITLE = "Sending an invoice in Ledgerly";
export const DURATION_S = 24;

export const Avatar = ({
	size = 24,
	letter,
	color,
}: {
	size?: number;
	letter?: string;
	color?: string;
}) =>
	letter ? (
		<span
			className="grid shrink-0 place-items-center rounded-full font-medium text-white"
			style={{
				width: size,
				height: size,
				background: color,
				fontSize: size * 0.45,
			}}
		>
			{letter}
		</span>
	) : (
		<span
			className="block shrink-0 rounded-full bg-cover bg-center"
			style={{
				width: size,
				height: size,
				backgroundImage: `url(${PRESENTER.avatar})`,
			}}
		/>
	);

export const stamp = (seconds: number) =>
	`00:00:${String(Math.floor(seconds)).padStart(2, "0")}`;

const clock = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export const RecordingFrame = ({
	playing,
	pageScale,
}: {
	playing: boolean;
	pageScale: number;
}) => (
	<div className="relative h-full w-full overflow-hidden bg-[#DCE6F1]">
		<div
			className="absolute left-1/2 top-1/2 overflow-hidden rounded-[8px] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.35)]"
			style={{
				width: INVOICE.w,
				height: INVOICE.h,
				transform: `translate(-50%, -50%) scale(${pageScale})`,
			}}
		>
			<InvoicePage />
		</div>
		<Webcam
			playing={playing}
			className="absolute bottom-[7%] right-[5%] aspect-square w-[14%] rounded-full shadow-[0_10px_24px_-10px_rgba(0,0,0,0.5)]"
		/>
	</div>
);

const Icon = ({ d, className }: { d: string; className?: string }) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 24 24"
		className={classNames("size-[18px]", className)}
		fill="none"
		stroke="currentColor"
		strokeWidth={1.8}
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d={d} />
	</svg>
);

const PlayerControls = ({ seconds }: { seconds: number }) => {
	const progress = seconds / DURATION_S;
	return (
		<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgba(0,0,0,0.55)] to-transparent px-4 pb-3 pt-10 text-white">
			<div className="relative h-[3px] rounded-full bg-white/30">
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-white"
					style={{ width: `${progress * 100}%` }}
				/>
				<div
					className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
					style={{ left: `${progress * 100}%` }}
				/>
			</div>
			<div className="mt-3 flex items-center gap-4 text-[13px]">
				<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px]">
					<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
					<rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
				</svg>
				<Icon d="M11 7l-5 5 5 5M18 7l-5 5 5 5" />
				<Icon d="M6 7l5 5-5 5M13 7l5 5-5 5" />
				<Icon d="M4 10v4h3l4 4V6L7 10H4zM15 9.5a3.5 3.5 0 0 1 0 5" />
				<span className="tabular-nums">
					{clock(seconds)} / {clock(DURATION_S)}
				</span>
				<span className="flex-1" />
				<Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
				<Icon d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
			</div>
		</div>
	);
};

const EMOJIS = ["😂", "😍", "😮", "🙌", "👍", "👎"];

export type ShareComment = {
	at: number;
	who: string;
	letter?: string;
	color?: string;
	when: string;
	seconds?: number;
	text: string;
};

export const CommentBubble = ({ comment }: { comment: ShareComment }) => (
	<div className="ht-pop-in flex items-start gap-2.5">
		<Avatar size={24} letter={comment.letter} color={comment.color} />
		<div className="flex-1 rounded-xl border border-[#EEEEEE] bg-[#F9F9F9] p-3">
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-[14px] font-medium text-[#1C1C1C]">
					{comment.who}
				</span>
				<span className="flex items-center gap-2 whitespace-nowrap text-[12px]">
					<span className="text-[#8F8F8F]">{comment.when}</span>
					{comment.seconds !== undefined ? (
						<span className="text-[#3B82F6]">{stamp(comment.seconds)}</span>
					) : null}
				</span>
			</div>
			<p className="mt-2 text-[14px] text-[#5D5D5D]">{comment.text}</p>
		</div>
	</div>
);

export type SidebarTab = "comments" | "summary" | "transcript";

export const ShareSidebar = ({
	tab,
	children,
	footer = true,
	className,
}: {
	tab: SidebarTab;
	children: ReactNode;
	footer?: boolean;
	className?: string;
}) => (
	<div className={classNames("flex flex-col bg-white", className)}>
		<div className="flex border-b border-[#E8E8E8]">
			{(
				[
					["comments", "Comments"],
					["summary", "Summary"],
					["transcript", "Transcript"],
				] as const
			).map(([key, label]) => (
				<div
					key={key}
					className={classNames(
						"relative flex-1 px-5 py-3 text-center text-[14px] font-medium transition-colors duration-300",
						key === tab ? "bg-[#F0F0F0] text-[#1C1C1C]" : "text-[#8F8F8F]",
					)}
				>
					{label}
					{key === tab ? (
						<span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#3B82F6]" />
					) : null}
				</div>
			))}
		</div>
		<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
		{footer ? (
			<div className="m-3 flex items-center gap-2.5 rounded-xl border border-[#E8E8E8] px-3 py-2.5 text-[14px]">
				<span className="grid size-7 place-items-center rounded-full bg-[#EEEEEE] text-[#8F8F8F]">
					<svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5">
						<circle cx="8" cy="5.5" r="3" fill="currentColor" />
						<path d="M2.5 14a5.5 5.5 0 0 1 11 0z" fill="currentColor" />
					</svg>
				</span>
				<span className="flex-1 text-[#A3A3A3]">Respond to Richie...</span>
			</div>
		) : null}
	</div>
);

export const SharePage = ({
	height,
	seconds,
	playing,
	views,
	sidebar,
	floating = [],
	pressed,
}: {
	height: number;
	seconds: number;
	playing: boolean;
	views: number;
	sidebar: ReactNode;
	floating?: { emoji: string; k: number; x: number }[];
	pressed?: string;
}) => (
	<div
		className="relative flex flex-col overflow-hidden bg-white text-[#1C1C1C]"
		style={{ width: SHARE_W, height, fontWeight: 400 }}
	>
		<div className="border-b border-[#E8E8E8] px-6 pb-4 pt-5">
			<div className="text-[24px] tracking-[-0.01em]">{CAP_TITLE}</div>
			<div className="mt-3 flex items-center gap-5">
				<div className="flex items-center gap-2.5">
					<Avatar size={32} />
					<div className="leading-tight">
						<div className="text-[14px]">Richie</div>
						<div className="text-[12.5px] text-[#8F8F8F]">
							just now · {views} views
						</div>
					</div>
				</div>
				<span className="flex h-9 items-center gap-1.5 rounded-full bg-[#3B82F6] px-4 text-[14px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
					<svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5">
						<path
							d="M9.5 2.5 14 7l-4.5 4.5V9C6 9 3.8 10 2 13c.5-4 2.8-6.6 7.5-7z"
							fill="currentColor"
						/>
					</svg>
					Share
				</span>
			</div>
		</div>
		<div className="flex min-h-0 flex-1">
			<div className="relative flex-1 bg-[#F7F7F7] px-6 pt-5">
				<div className="rounded-[18px] border border-[#E8E8E8] bg-white p-2">
					<div className="relative aspect-video overflow-hidden rounded-[12px] bg-black">
						<RecordingFrame playing={playing} pageScale={0.95} />
						<PlayerControls seconds={seconds} />
					</div>
				</div>
				<div className="mt-4 flex items-center gap-6">
					<div className="flex rounded-full border border-[#E8E8E8] bg-[#F0F0F0] p-1 text-[14px]">
						<span className="rounded-full bg-white px-3.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
							Player
						</span>
						<span className="px-3.5 py-1.5 text-[#646464]">Timeline</span>
					</div>
					<div className="relative mx-auto flex items-center gap-1 rounded-full border border-[#E8E8E8] bg-white p-1.5">
						{EMOJIS.map((emoji) => (
							<span
								key={emoji}
								className="grid size-10 place-items-center rounded-full text-[24px] transition-[background-color,transform] duration-200"
								style={{
									background: pressed === emoji ? "#DBEAFE" : "transparent",
									transform: pressed === emoji ? "scale(1.15)" : "none",
								}}
							>
								{emoji}
							</span>
						))}
						<span className="mx-2 h-6 w-px bg-[#E8E8E8]" />
						<span className="flex h-10 items-center gap-2 rounded-full bg-[#1C1C1C] pl-5 pr-2 text-[15px] text-white">
							Comment
							<span className="grid size-6 place-items-center rounded-full bg-white/20 text-[12px]">
								C
							</span>
						</span>
						{floating.map((item) => (
							<span
								key={`${item.emoji}-${item.x}`}
								className="pointer-events-none absolute text-[28px]"
								style={{
									left: item.x,
									bottom: 40 + item.k * 160,
									opacity: item.k < 0.8 ? 1 : (1 - item.k) * 5,
									transform: `scale(${0.8 + item.k * 0.5}) rotate(${(item.k - 0.5) * 20}deg)`,
								}}
							>
								{item.emoji}
							</span>
						))}
					</div>
				</div>
			</div>
			<ShareSidebar
				tab="comments"
				className="w-[360px] shrink-0 border-l border-[#E8E8E8]"
			>
				{sidebar}
			</ShareSidebar>
		</div>
	</div>
);
