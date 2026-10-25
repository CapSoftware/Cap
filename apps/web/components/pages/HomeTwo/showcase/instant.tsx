"use client";

import { Link2, MonitorPlay, Radio } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
	CapLogoMark,
	CapMicrophone,
	CapPauseCircle,
	CapRestart,
	CapStopCircle,
	CapTrash,
} from "../demo/capIcons";
import { OS_FONT, useIsWindowsDemo } from "../demo/platform";
import { copyOf, INSTANT_COPY } from "./copy";
import { CANVAS, lerp, type Scene, Showcase, seg, TONES } from "./kit";
import {
	CAP_TITLE,
	CommentBubble,
	RecordingFrame,
	SHARE_URL,
	SHARE_W,
	type ShareComment,
	SharePage,
} from "./share";
import {
	AppBar,
	BrowserBar,
	Cursor,
	INVOICE,
	InvoicePage,
	Ripple,
	WALLPAPERS,
	Webcam,
} from "./subjects";

const SCREEN = { w: 800, h: 478 } as const;
const SCREEN_LEFT = (CANVAS.w - SCREEN.w) / 2;
const SCREEN_TOP = 26;

const TASKBAR = 40;

const useFloor = () => (useIsWindowsDemo() ? TASKBAR : 0);

const Taskbar = () => (
	<div
		className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1.5 border-t border-white/60 bg-[rgba(243,243,243,0.9)] backdrop-blur-xl"
		style={{ height: TASKBAR }}
	>
		<span className="grid size-8 place-items-center rounded-md">
			<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[17px]">
				<path
					d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623"
					fill="#0078D4"
				/>
			</svg>
		</span>
		<span className="grid size-8 place-items-center rounded-md">
			<span className="size-[17px] rounded-full bg-[conic-gradient(#0EA5E9,#22C55E,#0EA5E9)]" />
		</span>
		<span className="relative grid size-8 place-items-center rounded-md bg-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
			<CapLogoMark className="size-[18px]" />
			<span className="absolute bottom-[3px] h-[3px] w-3 rounded-full bg-[#0078D4]" />
		</span>
	</div>
);

// New York for this section only: the hero has San Francisco and the
// painted sky, so the two never read as the same scene.
const Desktop = ({ children }: { children: ReactNode }) => {
	const windows = useIsWindowsDemo();
	return (
		<div
			className="absolute overflow-hidden rounded-[16px] shadow-[0_0_0_1px_rgba(17,17,17,0.06)]"
			style={{
				left: SCREEN_LEFT,
				top: SCREEN_TOP,
				width: SCREEN.w,
				height: SCREEN.h,
				backgroundImage: `url(${WALLPAPERS.nyc})`,
				backgroundSize: "cover",
				backgroundPosition: "center",
			}}
		>
			{children}
			{windows ? <Taskbar /> : null}
		</div>
	);
};

const PAGE_SCALE = 1.0;
const PAGE_LEFT = (SCREEN.w - INVOICE.w * PAGE_SCALE) / 2;
const PAGE_TOP = 24;

const PageWindow = ({ style }: { style?: CSSProperties }) => (
	<div
		className="absolute overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_20px_50px_-20px_rgba(17,24,39,0.35)]"
		style={{
			left: PAGE_LEFT,
			top: PAGE_TOP,
			width: INVOICE.w,
			height: INVOICE.h,
			...style,
		}}
	>
		<InvoicePage />
	</div>
);

