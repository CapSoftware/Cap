import { Select as KSelect } from "@kobalte/core/select";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { cx } from "cva";
import { createEffect, createSignal, onMount, Show } from "solid-js";

import Tooltip from "~/components/Tooltip";
import { captionsStore } from "~/store/captions";
import { commands } from "~/utils/tauri";
import AspectRatioSelect from "./AspectRatioSelect";
import {
	FPS,
	type PreviewQuality,
	serializeProjectConfiguration,
	useEditorContext,
} from "./context";
import {
	EditorButton,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	topLeftAnimateClasses,
} from "./ui";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { formatTime } from "./utils";

export function Player() {
	const {
		project,
		editorInstance,
		setDialog,
		totalDuration,
		editorState,
		setEditorState,
		zoomOutLimit,
		setProject,
		previewResolutionBase,
		previewQuality,
		setPreviewQuality,
	} = useEditorContext();

	const previewOptions = [
		{ label: "Full", value: "full" as PreviewQuality },
		{ label: "Half", value: "half" as PreviewQuality },
	];

	// Load captions on mount
	onMount(async () => {
		if (editorInstance && editorInstance.path) {
			// Still load captions into the store since they will be used by the GPU renderer
			await captionsStore.loadCaptions(editorInstance.path);

			// Synchronize captions settings with project configuration
			// This ensures the GPU renderer will receive the caption settings
			if (editorInstance && project) {
				const updatedProject = { ...project };

				// Add captions data to project configuration if it doesn't exist
				if (
					!updatedProject.captions &&
					captionsStore.state.segments.length > 0
				) {
					updatedProject.captions = {
						segments: captionsStore.state.segments.map((segment) => ({
							id: segment.id,
							start: segment.start,
							end: segment.end,
							text: segment.text,
						})),
						settings: {
							enabled: captionsStore.state.settings.enabled,
							font: captionsStore.state.settings.font,
							size: captionsStore.state.settings.size,
							color: captionsStore.state.settings.color,
							backgroundColor: captionsStore.state.settings.backgroundColor,
							backgroundOpacity: captionsStore.state.settings.backgroundOpacity,
							position: captionsStore.state.settings.position,
							bold: captionsStore.state.settings.bold,
							italic: captionsStore.state.settings.italic,
							outline: captionsStore.state.settings.outline,
							outlineColor: captionsStore.state.settings.outlineColor,
							exportWithSubtitles:
								captionsStore.state.settings.exportWithSubtitles,
						},
					};

					// Update the project with captions data
					setProject(updatedProject);

					// Save the updated project configuration
					await commands.setProjectConfig(
						serializeProjectConfiguration(updatedProject),
					);
				}
			}
		}
	});

	// Continue to update current caption when playback time changes
	// This is still needed for CaptionsTab to highlight the current caption
	createEffect(() => {
		const time = editorState.playbackTime;
		// Only update captions if we have a valid time and segments exist
		if (
			time !== undefined &&
			time >= 0 &&
			captionsStore.state.segments.length > 0
		) {
			captionsStore.updateCurrentCaption(time);
		}
	});

	const isAtEnd = () => {
		const total = totalDuration();
		return total > 0 && total - editorState.playbackTime <= 0.1;
	};

	const cropDialogHandler = async () => {
		const display = editorInstance.recordings.segments[0].display;
		setDialog({
			open: true,
			type: "crop",
			position: {
				...(project.background.crop?.position ?? { x: 0, y: 0 }),
			},
			size: {
				...(project.background.crop?.size ?? {
					x: display.width,
					y: display.height,
				}),
			},
		});
		await commands.stopPlayback();
		setEditorState("playing", false);
	};

	const handlePreviewQualityChange = async (quality: PreviewQuality) => {
		if (quality === previewQuality()) return;

		const wasPlaying = editorState.playing;
		const currentFrame = Math.max(
			Math.floor(editorState.playbackTime * FPS),
			0,
		);

		setPreviewQuality(quality);

		if (!wasPlaying) return;

		try {
			await commands.stopPlayback();
			setEditorState("playing", false);
			await commands.seekTo(currentFrame);
			await commands.startPlayback(FPS, previewResolutionBase());
			setEditorState("playing", true);
		} catch (error) {
			console.error("Failed to update preview quality:", error);
			setEditorState("playing", false);
		}
	};

	createEffect(() => {
		if (isAtEnd() && editorState.playing) {
			commands.stopPlayback();
			setEditorState("playing", false);
		}
	});

	const handlePlayPauseClick = async () => {
		try {
			if (isAtEnd()) {
				await commands.stopPlayback();
				setEditorState("playbackTime", 0);
				await commands.seekTo(0);
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			} else if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			} else {
				// Ensure we seek to the current playback time before starting playback
				await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			}
			if (editorState.playing) setEditorState("previewTime", null);
		} catch (error) {
			console.error("Error handling play/pause:", error);
			setEditorState("playing", false);
		}
	};

	// Register keyboard shortcuts in one place
	useEditorShortcuts(() => {
		const el = document.activeElement;
		if (!el) return true;
		const tagName = el.tagName.toLowerCase();
		const isContentEditable = el.getAttribute("contenteditable") === "true";
		return !(
			tagName === "input" ||
			tagName === "textarea" ||
			isContentEditable
		);
	}, [
		{
			combo: "S",
			handler: () =>
				setEditorState(
					"timeline",
					"interactMode",
					editorState.timeline.interactMode === "split" ? "seek" : "split",
				),
		},
		{
			combo: "Mod+=",
			handler: () =>
				editorState.timeline.transform.updateZoom(
					editorState.timeline.transform.zoom / 1.1,
					editorState.playbackTime,
				),
		},
		{
			combo: "Mod+-",
			handler: () =>
				editorState.timeline.transform.updateZoom(
					editorState.timeline.transform.zoom * 1.1,
					editorState.playbackTime,
				),
		},
		{
			combo: "Space",
			handler: async () => {
				const prevTime = editorState.previewTime;

				if (!editorState.playing) {
					if (prevTime !== null) setEditorState("playbackTime", prevTime);

					await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				}

				await handlePlayPauseClick();
			},
		},
	]);

	return (
		<div class="flex flex-col flex-1 rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3">
			<div class="flex items-center justify-between gap-3 p-3">
				<div class="flex items-center gap-3">
					<AspectRatioSelect />
					<EditorButton
						tooltipText="Crop Video"
						onClick={cropDialogHandler}
						leftIcon={<IconCapCrop class="w-5 text-gray-12" />}
					>
						Crop
					</EditorButton>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-xs font-medium text-gray-11">Preview</span>
					<KSelect<{ label: string; value: PreviewQuality }>
						options={previewOptions}
						optionValue="value"
						optionTextValue="label"
						value={previewOptions.find(
							(option) => option.value === previewQuality(),
						)}
						onChange={(next) => {
							if (next) handlePreviewQualityChange(next.value);
						}}
						disallowEmptySelection
						itemComponent={(props) => (
							<MenuItem<typeof KSelect.Item>
								as={KSelect.Item}
								item={props.item}
							>
								<KSelect.ItemLabel class="flex-1">
									{props.item.rawValue.label}
								</KSelect.ItemLabel>
								<KSelect.ItemIndicator class="ml-auto text-blue-9">
									<IconCapCircleCheck />
								</KSelect.ItemIndicator>
							</MenuItem>
						)}
					>
						<KSelect.Trigger class="flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-3 bg-gray-2 dark:bg-gray-3 text-sm text-gray-12">
							<KSelect.Value<{ label: string; value: PreviewQuality }>
								class="flex-1 text-left truncate"
								placeholder="Select preview quality"
							>
								{(state) =>
									state.selectedOption()?.label ?? "Select preview quality"
								}
							</KSelect.Value>
							<KSelect.Icon>
								<IconCapChevronDown class="size-4 text-gray-11" />
							</KSelect.Icon>
						</KSelect.Trigger>
						<KSelect.Portal>
							<PopperContent<typeof KSelect.Content>
								as={KSelect.Content}
								class={cx(topLeftAnimateClasses, "w-44")}
							>
								<MenuItem as="div" class="text-gray-11" data-disabled="true">
									Select preview quality
								</MenuItem>
								<MenuItemList<typeof KSelect.Listbox>
									as={KSelect.Listbox}
									class="max-h-40"
								/>
							</PopperContent>
						</KSelect.Portal>
					</KSelect>
				</div>
			</div>
			<PreviewCanvas />
			<div class="flex overflow-hidden z-10 flex-row gap-3 justify-between items-center p-5">
				<div class="flex-1">
					<Time
						class="text-gray-12"
						seconds={Math.max(
							editorState.previewTime ?? editorState.playbackTime,
							0,
						)}
					/>
					<span class="text-gray-11 text-[0.875rem] tabular-nums"> / </span>
					<Time seconds={totalDuration()} />
				</div>
				<div class="flex flex-row items-center justify-center text-gray-11 gap-8 text-[0.875rem]">
					<button
						type="button"
						class="transition-opacity hover:opacity-70 will-change-[opacity]"
						onClick={async () => {
							await commands.stopPlayback();
							setEditorState("playing", false);
							setEditorState("playbackTime", 0);
						}}
					>
						<IconCapPrev class="text-gray-12 size-3" />
					</button>
					<Tooltip kbd={["Space"]} content="Play/Pause video">
						<button
							type="button"
							onClick={handlePlayPauseClick}
							class="flex justify-center items-center rounded-full border border-gray-300 transition-colors bg-gray-3 hover:bg-gray-4 hover:text-black size-9"
						>
							{!editorState.playing || isAtEnd() ? (
								<IconCapPlay class="text-gray-12 size-3" />
							) : (
								<IconCapPause class="text-gray-12 size-3" />
							)}
						</button>
					</Tooltip>
					<button
						type="button"
						class="transition-opacity hover:opacity-70 will-change-[opacity]"
						onClick={async () => {
							await commands.stopPlayback();
							setEditorState("playing", false);
							setEditorState("playbackTime", totalDuration());
						}}
					>
						<IconCapNext class="text-gray-12 size-3" />
					</button>
				</div>
				<div class="flex flex-row flex-1 gap-4 justify-end items-center">
					<div class="flex-1" />
					<EditorButton<typeof KToggleButton>
						tooltipText="Toggle Split"
						kbd={["S"]}
						pressed={editorState.timeline.interactMode === "split"}
						onChange={(v: boolean) =>
							setEditorState("timeline", "interactMode", v ? "split" : "seek")
						}
						as={KToggleButton}
						variant="danger"
						leftIcon={
							<IconCapScissors
								class={cx(
									editorState.timeline.interactMode === "split"
										? "text-white"
										: "text-gray-12",
								)}
							/>
						}
					/>
					<div class="w-px h-8 rounded-full bg-gray-4" />
					<Tooltip kbd={["meta", "-"]} content="Zoom out">
						<IconCapZoomOut
							onClick={() => {
								editorState.timeline.transform.updateZoom(
									editorState.timeline.transform.zoom * 1.1,
									editorState.playbackTime,
								);
							}}
							class="text-gray-12 size-5 will-change-[opacity] transition-opacity hover:opacity-70"
						/>
					</Tooltip>
					<Tooltip kbd={["meta", "+"]} content="Zoom in">
						<IconCapZoomIn
							onClick={() => {
								editorState.timeline.transform.updateZoom(
									editorState.timeline.transform.zoom / 1.1,
									editorState.playbackTime,
								);
							}}
							class="text-gray-12 size-5 will-change-[opacity] transition-opacity hover:opacity-70"
						/>
					</Tooltip>
					<Slider
						class="w-24"
						minValue={0}
						maxValue={1}
						step={0.001}
						value={[
							Math.min(
								Math.max(
									1 - editorState.timeline.transform.zoom / zoomOutLimit(),
									0,
								),
								1,
							),
						]}
						onChange={([v]) => {
							editorState.timeline.transform.updateZoom(
								(1 - v) * zoomOutLimit(),
								editorState.playbackTime,
							);
						}}
						formatTooltip={() =>
							`${editorState.timeline.transform.zoom.toFixed(
								0,
							)} seconds visible`
						}
					/>
				</div>
			</div>
		</div>
	);
}

