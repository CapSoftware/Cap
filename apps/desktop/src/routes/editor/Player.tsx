import { Select as KSelect } from "@kobalte/core/select";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { debounce } from "@solid-primitives/scheduled";
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { cx } from "cva";
import {
	For,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	onMount,
	Show,
} from "solid-js";

import Tooltip from "~/components/Tooltip";
import { captionsStore } from "~/store/captions";
import { commands } from "~/utils/tauri";
import AspectRatioSelect from "./AspectRatioSelect";
import {
	type EditorPreviewQuality,
	FPS,
	serializeProjectConfiguration,
	useEditorContext,
} from "./context";
import { preloadCropVideoFull } from "./cropVideoPreloader";
import { MaskOverlay } from "./MaskOverlay";
import { PerformanceOverlay } from "./PerformanceOverlay";
import { TextOverlay } from "./TextOverlay";
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

export function PlayerContent() {
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
		{ label: "Full", value: "full" as EditorPreviewQuality },
		{ label: "Half", value: "half" as EditorPreviewQuality },
		{ label: "Quarter", value: "quarter" as EditorPreviewQuality },
	];

	// Load captions on mount
	onMount(async () => {
		if (editorInstance?.path) {
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
						settings: { ...captionsStore.state.settings },
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

	const handlePreviewQualityChange = async (quality: EditorPreviewQuality) => {
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
		<div class="flex flex-col flex-1 min-h-0">
			<div class="flex items-center justify-between gap-3 p-3">
				<div class="flex items-center gap-3">
					<AspectRatioSelect />
					<EditorButton
						tooltipText="Crop Video"
						onClick={cropDialogHandler}
						onMouseEnter={preloadCropVideoFull}
						onFocus={preloadCropVideoFull}
						leftIcon={<IconCapCrop class="w-5 text-gray-12" />}
					>
						Crop
					</EditorButton>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-xs font-medium text-gray-11">Preview quality</span>
					<KSelect<{ label: string; value: EditorPreviewQuality }>
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
							<KSelect.Value<{
								label: string;
								value: EditorPreviewQuality;
							}> class="flex-1 text-left truncate">
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
	const {
		latestFrame,
		canvasControls,
		performanceMode,
		setPerformanceMode,
		project,
		editorState,
	} = useEditorContext();

	type KeyboardOverlayEvent = {
		active_modifiers: string[];
		key: string;
		time_ms: number;
		down: boolean;
	};

	type SegmentKeyboardEvents = {
		segment_index: number;
		events: KeyboardOverlayEvent[];
	};

	const [keyboardEventsBySegment] = createResource(async () => {
		try {
			return await invoke<SegmentKeyboardEvents[]>("get_keyboard_events");
		} catch {
			return [];
		}
	});

	const hasRenderedFrame = () => canvasControls()?.hasRenderedFrame() ?? false;

	const handleContextMenu = async (e: MouseEvent) => {
		e.preventDefault();
		const menu = await Menu.new({
			items: [
				{
					id: "performance-mode",
					text: performanceMode() ? "✓ Performance Mode" : "Performance Mode",
					action: () => setPerformanceMode(!performanceMode()),
				},
			],
		});
		menu.popup();
	};

	const canvasInitializedRef = { current: false };
	const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | null>(
		null,
	);

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	const containerBounds = createElementBounds(canvasContainerRef);

	const [debouncedBounds, setDebouncedBounds] = createSignal({
		width: 0,
		height: 0,
	});

	const currentSourceTime = createMemo(() => {
		const timeline = project.timeline?.segments ?? [];
		if (timeline.length === 0) return null;

		const timelineTime = Math.max(
			editorState.previewTime ?? editorState.playbackTime,
			0,
		);
		let consumed = 0;

		for (
			let timelineIndex = 0;
			timelineIndex < timeline.length;
			timelineIndex++
		) {
			const segment = timeline[timelineIndex];
			if (!segment) continue;
			const duration = (segment.end - segment.start) / segment.timescale;

			if (timelineTime <= consumed + duration) {
				const elapsed = timelineTime - consumed;
				return {
					recordingSegmentIndex: segment.recordingSegment ?? timelineIndex,
					sourceTimeSec: segment.start + elapsed * segment.timescale,
				};
			}

			consumed += duration;
		}

		const last = timeline[timeline.length - 1];
		if (!last) return null;
		return {
			recordingSegmentIndex: last.recordingSegment ?? timeline.length - 1,
			sourceTimeSec: last.end,
		};
	});

	const activeShortcut = createMemo(() => {
		const recentWindowMs = 850;
		const modifierKeys = new Set([
			"Meta",
			"MetaLeft",
			"MetaRight",
			"Command",
			"Cmd",
			"Ctrl",
			"Control",
			"ControlLeft",
			"ControlRight",
			"Alt",
			"Option",
			"Opt",
			"AltLeft",
			"AltRight",
			"Shift",
			"ShiftLeft",
			"ShiftRight",
		]);
		const modifierOrder = new Map([
			["⌃", 0],
			["⌥", 1],
			["⇧", 2],
			["⌘", 3],
		]);

		const isModifierKey = (key: string) => modifierKeys.has(key);

		const normalizeModifier = (
			modifier: string,
		): "⌘" | "⌃" | "⌥" | "⇧" | null => {
			switch (modifier) {
				case "Meta":
				case "Command":
				case "Cmd":
				case "Super":
				case "Win":
					return "⌘";
				case "Ctrl":
				case "Control":
					return "⌃";
				case "Alt":
				case "Option":
				case "Opt":
				case "AltGraph":
					return "⌥";
				case "Shift":
					return "⇧";
				default:
					return null;
			}
		};

		const normalizeKey = (key: string) => {
			switch (key) {
				case "Left":
					return "←";
				case "Right":
					return "→";
				case "Up":
					return "↑";
				case "Down":
					return "↓";
				case "Enter":
				case "Return":
					return "Return";
				case "Escape":
					return "Esc";
				case "Backspace":
					return "Delete";
				case "Delete":
					return "Del";
				case "CapsLock":
					return "Caps";
				case "PageUp":
					return "Page Up";
				case "PageDown":
					return "Page Down";
				case "Space":
					return "Space";
				default:
					return key.toUpperCase();
			}
		};

		const source = currentSourceTime();
		const segments = keyboardEventsBySegment();
		if (!source || !segments) return null;

		const segmentEvents =
			segments.find((s) => s.segment_index === source.recordingSegmentIndex)
				?.events ?? [];
		if (segmentEvents.length === 0) return null;

		const nowMs = source.sourceTimeSec * 1000;
		const active = new Map<string, { label: string; downTime: number }>();
		let lastRecent: { label: string; downTime: number } | null = null;

		for (const event of segmentEvents) {
			if (event.time_ms > nowMs) break;
			if (isModifierKey(event.key)) continue;

			const normalizedModifiers = event.active_modifiers
				.filter((modifier) => modifier !== event.key)
				.map(normalizeModifier)
				.filter(
					(modifier): modifier is "⌘" | "⌃" | "⌥" | "⇧" => modifier !== null,
				)
				.sort()
				.filter((value, index, values) => values.indexOf(value) === index)
				.sort(
					(a, b) =>
						(modifierOrder.get(a) ?? Number.POSITIVE_INFINITY) -
						(modifierOrder.get(b) ?? Number.POSITIVE_INFINITY),
				);
			const label = [...normalizedModifiers, normalizeKey(event.key)].join(
				" + ",
			);

			if (event.down) {
				const state = { label, downTime: event.time_ms };
				active.set(event.key, state);
				if (!lastRecent || state.downTime > lastRecent.downTime) {
					lastRecent = state;
				}
			} else {
				active.delete(event.key);
			}
		}

		const activeValues = [...active.values()].sort(
			(a, b) => b.downTime - a.downTime,
		);
		if (activeValues.length > 0) {
			return {
				label: activeValues[0]?.label ?? "",
				opacity: 1,
				scale: 1.05,
			};
		}

		if (lastRecent && nowMs - lastRecent.downTime <= recentWindowMs) {
			const remaining = 1 - (nowMs - lastRecent.downTime) / recentWindowMs;
			const clamped = Math.min(Math.max(remaining, 0), 1);
			return {
				label: lastRecent.label,
				opacity: clamped,
				scale: 1 + 0.05 * clamped,
			};
		}

		return null;
	});

	const updateDebouncedBounds = debounce(
		(width: number, height: number) => setDebouncedBounds({ width, height }),
		100,
	);

	createEffect(() => {
		const width = containerBounds.width ?? 0;
		const height = containerBounds.height ?? 0;
		if (debouncedBounds().width === 0 && debouncedBounds().height === 0) {
			setDebouncedBounds({ width, height });
		} else {
			updateDebouncedBounds(width, height);
		}
	});

	createEffect(() => {
		const canvas = canvasRef();
		const controls = canvasControls();
		console.warn("[Player] Canvas init effect", {
			hasCanvas: !!canvas,
			hasControls: !!controls,
			alreadyInit: canvasInitializedRef.current,
		});
		if (canvasInitializedRef.current || !canvas || !controls) return;

		console.warn("[Player] Initializing canvas", {
			canvasId: canvas.id,
			isConnected: canvas.isConnected,
		});
		controls.initDirectCanvas(canvas);
		canvasInitializedRef.current = true;
		console.warn("[Player] Canvas initialized successfully");
	});

	const padding = 4;
	const frameWidth = () => latestFrame()?.width ?? 1920;
	const frameHeight = () => latestFrame()?.height ?? 1080;

	const availableWidth = () =>
		Math.max(debouncedBounds().width - padding * 2, 0);
	const availableHeight = () =>
		Math.max(debouncedBounds().height - padding * 2, 0);

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

		return { width, height };
	};

	const hasFrame = () => !!latestFrame();

	return (
		<div
			ref={setCanvasContainerRef}
			class="relative flex-1 justify-center items-center"
			style={{ contain: "layout style" }}
			onContextMenu={handleContextMenu}
		>
			<Show when={activeShortcut()}>
				{(shortcut) => (
					<div class="absolute left-0 right-0 z-20 flex justify-center bottom-3 pointer-events-none">
						<div
							class="rounded-md border border-gray-6 bg-gray-1/95 px-3 py-1.5 shadow-lg backdrop-blur-sm transition-[opacity,transform] duration-75"
							style={{
								opacity: shortcut().opacity,
								transform: `scale(${shortcut().scale})`,
							}}
						>
							<div class="flex items-center gap-1.5 text-[11px] text-gray-10 uppercase tracking-wide">
								<span>Shortcut</span>
							</div>
							<div class="mt-0.5 flex flex-wrap items-center gap-1">
								<For each={shortcut().label.split(" + ")}>
									{(part) => (
										<kbd class="rounded border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[11px] font-mono font-medium text-gray-12 shadow-sm">
											{part}
										</kbd>
									)}
								</For>
							</div>
						</div>
					</div>
				)}
			</Show>
			<div
				class="flex overflow-hidden absolute inset-0 justify-center items-center h-full"
				style={{ visibility: hasFrame() ? "visible" : "hidden" }}
			>
				<div
					class="relative"
					style={{
						width: `${size().width}px`,
						height: `${size().height}px`,
						contain: "strict",
					}}
				>
					<canvas
						style={{
							width: `${size().width}px`,
							height: `${size().height}px`,
							"image-rendering": "auto",
							"background-color": "#000000",
							...(hasRenderedFrame() ? gridStyle : {}),
						}}
						ref={setCanvasRef}
						id="canvas"
					/>
					<Show when={hasFrame()}>
						<MaskOverlay size={size()} />
						<TextOverlay size={size()} />
						<PerformanceOverlay size={size()} />
					</Show>
				</div>
			</div>
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
