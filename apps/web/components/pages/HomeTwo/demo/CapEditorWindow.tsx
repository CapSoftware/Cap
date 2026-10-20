"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import type { RefObject } from "react";
import {
	CapAudioOn,
	CapCamera,
	CapClapperboard,
	CapCrop,
	CapCursor,
	CapImage,
	CapLayoutIcon,
	CapMessageBubble,
	CapNext,
	CapPause,
	CapPlay,
	CapPresets,
	CapPrev,
	CapRedo,
	CapScissors,
	CapTrash,
	CapUndo,
	CapUpload,
	LucideAppWindowMac,
	LucideBuilding2,
	LucideChevronDown,
	LucideClock,
	LucideFolder,
	LucideKeyboard,
	LucidePlus,
	LucideSearch,
	LucideZoomIn,
	LucideZoomOut,
} from "./capIcons";
import { TrafficLights, WindowsCaptionControls } from "./chrome";
import { useVideoAttrs, VIDEO_POSTERS } from "./media";
import { useIsWindowsDemo } from "./platform";

const C = {
	gray1: "#fcfcfc",
	gray2: "#f9f9f9",
	gray3: "#f0f0f0",
	gray4: "#e8e8e8",
	gray5: "#e0e0e0",
	gray6: "#d9d9d9",
	gray9: "#8d8d8d",
	gray10: "#838383",
	gray11: "#646464",
	gray12: "#202020",
	blue9: "#0090ff",
	trackClip: "#3f8ae0",
	trackZoom: "#4a4f5c",
};

const WALLPAPERS = [
	"sf",
	"nyc",
	"miami",
	"monaco",
	"london",
	"rome",
	"santorini",
].map((city) => ({
	id: city,
	thumb: `/backgrounds/thumbs/${city}.webp`,
	full: `/backgrounds/${city}.webp`,
}));

const WALLPAPER_THEMES = [
	"macOS",
	"Dark",
	"Blue",
	"Cities",
	"Purple",
	"Orange",
];

const EditorButton = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => (
	<span
		className={classNames(
			"flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[0.875rem]",
			className,
		)}
		style={{ color: C.gray12 }}
	>
		{children}
	</span>
);

const Field = ({
	icon,
	label,
	children,
}: {
	icon: React.ReactNode;
	label: string;
	children?: React.ReactNode;
}) => (
	<div className="flex flex-col gap-4">
		<div className="flex items-center gap-2">
			<span className="size-4" style={{ color: C.gray12 }}>
				{icon}
			</span>
			<span className="text-sm font-medium" style={{ color: C.gray12 }}>
				{label}
			</span>
		</div>
		{children}
	</div>
);

const SliderRow = ({ fill, anchor }: { fill: number; anchor?: string }) => (
	<div className="relative flex h-4 items-center">
		<div
			className="h-[0.3rem] w-full overflow-hidden rounded-full"
			style={{ background: C.gray4 }}
		>
			<div
				className="h-full rounded-full transition-[width] duration-200 ease-out"
				style={{ width: `${fill * 100}%`, background: C.blue9 }}
			/>
		</div>
		<span
			data-scene-anchor={anchor}
			className="absolute size-4 rounded-full border shadow-md transition-[left] duration-200 ease-out"
			style={{
				left: `calc(${fill * 100}% - 8px)`,
				background: C.gray1,
				borderColor: C.gray6,
			}}
		/>
	</div>
);

const Tab = ({
	icon,
	selected,
	disabled,
}: {
	icon: React.ReactNode;
	selected?: boolean;
	disabled?: boolean;
}) => (
	<span
		className={classNames(
			"relative flex flex-1 items-center justify-center",
			disabled && "opacity-50",
		)}
	>
		{selected ? (
			<span
				className="absolute size-9 rounded-lg"
				style={{ background: C.gray3 }}
			/>
		) : null}
		<span
			className="relative size-5"
			style={{ color: selected ? C.gray12 : C.gray11 }}
		>
			{icon}
		</span>
	</span>
);

