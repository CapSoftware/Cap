import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import Tooltip from "~/components/Tooltip";
import { captionsStore } from "~/store/captions";
import { commands } from "~/utils/tauri";
import AspectRatioSelect from "./AspectRatioSelect";
import { FPS, OUTPUT_SIZE, useEditorContext } from "./context";
import { ComingSoonTooltip, EditorButton, Slider } from "./ui";
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
	} = useEditorContext();

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
					await commands.setProjectConfig(updatedProject);
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

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	const isAtEnd = () => {
		const total = totalDuration();
		return total > 0 && total - editorState.playbackTime <= 0.1;
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
				await commands.startPlayback(FPS, OUTPUT_SIZE);
				setEditorState("playing", true);
			} else if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			} else {
				// Ensure we seek to the current playback time before starting playback
				await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				await commands.startPlayback(FPS, OUTPUT_SIZE);
				setEditorState("playing", true);
			}
			if (editorState.playing) setEditorState("previewTime", null);
		} catch (error) {
			console.error("Error handling play/pause:", error);
			setEditorState("playing", false);
		}
	};

	createEventListener(document, "keydown", async (e: KeyboardEvent) => {
		if (e.code === "Space" && e.target === document.body) {
			e.preventDefault();
			const prevTime = editorState.previewTime;

			if (!editorState.playing) {
				if (prevTime !== null) setEditorState("playbackTime", prevTime);

				await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
			}

			await handlePlayPauseClick();
		}
	});

	return (
		<div class="flex flex-col flex-1 rounded-xl bg-gray-1 dark:bg-gray-2 border border-gray-3">
			<div class="flex gap-3 justify-center p-3">
				<AspectRatioSelect />
				<EditorButton
					onClick={() => {
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
					}}
					leftIcon={<IconCapCrop class="w-5 text-gray-12" />}
				>
					Crop
				</EditorButton>
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
					<Tooltip content="Zoom out">
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
					<Tooltip content="Zoom in">
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

					const containerAspect = () => {
						if (containerBounds.width && containerBounds.height) {
							return (
								(containerBounds.width - padding * 2) /
								(containerBounds.height - padding * 2)
							);
						}

						return 1;
					};

					const frameAspect = () =>
						currentFrame().width / currentFrame().data.height;

					const size = () => {
						if (frameAspect() < containerAspect()) {
							const height = (containerBounds.height ?? 0) - padding * 1;

							return {
								width: height * frameAspect(),
								height,
							};
						}

						const width = (containerBounds.width ?? 0) - padding * 2;

						return {
							width,
							height: width / frameAspect(),
						};
					};

					return (
						<div class="flex overflow-hidden absolute inset-0 justify-center items-center h-full">
							<canvas
								style={{
									width: `${size().width - padding * 2}px`,
									height: `${size().height}px`,
								}}
								class="bg-blue-50 rounded"
								ref={canvasRef}
								id="canvas"
								width={currentFrame().width}
								height={currentFrame().data.height}
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
