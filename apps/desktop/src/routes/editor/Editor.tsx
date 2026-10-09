import { Dialog as KDialog } from "@kobalte/core/dialog";
import { NumberField } from "@kobalte/core/number-field";
import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation, createQuery, skipToken } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emitTo } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	ErrorBoundary,
	For,
	lazy,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import toast from "solid-toast";
import {
	COMMON_RATIOS,
	CROP_ZERO,
	type CropBounds,
	Cropper,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import { Toggle } from "~/components/Toggle";
import { composeEventHandlers } from "~/utils/composeEventHandlers";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands, events } from "~/utils/tauri";
import { ConfigSidebar } from "./ConfigSidebar";
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
import { DEFAULT_TIMELINE_HEIGHT, editorVerticalLayout } from "./editor-layout";
import { EditorSkeleton } from "./editor-skeleton";
import { Header, type TitleSaveRegistration } from "./Header";
import { ImportProgress } from "./ImportProgress";
import { PlayerContent } from "./Player";
import { usePreparingEditor } from "./preparing-editor-context";
import { Timeline } from "./Timeline";
import { Dialog, DialogContent, EditorButton, Input, Subfield } from "./ui";

// Deferred surfaces: these are not visible at first paint (export mode,
// transcript panel, clips sidebar), so their code is split out of the editor
// chunk to keep webview parse time — the dominant editor-open cost on
// WebView2 — off the critical path. Each render site wraps them in a local
// <Suspense> so the chunk load never bubbles up to the top-level editor
// Suspense (which would flash the whole UI back to the skeleton).
const ClipsSidebar = lazy(() =>
	import("./ClipsSidebar").then((m) => ({ default: m.ClipsSidebar })),
);
const ExportPage = lazy(() =>
	import("./ExportPage").then((m) => ({ default: m.ExportPage })),
);
const TranscriptPanel = lazy(() =>
	import("./TranscriptPage").then((m) => ({ default: m.TranscriptPanel })),
);

// Preview stage minimum plus the 44px player toolbar and 48px transport bar.
const MIN_PLAYER_HEIGHT = 320;
const MIN_TIMELINE_HEIGHT = 240;
const MIN_COMPACT_TIMELINE_HEIGHT = 144;
// The timeline card's own vertical padding (pt-2.5 + pb-3); the Timeline
// reports the height its ruler and rows need inside that box.
const TIMELINE_CARD_PADDING_Y = 22;
const DEFAULT_TIMELINE_CONTENT_HEIGHT = 124;
// Vertical gutter between the player row and the timeline card, plus the
// gutter below the timeline card; both live inside the measured layout box.
const LAYOUT_GUTTERS = 16;

const scheduleIdleWork = (callback: () => void) => {
	const win = window as Window & {
		requestIdleCallback?: (
			callback: () => void,
			options?: { timeout: number },
		) => number;
		cancelIdleCallback?: (handle: number) => void;
	};

	if (win.requestIdleCallback) {
		const handle = win.requestIdleCallback(callback, { timeout: 1_000 });
		return () => win.cancelIdleCallback?.(handle);
	}

	const handle = window.setTimeout(callback, 250);
	return () => window.clearTimeout(handle);
};

function getEditorErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function getPreviewProjectConfig(
	project: ReturnType<typeof useEditorContext>["project"],
	editorState: ReturnType<typeof useEditorContext>["editorState"],
) {
	const config = serializeProjectConfiguration(project);

	if (!editorState.timeline.tracks.caption && config.captions) {
		config.captions = {
			...config.captions,
			settings: {
				...config.captions.settings,
				enabled: false,
			},
		};
	}

	if (!editorState.timeline.tracks.keyboard && config.keyboard) {
		config.keyboard = {
			...config.keyboard,
			settings: {
				...config.keyboard.settings,
				enabled: false,
			},
		};
	}

	if (!editorState.timeline.tracks["3d"] && config.timeline) {
		config.timeline = {
			...config.timeline,
			camera3dSegments: [],
		};
	}

	return config;
}