const WAVE_HEIGHTS = Array.from({ length: 90 }, (_, i) => {
	const a = Math.sin(i * 0.55) * 0.5 + 0.5;
	const b = Math.sin(i * 1.7 + 2) * 0.5 + 0.5;
	return 0.15 + 0.75 * (0.4 * a + 0.6 * b);
});

export type EditorUi = {
	visible: boolean;
	bgIndex: number;
	playing: boolean;
	padding?: number;
	radius?: number;
	zoomSegments?: boolean;
};

export const CapEditorWindow = ({
	ui,
	width,
	height,
	videoRef,
	camVideoRef,
	playheadRef,
	timeRef,
	canvasRef,
	canvasChildren,
	onSwatch,
	onExport,
	onTogglePlay,
}: {
	ui: EditorUi;
	width: number;
	height: number;
	videoRef: RefObject<HTMLVideoElement | null>;
	camVideoRef: RefObject<HTMLVideoElement | null>;
	playheadRef: RefObject<HTMLDivElement | null>;
	timeRef: RefObject<HTMLSpanElement | null>;
	canvasRef?: RefObject<HTMLDivElement | null>;
	canvasChildren?: React.ReactNode;
	onSwatch: (index: number) => void;
	onExport: () => void;
	onTogglePlay: () => void;
}) => {
	const isWindows = useIsWindowsDemo();
	const screenVideo = useVideoAttrs(VIDEO_POSTERS.screen, ui.visible);
	const cameraVideo = useVideoAttrs(VIDEO_POSTERS.webcam, ui.visible);
	const scale = width / 1275;
	const wallpaper = WALLPAPERS[ui.bgIndex] ?? WALLPAPERS[0];
	const padding = ui.padding ?? 0.35;
	const radius = ui.radius ?? 0.5;

	return (
		<div
			inert={!ui.visible}
			className={classNames(
				"absolute transition-[opacity,transform] duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
				ui.visible
					? "opacity-100 [transform:scale(1)]"
					: "pointer-events-none opacity-0 [transform:scale(0.96)_translateY(14px)]",
			)}
			style={{ width, height, fontWeight: 500 }}
		>
			<div
				className="overflow-hidden rounded-[10px]"
				style={{
					width: 1275,
					height: 800,
					transform: `scale(${scale})`,
					transformOrigin: "top left",
					background: C.gray2,
					border: "1px solid rgba(0,0,0,0.1)",
					boxShadow: "0 28px 80px rgba(0,0,0,0.3), 0 4px 18px rgba(0,0,0,0.12)",
				}}
			>
				<div className="flex h-full w-full flex-col">
					<div className="flex h-14 shrink-0 items-center">
						<div className="flex items-center gap-2 px-4">
							{isWindows ? null : <TrafficLights className="mr-3" />}
							<EditorButton>
								<CapTrash className="size-5" />
							</EditorButton>
							<EditorButton>
								<LucideFolder className="size-5" />
							</EditorButton>
							<span className="text-sm" style={{ color: C.gray12 }}>
								Dashboard walkthrough
								<span style={{ color: C.gray11 }}>.cap</span>
							</span>
						</div>

						<div
							className="flex h-full items-center gap-2 border-x px-4"
							style={{ borderColor: "rgba(18,22,31,0.1)" }}
						>
							<EditorButton>
								<CapPresets className="size-5" />
								<span>Presets</span>
								<LucideChevronDown
									className="size-3.5"
									style={{ color: C.gray11 }}
								/>
							</EditorButton>
							<EditorButton>
								<LucideBuilding2 className="size-4" />
								<span>Cap</span>
								<LucideChevronDown
									className="size-3.5"
									style={{ color: C.gray11 }}
								/>
							</EditorButton>
						</div>

						<div className="flex flex-1 items-center gap-2 pl-2 pr-2">
							<EditorButton>
								<CapUndo className="size-5" />
							</EditorButton>
							<EditorButton className="opacity-50">
								<CapRedo className="size-5" />
							</EditorButton>
							<div className="flex-1" />
							<span
								className="flex h-[40px] items-center gap-2 rounded-xl border px-4 text-[0.875rem]"
								style={{
									background: C.gray5,
									borderColor: C.gray6,
									color: C.gray12,
									boxShadow: "0 1.5px 0 0 rgba(255,255,255,0.4) inset",
								}}
							>
								<CapClapperboard className="size-4" />
								<span>Clips</span>
							</span>
							<button
								type="button"
								data-demo-anchor="editor-export"
								aria-label="Export the recording"
								onClick={onExport}
								className="flex h-[40px] cursor-pointer items-center gap-2 rounded-xl px-4 text-[0.8125rem] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.08]"
								style={{
									background: "linear-gradient(to bottom, #3b82f6, #2563eb)",
									boxShadow:
										"0 4px 14px -6px rgba(37,99,235,0.5), inset 0 1px 0 0 rgba(255,255,255,0.22)",
								}}
							>
								<CapUpload className="size-5" />
								<span>Export</span>
							</button>
							{isWindows ? (
								<WindowsCaptionControls className="-mr-2 h-14 self-stretch" />
							) : null}
						</div>
					</div>

					<div className="flex min-h-0 flex-1 px-2">
						<div
							className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
							style={{ borderColor: C.gray3, background: C.gray1 }}
						>
							<div className="flex items-center justify-between p-3">
								<div className="flex items-center gap-3">
									<EditorButton className="w-28">
										<CapLayoutIcon className="size-5" />
										<span className="flex-1 text-left">Auto</span>
										<LucideChevronDown
											className="size-3.5"
											style={{ color: C.gray11 }}
										/>
									</EditorButton>
									<EditorButton>
										<CapCrop className="size-5" />
										<span>Crop</span>
									</EditorButton>
									<EditorButton>
										<LucideAppWindowMac className="size-5" />
										<span>Frame</span>
										<LucideChevronDown
											className="size-3.5"
											style={{ color: C.gray11 }}
										/>
									</EditorButton>
								</div>
								<div className="flex items-center gap-2">
									<span
										className="text-xs font-medium"
										style={{ color: C.gray11 }}
									>
										Preview quality
									</span>
									<span
										className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm"
										style={{
											borderColor: C.gray3,
											background: C.gray2,
											color: C.gray12,
										}}
									>
										Full
										<LucideChevronDown
											className="size-4"
											style={{ color: C.gray11 }}
										/>
									</span>
								</div>
							</div>

							<div className="relative min-h-0 flex-1 px-4 pb-2">
								<div
									className="relative mx-auto h-full overflow-hidden"
									style={{
										aspectRatio: "16 / 9",
										maxWidth: "100%",
										backgroundImage: `url(${wallpaper?.full})`,
										backgroundSize: "cover",
										backgroundPosition: "center",
									}}
								>
									<div
										ref={canvasRef}
										className="absolute inset-0 will-change-transform"
									>
										<div
											className="absolute inset-0 flex items-center justify-center transition-[padding] duration-200 ease-out"
											style={{ padding: `${1.5 + padding * 9}%` }}
										>
											<video
												ref={videoRef}
												className="h-full w-full object-cover transition-[border-radius] duration-200 ease-out"
												style={{
													borderRadius: 2 + radius * 16,
													boxShadow: "0 18px 45px rgba(0,0,0,0.35)",
												}}
												src="/illustrations/homepage-animation.mp4"
												muted
												loop
												playsInline
												{...screenVideo}
											/>
										</div>
										<div
											className="absolute overflow-hidden rounded-full"
											style={{
												left: "3.5%",
												bottom: "6%",
												width: "13%",
												aspectRatio: "1",
												boxShadow: "0 10px 26px rgba(0,0,0,0.4)",
											}}
										>
											<video
												ref={camVideoRef}
												className="h-full w-full object-cover"
												src="/videos/home-two/webcam.mp4"
												muted
												loop
												playsInline
												{...cameraVideo}
											/>
										</div>
										{canvasChildren}
									</div>
								</div>
							</div>

							<div className="relative flex items-center p-5">
								<div className="flex flex-1 items-center">
									<span
										className="text-sm tabular-nums"
										style={{ color: C.gray12 }}
									>
										<span ref={timeRef}>0:00.00</span>
										<span style={{ color: C.gray11 }}> / 0:32.00</span>
									</span>
								</div>
								<div
									className="flex items-center gap-8"
									style={{ color: C.gray11 }}
								>
									<CapPrev className="h-3 w-auto" style={{ color: C.gray12 }} />
									<button
										type="button"
										aria-label={ui.playing ? "Pause preview" : "Play preview"}
										onClick={onTogglePlay}
										className="flex size-9 cursor-pointer items-center justify-center rounded-full border transition-colors duration-150 hover:bg-[#e8e8e8]"
										style={{
											borderColor: "#c7ccda",
											background: C.gray3,
											color: C.gray12,
										}}
									>
										{ui.playing ? (
											<CapPause className="h-3 w-auto" />
										) : (
											<CapPlay className="ml-0.5 h-3 w-auto" />
										)}
									</button>
									<CapNext className="h-3 w-auto" style={{ color: C.gray12 }} />
								</div>
								<div className="flex flex-1 items-center justify-end gap-4">
									<CapScissors className="size-5" style={{ color: C.gray12 }} />
									<span
										className="h-8 w-px rounded-full"
										style={{ background: C.gray4 }}
									/>
									<LucideZoomOut
										className="size-5"
										style={{ color: C.gray12 }}
									/>
									<div className="relative flex w-24 items-center">
										<div
											className="h-[0.3rem] w-full overflow-hidden rounded-full"
											style={{ background: C.gray4 }}
										>
											<div
												className="h-full rounded-full"
												style={{ width: "38%", background: C.blue9 }}
											/>
										</div>
										<span
											className="absolute size-4 rounded-full border shadow-md"
											style={{
												left: "calc(38% - 8px)",
												background: C.gray1,
												borderColor: C.gray6,
											}}
										/>
									</div>
									<LucideZoomIn
										className="size-5"
										style={{ color: C.gray12 }}
									/>
								</div>
							</div>

							<div
								className="flex h-4 flex-col items-center justify-center gap-0.5 border-t"
								style={{
									borderColor: C.gray4,
									background: "rgba(249,249,249,0.95)",
								}}
							>
								<span
									className="h-0.5 w-20 rounded-full"
									style={{ background: C.gray6 }}
								/>
								<span
									className="h-0.5 w-20 rounded-full"
									style={{ background: C.gray6 }}
								/>
							</div>
						</div>

						<div
							className="ml-2 flex w-[416px] shrink-0 flex-col overflow-hidden rounded-xl border"
							style={{ borderColor: C.gray3, background: C.gray1 }}
						>
							<div
								className="flex h-16 shrink-0 items-center border-b"
								style={{ borderColor: C.gray3 }}
							>
								<Tab icon={<CapImage className="size-5" />} selected />
								<Tab icon={<CapCamera className="size-5" />} />
								<Tab icon={<CapAudioOn className="size-5" />} />
								<Tab icon={<CapCursor className="size-5" />} />
								<Tab icon={<LucideKeyboard className="size-5" />} />
								<Tab icon={<CapMessageBubble className="size-5" />} />
							</div>

							<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden p-4 text-sm">
								<Field
									icon={<CapImage className="size-4" />}
									label="Background Image"
								>
									<div className="flex flex-col gap-2">
										<div className="flex flex-row items-center gap-2">
											{["Desktop", "Wallpaper", "Image"].map((label) => (
												<SourceTile
													key={label}
													label={label}
													selected={label === "Wallpaper"}
												/>
											))}
										</div>
										<div className="flex flex-row items-center gap-2">
											{["Color", "Gradient", "None"].map((label) => (
												<SourceTile key={label} label={label} />
											))}
										</div>
									</div>
									<div
										className="w-full border-t border-dashed"
										style={{ borderColor: C.gray5 }}
									/>
									<div>
										<div className="mb-3 flex flex-row items-center gap-2 overflow-hidden text-xs">
											{WALLPAPER_THEMES.map((label) => (
												<span
													key={label}
													className="flex flex-1 items-center justify-center whitespace-nowrap rounded-lg border px-4 py-2"
													style={
														label === "Cities"
															? {
																	background: C.gray3,
																	borderColor: C.gray3,
																	color: C.gray12,
																}
															: { borderColor: C.gray5, color: C.gray11 }
													}
												>
													{label}
												</span>
											))}
										</div>
										<div
											data-demo-anchor="editor-swatches"
											className="grid grid-cols-7 gap-2"
										>
											{WALLPAPERS.map((item, i) => (
												<button
													key={item.id}
													type="button"
													aria-label={`Wallpaper ${item.id}`}
													data-demo-anchor={
														i === 1 ? "editor-swatch" : undefined
													}
													data-scene-anchor={`swatch-${i}`}
													onClick={() => onSwatch(i)}
													className="aspect-square cursor-pointer overflow-hidden rounded-lg transition-[box-shadow,transform] duration-150 hover:scale-[1.06]"
													style={{
														boxShadow:
															ui.bgIndex === i
																? "0 0 0 2px #e5e7eb, 0 0 0 4px #6b7280"
																: undefined,
													}}
												>
													<Image
														src={item.thumb}
														alt=""
														width={48}
														height={48}
														draggable={false}
														className="h-full w-full object-cover"
													/>
												</button>
											))}
										</div>
									</div>
								</Field>
								<div
									className="w-full border-t border-dashed"
									style={{ borderColor: "#d1d5db" }}
								/>

								<Field
									icon={<CapLayoutIcon className="size-4" />}
									label="Padding"
								>
									<SliderRow fill={padding} anchor="editor-padding" />
								</Field>
								<Field
									icon={<CapCrop className="size-4" />}
									label="Rounded Corners"
								>
									<SliderRow fill={radius} anchor="editor-radius" />
								</Field>
							</div>
						</div>
					</div>

					<div
						data-demo-anchor="editor-timeline"
						className="relative shrink-0 px-4 pt-8"
						style={{ height: 236 }}
					>
						<div
							className="absolute left-32 right-4 top-3 h-3 rounded-full"
							style={{ background: "rgba(217,217,217,0.35)" }}
						>
							<span
								className="absolute inset-y-0 left-0 w-2/5 rounded-full border"
								style={{
									borderColor: "rgba(206,206,206,0.8)",
									background: "rgba(217,217,217,0.7)",
								}}
							/>
						</div>

						<div className="flex gap-2">
							<div className="flex w-[104px] shrink-0 flex-col justify-end pb-1">
								<span
									className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[0.6875rem] font-medium text-white"
									style={{
										background: "linear-gradient(to bottom, #3b82f6, #2563eb)",
										boxShadow:
											"0 2px 8px -4px rgba(37,99,235,0.55), inset 0 1px 0 0 rgba(255,255,255,0.2)",
									}}
								>
									<LucidePlus className="size-3.5" />
									<span>Add track</span>
									<LucideChevronDown className="size-2.5 text-white/70" />
								</span>
							</div>
							<div
								className="relative h-8 flex-1 text-xs"
								style={{ color: C.gray9 }}
							>
								{[0, 1, 2, 3, 4, 5, 6].map((s) => (
									<span
										key={s}
										className="absolute flex -translate-x-1/2 flex-col items-center gap-1"
										style={{ left: `${(s / 6.4) * 100}%`, top: 0 }}
									>
										<span>{`0:${String(s * 5).padStart(2, "0")}`}</span>
										<span className="h-1 w-1 rounded-full bg-current" />
									</span>
								))}
							</div>
						</div>

						<div className="mt-2 flex gap-2">
							<div
								className="flex h-[52px] w-[104px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-white"
								style={{
									background: C.trackClip,
									border: "1px solid #2a5c96",
								}}
							>
								<CapClapperboard className="size-4" />
								<span className="text-[0.625rem] font-medium">Video</span>
							</div>
							<div className="relative h-[52px] flex-1">
								<div
									className="absolute inset-y-0 left-0 overflow-hidden rounded-xl"
									style={{
										width: "78%",
										background: C.trackClip,
										border: "1px solid #2a5c96",
									}}
								>
									<div className="flex h-full flex-col items-center justify-center">
										<span className="text-xs text-white/70">Clip</span>
										<span className="flex items-center gap-1 text-[0.625rem] text-white">
											<LucideClock className="size-3" />
											<span>0:32</span>
											<span className="ml-1 rounded bg-white/15 px-1">1x</span>
										</span>
									</div>
									<div className="absolute inset-x-0 bottom-0 flex h-3 items-end gap-px px-1">
										{WAVE_HEIGHTS.map((h, i) => (
											<span
												// biome-ignore lint/suspicious/noArrayIndexKey: static generated bars
												key={i}
												className="w-full flex-1 rounded-sm"
												style={{
													height: `${h * 100}%`,
													background: "rgba(255,255,255,0.4)",
												}}
											/>
										))}
									</div>
								</div>
							</div>
						</div>

						<div className="mt-2 flex gap-2">
							<div
								className="flex h-[52px] w-[104px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-white"
								style={{
									background: C.trackZoom,
									border: "1px solid #30343d",
								}}
							>
								<LucideSearch className="size-4" />
								<span className="text-[0.625rem] font-medium">Zoom</span>
							</div>
							<div
								className="relative flex h-[52px] flex-1 items-center justify-center overflow-hidden rounded-xl"
								style={{ background: "rgba(240,240,240,0.35)" }}
							>
								{ui.zoomSegments ? (
									[
										{ left: "9%", width: "22%" },
										{ left: "44%", width: "26%" },
									].map((segment) => (
										<span
											key={segment.left}
											className="absolute inset-y-0 flex items-center justify-center gap-1.5 rounded-xl text-xs text-white"
											style={{
												...segment,
												background: C.trackZoom,
												border: "1px solid #30343d",
											}}
										>
											<LucideSearch className="size-3.5" />
											Auto
										</span>
									))
								) : (
									<span
										data-scene-anchor="editor-zoom-generate"
										className="flex h-8 items-center rounded-lg border px-3 text-xs shadow-md"
										style={{
											background: C.gray5,
											borderColor: C.gray6,
											color: C.gray12,
											boxShadow: "0 1.5px 0 0 rgba(255,255,255,0.4) inset",
										}}
									>
										Click to generate zoom segments
									</span>
								)}
							</div>
						</div>

						<div
							ref={playheadRef}
							className="pointer-events-none absolute bottom-2 top-6 will-change-transform"
							style={{ left: 128 }}
						>
							<span
								className="absolute -left-[5.5px] top-0 size-3 rounded-full"
								style={{ background: "rgb(226,64,64)" }}
							/>
							<span
								className="absolute left-0 top-1 h-full w-px"
								style={{
									background:
										"linear-gradient(to bottom, rgb(226,64,64), rgba(226,64,64,0))",
								}}
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

const SourceTile = ({
	label,
	selected,
}: {
	label: string;
	selected?: boolean;
}) => (
	<span
		className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-2 py-2.5 text-xs"
		style={
			selected
				? { background: C.gray3, borderColor: C.gray3, color: C.gray12 }
				: { borderColor: "transparent", color: C.gray11 }
		}
	>
		<span
			className="size-3.5 rounded"
			style={{
				background: "linear-gradient(135deg,#8fc1f7,#dad0f8)",
			}}
		/>
		{label}
	</span>
);
