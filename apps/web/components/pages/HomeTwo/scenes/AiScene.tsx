"use client";

import { classNames } from "@cap/utils/helpers";
import { Search, Sparkles } from "lucide-react";
import { type RefObject, useRef } from "react";
import { CapLogoMark, CapPlay } from "../demo/capIcons";
import { TrafficLights } from "../demo/chrome";
import { useVideoAttrs, VIDEO_POSTERS } from "../demo/media";
import { SCENE_META } from "./catalog";
import {
	restartAnimation,
	type SceneModule,
	type SceneProps,
	Stage,
	typed,
	useCursor,
	useSceneClock,
	useSceneState,
	useVideo,
	type Way,
} from "./engine";

const CHAPTERS = SCENE_META.share.chapters;

const WINDOW = { left: 30, top: 22, width: 620, height: 438 };
const VIDEO_SECONDS = 32;
const SPEED = 2.5;

const TITLE = "Dashboard walkthrough";
const QUERY = "live data";
const SUMMARY =
	"A tour of the new analytics dashboard: the live data cards, the revenue chart, and the team table, plus what ships next.";

const TRANSCRIPT = [
	{ at: 0, t: "0:00", text: "So this is the new dashboard we're shipping." },
	{ at: 4, t: "0:04", text: "Every card here pulls live data, watch this." },
	{ at: 9, t: "0:09", text: "The chart updates as orders come in." },
	{ at: 14, t: "0:14", text: "Down here is the team table, sortable now." },
	{ at: 19, t: "0:19", text: "Next week we add filters and exports." },
	{ at: 25, t: "0:25", text: "And that's really all there is to it." },
];

const CHAPTER_LIST = [
	{ at: 0, t: "0:00", label: "What we shipped" },
	{ at: 11, t: "0:11", label: "The new flow, end to end" },
	{ at: 24, t: "0:24", label: "What's next" },
];

const PATH: Way[] = [
	{ t: 0, x: 520, y: 330 },
	{ t: 1200, at: "share-search" },
	{ t: 1300, at: "share-search", click: true },
	{ t: 2800, x: 610, y: 400 },
	{ t: 7000, x: 610, y: 400 },
	{ t: 12100, at: "chapter-1" },
	{ t: 12200, at: "chapter-1", click: true },
	{ t: 13000, at: "reaction-fire" },
	{ t: 14000, at: "reaction-fire" },
	{ t: 14150, at: "reaction-fire", click: true },
	{ t: 15000, x: 560, y: 440 },
	{ t: 20500, x: 560, y: 440 },
];

const SEEK_AT = 12200;
const SEEK_TO = CHAPTER_LIST[1]?.at ?? 11;
const QUERY_START = 1400;
const TITLE_START = 7200;
const SUMMARY_START = 8300;
const CHAPTER_REVEAL = [10500, 10850, 11200];
const FIRE_AT = 14150;
const SUMMARY_TAB = 7000;
const COMMENTS_TAB = 14000;

const videoSecondsAt = (t: number) => {
	const raw = (t / 1000) * SPEED;
	const offset = t >= SEEK_AT ? SEEK_TO - (SEEK_AT / 1000) * SPEED : 0;
	return (((raw + offset) % VIDEO_SECONDS) + VIDEO_SECONDS) % VIDEO_SECONDS;
};

const uiAt = (t: number) => {
	const seconds = videoSecondsAt(t);
	const queryDone = t >= QUERY_START + (QUERY.length / 12) * 1000 + 300;
	return {
		tab:
			t < SUMMARY_TAB
				? "transcript"
				: t < COMMENTS_TAB
					? "summary"
					: "comments",
		activeLine: TRANSCRIPT.reduce(
			(acc, line, i) => (seconds >= line.at ? i : acc),
			0,
		),
		matched: t < SUMMARY_TAB && queryDone,
		chaptersShown: CHAPTER_REVEAL.filter((at) => t >= at).length,
		activeChapter: CHAPTER_LIST.reduce(
			(acc, chapter, i) => (seconds >= chapter.at ? i : acc),
			0,
		),
		fire: t >= FIRE_AT,
		comment: t >= 14500,
		reply: t >= 16000,
	};
};

const Tab = ({ label, active }: { label: string; active: boolean }) => (
	<span
		className={classNames(
			"relative flex h-9 flex-1 items-center justify-center text-[12px] font-medium transition-colors duration-200",
			active ? "text-[#111111]" : "text-[rgba(17,17,17,0.45)]",
		)}
	>
		{label}
		<span
			className={classNames(
				"absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#111111] transition-opacity duration-200",
				active ? "opacity-100" : "opacity-0",
			)}
		/>
	</span>
);

const Avatar = ({
	initial,
	gradient,
}: {
	initial: string;
	gradient: string;
}) => (
	<span
		className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
		style={{ background: gradient }}
	>
		{initial}
	</span>
);