export function Editor() {
	const currentWindow = getCurrentWindow();
	let flushTitleSave: (() => Promise<void>) | undefined;
	let setTitleReadOnly: ((readOnly: boolean) => void) | undefined;
	let activeTitleSave: { generation: number; requestId: string } | undefined;
	const registerTitleSave = (
		registration: TitleSaveRegistration | undefined,
	) => {
		flushTitleSave = registration?.flush;
		setTitleReadOnly = registration?.setReadOnly;
		setTitleReadOnly?.(activeTitleSave !== undefined);
	};

	onMount(() => {
		let disposed = false;
		let titleSaveGeneration = 0;

		const titleSaveCancelled = currentWindow.listen<{ requestId: string }>(
			"editor-title-save-cancelled",
			({ payload }) => {
				if (activeTitleSave?.requestId !== payload.requestId) return;
				activeTitleSave = undefined;
				setTitleReadOnly?.(false);
			},
		);

		const titleSaveRequest = titleSaveCancelled.then(() =>
			currentWindow.listen<{ requestId: string }>(
				"editor-title-save-request",
				async ({ payload }) => {
					if (disposed) return;

					const generation = titleSaveGeneration + 1;
					titleSaveGeneration = generation;
					const { requestId } = payload;
					activeTitleSave = { generation, requestId };
					const readOnly = setTitleReadOnly;
					readOnly?.(true);

					let error: string | null = null;
					try {
						if (flushTitleSave) await flushTitleSave();
					} catch (cause) {
						error = cause instanceof Error ? cause.message : String(cause);
					}

					if (
						disposed ||
						activeTitleSave?.generation !== generation ||
						activeTitleSave?.requestId !== requestId
					)
						return;

					try {
						await emitTo(currentWindow.label, "editor-title-save-finished", {
							requestId,
							windowLabel: currentWindow.label,
							error,
						});
					} catch (cause) {
						console.error("Failed to acknowledge editor title save:", cause);
						return;
					}
				},
			),
		);

		onCleanup(() => {
			disposed = true;
			activeTitleSave = undefined;
			setTitleReadOnly?.(false);
			void titleSaveRequest.then((unlisten) => unlisten()).catch(() => {});
			void titleSaveCancelled.then((unlisten) => unlisten()).catch(() => {});
		});
	});

	const [projectPath] = createResource(() => commands.getEditorProjectPath());

	const rawMetaQuery = createQuery(() => ({
		queryKey: ["editor", "raw-meta", projectPath()],
		queryFn: (() => {
			const path = projectPath();
			return path ? () => commands.getRecordingMetaByPath(path) : skipToken;
		})(),
		staleTime: Infinity,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		refetchOnReconnect: false,
	}));

	const rawImportStatus = createMemo(() => {
		const meta = rawMetaQuery.data;
		if (!meta) return "loading" as const;
		if (
			"status" in meta &&
			meta.status &&
			typeof meta.status === "object" &&
			"status" in meta.status &&
			meta.status.status === "InProgress"
		) {
			return "importing" as const;
		}
		return "ready" as const;
	});

	const [lockedToImporting, setLockedToImporting] = createSignal(false);

	createEffect(() => {
		if (rawImportStatus() === "importing") {
			setLockedToImporting(true);
		}
	});

	const importStatus = () => {
		if (lockedToImporting()) return "importing" as const;
		return rawImportStatus();
	};

	const [importAborted, setImportAborted] = createSignal(false);

	onCleanup(() => {
		setImportAborted(true);
	});

	const handleImportComplete = async () => {
		const path = projectPath();
		if (!path) return;

		for (let i = 0; i < 20; i++) {
			if (importAborted()) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
			if (importAborted()) return;
			const ready = await commands.checkImportReady(path);
			if (ready) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				if (importAborted()) return;
				window.location.reload();
				return;
			}
		}
		if (importAborted()) return;
		console.error("Import verification timed out");
		window.location.reload();
	};

	return (
		<Switch fallback={<EditorSkeleton />}>
			<Match
				when={importStatus() === "importing" ? (projectPath() ?? null) : null}
			>
				{(path) => (
					<ImportProgress
						projectPath={path()}
						onComplete={handleImportComplete}
						onError={(error) => console.error("Import failed:", error)}
					/>
				)}
			</Match>
			<Match when={importStatus() === "ready" ? (projectPath() ?? null) : null}>
				{(path) => (
					<ErrorBoundary
						fallback={(error) => (
							<EditorErrorScreen
								error={getEditorErrorMessage(error)}
								projectPath={path()}
							/>
						)}
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

	const errorInfo = () => {
		const error = ctx.editorInstance.error;
		if (!error) return null;
		const errorMessage = getEditorErrorMessage(error);
		return { error: errorMessage, projectPath: props.projectPath };
	};

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
			<Match when={errorInfo()}>
				{(info) => (
					<EditorErrorScreen
						error={info().error}
						projectPath={info().projectPath}
					/>
				)}
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
		canvasControls,
		flushProjectConfig,
		editorInstance,
		editorState,
		setEditorState,
		previewResolutionBase,
		dialog,
		exportState,
		requestHandoffPlayback,
		handoffPlaybackPending,
	} = useEditorContext();

	const preparingSession = usePreparingEditor();
	const editorReady = () =>
		preparingSession?.ordinaryReady() ??
		canvasControls()?.hasRenderedFrame() ??
		false;
	onMount(() => {
		const blockPreparingKeys = (event: KeyboardEvent) => {
			if (editorReady()) return;
			if (
				preparingSession?.handoffFailed() &&
				event.target instanceof Element &&
				event.target.closest("[data-editor-handoff-error]")
			) {
				event.stopImmediatePropagation();
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")
				return;
			if (event.altKey && event.key === "F4") return;
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

	createTauriEventListener(events.editorRecordingAdded, (payload) => {
		const normalize = (p: string) => p.replace(/[\\/]+$/, "");
		if (normalize(payload.editor_path) !== normalize(editorInstance.path))
			return;
		void appendRecordedClip(payload.recording_path);
	});

	const appendRecordedClip = async (recordingPath: string) => {
		const toastId = toast.loading("Adding clip…");
		try {
			const pending = requestHandoffPlayback(false);
			if (pending && !(await pending)) {
				toast.dismiss(toastId);
				return;
			}
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			await flushProjectConfig();
			await commands.addExistingRecordingToEditor(recordingPath);
			await commands.deleteRecordingDirectory(recordingPath).catch(() => {});
			toast.success("Clip added", { id: toastId });
			window.location.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Failed to add clip: ${message}`, { id: toastId });
		}
	};

	const isExportMode = () => {
		const d = dialog();
		return "type" in d && d.type === "export" && d.open;
	};

	const isTranscriptMode = () => {
		const d = dialog();
		return "type" in d && d.type === "transcript" && d.open;
	};

	const isClipsMode = () => {
		const d = dialog();
		return "type" in d && d.type === "clips" && d.open;
	};

	const [clipsSidebarMounted, setClipsSidebarMounted] = createSignal(false);

	createEffect(() => {
		if (isClipsMode()) setClipsSidebarMounted(true);
	});

	onMount(() => {
		const cancel = scheduleIdleWork(() => setClipsSidebarMounted(true));
		onCleanup(cancel);
	});

	const isCropMode = () => {
		const d = dialog();
		return "type" in d && d.type === "crop" && d.open;
	};

	const currentWindow = getCurrentWindow();
	let allowExportClose = false;
	let closePromptOpen = false;

	onMount(() => {
		const closeRequested = currentWindow.onCloseRequested(async (event) => {
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

				if (exportState.type === "idle" || exportState.type === "done") {
					allowExportClose = true;
					await currentWindow.close();
					return;
				}

				const resumeExport = await ask(
					"An export is currently running. Keep this editor open to continue it, or quit the editor and cancel the export.",
					{
						title: "Export in Progress",
						kind: "warning",
						okLabel: "Resume Export",
						cancelLabel: "Quit Editor",
					},
				);

				if (!resumeExport) {
					allowExportClose = true;
					await currentWindow.close();
				}
			} finally {
				closePromptOpen = false;
			}
		});

		onCleanup(() => {
			void closeRequested.then((unlisten) => unlisten()).catch(() => {});
		});
	});

	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const layoutBounds = createElementBounds(layoutRef);
	const [userTimelineHeight, setUserTimelineHeight] = makePersisted(
		createSignal<number | null>(null),
		{ name: "editorTimelineHeightOverride" },
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
			(layoutBounds.height ?? fullHeight + LAYOUT_GUTTERS) - LAYOUT_GUTTERS,
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
				userTimelineHeight() ??
					DEFAULT_TIMELINE_HEIGHT +
						timelineContentHeight() -
						(initialTimelineContentHeight() ?? timelineContentHeight()),
			),
		),
	);

	const handleTimelineResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = timelineHeight();
		setIsResizingTimeline(true);

		const handleMove = (moveEvent: MouseEvent) => {
			const delta = moveEvent.clientY - startY;
			setUserTimelineHeight(clampTimelineHeight(startHeight - delta));
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

	createTauriEventListener(events.editorStateChanged, (payload) => {
		if (handoffPlaybackPending()) return;
		throttledRenderFrame.clear();
		trailingRenderFrame.clear();
		setEditorState("playbackTime", payload.playhead_position / FPS);
	});

	let skipRenderFrameForConfigUpdate = false;

	const preparing = usePreparingEditor();
	const requestedFrame = (time: number) => {
		const frameNumber = Math.max(Math.floor(time * FPS), 0);
		return preparing?.requestOrdinaryFrame(frameNumber) ?? frameNumber;
	};

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
				aria-busy={!editorReady() && !preparingSession?.handoffFailed()}
			>
				<Header
					registerTitleSave={registerEditorSave}
					disabled={!editorReady()}
				/>
				<Show when={preparingSession?.handoffFailed()}>
					<div class="absolute inset-0 top-13 max-[900px]:top-[72px] z-30 flex items-center justify-center p-6">
						<div
							data-editor-handoff-error
							role="alertdialog"
							aria-modal="true"
							aria-labelledby="editor-handoff-error-title"
							class="max-w-sm rounded-xl border border-ed-line bg-ed-card p-6 text-center shadow-ed-card"
						>
							<h2
								id="editor-handoff-error-title"
								class="text-sm font-medium text-ed-text-1"
							>
								Couldn’t open the editor
							</h2>
							<p class="mt-2 text-xs text-ed-text-2">
								Try again to finish opening your recording.
							</p>
							<button
								type="button"
								class="mt-4 rounded-lg bg-ed-accent px-4 py-2 text-xs font-medium text-white"
								ref={(button) =>
									queueMicrotask(() => {
										if (button.isConnected) button.focus();
									})
								}
								onClick={() => void preparingSession?.retryHandoff()}
							>
								Try again
							</button>
						</div>
					</div>
				</Show>
				<div
					inert={!editorReady()}
					class="flex overflow-y-hidden flex-col flex-1 gap-2 w-full min-h-0 leading-5 transition-opacity duration-300 ease-out motion-reduce:transition-none"
					style={{ opacity: editorReady() ? 1 : 0.55 }}
					data-tauri-drag-region
				>
					<div
						ref={setLayoutRef}
						class="flex overflow-hidden flex-col flex-1 gap-2 pb-2 min-h-0"
					>
						<div
							ref={setSplitContainerRef}
							class="flex overflow-hidden flex-row flex-1 min-h-0 px-2"
							style={{
								"min-height": `${layoutLimits().minPlayerHeight}px`,
							}}
						>
							<div
								class="flex overflow-hidden flex-col rounded-xl bg-ed-card shadow-ed-card"
								style={{
									flex: isTranscriptMode()
										? `0 0 ${splitRatio() * 100}%`
										: "1 1 0%",
									"min-width": "0",
								}}
							>
								<PlayerContent compactness={layoutLimits().compactness} />
							</div>
							<Show when={!isTranscriptMode()}>
								<div class="ml-2 flex min-h-0 w-104 min-w-104 flex-none overflow-hidden">
									<div
										class="overflow-hidden min-h-0"
										classList={{
											flex: !isClipsMode(),
											"flex-1": !isClipsMode(),
											hidden: isClipsMode(),
										}}
									>
										<ConfigSidebar />
									</div>
									<Show when={clipsSidebarMounted()}>
										<Suspense>
											<ClipsSidebar
												class={isClipsMode() ? undefined : "hidden"}
											/>
										</Suspense>
									</Show>
								</div>
							</Show>
							<Show when={isTranscriptMode()}>
								<div
									class="flex-none flex items-center justify-center cursor-col-resize select-none group z-10"
									style={{ width: "12px" }}
									onMouseDown={handleSplitResizeStart}
									aria-label="Resize captions panel"
									role="separator"
									aria-orientation="vertical"
								>
									<div
										class="w-1 h-10 rounded-full transition-colors bg-ed-line-strong group-hover:bg-ed-text-3"
										classList={{
											"bg-ed-text-3": isResizingSplit(),
										}}
									/>
								</div>
								<div
									class="flex overflow-hidden flex-col min-h-0 rounded-xl duration-150 bg-ed-card shadow-ed-card animate-in fade-in"
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
							class="relative flex-none px-2 min-h-0"
							style={{ height: `${timelineHeight()}px` }}
						>
							<div
								role="separator"
								aria-orientation="horizontal"
								aria-label="Resize timeline height"
								class="group absolute left-2 right-2 h-[14px] -top-[11px] z-20 cursor-row-resize select-none"
								onMouseDown={handleTimelineResizeStart}
							>
								<div
									class="absolute left-1/2 top-[5px] w-9 h-1 rounded-full transition-colors -translate-x-1/2 bg-ed-line-strong group-hover:bg-ed-text-3"
									classList={{
										"bg-ed-text-3": isResizingTimeline(),
									}}
								/>
							</div>
							<div class="overflow-hidden relative px-3 pt-2.5 pb-3 h-full rounded-xl bg-ed-card shadow-ed-card">
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
							{(dialog) => {
								const {
									setProject: setState,
									styleScopeToken,
									editorInstance,
									editorState,
									canvasControls,
									latestFrame,
									previewResolutionBase,
								} = useEditorContext();
								const display = editorInstance.recordings.segments[0].display;
								const cropTarget = dialog().styleTarget ?? null;
								const cropToken = dialog().scopeToken;
								const cropStyle =
									cropTarget === null
										? null
										: project.timeline?.styleSegments[cropTarget];
								const cropTargetValid = () =>
									(!cropToken || cropToken === styleScopeToken()) &&
									(cropTarget === null ||
										project.timeline?.styleSegments[cropTarget] === cropStyle);

								let cropperRef: CropperRef | undefined;
								let previewCanvas: HTMLCanvasElement | undefined;
								const [crop, setCrop] = createSignal(CROP_ZERO);
								const [aspect, setAspect] = createSignal<Ratio | null>(null);

								const [frameUrl, setFrameUrl] = createSignal<string | null>(
									null,
								);
								const [frameLoaded, setFrameLoaded] = createSignal(false);
								const [frameError, setFrameError] = createSignal(false);
								const [previewReady, setPreviewReady] = createSignal(false);
								const screenshotSrc = convertFileSrc(
									`${editorInstance.path}/screenshots/display.jpg`,
								);

								let cancelled = false;

								// The crop must operate on the raw display recording (no
								// padding/background/zoom baked in), decoded at the current
								// playhead so it matches what the user is looking at.
								void commands
									.getDisplayFrameForCropping(FPS)
									.then((bytes) => {
										if (cancelled) return;
										setFrameUrl(
											URL.createObjectURL(
												new Blob([new Uint8Array(bytes)], {
													type: "image/jpeg",
												}),
											),
										);
									})
									.catch((error: unknown) => {
										if (cancelled) return;
										console.warn("Display frame fetch failed:", error);
										setFrameError(true);
									});

								const [viewport, setViewport] = createSignal({
									w: window.innerWidth,
									h: window.innerHeight,
								});
								const onViewportResize = () =>
									setViewport({
										w: window.innerWidth,
										h: window.innerHeight,
									});
								window.addEventListener("resize", onViewportResize);

								const boxSize = createMemo(() => {
									const { w: vw, h: vh } = viewport();
									const ratio = display.width / display.height;
									const maxW = Math.max(120, Math.min(vw - 164, 1280)) * 0.68;
									const maxH = Math.max(100, Math.min(vh - 280, 760));
									let w = maxW;
									let h = w / ratio;
									if (h > maxH) {
										h = maxH;
										w = h * ratio;
									}
									return { w: Math.round(w), h: Math.round(h) };
								});

								const currentFrameNumber = () =>
									Math.max(
										Math.floor(
											(editorState.previewTime ?? editorState.playbackTime) *
												FPS,
										),
										0,
									);

								const drawPreview = () => {
									if (
										previewCanvas &&
										canvasControls()?.drawLatestFrameToCanvas(previewCanvas)
									) {
										if (!previewReady()) setPreviewReady(true);
									}
								};

								// Render the live composited preview through the real GPU
								// pipeline so it is pixel-accurate. Updates are single-flighted
								// to keep dragging smooth under load.
								let configUpdateInFlight = false;
								let pendingConfig: {
									config: ReturnType<typeof getPreviewProjectConfig>;
									frameNumber: number;
									resolutionBase: ReturnType<typeof previewResolutionBase>;
								} | null = null;

								const flushConfig = async () => {
									if (configUpdateInFlight) return;
									const next = pendingConfig;
									if (!next) return;
									pendingConfig = null;
									configUpdateInFlight = true;
									try {
										await commands.updateProjectConfigInMemory(
											next.config,
											next.frameNumber,
											FPS,
											next.resolutionBase,
										);
									} catch (e) {
										console.error("[Crop] preview render failed:", e);
									} finally {
										configUpdateInFlight = false;
										if (pendingConfig) void flushConfig();
									}
								};

								const queueConfig = (bounds: CropBounds | null) => {
									const config = getPreviewProjectConfig(project, editorState);
									if (bounds) {
										if (!cropTargetValid()) return;
										const nextCrop = {
											position: { x: bounds.x, y: bounds.y },
											size: { x: bounds.width, y: bounds.height },
										};
										if (cropTarget === null)
											config.background = {
												...config.background,
												crop: nextCrop,
											};
										else if (config.timeline) {
											config.timeline = {
												...config.timeline,
												styleSegments: config.timeline.styleSegments.map(
													(segment, index) =>
														index === cropTarget
															? {
																	...segment,
																	overrides: {
																		...segment.overrides,
																		background: {
																			...(segment.overrides.background ??
																				config.background),
																			crop: nextCrop,
																		},
																	},
																}
															: segment,
												),
											};
										}
									}
									pendingConfig = {
										config,
										frameNumber: currentFrameNumber(),
										resolutionBase: previewResolutionBase(),
									};
									void flushConfig();
								};

								const throttledConfig = throttle(queueConfig, 1000 / FPS);
								const trailingConfig = debounce(queueConfig, 1000 / FPS + 16);

								let lastPushed: CropBounds = {
									x: dialog().position.x,
									y: dialog().position.y,
									width: dialog().size.x,
									height: dialog().size.y,
								};

								createEffect(
									on(
										crop,
										(bounds) => {
											if (bounds.width <= 0 || bounds.height <= 0) return;
											if (
												bounds.x === lastPushed.x &&
												bounds.y === lastPushed.y &&
												bounds.width === lastPushed.width &&
												bounds.height === lastPushed.height
											)
												return;
											lastPushed = bounds;
											throttledConfig(bounds);
											trailingConfig(bounds);
										},
										{ defer: true },
									),
								);

								createEffect(on(latestFrame, () => drawPreview()));

								onCleanup(() => {
									cancelled = true;
									window.removeEventListener("resize", onViewportResize);
									throttledConfig.clear();
									trailingConfig.clear();
									const url = frameUrl();
									if (url) URL.revokeObjectURL(url);
									queueConfig(null);
								});

								const initialBounds = {
									x: dialog().position.x,
									y: dialog().position.y,
									width: dialog().size.x,
									height: dialog().size.y,
								};

								const [snapToRatio, setSnapToRatioEnabled] = makePersisted(
									createSignal(true),
									{ name: "editorCropSnapToRatio" },
								);

								async function showCropOptionsMenu(
									e: UIEvent,
									positionAtCursor = false,
								) {
									e.preventDefault();
									e.stopPropagation();
									const items = createCropOptionsMenuItems({
										aspect: aspect(),
										snapToRatioEnabled: snapToRatio(),
										onAspectSet: setAspect,
										onSnapToRatioSet: setSnapToRatioEnabled,
									});
									const menu = await Menu.new({ items });
									let pos: LogicalPosition | undefined;
									if (!positionAtCursor) {
										const rect = (
											e.currentTarget as HTMLDivElement
										).getBoundingClientRect();
										pos = new LogicalPosition(rect.x, rect.y + 40);
									}
									await menu.popup(pos);
								}

								const saveCrop = () => {
									const bounds = crop();
									if (!frameLoaded() || bounds.width <= 0 || bounds.height <= 0)
										return;
									if (!cropTargetValid()) {
										toast.error(
											"Crop target changed. Reopen Crop to continue.",
										);
										return;
									}
									const nextCrop = {
										position: { x: bounds.x, y: bounds.y },
										size: { x: bounds.width, y: bounds.height },
									};
									if (cropTarget === null)
										setState("background", "crop", nextCrop);
									else
										setState(
											"timeline",
											"styleSegments",
											cropTarget,
											"overrides",
											"background",
											"crop",
											nextCrop,
										);
									setDialog((d) => ({ ...d, open: false }));
								};

								const closeCrop = () =>
									setDialog((d) => ({ ...d, open: false }));
								const styleScopeLabel =
									cropTarget === null
										? null
										: `Editing Style ${cropTarget + 1} only`;

								createEventListener(window, "keydown", (e: KeyboardEvent) => {
									if (e.key !== "Enter" || e.isComposing) return;
									const target = e.target as HTMLElement | null;
									if (
										target?.tagName === "INPUT" ||
										target?.tagName === "TEXTAREA" ||
										target?.isContentEditable ||
										target?.closest("button")
									)
										return;
									e.preventDefault();
									saveCrop();
								});

								const isFull = () =>
									crop().width === display.width &&
									crop().height === display.height;
								const isCentered = () =>
									crop().x === Math.round((display.width - crop().width) / 2) &&
									crop().y === Math.round((display.height - crop().height) / 2);
								const isUntouched = () =>
									crop().x === dialog().position.x &&
									crop().y === dialog().position.y &&
									crop().width === dialog().size.x &&
									crop().height === dialog().size.y &&
									aspect() === null;

								const ratioLabel = (ratio: Ratio | null) =>
									ratio ? `${ratio[0]}:${ratio[1]}` : "Free";
								const ratioSelected = (ratio: Ratio | null) => {
									const current = aspect();
									if (!ratio || !current) return ratio === current;
									return current[0] === ratio[0] && current[1] === ratio[1];
								};

								function BoundInput(props: {
									field: keyof CropBounds;
									min?: number;
									max?: number;
								}) {
									return (
										<NumberField
											value={crop()[props.field]}
											minValue={props.min}
											maxValue={props.max}
											onRawValueChange={(v) => {
												cropperRef?.setCropProperty(props.field, v);
											}}
											changeOnWheel={true}
											format={false}
											class="w-[60px]"
										>
											<NumberField.Input
												class="h-7 w-full rounded-[7px] border-0 bg-ed-ctl px-2 text-[12.5px] text-ed-text-1 caret-ed-accent tabular-nums outline-hidden transition-[background-color,box-shadow] duration-150 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
												onKeyDown={composeEventHandlers<HTMLInputElement>([
													(e) => e.stopPropagation(),
												])}
											/>
										</NumberField>
									);
								}

								const inspectorLabel = "text-xs font-medium text-ed-text-2";
								const inspectorRow =
									"flex h-7 items-center justify-between gap-3";
								const actionButton =
									"flex h-7 flex-1 items-center justify-center rounded-[7px] bg-ed-ctl text-xs font-medium text-ed-text-1 outline-hidden transition-colors duration-100 enabled:hover:bg-ed-ctl-hover enabled:active:bg-ed-ctl-active focus-visible:ring-1 focus-visible:ring-ed-accent disabled:opacity-45";

								return (
									<>
										<div class="flex h-[52px] shrink-0 items-center justify-between px-5">
											<KDialog.Title class="text-sm font-semibold text-ed-text-1">
												Crop
											</KDialog.Title>
											<EditorButton
												leftIcon={<IconLucideX />}
												tooltipText="Close"
												onClick={closeCrop}
											/>
										</div>
										<div class="flex items-stretch gap-4 px-5">
											<div
												class="relative flex items-center justify-center rounded-xl bg-ed-stage p-4"
												style={{ width: `${boxSize().w + 32}px` }}
											>
												<div
													class="relative transition-opacity duration-200"
													classList={{ "opacity-0": !frameLoaded() }}
													style={{
														width: `${boxSize().w}px`,
														height: `${boxSize().h}px`,
													}}
												>
													<Cropper
														ref={cropperRef}
														onCropChange={setCrop}
														aspectRatio={aspect() ?? undefined}
														targetSize={{
															x: display.width,
															y: display.height,
														}}
														initialCrop={initialBounds}
														snapToRatioEnabled={snapToRatio()}
														useBackdropFilter={true}
														allowLightMode={true}
														appearance="editor"
														snapToAlignmentEnabled={true}
														onContextMenu={(e) => showCropOptionsMenu(e, true)}
													>
														<img
															class="block h-full w-full select-none pointer-events-none"
															alt="Current frame"
															onError={() => {
																const url = frameUrl();
																if (url) {
																	setFrameUrl(null);
																	URL.revokeObjectURL(url);
																}
																setFrameError(true);
															}}
															onLoad={() => setFrameLoaded(true)}
															src={
																frameUrl() ??
																(frameError() ? screenshotSrc : undefined)
															}
														/>
													</Cropper>
												</div>
												<Show when={!frameLoaded()}>
													<div class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 rounded-xl bg-ed-stage">
														<div class="size-6 animate-spin rounded-full border-2 border-ed-line-strong border-t-ed-accent" />
														<span class="text-xs font-medium text-ed-text-2">
															Loading frame…
														</span>
													</div>
												</Show>
											</div>

											<div class="flex w-[300px] shrink-0 flex-col gap-3 rounded-xl bg-ed-card-2 p-3.5">
												<span class={inspectorLabel}>Preview</span>
												<div class="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-ed-stage">
													<canvas
														ref={previewCanvas}
														class="block max-h-full max-w-full object-contain"
													/>
													<Show when={!previewReady()}>
														<div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ed-stage">
															<div class="size-5 animate-spin rounded-full border-2 border-ed-line-strong border-t-ed-accent" />
															<span class="text-[11px] font-medium text-ed-text-3">
																Rendering preview…
															</span>
														</div>
													</Show>
												</div>

												<div class="h-px bg-ed-line" />

												<span class={inspectorLabel}>Aspect ratio</span>
												<div class="grid grid-cols-3 gap-1.5">
													<For each={[null, ...COMMON_RATIOS]}>
														{(ratio) => (
															<button
																type="button"
																class="flex h-7 items-center justify-center rounded-[7px] text-xs font-medium tabular-nums outline-hidden transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-ed-accent"
																classList={{
																	"bg-ed-accent/12 text-ed-accent ring-1 ring-inset ring-ed-accent":
																		ratioSelected(ratio),
																	"bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1":
																		!ratioSelected(ratio),
																}}
																aria-pressed={ratioSelected(ratio)}
																onClick={() => setAspect(ratio)}
															>
																{ratioLabel(ratio)}
															</button>
														)}
													</For>
												</div>
												<div class={inspectorRow}>
													<span class="text-xs text-ed-text-2">
														Snap to ratios
													</span>
													<Toggle
														size="sm"
														checked={snapToRatio()}
														onChange={setSnapToRatioEnabled}
													/>
												</div>

												<div class="h-px bg-ed-line" />

												<div class={inspectorRow}>
													<span class="text-xs text-ed-text-2">Size</span>
													<div class="flex items-center gap-1.5">
														<BoundInput field="width" max={display.width} />
														<span class="w-2 text-center text-xs text-ed-text-3">
															×
														</span>
														<BoundInput field="height" max={display.height} />
													</div>
												</div>
												<div class={inspectorRow}>
													<span class="text-xs text-ed-text-2">Position</span>
													<div class="flex items-center gap-1.5">
														<BoundInput field="x" />
														<span class="w-2" />
														<BoundInput field="y" />
													</div>
												</div>

												<div class="h-px bg-ed-line" />

												<div class="flex gap-1.5">
													<button
														type="button"
														class={actionButton}
														disabled={isCentered()}
														onClick={() => {
															const bounds = crop();
															cropperRef?.animateTo({
																...bounds,
																x: Math.round(
																	(display.width - bounds.width) / 2,
																),
																y: Math.round(
																	(display.height - bounds.height) / 2,
																),
															});
														}}
													>
														Center
													</button>
													<button
														type="button"
														class={actionButton}
														disabled={isFull()}
														onClick={() => cropperRef?.fill()}
													>
														Full
													</button>
													<button
														type="button"
														class={actionButton}
														disabled={isUntouched()}
														onClick={() => {
															cropperRef?.reset();
															setAspect(null);
														}}
													>
														Reset
													</button>
												</div>
											</div>
										</div>
										<p class="px-5 pt-3 pb-5 text-center text-xs text-ed-text-3">
											Drag to move · Arrow keys nudge · Hold{" "}
											<kbd class="rounded-[4px] bg-ed-ctl px-1 font-sans text-ed-text-2">
												⇧
											</kbd>{" "}
											to skip snapping
										</p>
										<div class="flex h-14 shrink-0 items-center justify-between gap-3 border-t border-ed-line px-5">
											<div class="min-w-0 text-xs text-ed-text-2">
												<Show
													when={cropTargetValid()}
													fallback={
														<p role="alert" class="text-orange-11">
															Crop target changed. Close and reopen Crop to
															continue.
														</p>
													}
												>
													<Show when={styleScopeLabel}>
														{(label) => <p>{label()}</p>}
													</Show>
												</Show>
											</div>
											<div class="flex shrink-0 items-center gap-2">
												<EditorButton onClick={closeCrop}>Cancel</EditorButton>
												<button
													type="button"
													class={cx(
														"flex h-[30px] shrink-0 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium text-white outline-hidden",
														"bg-linear-to-b from-ed-accent-2 to-ed-accent",
														"shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,60,160,0.25)]",
														"transition-[filter,opacity] duration-150 ease-out",
														"enabled:hover:brightness-[1.06] enabled:active:brightness-[0.96] disabled:opacity-45",
													)}
													disabled={
														!frameLoaded() ||
														crop().width <= 0 ||
														crop().height <= 0 ||
														!cropTargetValid()
													}
													onClick={saveCrop}
												>
													Save
												</button>
											</div>
										</div>
									</>
								);
							}}
						</Match>
					</Switch>
				)}
			</Show>
		</Dialog.Root>
	);
}