const formatTime = (ms: number) => {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const Toolbar = ({
	elapsed,
	style,
}: {
	elapsed: number;
	style?: CSSProperties;
}) => (
	<div
		className="absolute flex h-11 items-center gap-1 rounded-2xl border border-[#E0E0E0] bg-[#FCFCFC] px-1.5 text-[15px] shadow-[0_8px_24px_-10px_rgba(0,0,0,0.3)]"
		style={style}
	>
		<span className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[#FF4766]">
			<CapStopCircle className="size-5" />
			<span className="tabular-nums">{formatTime(elapsed)}</span>
		</span>
		<span className="mx-1 flex items-center gap-1 text-[#646464]">
			<CapMicrophone className="size-5 text-[#202020]" />
			<CapPauseCircle className="ml-2 size-5" />
			<CapRestart className="ml-2 size-5" />
			<CapTrash className="ml-2 size-5" />
		</span>
	</div>
);

const formatClock = (ms: number) => {
	const sec = Math.floor(ms / 1000);
	return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const CHUNK_MS = 2000;
const CHUNKS = 10;
const CHUNK_SLOTS = Array.from({ length: CHUNKS }, (_, i) => ({
	id: `chunk-${i}`,
	index: i,
}));

const LiveLink = ({
	elapsed,
	playing,
}: {
	elapsed: number;
	playing: boolean;
}) => {
	const landed = Math.floor(elapsed / CHUNK_MS);
	return (
		<div className="absolute right-[18px] top-[26px] w-[214px] overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_20px_44px_-18px_rgba(17,24,39,0.45)]">
			<div className="flex items-center gap-1.5 px-3 pb-2 pt-2.5 text-[11.5px] text-[#4B5059]">
				<CapLogoMark className="size-3.5" />
				<span className="truncate">{SHARE_URL}</span>
				<span className="ml-auto flex items-center gap-1 rounded-full bg-[#FEE2E2] px-1.5 py-[1px] text-[10px] font-semibold text-[#DC2626]">
					<span className="size-1.5 animate-pulse rounded-full bg-[#DC2626]" />
					Live
				</span>
			</div>
			<div className="relative mx-2 h-[112px] overflow-hidden rounded-[9px]">
				<RecordingFrame playing={playing} pageScale={0.27} />
				<span className="absolute bottom-1.5 right-1.5 rounded-[5px] bg-black/70 px-1.5 py-0.5 text-[10.5px] tabular-nums text-white">
					{formatClock(landed * CHUNK_MS)}
				</span>
			</div>
			<div className="flex gap-[3px] px-3 pt-2.5">
				{CHUNK_SLOTS.map(({ id, index }) => {
					const done = index < landed;
					const sending = index === landed;
					return (
						<span
							key={id}
							className="h-1.5 flex-1 rounded-full transition-colors duration-300"
							style={{
								background: done ? "#3B82F6" : sending ? "#BFDBFE" : "#EEF1F5",
							}}
						/>
					);
				})}
			</div>
			<div className="px-3 pb-2.5 pt-1.5 text-[11px] text-[#6B7079]">
				<span className="tabular-nums text-[#1C1D21]">
					{formatClock(landed * CHUNK_MS)}
				</span>{" "}
				already on Cap.so
			</div>
		</div>
	);
};

const RECORD_SCALE = 0.78;

const RecordView = ({ t, playing }: { t: number; playing: boolean }) => {
	const elapsed = 8000 + t;
	const cursor = {
		x: lerp(lerp(200, 400, seg(t, 300, 1800)), 330, seg(t, 2600, 4200)),
		y: lerp(lerp(170, 210, seg(t, 300, 1800)), 270, seg(t, 2600, 4200)),
	};
	const floor = useFloor();
	return (
		<Desktop>
			<div
				className="absolute overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_20px_50px_-20px_rgba(17,24,39,0.35)]"
				style={{
					left: 22,
					top: 26,
					width: INVOICE.w * RECORD_SCALE,
					height: INVOICE.h * RECORD_SCALE,
				}}
			>
				<div
					style={{
						width: INVOICE.w,
						height: INVOICE.h,
						transform: `scale(${RECORD_SCALE})`,
						transformOrigin: "top left",
					}}
				>
					<InvoicePage />
				</div>
			</div>
			<LiveLink elapsed={elapsed} playing={playing} />
			<Webcam
				playing={playing}
				className="absolute shadow-[0_16px_40px_-14px_rgba(0,0,0,0.45)]"
				style={{
					left: 28,
					bottom: 28 + floor,
					width: 112,
					height: 112,
					borderRadius: 56,
				}}
			/>
			<Toolbar
				elapsed={elapsed}
				style={{ left: SCREEN.w / 2 - 110, bottom: 22 + floor }}
			/>
			<Cursor x={cursor.x} y={cursor.y} size={24} />
		</Desktop>
	);
};

const Notification = ({ k }: { k: number }) => {
	const windows = useIsWindowsDemo();
	if (windows) {
		return (
			<div
				className="absolute z-30 flex w-[330px] flex-col gap-1 rounded-[8px] border border-black/[0.07] bg-[#F3F3F3] p-3.5 shadow-[0_16px_40px_rgba(0,0,0,0.25)]"
				style={{
					right: 12,
					bottom: TASKBAR + 12,
					fontFamily: OS_FONT.windows,
					opacity: k,
					transform: `translateY(${(1 - k) * 24}px)`,
				}}
			>
				<span className="flex items-center gap-2 text-[12px] text-[#5C5C5C]">
					<CapLogoMark className="size-4" /> Cap
					<span className="flex-1" />
					now
				</span>
				<span className="text-[14px] font-semibold text-[#1B1B1B]">
					Link copied
				</span>
				<span className="truncate text-[13px] text-[#404040]">
					{SHARE_URL} is on your clipboard
				</span>
			</div>
		);
	}
	return (
		<MacNotification
			style={{
				right: 18,
				top: 18,
				opacity: k,
				transform: `translateX(${(1 - k) * 24}px)`,
			}}
		/>
	);
};

const MacNotification = ({ style }: { style?: CSSProperties }) => (
	<div
		className="absolute z-30 flex w-[330px] items-center gap-3 rounded-2xl bg-[rgba(246,246,248,0.96)] p-3 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.35),0_0_0_1px_rgba(0,0,0,0.06)]"
		style={style}
	>
		<span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
			<CapLogoMark className="size-6" />
		</span>
		<span className="min-w-0 flex-1">
			<span className="flex justify-between text-[13px] font-semibold text-[#1C1D21]">
				Link copied
				<span className="font-normal text-[#8A8F98]">now</span>
			</span>
			<span className="block truncate text-[12.5px] text-[#4B5059]">
				{SHARE_URL} is on your clipboard
			</span>
		</span>
	</div>
);

const ChatWindow = ({
	typed,
	sent,
	reply,
	playing,
}: {
	typed: string;
	sent: boolean;
	reply: number;
	playing: boolean;
}) => {
	const floor = useFloor();
	return (
		<div
			style={{ bottom: floor }}
			className="absolute inset-x-[90px] top-[34px] flex flex-col overflow-hidden rounded-t-[12px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_20px_50px_-20px_rgba(17,24,39,0.35)]"
		>
			<AppBar className="h-10 border-b border-[#ECEDF0] text-[13.5px] text-[#1C1D21]">
				<span className="font-semibold"># billing</span>
				<span className="text-[#8A8F98]">4 members</span>
			</AppBar>
			<div className="flex flex-1 flex-col justify-end gap-4 px-5 pb-4">
				<div className="flex gap-3 text-[13.5px]">
					<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#FDE68A] text-[12px]">
						M
					</span>
					<span>
						<span className="font-semibold">Mia</span>{" "}
						<span className="text-[11.5px] text-[#8A8F98]">10:41</span>
						<span className="block text-[#33363D]">
							How do I send the Northwind invoice from the new flow?
						</span>
					</span>
				</div>
				{sent ? (
					<div className="ht-fade-in flex gap-3 text-[13.5px]">
						<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#C7D2FE] text-[12px]">
							R
						</span>
						<span className="min-w-0 flex-1">
							<span className="font-semibold">Richie</span>{" "}
							<span className="text-[11.5px] text-[#8A8F98]">10:42</span>
							<span className="block text-[#2563EB]">{SHARE_URL}</span>
							<span className="mt-2 flex w-[360px] overflow-hidden rounded-[10px] border border-[#ECEDF0]">
								<span className="block h-[86px] w-[138px] shrink-0">
									<RecordingFrame playing={playing} pageScale={0.17} />
								</span>
								<span className="flex flex-col justify-center gap-1 px-3">
									<span className="flex items-center gap-1.5 text-[11.5px] text-[#6B7079]">
										<CapLogoMark className="size-3.5" /> Cap
									</span>
									<span className="text-[13px] font-semibold leading-tight text-[#1C1D21]">
										{CAP_TITLE}
									</span>
									<span className="text-[11.5px] text-[#6B7079]">
										0:24 · Watch in the browser
									</span>
								</span>
							</span>
						</span>
					</div>
				) : null}
				{reply > 0 ? (
					<div className="ht-fade-in flex gap-3 text-[13.5px]">
						<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#FDE68A] text-[12px]">
							M
						</span>
						<span>
							<span className="font-semibold">Mia</span>{" "}
							<span className="text-[11.5px] text-[#8A8F98]">10:42</span>
							<span className="block text-[#33363D]">
								Perfect, that's so much easier than a doc.
							</span>
						</span>
					</div>
				) : null}
			</div>
			<div className="mx-4 mb-4 flex h-11 items-center rounded-[10px] border border-[#DADDE2] px-3.5 text-[13.5px] text-[#1C1D21]">
				{typed ? (
					<span className="text-[#2563EB]">{typed}</span>
				) : (
					<span className="text-[#9AA0A8]">Message #billing</span>
				)}
				{typed && !sent ? (
					<span className="ml-px h-4 w-px animate-pulse bg-[#1C1D21]" />
				) : null}
			</div>
		</div>
	);
};

const ShareView = ({ t, playing }: { t: number; playing: boolean }) => {
	const toolbarX = SCREEN.w / 2 - 110;
	const floor = useFloor();
	const stop = { x: toolbarX + 26, y: SCREEN.h - 22 - 22 - floor };
	const toChat = seg(t, 2300, 2800);
	const cursor =
		t < 1300
			? {
					x: lerp(420, stop.x, seg(t, 200, 1100)),
					y: lerp(260, stop.y, seg(t, 200, 1100)),
				}
			: { x: lerp(stop.x, 420, toChat), y: lerp(stop.y, 455, toChat) };
	const stopped = t > 1250;
	const note = seg(t, 1400, 1800) * (1 - seg(t, 4600, 5000));
	const pasted = t > 3200 ? SHARE_URL : "";
	const sent = t > 3900;
	return (
		<Desktop>
			<div style={{ opacity: 1 - toChat }}>
				<PageWindow />
				<Toolbar
					elapsed={24000}
					style={{
						left: toolbarX,
						bottom: 22 + floor,
						opacity: stopped ? 0 : 1,
						transform: stopped ? "translateY(8px)" : "none",
						transition: "opacity 250ms, transform 250ms",
					}}
				/>
			</div>
			{toChat > 0 ? (
				<div style={{ opacity: toChat }}>
					<ChatWindow
						typed={sent ? "" : pasted}
						sent={sent}
						reply={t > 5200 ? 1 : 0}
						playing={playing}
					/>
				</div>
			) : null}
			<Ripple
				x={stop.x}
				y={stop.y}
				k={(t - 1150) / 450}
				color="rgba(255,71,102,0.35)"
			/>
			<Notification k={note} />
			<Cursor x={cursor.x} y={cursor.y} size={24} />
		</Desktop>
	);
};

const COMMENTS: ShareComment[] = [
	{
		at: 1400,
		who: "Mia",
		letter: "M",
		color: "#F59E0B",
		when: "just now",
		seconds: 8,
		text: "Didn't know you could send it from here, nice.",
	},
	{
		at: 3300,
		who: "Sam",
		letter: "S",
		color: "#10B981",
		when: "just now",
		seconds: 19,
		text: "Can we make this the default flow?",
	},
];

const REACTIONS = [
	{ emoji: "🙌", at: 4400, x: 150 },
	{ emoji: "😍", at: 4800, x: 60 },
	{ emoji: "👍", at: 5200, x: 200 },
];

const WINDOW = { left: 40, top: 22, w: 720, h: 456 } as const;

const WatchView = ({ t, playing }: { t: number; playing: boolean }) => {
	const scale = WINDOW.w / SHARE_W;
	const pressed = REACTIONS.find((r) => t > r.at && t < r.at + 260)?.emoji;
	const height = WINDOW.h - useFloor();
	return (
		<Desktop>
			<div
				className="absolute overflow-hidden rounded-t-[12px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_24px_60px_-24px_rgba(17,24,39,0.45)]"
				style={{
					left: WINDOW.left,
					top: WINDOW.top,
					width: WINDOW.w,
					height,
				}}
			>
				<BrowserBar url={SHARE_URL} small className="h-8" />
				<div
					style={{
						width: SHARE_W,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
				>
					<SharePage
						height={(height - 32) / scale}
						seconds={Math.min(23, 4 + t / 380)}
						playing={playing}
						views={Math.min(12, 3 + Math.floor(t / 500))}
						pressed={pressed}
						floating={REACTIONS.filter((r) => t > r.at && t < r.at + 1400).map(
							(r) => ({ ...r, k: (t - r.at) / 1400 }),
						)}
						sidebar={
							<div className="flex flex-col gap-4 p-4">
								{COMMENTS.filter((c) => t > c.at).map((c) => (
									<CommentBubble key={c.who} comment={c} />
								))}
							</div>
						}
					/>
				</div>
			</div>
		</Desktop>
	);
};

const SCENES: Scene[] = [
	{
		key: "record",
		label: copyOf(INSTANT_COPY, "record").label,
		icon: <Radio />,
		lead: copyOf(INSTANT_COPY, "record").lead,
		body: copyOf(INSTANT_COPY, "record").body,
		duration: 5200,
		pose: 2600,
		View: RecordView,
	},
	{
		key: "share",
		label: copyOf(INSTANT_COPY, "share").label,
		icon: <Link2 />,
		lead: copyOf(INSTANT_COPY, "share").lead,
		body: copyOf(INSTANT_COPY, "share").body,
		duration: 7000,
		pose: 4800,
		View: ShareView,
	},
	{
		key: "watch",
		label: copyOf(INSTANT_COPY, "watch").label,
		icon: <MonitorPlay />,
		lead: copyOf(INSTANT_COPY, "watch").lead,
		body: copyOf(INSTANT_COPY, "watch").body,
		duration: 7000,
		pose: 5000,
		View: WatchView,
	},
];

export const InstantStage = () => (
	<Showcase scenes={SCENES} tone={TONES.instant} />
);
