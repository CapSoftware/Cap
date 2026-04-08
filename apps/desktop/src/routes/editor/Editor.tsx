import { Button } from "@cap/ui-solid";
import { NumberField } from "@kobalte/core/number-field";
import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation, createQuery, skipToken } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	ErrorBoundary,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import {
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
import { ExportPage } from "./ExportPage";
import { Header } from "./Header";
import { ImportProgress } from "./ImportProgress";
import { PlayerContent } from "./Player";
import { Timeline } from "./Timeline";
import { TranscriptPanel } from "./TranscriptPage";
import { Dialog, DialogContent, EditorButton, Input, Subfield } from "./ui";

const DEFAULT_TIMELINE_HEIGHT = 260;
const MIN_PLAYER_CONTENT_HEIGHT = 320;
const MIN_TIMELINE_HEIGHT = 240;
const RESIZE_HANDLE_HEIGHT = 16;
const MIN_PLAYER_HEIGHT = MIN_PLAYER_CONTENT_HEIGHT + RESIZE_HANDLE_HEIGHT;
const TIMELINE_RESIZE_GRIP_MARKS = [0, 1, 2] as const;

function logCropProfile(
	stage: string,
	data: Record<string, number | string | boolean | null> = {},
) {
	if (!import.meta.env.DEV) return;
	console.info("[crop-profile]", stage, data);
}

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

	return config;
}

export function Editor() {
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
		<Switch
			fallback={
				<div class="flex items-center justify-center h-full w-full">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-500" />
				</div>
			}
		>
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
							<EditorContent projectPath={path()} />
						</EditorInstanceContextProvider>
					</ErrorBoundary>
				)}
			</Match>
		</Switch>
	);
}

function EditorContent(props: { projectPath: string }) {
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
		<Switch>
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
						<Inner />
					</EditorContextProvider>
				)}
			</Match>
		</Switch>
	);
}

