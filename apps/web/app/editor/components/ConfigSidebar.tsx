"use client";

import { Switch } from "@cap/ui";
import { ArrowLeft, Camera, Image as ImageIcon, Volume2 } from "lucide-react";
import NextImage from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AspectRatio, BackgroundSource } from "../types/project-config";
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

const TABS_WITH_CAMERA = [
	{ id: "background", icon: ImageIcon, label: "Background" },
	{ id: "camera", icon: Camera, label: "Camera" },
	{ id: "audio", icon: Volume2, label: "Audio" },
] as const;

const TABS_WITHOUT_CAMERA = [
	{ id: "background", icon: ImageIcon, label: "Background" },
	{ id: "audio", icon: Volume2, label: "Audio" },
] as const;

type TabId = "background" | "camera" | "audio";

const ASPECT_RATIOS: Array<{ value: AspectRatio; label: string }> = [
	{ value: "wide", label: "16:9" },
	{ value: "vertical", label: "9:16" },
	{ value: "square", label: "1:1" },
	{ value: "classic", label: "4:3" },
	{ value: "tall", label: "3:4" },
];

const SOCIAL_ASPECT_PRESETS: Array<{
	id: string;
	label: string;
	ratio: string;
	value: AspectRatio;
}> = [
	{
		id: "instagram-story",
		label: "Instagram Story",
		ratio: "9:16",
		value: "vertical",
	},
	{ id: "tiktok", label: "TikTok", ratio: "9:16", value: "vertical" },
	{
		id: "instagram-reel",
		label: "Instagram Reel",
		ratio: "9:16",
		value: "vertical",
	},
	{
		id: "instagram-feed",
		label: "Instagram Feed",
		ratio: "1:1",
		value: "square",
	},
	{ id: "youtube", label: "YouTube", ratio: "16:9", value: "wide" },
	{ id: "linkedin", label: "LinkedIn", ratio: "4:3", value: "classic" },
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
	const gradientAngle =
		background.source.type === "gradient" ? background.source.angle : undefined;
	const [backgroundTheme, setBackgroundTheme] =
		useState<keyof typeof BACKGROUND_THEMES>("macOS");
	const [activeSocialAspectPresetId, setActiveSocialAspectPresetId] = useState<
		string | null
	>(null);

	const updateAspectRatio = useCallback(
		(nextAspectRatio: AspectRatio | null, socialPresetId: string | null) => {
			setProject({ ...project, aspectRatio: nextAspectRatio });
			setActiveSocialAspectPresetId(socialPresetId);
		},
		[project, setProject],
	);

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

	useEffect(() => {
		if (project.aspectRatio === null) {
			setActiveSocialAspectPresetId(null);
			return;
		}

		if (activeSocialAspectPresetId == null) return;

		const activePreset = SOCIAL_ASPECT_PRESETS.find(
			(preset) => preset.id === activeSocialAspectPresetId,
		);
		if (activePreset?.value === project.aspectRatio) return;
		setActiveSocialAspectPresetId(null);
	}, [project.aspectRatio, activeSocialAspectPresetId]);

	return (
		<div className="flex flex-col gap-6">
			<Field label="Aspect Ratio">
				<div className="flex flex-wrap gap-2">
					{ASPECT_RATIOS.map(({ value, label }) => (
						<button
							type="button"
							key={value}
							onClick={() => updateAspectRatio(value, null)}
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
						onClick={() => updateAspectRatio(null, null)}
						className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
							project.aspectRatio === null
								? "border-blue-8 bg-blue-3 text-blue-11"
								: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
						}`}
					>
						Auto
					</button>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
					{SOCIAL_ASPECT_PRESETS.map((preset) => (
						<button
							type="button"
							key={preset.id}
							onClick={() => updateAspectRatio(preset.value, preset.id)}
							className={`px-3 py-2 rounded-lg border transition-colors text-left ${
								activeSocialAspectPresetId === preset.id
									? "border-blue-8 bg-blue-3 text-blue-11"
									: "border-gray-4 bg-gray-2 text-gray-11 hover:border-gray-6"
							}`}
						>
							<div className="text-xs font-medium leading-none">
								{preset.label}
							</div>
							<div className="text-[11px] mt-1 leading-none text-gray-10">
								{preset.ratio}
							</div>
						</button>
					))}
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
										angle: gradientAngle ?? 90,
									});
								}}
								className="aspect-square rounded-lg border border-gray-4 hover:border-gray-6 transition-colors"
								style={{
									background: `linear-gradient(${gradientAngle ?? 90}deg, rgb(${gradient.from.join(",")}), rgb(${gradient.to.join(",")}))`,
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

export function ConfigSidebar() {
	const [activeTab, setActiveTab] = useState<TabId>("background");
	const { editorState, setEditorState, saveRender, cameraUrl } =
		useEditorContext();
	const isSaving = saveRender.isSaving;
	const tabs = useMemo(
		() => (cameraUrl ? TABS_WITH_CAMERA : TABS_WITHOUT_CAMERA),
		[cameraUrl],
	);

	useEffect(() => {
		if (!tabs.some((tab) => tab.id === activeTab)) {
			setActiveTab("background");
		}
	}, [activeTab, tabs]);

	const clearSelection = useCallback(() => {
		setEditorState((state) => ({
			...state,
			timeline: { ...state.timeline, selection: null },
		}));
	}, [setEditorState]);

	const renderPanel = () => {
		if (editorState.timeline.selection) {
			return (
				<div className="flex flex-col items-center justify-center py-8 text-center">
					<p className="text-sm text-gray-11">Clip selected</p>
					<p className="text-xs text-gray-10 mt-1">
						Click away to edit project settings
					</p>
					<button
						type="button"
						onClick={clearSelection}
						className="flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs text-gray-11 hover:text-gray-12 bg-gray-3 hover:bg-gray-4 rounded-md transition-colors"
					>
						<ArrowLeft className="size-3" />
						Back to settings
					</button>
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
			default:
				return null;
		}
	};

	return (
		<div className="flex flex-col min-h-0 shrink-0 w-full lg:flex-1 lg:max-w-[24rem] max-h-[50vh] max-h-[60dvh] lg:max-h-none overflow-hidden rounded-xl bg-gray-1 border border-gray-4">
			<div className="flex items-center h-12 sm:h-14 border-b border-gray-4 shrink-0">
				{tabs.map(({ id, icon: Icon, label }) => (
					<button
						type="button"
						key={id}
						disabled={isSaving}
						onClick={() => {
							if (editorState.timeline.selection) {
								clearSelection();
							}
							setActiveTab(id);
						}}
						className={`flex flex-1 justify-center items-center h-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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

			<div
				className={`flex-1 overflow-y-auto p-3 sm:p-4 transition-opacity ${isSaving ? "pointer-events-none opacity-50" : ""}`}
			>
				{renderPanel()}
			</div>
		</div>
	);
}
