import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation, createQuery, skipToken } from "@tanstack/solid-query";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	ErrorBoundary,
	lazy,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import { createEditorEventListener } from "~/utils/createEventListener";
import { commands, events, hostCommand } from "../../../engine/editor-api";
import {
	closeEditor,
	onEditorCloseRequested,
} from "../../../engine/editor-window";
import { isBrowserShortcut } from "./browser-shortcuts";
import { ConfigSidebar } from "./ConfigSidebar";
import { ClipStrip } from "./clip-strip";
import {
	EditorContextProvider,
	EditorInstanceContextProvider,
	FPS,
	isModalDialog,
	serializeProjectConfiguration,
	useEditorContext,
	useEditorInstanceContext,
} from "./context";
import { EditorErrorScreen } from "./EditorErrorScreen";
import {
	CLIP_STRIP_SPACE,
	DEFAULT_TIMELINE_HEIGHT,
	editorVerticalLayout,
} from "./editor-layout";
import { EditorSkeleton } from "./editor-skeleton";
import { createFocusMode } from "./focus-mode";
import { Header, type TitleSaveRegistration } from "./Header";
import { PlayerContent, PreviewTools } from "./Player";
import { getPreviewProjectConfig } from "./preview-config";
import { editorLayout, tapOpensSheet } from "./responsive-layout";
import { Timeline } from "./Timeline";
import { bridgeTouchToMouse } from "./touch-mouse-bridge";
import { Dialog, DialogContent, Input, Subfield } from "./ui";
import { applyAudioOnlySetup, needsAudioOnlySetup } from "./waveform";
import { WebDropImport } from "./web-drop-import";
import "./web-layout.css";

// Each render site wraps these in a local <Suspense> so the chunk load never
// bubbles to the top-level Suspense, which would flash the whole UI back to the skeleton.
const ExportPage = lazy(() =>
	import("./ExportPage").then((m) => ({ default: m.ExportPage })),
);
const CropDialog = lazy(() =>
	import("./crop-dialog").then((m) => ({ default: m.CropDialog })),
);
const TranscriptPanel = lazy(() =>
	import("./TranscriptPage").then((m) => ({ default: m.TranscriptPanel })),
);

const MIN_PLAYER_HEIGHT = 320;
const MIN_TIMELINE_HEIGHT = 240;
const MIN_COMPACT_TIMELINE_HEIGHT = 144;
// The timeline card's own vertical padding (pt-2.5 + pb-3); the Timeline
// reports the height its ruler and rows need inside that box.
const TIMELINE_CARD_PADDING_Y = 22;
const DEFAULT_TIMELINE_CONTENT_HEIGHT = 124;
const layoutGutters = (focused: boolean) =>
	16 + (focused ? 0 : CLIP_STRIP_SPACE);

function getEditorErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function Editor() {
	let flushTitleSave: (() => Promise<void>) | undefined;
	const registerTitleSave = (
		registration: TitleSaveRegistration | undefined,
	) => {
		flushTitleSave = registration?.flush;
	};

	const [projectPath] = createResource(() => commands.getEditorProjectPath());
	const loadedProjectPath = () =>
		projectPath.state === "ready" ? projectPath() : undefined;

	const rawMetaQuery = createQuery(() => ({
		queryKey: ["editor", "raw-meta", loadedProjectPath()],
		queryFn: (() => {
			const path = loadedProjectPath();
			return path ? () => commands.getRecordingMetaByPath(path) : skipToken;
		})(),
		staleTime: Infinity,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		refetchOnReconnect: false,
	}));

	const initialLoadError = () => projectPath.error ?? rawMetaQuery.error;

	return (
		<Switch fallback={<EditorSkeleton />}>
			<Match when={initialLoadError()}>
				{(error) => <EditorErrorScreen error={error()} />}
			</Match>
			<Match when={rawMetaQuery.data ? (loadedProjectPath() ?? null) : null}>
				{(path) => (
					<ErrorBoundary
						fallback={(error) => <EditorErrorScreen error={error} />}
					>
						<EditorInstanceContextProvider>
							<EditorContent
								projectPath={path()}
								getTitleSave={() => flushTitleSave}
								registerTitleSave={registerTitleSave}
							/>
						</EditorInstanceContextProvider>
					</ErrorBoundary>
				)}
			</Match>
		</Switch>
	);
}

