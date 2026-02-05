"use client";

import { Switch } from "@cap/ui";
import {
	Camera,
	Image as ImageIcon,
	MessageSquare,
	MousePointer2,
	Volume2,
} from "lucide-react";
import NextImage from "next/image";
import { useCallback, useState } from "react";
import type {
	AspectRatio,
	BackgroundSource,
	CursorAnimationStyle,
} from "../types/project-config";
import {
	BACKGROUND_COLORS,
	BACKGROUND_GRADIENTS,
	BACKGROUND_THEMES,
	getWallpaperPath,
	resolveBackgroundAssetPath,
	resolveBackgroundSourcePath,
	rgbHexToTuple,
	WALLPAPER_NAMES,
} from "../utils/backgrounds";
import { useEditorContext } from "./context";

const TABS = [
	{ id: "background", icon: ImageIcon, label: "Background" },
	{ id: "camera", icon: Camera, label: "Camera" },
	{ id: "audio", icon: Volume2, label: "Audio" },
	{ id: "cursor", icon: MousePointer2, label: "Cursor" },
	{ id: "captions", icon: MessageSquare, label: "Captions" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const ASPECT_RATIOS: Array<{ value: AspectRatio; label: string }> = [
	{ value: "wide", label: "16:9" },
	{ value: "vertical", label: "9:16" },
	{ value: "square", label: "1:1" },
	{ value: "classic", label: "4:3" },
	{ value: "tall", label: "3:4" },
];

const CURSOR_STYLES: Array<{
	value: typeof CursorAnimationStyle.Type;
	label: string;
	description: string;
}> = [
	{
		value: "slow",
		label: "Slow",
		description: "Gentle follow with higher inertia",
	},
	{
		value: "mellow",
		label: "Mellow",
		description: "Balanced smoothing for tutorials",
	},
	{ value: "custom", label: "Custom", description: "Manually tune physics" },
];

interface SliderProps {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step?: number;
	disabled?: boolean;
	formatLabel?: (value: number) => string;
}

function Slider({
	value,
	onChange,
	min,
	max,
	step = 1,
	disabled = false,
	formatLabel,
}: SliderProps) {
	const percentage = ((value - min) / (max - min)) * 100;

	return (
		<div className="flex items-center gap-3 w-full">
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				disabled={disabled}
				className="flex-1 h-2 bg-gray-3 rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed accent-blue-9"
				style={{
					background: `linear-gradient(to right, var(--blue-9) 0%, var(--blue-9) ${percentage}%, var(--gray-4) ${percentage}%, var(--gray-4) 100%)`,
				}}
			/>
			{formatLabel && (
				<span className="text-xs text-gray-11 w-12 text-right">
					{formatLabel(value)}
				</span>
			)}
		</div>
	);
}

interface FieldProps {
	label: string;
	children: React.ReactNode;
	icon?: React.ReactNode;
	action?: React.ReactNode;
}

function Field({ label, children, icon, action }: FieldProps) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 text-sm font-medium text-gray-12">
					{icon && <span className="text-gray-11">{icon}</span>}
					{label}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

function BackgroundPanel() {
	const { project, setProject } = useEditorContext();
	const background = project.background;
	const [backgroundTheme, setBackgroundTheme] =
		useState<keyof typeof BACKGROUND_THEMES>("macOS");

	const toAbsoluteAssetUrl = useCallback((path: string) => {
		if (typeof window === "undefined") return path;
		return new URL(path, window.location.origin).toString();
	}, []);

	const updateBackground = useCallback(
		(nextSource: BackgroundSource, options?: { ensurePadding?: boolean }) => {
			const nextPadding =
				options?.ensurePadding && background.padding === 0
					? 10
					: background.padding;
			setProject({
				...project,
				background: {
					...background,
					padding: nextPadding,
					source: nextSource,
				},
			});
		},
		[project, background, setProject],
	);

	const handleSourceTypeChange = useCallback(
		(type: BackgroundSource["type"]) => {
			if (type === "wallpaper") {
				const firstWallpaper = WALLPAPER_NAMES[0];
				updateBackground(
					{
						type: "wallpaper",
						path: firstWallpaper
							? toAbsoluteAssetUrl(getWallpaperPath(firstWallpaper))
							: null,
					},
					{ ensurePadding: true },
				);
				return;
			}

			if (type === "image") {
				updateBackground(
					{
						type: "image",
						path: null,
					},
					{ ensurePadding: true },
				);
				return;
			}

			if (type === "color") {
				updateBackground({
					type: "color",
					value: [255, 255, 255],
				});
				return;
			}

			updateBackground(
				{
					type: "gradient",
					from: [69, 104, 220],
					to: [176, 106, 179],
					angle: 90,
				},
				{ ensurePadding: true },
			);
		},
		[toAbsoluteAssetUrl, updateBackground],
	);

	const handleColorChange = useCallback(
		(hex: string) => {
			const value = rgbHexToTuple(hex);
			const alpha =
				hex.length === 9
					? Number.parseInt(hex.slice(7, 9), 16) / 255
					: undefined;
			updateBackground({
				type: "color",
				value,
				alpha,
			});
		},
		[updateBackground],
	);

	const filteredWallpapers = WALLPAPER_NAMES.filter((wallpaper) =>
		wallpaper.startsWith(`${backgroundTheme}/`),
	);

	const selectedWallpaperPath =
		background.source.type === "wallpaper"
			? resolveBackgroundSourcePath(background.source)
			: null;

	return (
		<div className="flex flex-col gap-6">
			<Field label="Aspect Ratio">
				<div className="flex flex-wrap gap-2">
					{ASPECT_RATIOS.map(({ value, label }) => (
						<button
							type="button"
							key={value}
							onClick={() => setProject({ ...project, aspectRatio: value })}
							className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
								project.aspectRatio === value
									? "border-blue-8 bg-blue-3 text-blue-11"
									: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
							}`}
						>
							{label}
						</button>
					))}
					<button
						type="button"
						onClick={() => setProject({ ...project, aspectRatio: null })}
						className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
							project.aspectRatio === null
								? "border-blue-8 bg-blue-3 text-blue-11"
								: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
						}`}
					>
						Auto
					</button>
				</div>
			</Field>

			<Field label="Background Type">
				<div className="grid grid-cols-4 gap-2">
					{(["color", "gradient", "wallpaper", "image"] as const).map(
						(type) => (
							<button
								type="button"
								key={type}
								onClick={() => handleSourceTypeChange(type)}
								className={`px-3 py-2 text-xs rounded-lg border transition-colors capitalize ${
									background.source.type === type
										? "border-blue-8 bg-blue-3 text-blue-11"
										: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
								}`}
							>
								{type}
							</button>
						),
					)}
				</div>
			</Field>

			{background.source.type === "color" && (
				<Field label="Color">
					<div className="flex flex-wrap gap-2">
						{BACKGROUND_COLORS.map((color) => (
							<button
								type="button"
								key={color}
								onClick={() => handleColorChange(color)}
								className="size-8 rounded-lg border border-gray-4 hover:border-gray-6 transition-colors"
								style={{ backgroundColor: color }}
							/>
						))}
					</div>
				</Field>
			)}

			{background.source.type === "gradient" && (
				<Field label="Gradients">
					<div className="grid grid-cols-6 gap-2">
						{BACKGROUND_GRADIENTS.map((gradient) => (
							<button
								type="button"
								key={`${gradient.from.join(",")}-${gradient.to.join(",")}`}
								onClick={() => {
									const [fromR, fromG, fromB] = gradient.from;
									const [toR, toG, toB] = gradient.to;
									updateBackground({
										type: "gradient",
										from: [fromR, fromG, fromB],
										to: [toR, toG, toB],
										angle: background.source.angle ?? 90,
									});
								}}
								className="aspect-square rounded-lg border border-gray-4 hover:border-gray-6 transition-colors"
								style={{
									background: `linear-gradient(${background.source.angle ?? 90}deg, rgb(${gradient.from.join(",")}), rgb(${gradient.to.join(",")}))`,
								}}
							/>
						))}
					</div>
				</Field>
			)}

			{background.source.type === "wallpaper" && (
				<Field label="Wallpapers">
					<div className="flex flex-wrap gap-2">
						{Object.entries(BACKGROUND_THEMES).map(([key, label]) => (
							<button
								type="button"
								key={key}
								onClick={() =>
									setBackgroundTheme(key as keyof typeof BACKGROUND_THEMES)
								}
								className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
									backgroundTheme === key
										? "border-blue-8 bg-blue-3 text-blue-11"
										: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
								}`}
							>
								{label}
							</button>
						))}
					</div>
					<div className="grid grid-cols-5 gap-2">
						{filteredWallpapers.map((name) => {
							const path = getWallpaperPath(name);
							const resolvedPath = resolveBackgroundAssetPath(path);
							const selected = selectedWallpaperPath?.endsWith(path);
							return (
								<button
									type="button"
									key={name}
									onClick={() =>
										updateBackground(
											{
												type: "wallpaper",
												path: toAbsoluteAssetUrl(path),
											},
											{ ensurePadding: true },
										)
									}
									className={`relative aspect-square overflow-hidden rounded-lg border transition-colors ${
										selected
											? "border-blue-8 ring-1 ring-blue-8"
											: "border-gray-4 hover:border-gray-6"
									}`}
								>
									<NextImage
										src={resolvedPath}
										alt={name}
										fill
										className="object-cover"
										sizes="(max-width: 1024px) 20vw, 10vw"
									/>
								</button>
							);
						})}
					</div>
				</Field>
			)}

			{background.source.type === "image" && (
				<Field label="Image URL">
					<input
						type="url"
						value={background.source.path ?? ""}
						placeholder="https://example.com/background.jpg"
						onChange={(event) => {
							const value = event.target.value.trim();
							updateBackground(
								{
									type: "image",
									path: value.length > 0 ? value : null,
								},
								{ ensurePadding: true },
							);
						}}
						className="w-full h-10 px-3 rounded-lg border border-gray-4 bg-gray-2 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-8"
					/>
				</Field>
			)}

			<Field label="Padding">
				<Slider
					value={background.padding}
					onChange={(value) =>
						setProject({
							...project,
							background: { ...background, padding: value },
						})
					}
					min={0}
					max={50}
					formatLabel={(v) => `${v}%`}
				/>
			</Field>

			<Field label="Rounding">
				<Slider
					value={background.rounding}
					onChange={(value) =>
						setProject({
							...project,
							background: { ...background, rounding: value },
						})
					}
					min={0}
					max={100}
					formatLabel={(v) => `${v}%`}
				/>
			</Field>

			<Field label="Shadow">
				<Slider
					value={background.shadow}
					onChange={(value) =>
						setProject({
							...project,
							background: { ...background, shadow: value },
						})
					}
					min={0}
					max={100}
					formatLabel={(v) => `${v}%`}
				/>
			</Field>
		</div>
	);
}

function CameraPanel() {
	const { project, setProject } = useEditorContext();
	const camera = project.camera;

	return (
		<div className="flex flex-col gap-6">
			<Field
				label="Show Camera"
				action={
					<Switch
						checked={!camera.hide}
						onCheckedChange={(checked) =>
							setProject({
								...project,
								camera: { ...camera, hide: !checked },
							})
						}
					/>
				}
			>
				<p className="text-xs text-gray-10">
					Toggle visibility of camera overlay
				</p>
			</Field>

			{!camera.hide && (
				<>
					<Field
						label="Mirror"
						action={
							<Switch
								checked={camera.mirror}
								onCheckedChange={(checked) =>
									setProject({
										...project,
										camera: { ...camera, mirror: checked },
									})
								}
							/>
						}
					>
						<p className="text-xs text-gray-10">Flip camera horizontally</p>
					</Field>

					<Field label="Size">
						<Slider
							value={camera.size}
							onChange={(value) =>
								setProject({
									...project,
									camera: { ...camera, size: value },
								})
							}
							min={10}
							max={50}
							formatLabel={(v) => `${v}%`}
						/>
					</Field>

					<Field label="Rounding">
						<Slider
							value={camera.rounding}
							onChange={(value) =>
								setProject({
									...project,
									camera: { ...camera, rounding: value },
								})
							}
							min={0}
							max={100}
							formatLabel={(v) => `${v}%`}
						/>
					</Field>

					<Field label="Position">
						<div className="grid grid-cols-3 gap-2">
							{(["left", "center", "right"] as const).map((x) =>
								(["top", "bottom"] as const).map((y) => (
									<button
										type="button"
										key={`${x}-${y}`}
										onClick={() =>
											setProject({
												...project,
												camera: { ...camera, position: { x, y } },
											})
										}
										className={`px-2 py-1.5 text-xs rounded-lg border transition-colors capitalize ${
											camera.position.x === x && camera.position.y === y
												? "border-blue-8 bg-blue-3 text-blue-11"
												: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
										}`}
									>
										{y} {x}
									</button>
								)),
							)}
						</div>
					</Field>

					<Field label="Shadow">
						<Slider
							value={camera.shadow}
							onChange={(value) =>
								setProject({
									...project,
									camera: { ...camera, shadow: value },
								})
							}
							min={0}
							max={100}
							formatLabel={(v) => `${v}%`}
						/>
					</Field>
				</>
			)}
		</div>
	);
}

function AudioPanel() {
	const { project, setProject } = useEditorContext();
	const audio = project.audio;

	return (
		<div className="flex flex-col gap-6">
			<Field
				label="Mute Audio"
				action={
					<Switch
						checked={audio.mute}
						onCheckedChange={(checked) =>
							setProject({
								...project,
								audio: { ...audio, mute: checked },
							})
						}
					/>
				}
			>
				<p className="text-xs text-gray-10">Disable all audio in the video</p>
			</Field>

			<Field label="Microphone Volume">
				<Slider
					value={audio.micVolumeDb}
					onChange={(value) =>
						setProject({
							...project,
							audio: { ...audio, micVolumeDb: value },
						})
					}
					min={-30}
					max={10}
					step={0.1}
					disabled={audio.mute}
					formatLabel={(v) =>
						v <= -30 ? "Muted" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
					}
				/>
			</Field>

			<Field label="System Audio Volume">
				<Slider
					value={audio.systemVolumeDb}
					onChange={(value) =>
						setProject({
							...project,
							audio: { ...audio, systemVolumeDb: value },
						})
					}
					min={-30}
					max={10}
					step={0.1}
					disabled={audio.mute}
					formatLabel={(v) =>
						v <= -30 ? "Muted" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
					}
				/>
			</Field>
		</div>
	);
}

function CursorPanel() {
	const { project, setProject } = useEditorContext();
	const cursor = project.cursor;

	return (
		<div className="flex flex-col gap-6">
			<Field
				label="Show Cursor"
				action={
					<Switch
						checked={!cursor.hide}
						onCheckedChange={(checked) =>
							setProject({
								...project,
								cursor: { ...cursor, hide: !checked },
							})
						}
					/>
				}
			>
				<p className="text-xs text-gray-10">Toggle cursor visibility</p>
			</Field>

			{!cursor.hide && (
				<>
					<Field label="Cursor Type">
						<div className="flex gap-2">
							{(["auto", "pointer", "circle"] as const).map((type) => (
								<button
									type="button"
									key={type}
									onClick={() =>
										setProject({
											...project,
											cursor: { ...cursor, type },
										})
									}
									className={`px-3 py-1.5 text-sm rounded-lg border transition-colors capitalize ${
										cursor.type === type
											? "border-blue-8 bg-blue-3 text-blue-11"
											: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
									}`}
								>
									{type}
								</button>
							))}
						</div>
					</Field>

					<Field label="Size">
						<Slider
							value={cursor.size}
							onChange={(value) =>
								setProject({
									...project,
									cursor: { ...cursor, size: value },
								})
							}
							min={20}
							max={300}
							formatLabel={(v) => `${v}%`}
						/>
					</Field>

					<Field
						label="Hide When Idle"
						action={
							<Switch
								checked={cursor.hideWhenIdle}
								onCheckedChange={(checked) =>
									setProject({
										...project,
										cursor: { ...cursor, hideWhenIdle: checked },
									})
								}
							/>
						}
					>
						<p className="text-xs text-gray-10">Fade cursor after inactivity</p>
					</Field>

					{cursor.hideWhenIdle && (
						<Field label="Idle Delay">
							<Slider
								value={cursor.hideWhenIdleDelay}
								onChange={(value) =>
									setProject({
										...project,
										cursor: { ...cursor, hideWhenIdleDelay: value },
									})
								}
								min={0.5}
								max={5}
								step={0.1}
								formatLabel={(v) => `${v.toFixed(1)}s`}
							/>
						</Field>
					)}

					<Field label="Movement Style">
						<div className="flex flex-col gap-2">
							{CURSOR_STYLES.map(({ value, label, description }) => (
								<button
									type="button"
									key={value}
									onClick={() =>
										setProject({
											...project,
											cursor: { ...cursor, animationStyle: value },
										})
									}
									className={`p-3 text-left rounded-lg border transition-colors ${
										cursor.animationStyle === value
											? "border-blue-8 bg-blue-3"
											: "border-gray-4 bg-gray-2 hover:border-gray-6"
									}`}
								>
									<div className="text-sm font-medium text-gray-12">
										{label}
									</div>
									<div className="text-xs text-gray-10">{description}</div>
								</button>
							))}
						</div>
					</Field>
				</>
			)}
		</div>
	);
}

function CaptionsPanel() {
	const { project } = useEditorContext();
	const captions = project.captions;

	return (
		<div className="flex flex-col gap-6">
			{captions ? (
				<Field
					label="Captions"
					action={
						<Switch
							checked={captions.settings.enabled}
							onCheckedChange={() => {}}
						/>
					}
				>
					<p className="text-xs text-gray-10">
						Enable captions overlay on video
					</p>
				</Field>
			) : (
				<div className="flex flex-col items-center justify-center py-8 text-center">
					<MessageSquare className="size-8 text-gray-8 mb-3" />
					<p className="text-sm text-gray-11">No captions available</p>
					<p className="text-xs text-gray-10 mt-1">
						Generate captions from the video page
					</p>
				</div>
			)}
		</div>
	);
}

export function ConfigSidebar() {
	const [activeTab, setActiveTab] = useState<TabId>("background");
	const { editorState } = useEditorContext();

	const renderPanel = () => {
		if (editorState.timeline.selection) {
			return (
				<div className="flex flex-col items-center justify-center py-8 text-center">
					<p className="text-sm text-gray-11">Clip selected</p>
					<p className="text-xs text-gray-10 mt-1">
						Click away to edit project settings
					</p>
				</div>
			);
		}

		switch (activeTab) {
			case "background":
				return <BackgroundPanel />;
			case "camera":
				return <CameraPanel />;
			case "audio":
				return <AudioPanel />;
			case "cursor":
				return <CursorPanel />;
			case "captions":
				return <CaptionsPanel />;
			default:
				return null;
		}
	};

	return (
		<div className="flex flex-col min-h-0 shrink-0 w-full lg:flex-1 lg:max-w-[24rem] max-h-[50vh] lg:max-h-none overflow-hidden rounded-xl bg-gray-1 border border-gray-4">
			<div className="flex items-center h-12 sm:h-14 border-b border-gray-4 shrink-0">
				{TABS.map(({ id, icon: Icon, label }) => (
					<button
						type="button"
						key={id}
						onClick={() => setActiveTab(id)}
						className={`flex flex-1 justify-center items-center h-full transition-colors ${
							activeTab === id && !editorState.timeline.selection
								? "text-gray-12"
								: "text-gray-10 hover:text-gray-11"
						}`}
						title={label}
					>
						<div
							className={`flex justify-center items-center size-9 rounded-lg transition-colors ${
								activeTab === id && !editorState.timeline.selection
									? "bg-gray-3"
									: ""
							}`}
						>
							<Icon className="size-5" />
						</div>
					</button>
				))}
			</div>

			<div className="flex-1 overflow-y-auto p-3 sm:p-4">{renderPanel()}</div>
		</div>
	);
}
