"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { CapShareWindow } from "../demo/CapShareWindow";
import { LinkNotification, RecordingToolbar } from "../demo/CapSurfaces";
import { CapLogoMark } from "../demo/capIcons";
import { ContentWindow } from "../demo/MacDesktop";
import { SCENE_META } from "./catalog";
import {
	clockText,
	easeInOut,
	noop,
	Reveal,
	type SceneModule,
	type SceneProps,
	Stage,
	span,
	useCursor,
	useSceneClock,
	useSceneState,
	useVideo,
	type Way,
} from "./engine";

const CHAPTERS = SCENE_META.instant.chapters;

const POS = {
	content: { left: 24, top: 22, width: 430, height: 330 },
	toolbar: { left: 192, top: 424 },
	notification: { left: 322, top: 10 },
	share: { left: 100, top: 12, width: 480, height: 464 },
	popover: { left: 264, top: 108, width: 300 },
};

const PATH: Way[] = [
	{ t: 0, x: 250, y: 200 },
	{ t: 2200, x: 330, y: 250 },
	{ t: 3900, x: 390, y: 180 },
	{ t: 5800, at: "toolbar-stop" },
	{ t: 5900, at: "toolbar-stop", click: true },
	{ t: 6100, at: "toolbar-stop" },
	{ t: 7300, at: "notification" },
	{ t: 7400, at: "notification", click: true },
	{ t: 8800, x: 620, y: 400 },
	{ t: 10300, x: 620, y: 400 },
	{ t: 11400, at: "share-button" },
	{ t: 11600, at: "share-button" },
	{ t: 11700, at: "share-button", click: true },
	{ t: 12900, at: "share-password" },
	{ t: 13000, at: "share-password", click: true },
	{ t: 14200, at: "share-public" },
	{ t: 14300, at: "share-public", click: true },
	{ t: 15400, at: "share-copy" },
	{ t: 15500, at: "share-copy", click: true },
	{ t: 16400, at: "share-copy", dx: 40, dy: 30 },
	{ t: 17600, at: "share-copy", dx: 40, dy: 30 },
];

const RECORD_START = 200;
const RECORD_STOP = 5950;

const uiAt = (t: number) => ({
	toolbar: t >= 100 && t < RECORD_STOP,
	recording: t >= RECORD_START && t < RECORD_STOP,
	notification: t >= 6150 && t < 8200,
	share: t >= 7450,
	comment: t >= 9500,
	popover: t >= 11750,
	password: t >= 13000,
	publicLink: t < 14300,
	copied: t >= 15500,
});

const Switch = ({ on }: { on: boolean }) => (
	<span
		className="relative inline-flex h-5 w-[34px] shrink-0 rounded-full transition-colors duration-200"
		style={{ background: on ? "#0090ff" : "#e0e0e0" }}
	>
		<span
			className="absolute top-[2px] size-4 rounded-full bg-white shadow-sm transition-[left] duration-200"
			style={{ left: on ? 16 : 2 }}
		/>
	</span>
);

const SharePopover = ({
	show,
	password,
	publicLink,
	copied,
}: {
	show: boolean;
	password: boolean;
	publicLink: boolean;
	copied: boolean;
}) => (
	<Reveal
		show={show}
		from="translateY(-6px) scale(0.97)"
		className="z-40"
		style={{
			left: POS.popover.left,
			top: POS.popover.top,
			width: POS.popover.width,
			transformOrigin: "top right",
		}}
	>
		<div
			className="flex flex-col gap-2 rounded-[14px] p-3"
			style={{
				background: "#fcfcfc",
				border: "1px solid rgba(0,0,0,0.08)",
				boxShadow: "0 24px 60px -18px rgba(16,24,40,0.45)",
			}}
		>
			<div
				className="flex h-[38px] items-center gap-2 rounded-lg px-2.5"
				style={{
					background: "#e6f4fe",
					border: "1px solid rgba(0,144,255,0.2)",
				}}
			>
				<CapLogoMark className="size-4 shrink-0" />
				<span
					className="min-w-0 flex-1 truncate text-[12px]"
					style={{ color: "#0d74ce" }}
				>
					cap.link/dashboard-walkthrough
				</span>
				<span
					data-scene-anchor="share-copy"
					className={classNames(
						"flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-white transition-colors duration-200",
						copied ? "bg-[#0f7a58]" : "bg-[#0090ff]",
					)}
				>
					{copied ? "Copied" : "Copy"}
				</span>
			</div>
			<div
				className="flex h-[38px] items-center gap-2.5 rounded-lg px-2.5"
				style={{ background: "#f9f9f9", border: "1px solid #d9d9d9" }}
			>
				<span className="flex-1 text-[12px] font-medium text-[#202020]">
					Password protection
				</span>
				<span data-scene-anchor="share-password">
					<Switch on={password} />
				</span>
			</div>
			<div
				className="flex h-[38px] items-center gap-2.5 rounded-lg px-2.5"
				style={{ background: "#f9f9f9", border: "1px solid #d9d9d9" }}
			>
				<span className="min-w-0 flex-1">
					<span className="block text-[12px] font-medium text-[#202020]">
						{publicLink ? "Anyone with the link" : "Only your team"}
					</span>
				</span>
				<span data-scene-anchor="share-public">
					<Switch on={publicLink} />
				</span>
			</div>
		</div>
	</Reveal>
);

export const InstantScene = (props: SceneProps) => {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const timerRef = useRef<HTMLSpanElement | null>(null);
	const shareVideoRef = useRef<HTMLVideoElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(layerRef);
	useVideo(props.playing && ui.share, shareVideoRef);

	useSceneClock({
		...props,
		chapters: CHAPTERS,
		tick: (t, seek) => {
			setUi(uiAt(t));
			if (timerRef.current) {
				timerRef.current.textContent =
					t >= RECORD_START ? clockText(t - RECORD_START) : "0:00";
			}
			if (scrollRef.current) {
				scrollRef.current.style.transform = `translateY(${
					-110 * easeInOut(span(t, 1300, 4200))
				}px)`;
			}
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<Stage
			wallpaper="/backgrounds/nyc.webp"
			recording={ui.recording}
			layerRef={layerRef}
		>
			<div
				className="absolute"
				style={{ left: POS.content.left, top: POS.content.top }}
			>
				<ContentWindow
					width={POS.content.width}
					height={POS.content.height}
					scrollRef={scrollRef}
				/>
			</div>
			<div className="absolute z-10" style={POS.share}>
				<CapShareWindow
					visible={ui.share}
					width={POS.share.width}
					height={POS.share.height}
					commentVisible={ui.comment}
					videoRef={shareVideoRef}
				/>
			</div>
			<SharePopover
				show={ui.popover}
				password={ui.password}
				publicLink={ui.publicLink}
				copied={ui.copied}
			/>
			<div className="absolute z-20" style={POS.toolbar}>
				<RecordingToolbar
					visible={ui.toolbar}
					paused={false}
					timerRef={timerRef}
					onStop={noop}
					onTogglePause={noop}
					onRestart={noop}
					onMiss={noop}
				/>
			</div>
			<div className="absolute z-30" style={POS.notification}>
				<LinkNotification visible={ui.notification} onOpen={noop} />
			</div>
			{cursor.Cursor}
		</Stage>
	);
};

export const INSTANT: SceneModule = {
	Scene: InstantScene,
	chapters: CHAPTERS,
	poster: SCENE_META.instant.poster,
};