function EditorContent(props: {
	projectPath: string;
	getTitleSave: () => (() => Promise<void>) | undefined;
	registerTitleSave: (registration: TitleSaveRegistration | undefined) => void;
}) {
	const ctx = useEditorInstanceContext();

	const loadError = (): unknown =>
		ctx.editorInstance.error ?? ctx.metaQuery.error ?? null;

	const readyData = () => {
		const editorInstance = ctx.editorInstance.latest;
		if (!editorInstance || !ctx.metaQuery.data) return null;

		return {
			editorInstance,
			meta() {
				const d = ctx.metaQuery.data;
				if (!d)
					throw new Error("metaQuery.data is undefined - how did this happen?");
				return d;
			},
			refetchMeta: async () => {
				await ctx.metaQuery.refetch();
			},
		};
	};

	return (
		<Switch fallback={<EditorSkeleton />}>
			<Match when={loadError()}>
				{(error) => <EditorErrorScreen error={error()} />}
			</Match>
			<Match when={readyData()}>
				{(values) => (
					<EditorContextProvider {...values()}>
						<Inner
							getTitleSave={props.getTitleSave}
							registerTitleSave={props.registerTitleSave}
						/>
					</EditorContextProvider>
				)}
			</Match>
		</Switch>
	);
}

function Inner(props: {
	getTitleSave: () => (() => Promise<void>) | undefined;
	registerTitleSave: (registration: TitleSaveRegistration | undefined) => void;
}) {
	const {
		project,
		setProject,
		projectHistory,
		meta,
		totalDuration,
		canvasControls,
		flushProjectConfig,
		editorState,
		setEditorState,
		previewResolutionBase,
		dialog,
		setDialog,
		exportState,
	} = useEditorContext();

	const firstFrameShown = () => canvasControls()?.hasRenderedFrame() ?? false;
	// Ready from the first frame on. The canvas's own flag dips while it
	// redraws at a new size, and the layout's bindings (which this shares an
	// update with) re-run whenever the layout moves, so reading the flag live
	// could grey the editor out mid-playback until some other change.
	const [editorOpened, setEditorOpened] = createSignal(false);
	createEffect(() => {
		if (!editorOpened() && firstFrameShown()) setEditorOpened(true);
	});
	const editorReady = () => editorOpened() || firstFrameShown();

	const focusMode = createFocusMode();
	const focused = () => focusMode.active();

	const layout = editorLayout();
	const [sheetOpen, setSheetOpen] = createSignal(false);
	const sheet = {
		open: () => layout.compact() && sheetOpen(),
		setOpen: setSheetOpen,
	};
	const sheetSelectionKey = () => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type === "clip" || selection.type === "style")
			return "";
		return `${selection.type}:${"indices" in selection ? selection.indices.join(",") : selection.index}`;
	};
	let press: { selection: string; x: number; y: number } | null = null;
	createEventListener(
		window,
		"pointerdown",
		(event: PointerEvent) => {
			press = {
				selection: sheetSelectionKey(),
				x: event.clientX,
				y: event.clientY,
			};
		},
		{ capture: true },
	);
	createEventListener(window, "click", (event: MouseEvent) => {
		const start = press;
		press = null;
		if (!layout.compact() || !start) return;
		const target = event.target instanceof Element ? event.target : null;
		if (
			tapOpensSheet({
				selectionBefore: start.selection,
				selectionAfter: sheetSelectionKey(),
				distance: Math.hypot(event.clientX - start.x, event.clientY - start.y),
				onTrackLane: !!target?.closest("[data-track-type] > :nth-child(2)"),
			})
		)
			setSheetOpen(true);
	});
	createEffect(
		on(
			() =>
				editorState.timeline.audioPicker !== null ||
				editorState.timeline.audioReplace !== null,
			(picking) => {
				if (picking && layout.compact()) setSheetOpen(true);
			},
			{ defer: true },
		),
	);
	createEventListener(window, "keydown", (event: KeyboardEvent) => {
		if (event.key === "Escape" && sheet.open() && !event.defaultPrevented)
			setSheetOpen(false);
	});
	const sidebarSheet = createMemo(() =>
		layout.compact()
			? {
					open: sheet.open,
					setOpen: setSheetOpen,
					tools: layout.phone() ? <PreviewTools /> : undefined,
				}
			: undefined,
	);

	const setPlayerCardRef = (element: HTMLDivElement) => {
		onCleanup(bridgeTouchToMouse(element));
	};
	const setTimelineCardRef = (element: HTMLDivElement) => {
		onCleanup(bridgeTouchToMouse(element, { pinch: true }));
	};

	// Capture phase, so Esc is judged before the timeline and canvas clear the
	// selection it would otherwise dismiss first.
	createEventListener(
		window,
		"keydown",
		(event: KeyboardEvent) => {
			if (!editorReady() || event.repeat) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (
				target &&
				(target.isContentEditable ||
					target.closest(
						"input, textarea, select, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
					))
			)
				return;
			if (isModalDialog(dialog())) return;
			if (event.code === "KeyF" && !event.shiftKey) {
				event.preventDefault();
				focusMode.toggle();
			} else if (
				event.key === "Escape" &&
				focusMode.active() &&
				!editorState.timeline.selection &&
				!editorState.canvasSelection
			) {
				focusMode.exit();
			}
		},
		{ capture: true },
	);
	onMount(() => {
		const blockPreparingKeys = (event: KeyboardEvent) => {
			if (editorReady()) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")
				return;
			if (event.altKey && event.key === "F4") return;
			// In a browser, reload, find and the other browser shortcuts must
			// still work while the editor loads: kept from the editor's own
			// shortcuts, never cancelled.
			if (isBrowserShortcut(event)) {
				event.stopImmediatePropagation();
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		window.addEventListener("keydown", blockPreparingKeys, true);
		onCleanup(() =>
			window.removeEventListener("keydown", blockPreparingKeys, true),
		);
	});

	const registerEditorSave = (
		registration: TitleSaveRegistration | undefined,
	) => {
		props.registerTitleSave(
			registration
				? {
						...registration,
						flush: async () => {
							await registration.flush();
							try {
								await flushProjectConfig();
							} catch (error) {
								toast.error(getEditorErrorMessage(error));
								throw error;
							}
						},
					}
				: undefined,
		);
	};

	const isExportMode = () => {
		const d = dialog();
		return "type" in d && d.type === "export" && d.open;
	};

	const isTranscriptMode = () => {
		const d = dialog();
		return "type" in d && d.type === "transcript" && d.open;
	};

	const isCropMode = () => {
		const d = dialog();
		return "type" in d && d.type === "crop" && d.open;
	};

	let allowExportClose = false;
	let closePromptOpen = false;

	onMount(() => {
		const unlisten = onEditorCloseRequested(async (event) => {
			if (allowExportClose) return;

			event.preventDefault();
			if (closePromptOpen) return;

			closePromptOpen = true;
			try {
				try {
					await props.getTitleSave()?.();
				} catch {
					return;
				}
				try {
					await flushProjectConfig();
				} catch (error) {
					console.error("Failed to save the project before closing", error);
					toast.error(
						"Could not save your edits. Keep the editor open and try again.",
					);
					return;
				}

				if (
					exportState.type === "idle" ||
					exportState.type === "done" ||
					!window.confirm(
						"An export is running. Keep the editor open to finish it? Choose Cancel to leave and stop the export.",
					)
				) {
					allowExportClose = true;
					await closeEditor();
				}
			} finally {
				closePromptOpen = false;
			}
		});

		onCleanup(unlisten);
	});

	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const layoutBounds = createElementBounds(layoutRef, {
		trackMutation: false,
	});
	const [userTimelineHeight, setUserTimelineHeight] = makePersisted(
		createSignal<number | null>(null),
		{ name: "editorTimelineHeightOverride" },
	);
	const [focusTimelineHeight, setFocusTimelineHeight] = makePersisted(
		createSignal<number | null>(null),
		{ name: "editorFocusTimelineHeight" },
	);
	const [isResizingTimeline, setIsResizingTimeline] = createSignal(false);
	const [timelineContentHeight, setTimelineContentHeight] = createSignal(
		DEFAULT_TIMELINE_CONTENT_HEIGHT,
	);
	const [initialTimelineContentHeight, setInitialTimelineContentHeight] =
		createSignal<number>();
	const updateTimelineContentHeight = (height: number) => {
		if (!editorReady() || initialTimelineContentHeight() === undefined)
			setInitialTimelineContentHeight(height);
		setTimelineContentHeight(height);
	};
	const [timelineViewportOverflow, setTimelineViewportOverflow] = createSignal<{
		overflow: number;
		visibleTrackCount: number;
	} | null>(null);

	const huggedTimelineHeight = () =>
		timelineContentHeight() + TIMELINE_CARD_PADDING_Y;

	const layoutLimits = createMemo(() => {
		const fullHeight = MIN_PLAYER_HEIGHT + MIN_TIMELINE_HEIGHT;
		const available = Math.max(
			(layoutBounds.height ?? fullHeight + layoutGutters(focused())) -
				layoutGutters(focused()),
			0,
		);
		const { minPlayerHeight } = editorVerticalLayout(
			available,
			DEFAULT_TIMELINE_HEIGHT,
		);
		const maxTimelineHeight = Math.floor(
			Math.max(0, available - minPlayerHeight),
		);

		return {
			minPlayerHeight,
			maxTimelineHeight,
			minTimelineHeight: Math.min(
				maxTimelineHeight,
				MIN_TIMELINE_HEIGHT,
				huggedTimelineHeight(),
				Math.max(MIN_COMPACT_TIMELINE_HEIGHT, available - MIN_PLAYER_HEIGHT),
			),
			compactness: Math.min(
				1,
				Math.max(
					0,
					(fullHeight - available) /
						(MIN_TIMELINE_HEIGHT - MIN_COMPACT_TIMELINE_HEIGHT),
				),
			),
		};
	});

	const clampTimelineHeight = (value: number) => {
		const limits = layoutLimits();
		return Math.min(
			Math.max(value, limits.minTimelineHeight),
			limits.maxTimelineHeight,
		);
	};

	const timelineHeight = createMemo(() =>
		Math.round(
			clampTimelineHeight(
				focused()
					? (focusTimelineHeight() ?? huggedTimelineHeight())
					: (userTimelineHeight() ??
							DEFAULT_TIMELINE_HEIGHT +
								timelineContentHeight() -
								(initialTimelineContentHeight() ?? timelineContentHeight())),
			),
		),
	);

	const handleTimelineResizeKey = (event: KeyboardEvent) => {
		const step = event.shiftKey ? 64 : 16;
		const delta =
			event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
		if (delta === 0) return;
		event.preventDefault();
		const setHeight = focused()
			? setFocusTimelineHeight
			: setUserTimelineHeight;
		setHeight(clampTimelineHeight(timelineHeight() + delta));
	};

	const handleTimelineResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = timelineHeight();
		setIsResizingTimeline(true);

		const setHeight = focused()
			? setFocusTimelineHeight
			: setUserTimelineHeight;

		const handleMove = (moveEvent: MouseEvent) => {
			const delta = moveEvent.clientY - startY;
			setHeight(clampTimelineHeight(startHeight - delta));
		};

		const handleUp = () => {
			setIsResizingTimeline(false);
			window.removeEventListener("mousemove", handleMove);
			window.removeEventListener("mouseup", handleUp);
		};

		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	createEffect(
		on(timelineViewportOverflow, (next, prev) => {
			if (
				!focused() &&
				userTimelineHeight() !== null &&
				next &&
				prev &&
				next.visibleTrackCount > prev.visibleTrackCount &&
				next.overflow > 0
			) {
				const height = timelineHeight();
				const expandedHeight = clampTimelineHeight(height + next.overflow);
				if (expandedHeight > height) {
					setUserTimelineHeight((preferredHeight) =>
						Math.max(preferredHeight ?? 0, expandedHeight),
					);
				}
			}

			return next;
		}),
	);

	createEditorEventListener(events.editorStateChanged, (payload) => {
		throttledRenderFrame.clear();
		trailingRenderFrame.clear();
		setEditorState("playbackTime", payload.playhead_position / FPS);
	});

	let skipRenderFrameForConfigUpdate = false;

	const requestedFrame = (time: number) => Math.max(Math.floor(time * FPS), 0);

	const emitRenderFrame = (time: number) => {
		if (skipRenderFrameForConfigUpdate) {
			return;
		}
		if (!editorState.playing) {
			events.renderFrameEvent.emit({
				frame_number: requestedFrame(time),
				fps: FPS,
				resolution_base: previewResolutionBase(),
			});
		}
	};

	const throttledRenderFrame = throttle(emitRenderFrame, 1000 / FPS);

	const trailingRenderFrame = debounce(emitRenderFrame, 1000 / FPS + 16);

	const renderFrame = (time: number) => {
		throttledRenderFrame(time);
		trailingRenderFrame(time);
	};

	const frameNumberToRender = createMemo(() => {
		const preview = editorState.previewTime;
		if (preview !== null) return preview;
		return editorState.playbackTime;
	});

	type PreviewConfigUpdate = {
		config: ReturnType<typeof getPreviewProjectConfig>;
		frameNumber: number;
		resolutionBase: ReturnType<typeof previewResolutionBase>;
	};

	let previewConfigUpdateInFlight = false;
	let pendingPreviewConfigUpdate: PreviewConfigUpdate | null = null;

	const flushPreviewConfigUpdate = async () => {
		if (previewConfigUpdateInFlight) return;
		const next = pendingPreviewConfigUpdate;
		if (!next) return;

		pendingPreviewConfigUpdate = null;
		previewConfigUpdateInFlight = true;

		try {
			await commands.updateProjectConfigInMemory(
				next.config,
				next.frameNumber,
				FPS,
				next.resolutionBase,
			);
		} catch (e) {
			console.error(
				"[Editor] doConfigUpdate - ERROR sending config to Rust:",
				e,
			);
		} finally {
			previewConfigUpdateInFlight = false;
			if (pendingPreviewConfigUpdate) void flushPreviewConfigUpdate();
		}
	};

	const doConfigUpdate = (time: number) => {
		pendingPreviewConfigUpdate = {
			config: getPreviewProjectConfig(project, editorState),
			frameNumber: requestedFrame(time),
			resolutionBase: previewResolutionBase(),
		};
		void flushPreviewConfigUpdate();
	};

	const throttledConfigUpdate = throttle(doConfigUpdate, 1000 / FPS);
	const trailingConfigUpdate = debounce(doConfigUpdate, 1000 / FPS + 16);
	const updateConfigAndRender = (time: number) => {
		throttledConfigUpdate(time);
		trailingConfigUpdate(time);
	};
	const refreshCaptionPlan = () => {
		void commands.checkUpgradedAndUpdate().catch(() => undefined);
	};
	onMount(refreshCaptionPlan);
	createEventListener(window, "focus", refreshCaptionPlan);
	createEventListener(document, "visibilitychange", () => {
		if (!document.hidden) refreshCaptionPlan();
	});
	createEventListener(window, "cap-web-editor-captions-plan", () => {
		if (
			(window as Window & { capWebEditorCaptionsEnabled?: boolean })
				.capWebEditorCaptionsEnabled !== true
		) {
			if (isTranscriptMode()) setDialog((d) => ({ ...d, open: false }));
			if (editorState.timeline.selection?.type === "caption")
				setEditorState("timeline", "selection", null);
		}
		doConfigUpdate(frameNumberToRender());
	});

	createEffect(
		on(
			() => {
				trackDeep(project);
				return {
					caption: editorState.timeline.tracks.caption,
					keyboard: editorState.timeline.tracks.keyboard,
					threeD: editorState.timeline.tracks["3d"],
				};
			},
			() => {
				skipRenderFrameForConfigUpdate = true;
				queueMicrotask(() => {
					skipRenderFrameForConfigUpdate = false;
				});
				updateConfigAndRender(frameNumberToRender());
			},
			{ defer: true },
		),
	);

	onMount(() => {
		if (!meta().audioOnly || !needsAudioOnlySetup(project)) return;
		const duration = totalDuration();
		const resume = projectHistory.pause();
		setProject(
			produce((project) => {
				project.timeline ??= {
					segments: [{ start: 0, end: duration, timescale: 1 }],
					zoomSegments: [],
					sceneSegments: [],
					maskSegments: [],
					textSegments: [],
					styleSegments: [],
					imageSegments: [],
					captionSegments: [],
					keyboardSegments: [],
					camera3dSegments: [],
					transitions: [],
				};
				applyAudioOnlySetup(project, duration);
			}),
		);
		setEditorState("timeline", "tracks", "waveform", 1);
		resume();
	});

	createEffect(
		on(
			() => [frameNumberToRender(), previewResolutionBase()],
			([number]) => {
				if (editorState.playing) return;
				renderFrame(number as number);
			},
			{ defer: false },
		),
	);

	createEffect(
		on(isExportMode, (exportMode, prevExportMode) => {
			if (prevExportMode === true && exportMode === false) {
				emitRenderFrame(frameNumberToRender());
			}
		}),
	);

	createEffect(
		on(isCropMode, (cropMode, prevCropMode) => {
			if (prevCropMode === true && cropMode === false) {
				emitRenderFrame(frameNumberToRender());
			}
		}),
	);

	const fullscreenMode = () => {
		if (isExportMode()) return "export" as const;
		return null;
	};

	createEffect(() => {
		if (isExportMode()) focusMode?.exit();
	});

	const MIN_SPLIT_RATIO = 0.25;
	const MAX_SPLIT_RATIO = 0.75;
	const DEFAULT_SPLIT_RATIO = 0.5;

	const [splitRatio, setSplitRatio] = makePersisted(
		createSignal(DEFAULT_SPLIT_RATIO),
		{ name: "editorTranscriptSplitRatio" },
	);
	const [isResizingSplit, setIsResizingSplit] = createSignal(false);
	const [splitContainerRef, setSplitContainerRef] =
		createSignal<HTMLDivElement>();

	const handleSplitResizeKey = (event: KeyboardEvent) => {
		const step = event.shiftKey ? 0.1 : 0.02;
		const next =
			event.key === "ArrowLeft"
				? splitRatio() - step
				: event.key === "ArrowRight"
					? splitRatio() + step
					: event.key === "Home"
						? MIN_SPLIT_RATIO
						: event.key === "End"
							? MAX_SPLIT_RATIO
							: null;
		if (next === null) return;
		event.preventDefault();
		setSplitRatio(Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, next)));
	};

	const handleSplitResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startX = event.clientX;
		const startRatio = splitRatio();
		const container = splitContainerRef();
		if (!container) return;
		const containerWidth = container.offsetWidth;
		setIsResizingSplit(true);

		const handleMove = (moveEvent: MouseEvent) => {
			const delta = moveEvent.clientX - startX;
			const ratioDelta = delta / containerWidth;
			const newRatio = Math.min(
				MAX_SPLIT_RATIO,
				Math.max(MIN_SPLIT_RATIO, startRatio + ratioDelta),
			);
			setSplitRatio(newRatio);
		};

		const handleUp = () => {
			setIsResizingSplit(false);
			window.removeEventListener("mousemove", handleMove);
			window.removeEventListener("mouseup", handleUp);
		};

		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	return (
		<Show
			when={!fullscreenMode()}
			fallback={
				<Suspense fallback={<EditorSkeleton />}>
					<ExportPage />
				</Suspense>
			}
		>
			<div
				class="relative flex flex-col flex-1 min-h-0"
				aria-busy={!editorReady()}
				data-editor-root
				data-focused={focused() ? "" : undefined}
			>
				{/* Hidden rather than unmounted, so a title edit and its save
				    registration survive focus mode. */}
				<div classList={{ contents: !focused(), hidden: focused() }}>
					<Header
						registerTitleSave={registerEditorSave}
						disabled={!editorReady()}
					/>
				</div>
				<Show when={editorReady()}>
					<WebDropImport />
				</Show>
				<div
					inert={!editorReady()}
					class="flex overflow-y-hidden flex-col flex-1 gap-2 w-full min-h-0 leading-5"
					style={{ opacity: editorReady() ? 1 : 0.55 }}
				>
					<div
						ref={setLayoutRef}
						class="flex overflow-hidden flex-col flex-1 gap-2 pb-2 min-h-0"
						classList={{ "pt-2": focused() }}
						data-editor-grid
						style={
							layout.compact()
								? { "--timeline-hug": `${huggedTimelineHeight()}px` }
								: undefined
						}
					>
						<div
							ref={setSplitContainerRef}
							class="flex overflow-hidden flex-row flex-1 min-h-0 px-2"
							style={{
								"min-height": `${layoutLimits().minPlayerHeight}px`,
							}}
							data-editor-player-row
						>
							<div
								ref={setPlayerCardRef}
								data-editor-player
								class="flex overflow-hidden flex-col rounded-[14px]"
								style={{
									flex:
										isTranscriptMode() && !focused()
											? `0 0 ${splitRatio() * 100}%`
											: "1 1 0%",
									"min-width": "0",
								}}
							>
								<PlayerContent
									compactness={
										layout.compact() ? 0 : layoutLimits().compactness
									}
									focusMode={focusMode}
								/>
							</div>
							<Show when={!isTranscriptMode()}>
								<div
									class="ml-2 flex min-h-0 w-104 min-w-104 flex-none overflow-hidden"
									classList={{ hidden: focused() }}
									data-editor-sheet
									data-open={sheet.open() ? "" : undefined}
								>
									<div class="flex flex-1 overflow-hidden min-h-0">
										<ConfigSidebar sheet={sidebarSheet()} />
									</div>
								</div>
							</Show>
							<Show when={isTranscriptMode()}>
								<hr
									class="relative flex-none self-stretch m-0 border-0 cursor-col-resize select-none z-10 outline-hidden after:absolute after:top-1/2 after:left-1/2 after:w-1 after:h-10 after:rounded-full after:-translate-1/2 after:transition-colors after:bg-ed-line-strong hover:after:bg-ed-text-3 focus-visible:after:bg-ed-accent"
									classList={{
										hidden: focused(),
										"after:bg-ed-text-3": isResizingSplit(),
									}}
									data-editor-split-handle
									style={{ width: "12px", height: "auto" }}
									tabIndex={0}
									onMouseDown={handleSplitResizeStart}
									onKeyDown={handleSplitResizeKey}
									aria-label="Resize captions panel"
									aria-orientation="vertical"
									aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
									aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
									aria-valuenow={Math.round(splitRatio() * 100)}
								/>
								<div
									class="flex overflow-hidden flex-col min-h-0 rounded-[14px] duration-150 bg-ed-card shadow-ed-card animate-in fade-in"
									classList={{ hidden: focused() }}
									data-editor-transcript
									style={{
										flex: isResizingSplit()
											? `0 0 calc(${(1 - splitRatio()) * 100}% - 12px)`
											: `0 0 calc(${(1 - splitRatio()) * 100}% - 12px)`,
										"min-width": "0",
									}}
								>
									<Suspense>
										<TranscriptPanel />
									</Suspense>
								</div>
							</Show>
						</div>
						<div
							class="flex-none px-2"
							classList={{ hidden: focused() }}
							data-editor-clip-strip
						>
							<Show when={editorReady()} fallback={<div class="h-[48px]" />}>
								<ClipStrip />
							</Show>
						</div>
						<div
							ref={setTimelineCardRef}
							class="relative flex-none px-2 min-h-0"
							style={
								layout.compact() && !focused()
									? undefined
									: { height: `${timelineHeight()}px` }
							}
							data-editor-timeline
						>
							<hr
								data-editor-timeline-resize
								aria-orientation="horizontal"
								aria-label="Resize timeline height"
								aria-valuemin={MIN_TIMELINE_HEIGHT}
								aria-valuenow={Math.round(timelineHeight())}
								tabIndex={0}
								class="absolute left-2 right-2 h-[14px] -top-[11px] z-20 m-0 border-0 cursor-row-resize select-none outline-hidden after:absolute after:left-1/2 after:top-[5px] after:w-9 after:h-1 after:rounded-full after:-translate-x-1/2 after:transition-colors after:bg-ed-line-strong hover:after:bg-ed-text-3 focus-visible:after:bg-ed-accent"
								classList={{ "after:bg-ed-text-3": isResizingTimeline() }}
								onMouseDown={handleTimelineResizeStart}
								onKeyDown={handleTimelineResizeKey}
							/>
							<div class="overflow-hidden relative px-3 pt-2.5 pb-3 h-full rounded-[14px]">
								<div class="h-full">
									<Timeline
										onViewportOverflowChange={setTimelineViewportOverflow}
										onContentHeightChange={updateTimelineContentHeight}
									/>
								</div>
							</div>
						</div>
					</div>
					<Dialogs />
				</div>
			</div>
		</Show>
	);
}