// CSS for checkerboard grid (adaptive to light/dark mode)
const gridStyle = {
	"background-image":
		"linear-gradient(45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
		"linear-gradient(-45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
		"linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.12) 75%), " +
		"linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.12) 75%)",
	"background-size": "40px 40px",
	"background-position": "0 0, 0 20px, 20px -20px, -20px 0px",
	"background-color": "rgba(200,200,200,0.08)",
};

function PreviewCanvas() {
	const { latestFrame } = useEditorContext();

	let canvasRef: HTMLCanvasElement | undefined;

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	createEffect(() => {
		const frame = latestFrame();
		if (!frame) return;
		if (!canvasRef) return;
		const ctx = canvasRef.getContext("2d");
		ctx?.putImageData(frame.data, 0, 0);
	});

	return (
		<div
			ref={setCanvasContainerRef}
			class="relative flex-1 justify-center items-center"
		>
			<Show when={latestFrame()}>
				{(currentFrame) => {
					const padding = 4;
					const frameWidth = () => currentFrame().width;
					const frameHeight = () => currentFrame().data.height;

					const availableWidth = () =>
						Math.max((containerBounds.width ?? 0) - padding * 2, 0);
					const availableHeight = () =>
						Math.max((containerBounds.height ?? 0) - padding * 2, 0);

					const containerAspect = () => {
						const width = availableWidth();
						const height = availableHeight();
						if (width === 0 || height === 0) return 1;
						return width / height;
					};

					const frameAspect = () => {
						const width = frameWidth();
						const height = frameHeight();
						if (width === 0 || height === 0) return containerAspect();
						return width / height;
					};

					const size = () => {
						let width: number;
						let height: number;
						if (frameAspect() < containerAspect()) {
							height = availableHeight();
							width = height * frameAspect();
						} else {
							width = availableWidth();
							height = width / frameAspect();
						}

						return {
							width: Math.min(width, frameWidth()),
							height: Math.min(height, frameHeight()),
						};
					};

					return (
						<div class="flex overflow-hidden absolute inset-0 justify-center items-center h-full">
							<canvas
								style={{
									width: `${size().width}px`,
									height: `${size().height}px`,
									...gridStyle,
								}}
								class="rounded"
								ref={canvasRef}
								id="canvas"
								width={frameWidth()}
								height={frameHeight()}
							/>
						</div>
					);
				}}
			</Show>
		</div>
	);
}

function Time(props: { seconds: number; fps?: number; class?: string }) {
	return (
		<span class={cx("text-gray-11 text-sm tabular-nums", props.class)}>
			{formatTime(props.seconds, props.fps ?? FPS)}
		</span>
	);
}