const Comment = ({
	show,
	name,
	stamp,
	text,
	initial,
	gradient,
	indent,
}: {
	show: boolean;
	name: string;
	stamp: string;
	text: string;
	initial: string;
	gradient: string;
	indent?: boolean;
}) => (
	<div
		className={classNames(
			"flex items-start gap-2.5 transition-[opacity,transform] duration-[420ms] ease-out",
			show ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
			indent && "pl-8",
		)}
	>
		<Avatar initial={initial} gradient={gradient} />
		<div className="min-w-0 flex-1 rounded-xl bg-[#F4F6F9] px-3 py-2">
			<p className="text-[11.5px] font-medium text-[#111111]">
				{name}
				<span className="ml-1.5 font-normal text-[rgba(17,17,17,0.4)]">
					{stamp}
				</span>
			</p>
			<p className="text-[12.5px] leading-snug text-[rgba(17,17,17,0.75)]">
				{text}
			</p>
		</div>
	</div>
);

const SharePage = ({
	ui,
	videoRef,
	progressRef,
	timeRef,
	titleRef,
	queryRef,
	summaryRef,
	popRef,
}: {
	ui: ReturnType<typeof uiAt>;
	videoRef: RefObject<HTMLVideoElement | null>;
	progressRef: RefObject<HTMLSpanElement | null>;
	timeRef: RefObject<HTMLSpanElement | null>;
	titleRef: RefObject<HTMLSpanElement | null>;
	queryRef: RefObject<HTMLSpanElement | null>;
	summaryRef: RefObject<HTMLSpanElement | null>;
	popRef: RefObject<HTMLSpanElement | null>;
}) => {
	const screenVideo = useVideoAttrs(VIDEO_POSTERS.screen);
	return (
		<div
			className="flex h-full w-full flex-col overflow-hidden rounded-[10px]"
			style={{
				background: "#ffffff",
				border: "1px solid rgba(0,0,0,0.1)",
				boxShadow: "0 28px 80px rgba(0,0,0,0.28), 0 4px 18px rgba(0,0,0,0.1)",
			}}
		>
			<div
				className="flex h-10 shrink-0 items-center gap-3 border-b px-3.5"
				style={{ background: "#f6f7f9", borderColor: "rgba(0,0,0,0.07)" }}
			>
				<TrafficLights />
				<div className="flex min-w-0 flex-1 justify-center">
					<span
						className="flex h-6 w-[52%] items-center justify-center rounded-md text-[11px]"
						style={{
							background: "rgba(17,17,17,0.05)",
							color: "rgba(17,17,17,0.6)",
						}}
					>
						cap.link/dashboard-walkthrough
					</span>
				</div>
				<span className="w-12" />
			</div>

			<div className="flex min-h-0 flex-1 gap-3.5 p-4">
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-2.5 pb-3">
						<CapLogoMark className="size-7" />
						<div className="min-w-0 flex-1 leading-tight">
							<p className="truncate text-[14px] font-semibold text-[#111111]">
								<span ref={titleRef}>{TITLE}</span>
								<span
									className={classNames(
										"ml-1 inline-block h-[13px] w-[1.5px] translate-y-[2px] bg-[#111111]",
										ui.tab === "summary" ? "opacity-70" : "opacity-0",
									)}
								/>
							</p>
							<p className="text-[11.5px] text-[rgba(17,17,17,0.5)]">
								Richie · just now · 0:32
							</p>
						</div>
						<span
							className="flex h-8 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-white"
							style={{ background: "linear-gradient(180deg,#3b82f6,#2563eb)" }}
						>
							Share
						</span>
					</div>

					<div className="relative overflow-hidden rounded-xl bg-black">
						<video
							ref={videoRef}
							className="aspect-[16/9] w-full object-cover"
							src="/illustrations/homepage-animation.mp4"
							muted
							loop
							playsInline
							{...screenVideo}
						/>
						<div
							className="absolute inset-x-0 bottom-0 flex items-center gap-3 px-4 pb-2.5 pt-8 text-white"
							style={{
								background:
									"linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))",
							}}
						>
							<CapPlay className="h-3 w-auto" />
							<div className="relative h-1 flex-1 rounded-full bg-white/25">
								{ui.chaptersShown > 0
									? CHAPTER_LIST.map((chapter, i) => (
											<span
												key={chapter.t}
												className="absolute inset-y-0 w-[2px] bg-black/40"
												style={{
													left: `${(chapter.at / VIDEO_SECONDS) * 100}%`,
													opacity: i === 0 || i >= ui.chaptersShown ? 0 : 1,
												}}
											/>
										))
									: null}
								<span
									ref={progressRef}
									className="absolute inset-y-0 left-0 w-0 rounded-full bg-white"
								/>
								<span
									className={classNames(
										"absolute -top-[3px] size-[10px] -translate-x-1/2 rounded-full border-2 border-white transition-opacity duration-300",
										ui.comment ? "opacity-100" : "opacity-0",
									)}
									style={{
										left: `${(12 / VIDEO_SECONDS) * 100}%`,
										background: "linear-gradient(135deg,#7B5FD0,#B9A5F2)",
									}}
								/>
							</div>
							<span
								ref={timeRef}
								className="text-[11px] tabular-nums text-white/90"
							>
								0:00 / 0:32
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2 pt-3">
						{[
							{ emoji: "👍", count: 1, anchor: "reaction-up", lit: false },
							{
								emoji: "🔥",
								count: ui.fire ? 3 : 2,
								anchor: "reaction-fire",
								lit: ui.fire,
							},
							{ emoji: "❤️", count: 1, anchor: "reaction-heart", lit: false },
						].map((reaction) => (
							<span
								key={reaction.emoji}
								data-scene-anchor={reaction.anchor}
								className={classNames(
									"relative flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors duration-150",
									reaction.lit
										? "border-[#5eb1ef] bg-[#e6f4fe]"
										: "border-[rgba(0,0,0,0.08)]",
								)}
								style={{ color: "rgba(17,17,17,0.7)" }}
							>
								{reaction.emoji}
								<span className="text-[11px] tabular-nums text-[rgba(17,17,17,0.45)]">
									{reaction.count}
								</span>
								{reaction.anchor === "reaction-fire" ? (
									<span
										ref={popRef}
										className="pointer-events-none absolute left-1.5 top-0 text-[16px] opacity-0"
									>
										🔥
									</span>
								) : null}
							</span>
						))}
						<span className="flex-1" />
						<span className="text-[11.5px] text-[rgba(17,17,17,0.45)]">
							3 views
						</span>
					</div>
				</div>

				<div
					className="flex w-[240px] shrink-0 flex-col overflow-hidden rounded-xl border"
					style={{ borderColor: "rgba(0,0,0,0.08)" }}
				>
					<div
						className="flex shrink-0 border-b px-1"
						style={{ borderColor: "rgba(0,0,0,0.07)" }}
					>
						<Tab label="Comments" active={ui.tab === "comments"} />
						<Tab label="Summary" active={ui.tab === "summary"} />
						<Tab label="Transcript" active={ui.tab === "transcript"} />
					</div>

					<div className="relative min-h-0 flex-1">
						<div
							className={classNames(
								"absolute inset-0 flex flex-col gap-2 p-2.5 transition-opacity duration-300",
								ui.tab === "transcript" ? "opacity-100" : "opacity-0",
							)}
						>
							<div
								data-scene-anchor="share-search"
								className="flex h-8 items-center gap-2 rounded-lg border px-2.5"
								style={{ borderColor: "#e0e0e0", background: "#f9f9f9" }}
							>
								<Search className="size-3.5 shrink-0 text-[#838383]" />
								<span className="text-[11.5px] text-[#202020]">
									<span ref={queryRef} />
									<span className="text-[#838383]">
										{ui.tab === "transcript" && ui.matched
											? ""
											: "Search this recording"}
									</span>
								</span>
							</div>
							<div className="flex flex-col gap-0.5">
								{TRANSCRIPT.map((line, i) => {
									const active = i === ui.activeLine;
									const hit = ui.matched && i === 1;
									const dim = ui.matched && !hit;
									return (
										<div
											key={line.t}
											className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-[background-color,opacity] duration-300"
											style={{
												background: hit
													? "#FFF3C4"
													: active
														? "#e6f4fe"
														: "transparent",
												opacity: dim ? 0.35 : 1,
											}}
										>
											<span
												className="w-7 shrink-0 pt-px text-[10.5px] tabular-nums"
												style={{ color: active || hit ? "#0d74ce" : "#838383" }}
											>
												{line.t}
											</span>
											<p
												className="text-[12px] leading-snug"
												style={{ color: active || hit ? "#202020" : "#646464" }}
											>
												{line.text}
											</p>
										</div>
									);
								})}
							</div>
						</div>

						<div
							className={classNames(
								"absolute inset-0 flex flex-col gap-3 p-3 transition-opacity duration-300",
								ui.tab === "summary" ? "opacity-100" : "opacity-0",
							)}
						>
							<div>
								<div className="flex items-center gap-1.5">
									<p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[rgba(17,17,17,0.5)]">
										Summary
									</p>
									<span className="flex items-center gap-1 rounded-full bg-[#EFE7FD] px-1.5 py-[2px] text-[9.5px] font-medium text-[#7B5FD0]">
										<Sparkles className="size-2.5" />
										Cap AI
									</span>
								</div>
								<p className="mt-1.5 min-h-[62px] text-[12px] leading-[1.45] text-[#202020]">
									<span ref={summaryRef} />
								</p>
							</div>
							<div>
								<p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[rgba(17,17,17,0.5)]">
									Chapters
								</p>
								<div className="mt-1.5 flex flex-col gap-0.5">
									{CHAPTER_LIST.map((chapter, i) => (
										<div
											key={chapter.t}
											data-scene-anchor={`chapter-${i}`}
											className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-[opacity,transform,background-color] duration-[380ms] ease-out"
											style={{
												opacity: i < ui.chaptersShown ? 1 : 0,
												transform:
													i < ui.chaptersShown ? "none" : "translateY(6px)",
												background:
													i === ui.activeChapter && ui.chaptersShown > 0
														? "#f0f0f0"
														: "transparent",
											}}
										>
											<span
												className="text-[10.5px] tabular-nums"
												style={{
													color: i === ui.activeChapter ? "#0d74ce" : "#838383",
												}}
											>
												{chapter.t}
											</span>
											<span className="text-[12px] font-medium text-[#202020]">
												{chapter.label}
											</span>
										</div>
									))}
								</div>
							</div>
						</div>

						<div
							className={classNames(
								"absolute inset-0 flex flex-col gap-2.5 p-3 transition-opacity duration-300",
								ui.tab === "comments" ? "opacity-100" : "opacity-0",
							)}
						>
							<Comment
								show={ui.comment}
								name="Sofia"
								stamp="at 0:12"
								text="Perfect, shipping this today 🔥"
								initial="S"
								gradient="linear-gradient(135deg,#7B5FD0,#B9A5F2)"
							/>
							<Comment
								show={ui.reply}
								name="Richie"
								stamp="just now"
								text="Filters land next week, I'll record a follow up."
								initial="R"
								gradient="linear-gradient(135deg,#3D77C2,#8FC1F7)"
								indent
							/>
							<div
								className={classNames(
									"mt-auto flex h-8 items-center rounded-lg border px-2.5 text-[11.5px] text-[#838383] transition-opacity duration-300",
									ui.comment ? "opacity-100" : "opacity-0",
								)}
								style={{ borderColor: "#e0e0e0" }}
							>
								Leave a comment
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export const AiScene = (props: SceneProps) => {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const progressRef = useRef<HTMLSpanElement | null>(null);
	const timeRef = useRef<HTMLSpanElement | null>(null);
	const titleRef = useRef<HTMLSpanElement | null>(null);
	const queryRef = useRef<HTMLSpanElement | null>(null);
	const summaryRef = useRef<HTMLSpanElement | null>(null);
	const popRef = useRef<HTMLSpanElement | null>(null);
	const popAtRef = useRef(-1);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(layerRef);
	useVideo(props.playing, videoRef);

	useSceneClock({
		...props,
		chapters: CHAPTERS,
		tick: (t, seek) => {
			setUi(uiAt(t));
			const seconds = videoSecondsAt(t);
			if (progressRef.current) {
				progressRef.current.style.width = `${(seconds / VIDEO_SECONDS) * 100}%`;
			}
			if (timeRef.current) {
				timeRef.current.textContent = `0:${String(Math.floor(seconds)).padStart(
					2,
					"0",
				)} / 0:32`;
			}
			if (queryRef.current) {
				queryRef.current.textContent =
					t >= QUERY_START && t < SUMMARY_TAB
						? typed(QUERY, t, QUERY_START, 12)
						: "";
			}
			if (titleRef.current) {
				titleRef.current.textContent =
					t >= SUMMARY_TAB && t < COMMENTS_TAB
						? typed(TITLE, t, TITLE_START, 20)
						: TITLE;
			}
			if (summaryRef.current) {
				summaryRef.current.textContent =
					t >= COMMENTS_TAB ? SUMMARY : typed(SUMMARY, t, SUMMARY_START, 58);
			}
			if (seek) popAtRef.current = t - 1;
			if (popAtRef.current < FIRE_AT && t >= FIRE_AT) {
				restartAnimation(popRef.current, "ht-scene-pop 700ms ease-out");
			}
			popAtRef.current = t;
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<Stage wallpaper="/backgrounds/rome.webp" layerRef={layerRef}>
			<div className="absolute" style={WINDOW}>
				<SharePage
					ui={ui}
					videoRef={videoRef}
					progressRef={progressRef}
					timeRef={timeRef}
					titleRef={titleRef}
					queryRef={queryRef}
					summaryRef={summaryRef}
					popRef={popRef}
				/>
			</div>
			{cursor.Cursor}
		</Stage>
	);
};

export const AI: SceneModule = {
	Scene: AiScene,
	chapters: CHAPTERS,
	poster: SCENE_META.share.poster,
};
