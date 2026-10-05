import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { debounce } from "@solid-primitives/scheduled";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onMount,
	Show,
	untrack,
} from "solid-js";
import Tooltip from "~/components/Tooltip";
import { captionsStore } from "~/store/captions";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands } from "~/utils/tauri";
import AspectRatioSelect from "./AspectRatioSelect";
import { BufferingStatus, createBufferingDisplay } from "./buffering-status";
import {
	CanvasElementsOverlay,
	SnapGuidesOverlay,
} from "./CanvasElementsOverlay";
import { CaptionOverlay } from "./CaptionOverlay";
import { CaptionsRegenerateBadge } from "./CaptionsRegenerateBadge";
import { createCaptionTrackSegments } from "./captions";
import {
	type EditorPreviewQuality,
	FPS,
	MAX_ZOOM_IN,
	useEditorContext,
} from "./context";
import { FrameButton } from "./FrameButton";
import type { FocusMode } from "./focus-mode";
import { ImageOverlay } from "./image-overlay";
import { MaskOverlay } from "./MaskOverlay";
import { PerformanceOverlay } from "./PerformanceOverlay";
import { createPlaybackBuffering, onPlayRequest } from "./playback-buffering";
import { usePreparingEditor } from "./preparing-editor-context";
import { PreparingFrame } from "./preparing-frame";
import {
	createPreviewBoundsReaction,
	createPreviewBoundsUpdater,
} from "./preview-bounds";
import { SplitScreenOverlay } from "./SplitScreenOverlay";
import { TextOverlay } from "./TextOverlay";
import { sliderToZoom, ZOOM_STEP, zoomToSlider } from "./Timeline/zoom";
import { EditorButton, Slider } from "./ui";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { formatTime } from "./utils";
import { WaveformOverlay } from "./waveform-overlay";

const READOUT_INTERVAL_MS = 100;