function Inner() {
	const {
		project,
		editorState,
		setEditorState,
		previewResolutionBase,
		dialog,
	} = useEditorContext();

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

	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const layoutBounds = createElementBounds(layoutRef);
	const [storedTimelineHeight, setStoredTimelineHeight] = makePersisted(
		createSignal(DEFAULT_TIMELINE_HEIGHT),
		{ name: "editorTimelineHeight" },
	);
	const [isResizingTimeline, setIsResizingTimeline] = createSignal(false);
	const [timelineViewportOverflow, setTimelineViewportOverflow] = createSignal<{
		overflow: number;
		visibleTrackCount: number;
	} | null>(null);

	const clampTimelineHeight = (value: number) => {
		const available = layoutBounds.height ?? 0;
		const maxHeight =
			available > 0
				? Math.max(MIN_TIMELINE_HEIGHT, available - MIN_PLAYER_HEIGHT)
				: Number.POSITIVE_INFINITY;
		const upperBound = Number.isFinite(maxHeight)
			? maxHeight
			: Math.max(value, MIN_TIMELINE_HEIGHT);
		return Math.min(Math.max(value, MIN_TIMELINE_HEIGHT), upperBound);
	};

	const timelineHeight = createMemo(() =>
		Math.round(clampTimelineHeight(storedTimelineHeight())),
	);

	const handleTimelineResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = timelineHeight();
		setIsResizingTimeline(true);

		const handleMove = (moveEvent: MouseEvent) => {
			const delta = moveEvent.clientY - startY;
			setStoredTimelineHeight(clampTimelineHeight(startHeight - delta));
		};

		const handleUp = () => {
			setIsResizingTimeline(false);
			window.removeEventListener("mousemove", handleMove);
			window.removeEventListener("mouseup", handleUp);
		};

		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	createEffect(() => {
		const available = layoutBounds.height;
		if (!available) return;
		setStoredTimelineHeight((height) => clampTimelineHeight(height));
	});

	createEffect(
		on(timelineViewportOverflow, (next, prev) => {
			if (
				next &&
				prev &&
				next.visibleTrackCount > prev.visibleTrackCount &&
				next.overflow > 0
			) {
				setStoredTimelineHeight((height) =>
					clampTimelineHeight(height + next.overflow),
				);
			}

			return next;
		}),
	);

	createTauriEventListener(events.editorStateChanged, (payload) => {
		throttledRenderFrame.clear();
		trailingRenderFrame.clear();
		setEditorState("playbackTime", payload.playhead_position / FPS);
	});

	let skipRenderFrameForConfigUpdate = false;

	const emitRenderFrame = (time: number) => {
		if (skipRenderFrameForConfigUpdate) {
			return;
		}
		if (!editorState.playing) {
			events.renderFrameEvent.emit({
				frame_number: Math.max(Math.floor(time * FPS), 0),
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

	const doConfigUpdate = async (time: number) => {
		const config = getPreviewProjectConfig(project, editorState);
		const frameNumber = Math.max(Math.floor(time * FPS), 0);
		const resBase = previewResolutionBase();
		try {
			await commands.updateProjectConfigInMemory(
				config,
				frameNumber,
				FPS,
				resBase,
			);
		} catch (e) {
			console.error(
				"[Editor] doConfigUpdate - ERROR sending config to Rust:",
				e,
			);
		}
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
		<Show when={!fullscreenMode()} fallback={<ExportPage />}>
			<div class="flex flex-col flex-1 min-h-0 animate-in fade-in duration-300">
				<Header />
				<div
					class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-4 w-full min-h-0 leading-5"
					data-tauri-drag-region
				>
					<div
						ref={setLayoutRef}
						class="flex overflow-hidden flex-col flex-1 min-h-0"
					>
						<div
							ref={setSplitContainerRef}
							class="flex overflow-hidden flex-row flex-1 min-h-0 px-2"
							style={{
								"min-height": `${MIN_PLAYER_HEIGHT}px`,
							}}
						>
							<div
								class="flex flex-col rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 overflow-hidden"
								style={{
									flex: isTranscriptMode()
										? `0 0 ${splitRatio() * 100}%`
										: "1 1 0%",
									"min-width": "0",
								}}
							>
								<PlayerContent />
								<div
									role="separator"
									aria-orientation="horizontal"
									class="flex-none shrink-0 border-t border-gray-4 dark:border-gray-5 bg-gray-2/95 dark:bg-gray-3/55 transition-colors hover:bg-gray-3/70 dark:hover:bg-gray-4/55"
									style={{ height: `${RESIZE_HANDLE_HEIGHT}px` }}
								>
									<div
										class="flex flex-col gap-0.5 justify-center items-center h-full w-full cursor-row-resize select-none group"
										classList={{
											"bg-gray-3/55 dark:bg-gray-4/50": isResizingTimeline(),
										}}
										onMouseDown={handleTimelineResizeStart}
										aria-label="Resize timeline height"
									>
										<For each={TIMELINE_RESIZE_GRIP_MARKS}>
											{() => (
												<div
													class="h-0.5 w-20 max-w-[85%] rounded-full bg-gray-6 dark:bg-gray-7 shadow-[0_1px_0_rgb(0_0_0_/0.06)] transition-colors group-hover:bg-gray-9 dark:group-hover:bg-gray-11"
													classList={{
														"bg-gray-9 dark:bg-gray-11": isResizingTimeline(),
													}}
												/>
											)}
										</For>
									</div>
								</div>
							</div>
							<Show when={!isTranscriptMode()}>
								<div class="ml-2 flex min-h-0 w-[26rem] min-w-[26rem] flex-none overflow-hidden">
									<ConfigSidebar />
								</div>
							</Show>
							<Show when={isTranscriptMode()}>
								<div
									class="flex-none flex items-center justify-center cursor-col-resize select-none group z-10"
									style={{ width: "12px" }}
									onMouseDown={handleSplitResizeStart}
									aria-label="Resize transcript panel"
									role="separator"
									aria-orientation="vertical"
								>
									<div
										class="w-1 h-10 rounded-full bg-gray-6 dark:bg-gray-7 transition-colors group-hover:bg-gray-9 dark:group-hover:bg-gray-11"
										classList={{
											"bg-gray-9 dark:bg-gray-11": isResizingSplit(),
										}}
									/>
								</div>
								<div
									class="flex flex-col min-h-0 overflow-hidden rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 animate-in fade-in duration-150"
									style={{
										flex: isResizingSplit()
											? `0 0 calc(${(1 - splitRatio()) * 100}% - 12px)`
											: `0 0 calc(${(1 - splitRatio()) * 100}% - 12px)`,
										"min-width": "0",
									}}
								>
									<TranscriptPanel />
								</div>
							</Show>
						</div>
						<div
							class="flex-none min-h-0 px-2 pb-0.5 overflow-hidden relative"
							style={{ height: `${timelineHeight()}px` }}
						>
							<div class="h-full">
								<Timeline
									onViewportOverflowChange={setTimelineViewportOverflow}
								/>
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
			size={(() => {
				const d = dialog();
				if ("type" in d && d.type === "crop") return "lg";
				return "sm";
			})()}
			contentClass={(() => {
				const d = dialog();
				if ("type" in d && d.type === "export") return "max-w-[740px]";
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
								const { setProject: setState, editorInstance } =
									useEditorContext();
								const display = editorInstance.recordings.segments[0].display;

								let cropperRef: CropperRef | undefined;
								const [crop, setCrop] = createSignal(CROP_ZERO);
								const [aspect, setAspect] = createSignal<Ratio | null>(null);

								const initialPreviewUrl = dialog().previewUrl ?? null;
								const [frameBlobUrl, setFrameBlobUrl] = createSignal<
									string | null
								>(initialPreviewUrl);
								const [frameSource, setFrameSource] = createSignal<
									"captured-preview" | "accurate-frame" | "screenshot"
								>(initialPreviewUrl ? "captured-preview" : "screenshot");
								const cropOpenedAt = performance.now();
								const screenshotSrc = convertFileSrc(
									`${editorInstance.path}/screenshots/display.jpg`,
								);

								let cancelled = false;
								let frameLoadDelayTimeoutId:
									| ReturnType<typeof globalThis.setTimeout>
									| undefined;
								let frameLoadTimeoutId:
									| ReturnType<typeof globalThis.setTimeout>
									| undefined;
								let frameLoadIdleId: number | undefined;
								let accurateFrameRequested = false;
								const idleWindow = globalThis as typeof globalThis & {
									requestIdleCallback?: (
										callback: () => void,
										options?: { timeout?: number },
									) => number;
									cancelIdleCallback?: (handle: number) => void;
								};

								const clearScheduledAccurateFrame = () => {
									if (frameLoadDelayTimeoutId !== undefined) {
										globalThis.clearTimeout(frameLoadDelayTimeoutId);
										frameLoadDelayTimeoutId = undefined;
									}
									if (frameLoadIdleId !== undefined) {
										idleWindow.cancelIdleCallback?.(frameLoadIdleId);
										frameLoadIdleId = undefined;
									}
									if (frameLoadTimeoutId !== undefined) {
										globalThis.clearTimeout(frameLoadTimeoutId);
										frameLoadTimeoutId = undefined;
									}
								};

								const setPreviewBlob = (
									blob: Blob,
									source: "accurate-frame",
								) => {
									const nextUrl = URL.createObjectURL(blob);
									const previousUrl = frameBlobUrl();
									setFrameBlobUrl(nextUrl);
									setFrameSource(source);
									if (previousUrl) {
										URL.revokeObjectURL(previousUrl);
									}
								};

								const requestAccurateFrame = (reason: string) => {
									if (accurateFrameRequested || cancelled) return;

									clearScheduledAccurateFrame();

									accurateFrameRequested = true;
									const frameRequestStartedAt = performance.now();
									logCropProfile("accurate-frame-request-start", {
										elapsedMs: Number(
											(frameRequestStartedAt - cropOpenedAt).toFixed(2),
										),
										reason,
									});

									void commands
										.getDisplayFrameForCropping(FPS)
										.then((pngBytes) => {
											if (cancelled) return;

											setPreviewBlob(
												new Blob([new Uint8Array(pngBytes)], {
													type: "image/png",
												}),
												"accurate-frame",
											);
											logCropProfile("accurate-frame-request-finish", {
												elapsedMs: Number(
													(performance.now() - cropOpenedAt).toFixed(2),
												),
												requestMs: Number(
													(performance.now() - frameRequestStartedAt).toFixed(
														2,
													),
												),
												reason,
											});
										})
										.catch((error: unknown) => {
											if (cancelled) return;
											console.warn("Display frame fetch failed:", error);
											logCropProfile("accurate-frame-request-failed", {
												elapsedMs: Number(
													(performance.now() - cropOpenedAt).toFixed(2),
												),
												requestMs: Number(
													(performance.now() - frameRequestStartedAt).toFixed(
														2,
													),
												),
												message:
													error instanceof Error
														? error.message
														: String(error),
												reason,
											});
										});
								};

								const scheduleAccurateFrame = (
									reason: string,
									options: {
										delayMs?: number;
										idleTimeoutMs: number;
										fallbackDelayMs: number;
									},
								) => {
									const queueIdleFrame = () => {
										const loadFrame = () => requestAccurateFrame(reason);

										if (idleWindow.requestIdleCallback) {
											frameLoadIdleId = idleWindow.requestIdleCallback(
												() => {
													frameLoadIdleId = undefined;
													loadFrame();
												},
												{
													timeout: options.idleTimeoutMs,
												},
											);
											return;
										}

										frameLoadTimeoutId = globalThis.setTimeout(() => {
											frameLoadTimeoutId = undefined;
											loadFrame();
										}, options.fallbackDelayMs);
									};

									if (!options.delayMs) {
										queueIdleFrame();
										return;
									}

									frameLoadDelayTimeoutId = globalThis.setTimeout(() => {
										frameLoadDelayTimeoutId = undefined;
										if (cancelled || accurateFrameRequested) return;
										queueIdleFrame();
									}, options.delayMs);
								};

								onMount(() => {
									logCropProfile("dialog-mounted", {
										elapsedMs: Number(
											(performance.now() - cropOpenedAt).toFixed(2),
										),
										recordingDurationSec: Math.round(
											editorInstance.recordingDuration,
										),
									});

									scheduleAccurateFrame("immediate", {
										idleTimeoutMs: 500,
										fallbackDelayMs: 16,
									});
								});

								onCleanup(() => {
									cancelled = true;
									clearScheduledAccurateFrame();
									const url = frameBlobUrl();
									if (url) {
										URL.revokeObjectURL(url);
									}
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
											e.target as HTMLDivElement
										).getBoundingClientRect();
										pos = new LogicalPosition(rect.x, rect.y + 40);
									}
									await menu.popup(pos);
									await menu.close();
								}

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
										>
											<NumberField.Input
												class="rounded-[0.5rem] bg-gray-2 hover:ring-1 py-[18px] hover:ring-gray-5 h-[2rem] font-normal placeholder:text-black-transparent-40 text-xs caret-gray-500 transition-shadow duration-200 focus:ring-offset-1 focus:bg-gray-3 focus:ring-offset-gray-100 focus:ring-1 focus:ring-gray-10 px-[0.5rem] w-full text-[0.875rem] outline-none text-gray-12"
												onKeyDown={composeEventHandlers<HTMLInputElement>([
													(e) => e.stopPropagation(),
												])}
											/>
										</NumberField>
									);
								}

								return (
									<>
										<Dialog.Header>
											<div class="flex flex-row space-x-[2rem]">
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Size</span>
													<div class="w-[3.25rem]">
														<BoundInput field="width" max={display.width} />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="height" max={display.height} />
													</div>
												</div>
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Position</span>
													<div class="w-[3.25rem]">
														<BoundInput field="x" />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="y" />
													</div>
												</div>
											</div>
											<div class="flex flex-row gap-3 justify-end items-center w-full">
												<div class="flex flex-row items-center space-x-[0.5rem] text-gray-11"></div>

												<Button
													variant="white"
													size="xs"
													class="flex items-center justify-center text-center rounded-full h-[2rem] w-[2rem] border focus:border-blue-9"
													onMouseDown={showCropOptionsMenu}
													onClick={showCropOptionsMenu}
												>
													<div class="relative pointer-events-none size-4">
														<Show when={!aspect()}>
															<IconLucideRatio class="group-active:scale-90 transition-transform size-4 pointer-events-none *:pointer-events-none" />
														</Show>
														<Transition
															enterClass="scale-50 opacity-0 blur-md"
															enterActiveClass="duration-200 [transition-timing-function:cubic-bezier(0.215,0.61,0.355,1)]"
															enterToClass="scale-100 opacity-100 blur-0"
															exitClass="opacity-0"
															exitActiveClass="duration-0"
															exitToClass="opacity-0"
														>
															<Show when={aspect()} keyed>
																{(ratio) => (
																	<span class="flex absolute inset-0 justify-center items-center text-xs font-medium tracking-tight leading-none pointer-events-none text text-blue-10">
																		{ratio[0]}:{ratio[1]}
																	</span>
																)}
															</Show>
														</Transition>
													</div>
												</Button>

												<EditorButton
													leftIcon={<IconLucideMaximize />}
													onClick={() => cropperRef?.fill()}
													disabled={
														crop().width === display.width &&
														crop().height === display.height
													}
												>
													Full
												</EditorButton>
												<EditorButton
													leftIcon={<IconCapCircleX />}
													onClick={() => {
														cropperRef?.reset();
														setAspect(null);
													}}
													disabled={
														crop().x === dialog().position.x &&
														crop().y === dialog().position.y &&
														crop().width === dialog().size.x &&
														crop().height === dialog().size.y
													}
												>
													Reset
												</EditorButton>
											</div>
										</Dialog.Header>
										<Dialog.Content>
											<div class="flex flex-row justify-center">
												<div class="rounded divide-black-transparent-10">
													<Cropper
														ref={cropperRef}
														onCropChange={setCrop}
														aspectRatio={aspect() ?? undefined}
														targetSize={{ x: display.width, y: display.height }}
														initialCrop={initialBounds}
														snapToRatioEnabled={snapToRatio()}
														useBackdropFilter={true}
														allowLightMode={true}
														onContextMenu={(e) => showCropOptionsMenu(e, true)}
													>
														<img
															class="shadow pointer-events-none max-h-[70vh]"
															alt="Current frame"
															onError={() => {
																const failedSource = frameSource();
																logCropProfile("preview-image-failed", {
																	elapsedMs: Number(
																		(performance.now() - cropOpenedAt).toFixed(
																			2,
																		),
																	),
																	source: failedSource,
																});
																requestAccurateFrame(
																	failedSource === "screenshot"
																		? "screenshot-load-failed"
																		: "preview-load-failed",
																);
															}}
															onLoad={() =>
																logCropProfile("preview-image-loaded", {
																	elapsedMs: Number(
																		(performance.now() - cropOpenedAt).toFixed(
																			2,
																		),
																	),
																	source: frameSource(),
																})
															}
															src={frameBlobUrl() ?? screenshotSrc}
														/>
													</Cropper>
												</div>
											</div>
										</Dialog.Content>
										<Dialog.Footer>
											<Button
												onClick={() => {
													const bounds = crop();
													setState("background", "crop", {
														position: {
															x: bounds.x,
															y: bounds.y,
														},
														size: {
															x: bounds.width,
															y: bounds.height,
														},
													});
													setDialog((d) => ({ ...d, open: false }));
												}}
											>
												Save
											</Button>
										</Dialog.Footer>
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