function Dialogs() {
	const { dialog, setDialog, presets, project } = useEditorContext();

	const isDialogType = () => isModalDialog(dialog());

	return (
		<Dialog.Root
			size="sm"
			contentClass={(() => {
				const d = dialog();
				if ("type" in d && d.type === "export") return "max-w-[740px]";
				if ("type" in d && d.type === "crop") return "max-w-[1440px]";
				return "";
			})()}
			open={isDialogType()}
			onOpenChange={(o) => {
				if (!o) setDialog((d) => ({ ...d, open: false }));
			}}
		>
			<Show
				when={(() => {
					const d = dialog();
					if (isModalDialog(d)) return d;
				})()}
			>
				{(dialog) => (
					<Switch>
						<Match when={dialog().type === "createPreset"}>
							{(_) => {
								const [form, setForm] = createStore({
									name: "",
									default: false,
								});

								const createPreset = createMutation(() => ({
									mutationFn: async () => {
										await presets.createPreset({ ...form, config: project });
										if (form.default) {
											await hostCommand("webEditorSaveDefaultStyle", {
												config: JSON.parse(
													JSON.stringify(
														serializeProjectConfiguration(project),
													),
												),
											}).catch((error) =>
												toast.error(
													error instanceof Error
														? error.message
														: "Default was not saved",
												),
											);
										}
									},
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Create Preset"
										confirm={
											<Dialog.ConfirmButton
												disabled={createPreset.isPending}
												onClick={() => createPreset.mutate()}
											>
												Create
											</Dialog.ConfirmButton>
										}
									>
										<Subfield name="Name" required />
										<Input
											class="mt-2"
											value={form.name}
											placeholder="Enter preset name..."
											onInput={(e) => setForm("name", e.currentTarget.value)}
										/>
										<Subfield name="Set as default" class="mt-4">
											<Toggle
												checked={form.default}
												onChange={(checked) => setForm("default", checked)}
											/>
										</Subfield>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "renamePreset") return d;
							})()}
						>
							{(dialog) => {
								const [name, setName] = createSignal(
									presets.query.data?.presets[dialog().presetIndex]?.name ?? "",
								);

								const renamePreset = createMutation(() => ({
									mutationFn: async () =>
										presets.renamePreset(dialog().presetIndex, name()),
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Rename Preset"
										confirm={
											<Dialog.ConfirmButton
												disabled={renamePreset.isPending}
												onClick={() => renamePreset.mutate()}
											>
												Rename
											</Dialog.ConfirmButton>
										}
									>
										<Subfield name="Name" required />
										<Input
											class="mt-2"
											value={name()}
											onInput={(e) => setName(e.currentTarget.value)}
										/>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "deletePreset") return d;
							})()}
						>
							{(dialog) => {
								const deletePreset = createMutation(() => ({
									mutationFn: async () => {
										await presets.deletePreset(dialog().presetIndex);
										await presets.query.refetch();
									},
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Delete Preset"
										confirm={
											<Dialog.ConfirmButton
												variant="destructive"
												onClick={() => deletePreset.mutate()}
												disabled={deletePreset.isPending}
											>
												Delete
											</Dialog.ConfirmButton>
										}
									>
										<p class="text-gray-11">
											Are you sure you want to delete this preset?
										</p>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "crop") return d;
							})()}
						>
							{(dialog) => (
								<Suspense>
									<CropDialog dialog={dialog} />
								</Suspense>
							)}
						</Match>
					</Switch>
				)}
			</Show>
		</Dialog.Root>
	);
}