export function PlayerContent(props: {
	compactness?: number;
	focusMode?: FocusMode;
}) {
	const {
		previewStyle,
		selectedStyle,
		toggleStyleGroup,
		styleScopeToken,
		project,
		flushProjectConfig,
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
		playbackIntent,
		requestHandoffPlayback,
		handoffPlaybackPending,
		meta,
	} = useEditorContext();

	let panelRef: HTMLDivElement | undefined;
	const [panelHovered, setPanelHovered] = createSignal(false);
	const [previewPointerDown, setPreviewPointerDown] = createSignal(false);

	createEventListener(window, "mouseup", (event) => {
		if (event.button !== 0 || !previewPointerDown()) return;
		const bounds = panelRef?.getBoundingClientRect();
		setPanelHovered(
			!!bounds &&
				event.clientX >= bounds.left &&
				event.clientX < bounds.right &&
				event.clientY >= bounds.top &&
				event.clientY < bounds.bottom,
		);
		setPreviewPointerDown(false);
	});
	createEventListener(window, "blur", () => {
		setPanelHovered(false);
		setPreviewPointerDown(false);
	});

	const previewOptions = [
		{ label: "Full", value: "full" as EditorPreviewQuality },
		{ label: "Half", value: "half" as EditorPreviewQuality },
		{ label: "Quarter", value: "quarter" as EditorPreviewQuality },
	];

	const zoomHint = () =>
		ostype() === "windows"
			? "Hold Ctrl and scroll, or press Ctrl +/- to zoom"
			: "Pinch, or press Cmd +/- to zoom";

	// Load captions on mount
	onMount(async () => {
		if (editorInstance?.path) {
			await captionsStore.loadCaptions(editorInstance.path);

			if (editorInstance && project) {
				const updatedProject = { ...project };
				let projectDidChange = false;
				const captionSegments = captionsStore.state.segments;
				const hasStoredCaptions = captionSegments.length > 0;

				if (!updatedProject.captions && hasStoredCaptions) {
					updatedProject.captions = {
						segments: captionSegments.map((segment) => ({
							id: segment.id,
							start: segment.start,
							end: segment.end,
							text: segment.text,
						})),
						settings: { ...captionsStore.state.settings },
						sourceTimed: true,
					};
					projectDidChange = true;
				}

				if (
					hasStoredCaptions &&
					(updatedProject.timeline?.captionSegments?.length ?? 0) === 0
				) {
					updatedProject.timeline = {
						...(updatedProject.timeline ?? {
							segments: [
								{
									start: 0,
									end: editorInstance.recordingDuration,
									timescale: 1,
								},
							],
							zoomSegments: [],
							sceneSegments: [],
							maskSegments: [],
							textSegments: [],
							styleSegments: [],
							imageSegments: [],
							camera3dSegments: [],
							transitions: [],
						}),
						captionSegments: createCaptionTrackSegments(captionSegments),
					};
					projectDidChange = true;
				}

				const hasCaptionTrackData =
					hasStoredCaptions ||
					(updatedProject.timeline?.captionSegments?.length ?? 0) > 0;

				if (hasCaptionTrackData) {
					setEditorState(
						"timeline",
						"tracks",
						"caption",
						updatedProject.captions?.settings?.enabled ?? true,
					);
				}

				if (projectDidChange) {
					setProject(updatedProject);
					await flushProjectConfig();
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

	const isAtEnd = createMemo(() => {
		const total = totalDuration();
		return total > 0 && total - editorState.playbackTime <= 0.1;
	});

	// While playing, the readout's frame digits change faster than they can be
	// read, and each change costs the page a layout; it keeps up at 10 Hz.
	let readoutAt = 0;
	const readoutSeconds = createMemo((shown: number) => {
		const seconds = Math.max(
			editorState.previewTime ?? editorState.playbackTime,
			0,
		);
		if (!editorState.playing) return seconds;
		const now = performance.now();
		if (now - readoutAt < READOUT_INTERVAL_MS) return shown;
		readoutAt = now;
		return seconds;
	}, 0);

	const cropDialogHandler = async () => {
		const background = selectedStyle()
			? (selectedStyle()?.overrides.background ?? previewStyle().background)
			: project.background;
		if (selectedStyle() && !selectedStyle()?.overrides.background)
			toggleStyleGroup("background", true);
		const styleTarget = editorState.styleEditIndex;
		const scopeToken = styleScopeToken();
		const display = editorInstance.recordings.segments[0].display;
		setDialog({
			open: true,
			type: "crop",
			styleTarget,
			scopeToken,
			position: {
				...(background.crop?.position ?? { x: 0, y: 0 }),
			},
			size: {
				...(background.crop?.size ?? {
					x: display.width,
					y: display.height,
				}),
			},
		});
		const pending = requestHandoffPlayback(false);
		if (pending) {
			await pending;
			return;
		}
		await commands.stopPlayback();
		setEditorState("playing", false);
	};

	const handlePreviewQualityChange = async (quality: EditorPreviewQuality) => {
		if (quality === previewQuality()) return;

		const wasPlaying = playbackIntent();
		const currentFrame = Math.max(
			Math.floor(editorState.playbackTime * FPS),
			0,
		);

		setPreviewQuality(quality);

		if (!wasPlaying) return;
		const pending = requestHandoffPlayback(true);
		if (pending) {
			await pending;
			return;
		}

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
		if (isAtEnd() && playbackIntent()) {
			const pending = requestHandoffPlayback(false);
			if (pending) return;
			commands.stopPlayback();
			setEditorState("playing", false);
		}
	});

	// On the web the frame Play starts from can still be loading, so the
	// button shows the press at once rather than when playback begins.
	const [playPending, setPlayPending] = createSignal(false);
	let playRequest = 0;
	const shownPlaying = () => playPending() || (playbackIntent() && !isAtEnd());
	const buffering = createPlaybackBuffering();
	const bufferingDisplay = createBufferingDisplay(
		() => playPending() || buffering(),
		shownPlaying,
	);
	const playBusy = () => bufferingDisplay.shown() && shownPlaying();

	const handlePlayPauseClick = async () => {
		if (playPending()) {
			// Pressed again before playback began: it doesn't start.
			playRequest++;
			setPlayPending(false);
			return;
		}
		const pending = requestHandoffPlayback(
			isAtEnd() || !playbackIntent(),
			isAtEnd() ? 0 : undefined,
		);
		if (pending) {
			await pending;
			return;
		}
		const request = ++playRequest;
		const current = () => request === playRequest;
		try {
			if (isAtEnd()) {
				setPlayPending(true);
				await commands.stopPlayback();
				setEditorState("playbackTime", 0);
				await commands.seekTo(0);
				if (!current()) return;
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			} else if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			} else {
				setPlayPending(true);
				await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				if (!current()) return;
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			}
			if (!current() && editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			if (editorState.playing) setEditorState("previewTime", null);
		} catch (error) {
			console.error("Error handling play/pause:", error);
			setEditorState("playing", false);
		} finally {
			if (current()) setPlayPending(false);
		}
	};

	// Play pressed on the loading screen starts once the editor is here.
	onPlayRequest((playing) => {
		if (playing !== shownPlaying()) void handlePlayPauseClick();
	});

	if (import.meta.env.DEV) {
		createTauriEventListener<boolean>(
			{
				listen: (callback) =>
					getCurrentWebviewWindow().listen(
						"cap-dev-set-editor-playback",
						callback,
					),
			},
			(playing) => {
				if (shownPlaying() !== playing) void handlePlayPauseClick();
			},
		);
	}

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
					editorState.timeline.transform.zoom / ZOOM_STEP,
					editorState.playbackTime,
				),
		},
		{
			combo: "Mod+-",
			handler: () =>
				editorState.timeline.transform.updateZoom(
					editorState.timeline.transform.zoom * ZOOM_STEP,
					editorState.playbackTime,
				),
		},
		{
			combo: "Mod+Digit0",
			handler: () => {
				editorState.timeline.transform.updateZoom(zoomOutLimit(), 0);
				editorState.timeline.transform.setPosition(0);
			},
		},
		{
			combo: "Space",
			handler: async () => {
				const prevTime = editorState.previewTime;

				if (!playbackIntent()) {
					if (prevTime !== null) setEditorState("playbackTime", prevTime);

					if (!handoffPlaybackPending())
						await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				}

				await handlePlayPauseClick();
			},
		},
	]);

	return (
		<div
			ref={panelRef}
			class="flex flex-col flex-1 min-h-0"
			style={{
				"--preview-controls-opacity":
					panelHovered() || previewPointerDown() ? 1 : 0,
			}}
			onMouseEnter={() => setPanelHovered(true)}
			onMouseLeave={() => setPanelHovered(false)}
		>
			<div
				class="flex overflow-x-auto relative z-10 flex-none flex-row gap-3 items-center px-3"
				style={{ height: `${44 - 4 * (props.compactness ?? 0)}px` }}
			>
				<div class="flex flex-1 gap-0.5 items-center min-w-fit">
					<Show when={!selectedStyle()}>
						<AspectRatioSelect />
					</Show>
					<Show when={!meta().audioOnly && !project.hideDisplay}>
						<EditorButton
							variant="text"
							tooltipText="Crop Video"
							onClick={cropDialogHandler}
							leftIcon={<IconCapCrop />}
						>
							<span class="max-[1200px]:hidden">Crop</span>
						</EditorButton>
						<FrameButton />
					</Show>
				</div>
				<div class="flex flex-row flex-none gap-2 items-center">
					<Tooltip content="How sharp playback looks while you edit. Exports always render at full quality.">
						<span class="text-xs text-ed-text-2 cursor-default">
							Preview quality
						</span>
					</Tooltip>
					<div
						role="group"
						aria-label="Preview quality"
						class="inline-flex gap-0.5 p-0.5 rounded-lg shrink-0 bg-ed-ctl"
					>
						<For each={previewOptions}>
							{(option) => {
								const selected = () => previewQuality() === option.value;
								return (
									<button
										type="button"
										title={`${option.label} preview quality`}
										aria-label={`${option.label} preview quality`}
										aria-pressed={selected()}
										onClick={() => handlePreviewQualityChange(option.value)}
										class={cx(
											"flex items-center px-2.5 h-6 text-xs font-medium rounded-md transition-colors duration-100",
											selected()
												? "bg-ed-card text-ed-text-1 shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-white/12 dark:shadow-none"
												: "text-ed-text-2 hover:text-ed-text-1",
										)}
									>
										{option.label}
									</button>
								);
							}}
						</For>
					</div>
				</div>
			</div>
			<PreviewCanvas
				focusMode={props.focusMode}
				buffering={
					bufferingDisplay.shown()
						? { playing: shownPlaying(), slow: bufferingDisplay.slow() }
						: null
				}
				onPreviewMouseDown={(event) => {
					if (event.button === 0) setPreviewPointerDown(true);
				}}
			/>
			<div
				class="flex overflow-x-auto relative z-10 flex-none flex-row gap-3 items-center px-3.5"
				style={{ height: `${48 - 4 * (props.compactness ?? 0)}px` }}
			>
				<div class="flex flex-1 items-center min-w-fit whitespace-nowrap">
					<Time class="font-medium text-ed-text-1" seconds={readoutSeconds()} />
					<span class="text-[13px] tabular-nums text-ed-text-3"> / </span>
					<Time seconds={totalDuration()} />
				</div>
				<div class="flex flex-row flex-none gap-3.5 items-center">
					<button
						type="button"
						aria-label="Skip to start"
						class="text-ed-text-2 transition-opacity hover:opacity-70 will-change-[opacity]"
						onClick={async () => {
							const pending = requestHandoffPlayback(false, 0);
							if (pending) {
								editorState.timeline.transform.setPosition(0);
								await pending;
								return;
							}
							await commands.stopPlayback();
							setEditorState("playing", false);
							setEditorState("playbackTime", 0);
							editorState.timeline.transform.setPosition(0);
						}}
					>
						<IconCapPrev class="size-3.5" />
					</button>
					<Tooltip kbd={["Space"]} content="Play/Pause video">
						<button
							type="button"
							aria-label={shownPlaying() ? "Pause video" : "Play video"}
							aria-busy={playBusy() || undefined}
							onClick={handlePlayPauseClick}
							class="flex relative justify-center items-center rounded-full transition-opacity size-8 bg-ed-text-1 text-ed-card hover:opacity-90"
						>
							{shownPlaying() ? (
								<IconCapPause class="size-3" />
							) : (
								<IconCapPlay class="size-3" />
							)}
							<Show when={playBusy()}>
								<span
									aria-hidden="true"
									class="absolute -inset-[3px] rounded-full border-2 border-transparent border-t-ed-text-1 animate-spin motion-reduce:animate-none"
								/>
							</Show>
						</button>
					</Tooltip>
					<button
						type="button"
						class="text-ed-text-2 transition-opacity hover:opacity-70 will-change-[opacity]"
						onClick={async () => {
							const pending = requestHandoffPlayback(false, totalDuration());
							if (pending) {
								await pending;
								return;
							}
							await commands.stopPlayback();
							setEditorState("playing", false);
							setEditorState("playbackTime", totalDuration());
						}}
					>
						<IconCapNext class="size-3.5" />
					</button>
				</div>
				<div class="flex flex-row flex-1 gap-0.5 justify-end items-center min-w-fit">
					<EditorButton<typeof KToggleButton>
						tooltipText="Toggle Split"
						kbd={["S"]}
						pressed={editorState.timeline.interactMode === "split"}
						onChange={(v: boolean) =>
							setEditorState("timeline", "interactMode", v ? "split" : "seek")
						}
						as={KToggleButton}
						variant="danger"
						leftIcon={<IconCapScissors />}
					/>
					<div class="mx-1.5 w-px h-4 shrink-0 bg-ed-line-strong" />
					<div class="flex flex-row gap-0.5 items-center" title={zoomHint()}>
						<EditorButton
							tooltipText="Zoom out"
							kbd={["meta", "-"]}
							onClick={() => {
								editorState.timeline.transform.updateZoom(
									editorState.timeline.transform.zoom * ZOOM_STEP,
									editorState.playbackTime,
								);
							}}
							leftIcon={<IconCapZoomOut />}
						/>
						<Slider
							class="w-18 shrink-0"
							thumbClass="size-3! -top-[4.5px]!"
							minValue={0}
							maxValue={1}
							step={0.001}
							value={[
								zoomToSlider(
									editorState.timeline.transform.zoom,
									MAX_ZOOM_IN,
									zoomOutLimit(),
								),
							]}
							onChange={([v]) => {
								editorState.timeline.transform.updateZoom(
									sliderToZoom(v ?? 0, MAX_ZOOM_IN, zoomOutLimit()),
									editorState.playbackTime,
								);
							}}
							formatTooltip={() =>
								`${editorState.timeline.transform.zoom.toFixed(
									0,
								)} seconds visible`
							}
						/>
						<EditorButton
							tooltipText="Zoom in"
							kbd={["meta", "+"]}
							onClick={() => {
								editorState.timeline.transform.updateZoom(
									editorState.timeline.transform.zoom / ZOOM_STEP,
									editorState.playbackTime,
								);
							}}
							leftIcon={<IconCapZoomIn />}
						/>
					</div>
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

const prefersReducedMotion = () =>
	window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function FocusModeIcon(props: { active: boolean }) {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-4"
			aria-hidden="true"
		>
			<Show
				when={props.active}
				fallback={
					<path d="M2.75 6V4.25c0-.83.67-1.5 1.5-1.5H6M10 2.75h1.75c.83 0 1.5.67 1.5 1.5V6M13.25 10v1.75c0 .83-.67 1.5-1.5 1.5H10M6 13.25H4.25c-.83 0-1.5-.67-1.5-1.5V10" />
				}
			>
				<path d="M6 2.75V4.5c0 .83-.67 1.5-1.5 1.5H2.75M10 2.75V4.5c0 .83.67 1.5 1.5 1.5h1.75M13.25 10H11.5c-.83 0-1.5.67-1.5 1.5v1.75M2.75 10H4.5c.83 0 1.5.67 1.5 1.5v1.75" />
			</Show>
		</svg>
	);
}

function PreviewCanvas(props: {
	onPreviewMouseDown: (event: MouseEvent) => void;
	focusMode?: FocusMode;
	buffering?: { playing: boolean; slow: boolean } | null;
}) {
	const preparing = usePreparingEditor();
	const {
		latestFrame,
		canvasControls,
		performanceMode,
		setPerformanceMode,
		editorState,
	} = useEditorContext();

	const hasRenderedFrame = () => canvasControls()?.hasRenderedFrame() ?? false;
	const [hasShownFrame, setHasShownFrame] = createSignal(false);
	createEffect(() => {
		if (latestFrame() && hasRenderedFrame()) setHasShownFrame(true);
	});
	createEffect(
		on(
			() => editorState.playing,
			(playing) => {
				preparing?.setOrdinaryAdvancing(
					playing,
					Math.max(Math.floor(editorState.playbackTime * FPS), 0),
				);
			},
		),
	);

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

	let initializedCanvas: HTMLCanvasElement | undefined;
	const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | null>(
		null,
	);

	const [canvasContainerRef, setCanvasContainerRef] =
		createSignal<HTMLDivElement>();
	createEventListener(
		canvasContainerRef,
		"mousedown",
		props.onPreviewMouseDown,
		{
			capture: true,
		},
	);
	const containerBounds = createElementBounds(canvasContainerRef, {
		trackMutation: false,
	});

	const [debouncedBounds, setDebouncedBounds] = createSignal({
		width: 0,
		height: 0,
	});

	const updateDebouncedBounds = debounce(
		(width: number, height: number) => setDebouncedBounds({ width, height }),
		100,
	);

	const boundsUpdater = createPreviewBoundsUpdater({
		current: () => untrack(debouncedBounds),
		measure: () => {
			const container = canvasContainerRef();
			if (!container?.isConnected) return;
			const { width, height } = container.getBoundingClientRect();
			return { width, height, connected: container.isConnected };
		},
		commit: setDebouncedBounds,
		defer: ({ width, height }) => updateDebouncedBounds(width, height),
		cancel: updateDebouncedBounds.clear,
		requestFrame: (callback) => requestAnimationFrame(callback),
		cancelFrame: (id) => cancelAnimationFrame(id),
	});

	// Only track container-size and frame-availability changes. Reading debouncedBounds()
	// reactively here would resubscribe the effect to its own debounced write:
	// the trailing setter rewrites debouncedBounds with a fresh object every
	// 100ms, which would re-run this effect and re-arm the timer forever,
	// spinning the whole preview graph at ~10Hz while the editor sits idle.
	const hasFrame = createPreviewBoundsReaction({
		bounds: () => ({
			width: containerBounds.width ?? 0,
			height: containerBounds.height ?? 0,
		}),
		hasFrame: () => !!latestFrame(),
		updater: boundsUpdater,
	});
	// The web page keeps its snapshot of the video up until the preview shows
	// a frame of its own.
	const previewVisible = () =>
		preparing?.model.rendered() === true || hasShownFrame();
	if (import.meta.env.VITE_CAP_WEB_EDITOR === "true")
		createEffect(() => {
			if (previewVisible())
				window.parent.postMessage(
					{ kind: "cap-editor-painted", version: 1 },
					window.location.origin,
				);
		});

	createEffect(() => {
		const canvas = canvasRef();
		const controls = canvasControls();
		if (!canvas || !controls || initializedCanvas === canvas) return;

		controls.initDirectCanvas(canvas);
		initializedCanvas = canvas;
	});

	const padding = 16;
	// Every frame arrives as a new object; the preview's size only changes
	// with its dimensions.
	const frameWidth = createMemo(() => latestFrame()?.width ?? 1920);
	const frameHeight = createMemo(() => latestFrame()?.height ?? 1080);

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

	const size = createMemo(
		() => {
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
		},
		undefined,
		{
			equals: (previous, next) =>
				previous?.width === next.width && previous?.height === next.height,
		},
	);

	createEffect(() => {
		const frame = latestFrame();
		if (frame && hasRenderedFrame()) {
			preparing?.acknowledgeOrdinaryFrame(frame, size());
		}
	});

	// Entering or leaving focus mode resizes the preview at once rather than
	// after the resize debounce, and glides it from where it was to where it
	// lands. The layout can move again while the glide runs (the browser
	// going fullscreen a moment later, the page's bar stepping aside), so for
	// a short while each move restarts the glide from wherever the preview is
	// shown. Positions are kept in the embedding page's coordinates, so the
	// glide holds still on screen when this frame itself moves. The canvas
	// measures its box under the glide's transform, so it measures again once
	// the glide ends to stay sharp.
	let frameRef: HTMLDivElement | undefined;
	let focusFrom: DOMRect | undefined;
	let focusGlide: Animation | undefined;
	// Where the preview's box last landed, untransformed.
	let focusTarget: DOMRect | undefined;
	let focusSettlesAt = 0;
	let focusGlideRun = 0;
	const onPage = (rect: DOMRect) => {
		let host: DOMRect | undefined;
		try {
			host = window.frameElement?.getBoundingClientRect();
		} catch {}
		return new DOMRect(
			rect.left + (host?.left ?? 0),
			rect.top + (host?.top ?? 0),
			rect.width,
			rect.height,
		);
	};
	// Once the layout has moved the box no longer says where the preview is
	// shown, so that comes from the last landing spot and the glide's current
	// transform instead.
	const shownRect = (layoutMoved: boolean) => {
		if (!frameRef) return;
		if (focusGlide && focusTarget) {
			const transform = getComputedStyle(frameRef).transform;
			const matrix = new DOMMatrixReadOnly(
				transform === "none" ? undefined : transform,
			);
			const width = focusTarget.width * matrix.a;
			const height = focusTarget.height * matrix.d;
			return new DOMRect(
				focusTarget.left + focusTarget.width / 2 + matrix.e - width / 2,
				focusTarget.top + focusTarget.height / 2 + matrix.f - height / 2,
				width,
				height,
			);
		}
		return layoutMoved ? focusTarget : onPage(frameRef.getBoundingClientRect());
	};
	const glideFrom = (from: DOMRect | undefined) => {
		const container = canvasContainerRef();
		if (!container?.isConnected || !hasFrame()) return;
		const { width, height } = container.getBoundingClientRect();
		if (width <= 0 || height <= 0) return;
		focusGlide?.cancel();
		focusGlide = undefined;
		updateDebouncedBounds.clear();
		setDebouncedBounds({ width, height });
		const run = ++focusGlideRun;
		// The new size reaches the page once this update finishes, still
		// before the next frame is drawn.
		queueMicrotask(() => {
			if (run !== focusGlideRun || !frameRef?.isConnected) return;
			const to = onPage(frameRef.getBoundingClientRect());
			focusTarget = to;
			if (!from || from.width < 2 || to.width < 2 || prefersReducedMotion())
				return;
			const scale = from.width / to.width;
			const dx = from.left + from.width / 2 - (to.left + to.width / 2);
			const dy = from.top + from.height / 2 - (to.top + to.height / 2);
			if (Math.abs(scale - 1) < 0.005 && Math.hypot(dx, dy) < 1) return;
			const glide = frameRef.animate(
				[
					{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
					{ transform: "none" },
				],
				{ duration: 380, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
			);
			// Resolved now, so the frame being drawn already starts where the
			// preview was rather than at its new size.
			glide.currentTime = 0;
			focusGlide = glide;
			glide.onfinish = () => {
				if (focusGlide !== glide) return;
				focusGlide = undefined;
				window.dispatchEvent(new Event("resize"));
			};
		});
	};
	props.focusMode?.onBeforeChange(() => {
		focusFrom = shownRect(false);
	});
	createEffect(
		on(
			() => props.focusMode?.active(),
			() => {
				const from = focusFrom;
				focusFrom = undefined;
				focusSettlesAt = performance.now() + 900;
				glideFrom(from);
			},
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => [containerBounds.width, containerBounds.height],
			() => {
				if (performance.now() < focusSettlesAt) glideFrom(shownRect(true));
			},
			{ defer: true },
		),
	);

	return (
		<div
			ref={setCanvasContainerRef}
			class="relative flex-1 justify-center items-center min-h-0 bg-ed-card"
			style={{ contain: "layout style" }}
			onContextMenu={handleContextMenu}
		>
			<CaptionsRegenerateBadge class="absolute top-3 right-3 z-20" />
			<Show when={!hasFrame() && props.buffering}>
				{(status) => (
					<div class="flex absolute inset-0 z-20 justify-center items-center p-4 pointer-events-none">
						<BufferingStatus playing={status().playing} slow={status().slow} />
					</div>
				)}
			</Show>
			<Show when={preparing?.model.rendered() && !preparing?.ordinaryReady()}>
				<div class="absolute inset-0 flex items-center justify-center p-4 z-10 pointer-events-none">
					<PreparingFrame fallback={false} />
				</div>
			</Show>
			<div
				class="flex overflow-hidden absolute inset-0 justify-center items-center h-full transition-opacity duration-300 ease-out motion-reduce:transition-none"
				style={{
					visibility: hasFrame() ? "visible" : "hidden",
					opacity: previewVisible() ? 1 : 0,
				}}
			>
				<div
					ref={frameRef}
					class="relative"
					style={{
						width: `${size().width}px`,
						height: `${size().height}px`,
						contain: "size layout style",
					}}
				>
					<Show when={canvasControls()} keyed>
						{(_controls) => (
							<canvas
								class="shadow-[0_0_0_1px_var(--ed-line-strong)]"
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
						)}
					</Show>
					<Show when={hasFrame()}>
						<Show when={props.buffering}>
							{(status) => (
								<BufferingStatus
									playing={status().playing}
									slow={status().slow}
									class="absolute top-2.5 left-2.5 z-30"
								/>
							)}
						</Show>
						<CanvasElementsOverlay size={size()} />
						<div class="absolute inset-0 isolate pointer-events-none">
							<MaskOverlay size={size()} />
							<ImageOverlay size={size()} />
							<WaveformOverlay size={size()} />
							<TextOverlay size={size()} />
						</div>
						<CaptionOverlay size={size()} />
						<SplitScreenOverlay size={size()} />
						<SnapGuidesOverlay size={size()} />
						<PerformanceOverlay size={size()} />
						<Show when={size().width >= 160 && props.focusMode}>
							{(focusMode) => {
								const label = () =>
									focusMode().active() ? "Exit focus mode" : "Focus mode";
								return (
									<div
										class="absolute right-2.5 bottom-2.5 z-30 transition-opacity duration-200 ease-out has-[:focus-visible]:opacity-100! [@media(hover:none)]:opacity-100!"
										style={{ opacity: "var(--preview-controls-opacity, 0)" }}
									>
										<Tooltip content={label()} kbd={["F"]} placement="top">
											<button
												type="button"
												aria-label={label()}
												data-editor-focus-toggle
												onClick={() => focusMode().toggle()}
												class="flex justify-center items-center rounded-lg size-8 text-white/90 bg-black/45 backdrop-blur-md shadow-[0_0_0_0.5px_rgba(255,255,255,0.16),0_6px_16px_-4px_rgba(0,0,0,0.4)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-black/60 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ed-accent"
											>
												<FocusModeIcon active={focusMode().active()} />
											</button>
										</Tooltip>
									</div>
								);
							}}
						</Show>
					</Show>
				</div>
			</div>
		</div>
	);
}

function Time(props: { seconds: number; fps?: number; class?: string }) {
	return (
		<span class={cx("text-[13px] tabular-nums text-ed-text-3", props.class)}>
			{formatTime(props.seconds, props.fps ?? FPS)}
		</span>
	);
}
