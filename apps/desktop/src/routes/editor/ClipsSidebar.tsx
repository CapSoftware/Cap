import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { useQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	type Component,
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import { produce, reconcile } from "solid-js/store";
import { Portal } from "solid-js/web";
import toast from "solid-toast";
import { createDevicesQuery } from "~/utils/devices";
import {
	createCameraMutation,
	listDisplaysWithThumbnails,
	listWindowsWithThumbnails,
} from "~/utils/queries";
import {
	type CameraInfo,
	type CaptureDisplayWithThumbnail,
	type CaptureWindowWithThumbnail,
	commands,
	type DeviceOrModelID,
	type RecordingMode,
	type RecordingTargetMode,
	type ScreenCaptureTarget,
} from "~/utils/tauri";
import { CameraSelectBase } from "../(window-chrome)/new-main/CameraSelect";
import InfoPill from "../(window-chrome)/new-main/InfoPill";
import { MicrophoneSelectBase } from "../(window-chrome)/new-main/MicrophoneSelect";
import SystemAudio from "../(window-chrome)/new-main/SystemAudio";
import TargetDropdownButton from "../(window-chrome)/new-main/TargetDropdownButton";
import TargetMenuGrid from "../(window-chrome)/new-main/TargetMenuGrid";
import TargetTypeButton from "../(window-chrome)/new-main/TargetTypeButton";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "../(window-chrome)/OptionsContext";
import {
	type EditorTimelineSegment,
	serializeProjectConfiguration,
	useEditorContext,
} from "./context";
import { Input } from "./ui";

const findCamera = (cameras: CameraInfo[], id?: DeviceOrModelID | null) => {
	if (!id) return undefined;
	return cameras.find((camera) =>
		"DeviceID" in id
			? camera.device_id === id.DeviceID
			: camera.model_id === id.ModelID,
	);
};

const formatClipDuration = (seconds: number) => {
	if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
	const total = Math.round(seconds);
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const thumbnailCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string | null>>();
const thumbnailQueue: (() => void)[] = [];
let activeThumbnailLoads = 0;
let thumbnailPumpScheduled = false;

const MAX_THUMBNAIL_LOADS = 2;

const clipThumbnailKey = (
	projectPath: string,
	recordingSegment: number,
	start: number,
) => `${projectPath}::${recordingSegment}-${Math.round(start * 1000)}`;

const scheduleThumbnailWork = (callback: () => void) => {
	const requestIdle = (
		window as Window & {
			requestIdleCallback?: (
				callback: () => void,
				options?: { timeout: number },
			) => number;
		}
	).requestIdleCallback;

	if (requestIdle) {
		requestIdle(callback, { timeout: 150 });
	} else {
		requestAnimationFrame(callback);
	}
};

const pumpThumbnailQueue = () => {
	if (thumbnailPumpScheduled) return;
	thumbnailPumpScheduled = true;

	scheduleThumbnailWork(() => {
		thumbnailPumpScheduled = false;

		while (
			activeThumbnailLoads < MAX_THUMBNAIL_LOADS &&
			thumbnailQueue.length > 0
		) {
			const run = thumbnailQueue.shift();
			if (!run) return;
			activeThumbnailLoads += 1;
			run();
		}
	});
};

const loadClipThumbnail = (
	recordingSegment: number,
	start: number,
	key: string,
) => {
	let promise = thumbnailInflight.get(key);
	if (promise) return promise;

	promise = new Promise<string | null>((resolve) => {
		thumbnailQueue.push(() => {
			commands
				.getClipThumbnail(recordingSegment, start)
				.then((path) => {
					const url = convertFileSrc(path);
					thumbnailCache.set(key, url);
					resolve(url);
				})
				.catch((error) => {
					console.error("Failed to load clip thumbnail", error);
					resolve(null);
				})
				.finally(() => {
					activeThumbnailLoads -= 1;
					thumbnailInflight.delete(key);
					pumpThumbnailQueue();
				});
		});
		pumpThumbnailQueue();
	});
	thumbnailInflight.set(key, promise);

	return promise;
};

function ClipThumbnail(props: {
	projectPath: string;
	recordingSegment: number;
	start: number;
	index: number;
}) {
	const [src, setSrc] = createSignal<string | null>(null);
	const [loaded, setLoaded] = createSignal(false);
	const [visible, setVisible] = createSignal(false);
	let container: HTMLDivElement | undefined;
	let disposed = false;

	const cacheKey = createMemo(() =>
		clipThumbnailKey(props.projectPath, props.recordingSegment, props.start),
	);

	const applySrc = (key: string, url: string | null) => {
		if (disposed || key !== cacheKey() || !url) return;
		setSrc(url);
	};

	const load = (key: string, recordingSegment: number, start: number) => {
		const cached = thumbnailCache.get(key);
		if (cached) {
			applySrc(key, cached);
			return;
		}

		const promise = loadClipThumbnail(recordingSegment, start, key);
		void promise.then((url) => applySrc(key, url));
	};

	onMount(() => {
		if (!container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
			},
			{ rootMargin: "300px" },
		);
		observer.observe(container);
		onCleanup(() => observer.disconnect());
	});

	createEffect(() => {
		const key = cacheKey();
		const cached = thumbnailCache.get(key);
		if (cached) {
			setSrc(cached);
			return;
		}
		setSrc(null);
		setLoaded(false);
		if (visible()) load(key, props.recordingSegment, props.start);
	});

	onCleanup(() => {
		disposed = true;
	});

	return (
		<div ref={container} class="absolute inset-0">
			<div class="flex absolute inset-0 justify-center items-center bg-gray-3 dark:bg-gray-4">
				<span class="text-sm font-semibold tabular-nums text-gray-9">
					{props.index + 1}
				</span>
			</div>
			<Show when={src()}>
				{(url) => (
					<img
						src={url()}
						alt=""
						draggable={false}
						loading="lazy"
						decoding="async"
						onLoad={() => setLoaded(true)}
						class={cx(
							"absolute inset-0 object-cover pointer-events-none size-full transition-opacity duration-200",
							loaded() ? "opacity-100" : "opacity-0",
						)}
					/>
				)}
			</Show>
		</div>
	);
}

export function ClipsSidebar(props: { open: boolean; class?: string }) {
	return (
		<RecordingOptionsProvider>
			<ClipsSidebarInner open={props.open} class={props.class} />
		</RecordingOptionsProvider>
	);
}

function ClipsSidebarInner(props: { open: boolean; class?: string }) {
	const {
		project,
		setProject,
		editorInstance,
		editorState,
		setEditorState,
		setDialog,
	} = useEditorContext();
	const { rawOptions, setOptions } = useRecordingOptions();

	const backToEditor = () => setDialog((d) => ({ ...d, open: false }));

	let previousMode: RecordingMode | null = null;
	const [importing, setImporting] = createSignal(false);
	const [recordOpen, setRecordOpen] = createSignal(false);

	const restoreMode = () => {
		if (previousMode !== null && rawOptions.mode !== previousMode) {
			setOptions("mode", previousMode);
			void commands.setRecordingMode(previousMode);
		}
		previousMode = null;
	};

	const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
	const [windowMenuOpen, setWindowMenuOpen] = createSignal(false);
	const activeTargetMenu = createMemo<"display" | "window" | null>(() =>
		displayMenuOpen() ? "display" : windowMenuOpen() ? "window" : null,
	);
	const [targetSearch, setTargetSearch] = createSignal("");
	let displayTriggerRef: HTMLButtonElement | undefined;
	let windowTriggerRef: HTMLButtonElement | undefined;

	createEffect(() => {
		if (!activeTargetMenu()) setTargetSearch("");
	});

	const closeRecord = () => {
		setRecordOpen(false);
		setDisplayMenuOpen(false);
		setWindowMenuOpen(false);
	};

	let hiddenForPicker = false;

	const resetRecordingTarget = () => {
		const targetMode = untrack(() => rawOptions.targetMode);
		if (targetMode != null) {
			setOptions("targetMode", null);
			void commands.closeTargetSelectOverlays().catch(() => {});
		}
		void commands.setEditorRecordingTarget(null).catch(() => {});
	};

	const showEditorWindow = async (focus: boolean) => {
		const window = getCurrentWindow();
		await window.show();
		if (focus) await window.setFocus();
	};

	const hideEditorForPicker = () => {
		if (hiddenForPicker) return;
		hiddenForPicker = true;
		void getCurrentWindow().hide();
	};

	createEffect(
		on(
			() => props.open,
			(open) => {
				if (open) {
					resetRecordingTarget();
					return;
				}

				closeRecord();
				setTargetSearch("");
				resetRecordingTarget();
				restoreMode();

				if (hiddenForPicker) {
					hiddenForPicker = false;
					void showEditorWindow(false).catch(() => {});
				}
			},
		),
	);

	const devices = createDevicesQuery(() => props.open && recordOpen());
	const cameras = createMemo(() => devices.data?.cameras ?? []);
	const mics = createMemo(() => devices.data?.microphones ?? []);
	const permissions = createMemo(() => devices.data?.permissions);
	const setCamera = createCameraMutation();

	const selectedCamera = createMemo(
		() => findCamera(cameras(), rawOptions.cameraID) ?? null,
	);
	const selectedMicName = createMemo(() => {
		if (!rawOptions.micName) return null;
		return mics().find((name) => name === rawOptions.micName) ?? null;
	});

	const displayTargets = useQuery(() => ({
		...listDisplaysWithThumbnails,
		enabled: props.open && recordOpen() && displayMenuOpen(),
	}));
	const windowTargets = useQuery(() => ({
		...listWindowsWithThumbnails,
		enabled: props.open && recordOpen() && windowMenuOpen(),
	}));

	const normalizedTargetQuery = createMemo(() =>
		targetSearch().trim().toLowerCase(),
	);
	const matchesQuery = (value: string | null | undefined, query: string) =>
		!!value && value.toLowerCase().includes(query);

	const filteredDisplayTargets = createMemo<CaptureDisplayWithThumbnail[]>(
		() => {
			const query = normalizedTargetQuery();
			const targets = displayTargets.data ?? [];
			if (!query) return targets;
			return targets.filter((target) => matchesQuery(target.name, query));
		},
	);
	const filteredWindowTargets = createMemo<CaptureWindowWithThumbnail[]>(() => {
		const query = normalizedTargetQuery();
		const targets = windowTargets.data ?? [];
		if (!query) return targets;
		return targets.filter(
			(target) =>
				matchesQuery(target.name, query) ||
				matchesQuery(target.owner_name, query),
		);
	});

	createEffect(() => {
		if (rawOptions.targetMode == null && hiddenForPicker) {
			hiddenForPicker = false;
			if (rawOptions.targetModeSource === "editorRecording") {
				closeRecord();
				setTargetSearch("");
				return;
			}
			void commands.setEditorRecordingTarget(null).catch(() => {});
			restoreMode();
			closeRecord();
			void showEditorWindow(true).catch(() => {});
		}
	});

	onCleanup(() => {
		resetRecordingTarget();
		restoreMode();
		if (hiddenForPicker) void showEditorWindow(false).catch(() => {});
	});

	const beginEditorRecording = async () => {
		closeRecord();
		if (editorState.playing) {
			await commands.stopPlayback();
			setEditorState("playing", false);
		}
		if (previousMode === null) previousMode = rawOptions.mode;
		setOptions("mode", "studio");
		await commands.setRecordingMode("studio");
		await commands.setProjectConfig(serializeProjectConfiguration(project));
		await commands.setEditorRecordingTarget(editorInstance.path);
	};

	const openTargetMode = async (mode: RecordingTargetMode) => {
		setDisplayMenuOpen(false);
		setWindowMenuOpen(false);
		await beginEditorRecording();

		if (mode === "camera") {
			setOptions(
				"captureTarget",
				reconcile({ variant: "cameraOnly" } as ScreenCaptureTarget),
			);
			setOptions("captureSystemAudio", false);
		}

		await commands.openTargetSelectOverlays(null, null, mode);
		setOptions({ targetMode: mode, targetModeSource: "editor" });
		hideEditorForPicker();
	};

	const selectDisplayTarget = async (target: CaptureDisplayWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "display", id: target.id }),
		);
		setDisplayMenuOpen(false);
		await beginEditorRecording();
		await commands.openTargetSelectOverlays(
			{ variant: "display", id: target.id },
			null,
			"display",
		);
		setOptions({ targetMode: "display", targetModeSource: "editor" });
		hideEditorForPicker();
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "window", id: target.id }),
		);
		setWindowMenuOpen(false);
		await beginEditorRecording();
		await commands.openTargetSelectOverlays(
			{ variant: "window", id: target.id },
			null,
			"window",
		);
		setOptions({ targetMode: "window", targetModeSource: "editor" });
		hideEditorForPicker();

		try {
			await commands.focusWindow(target.id);
		} catch (error) {
			console.error("Failed to focus window:", error);
		}
	};

	const importRecordingPath = async (sourcePath: string) => {
		if (importing()) return;
		setImporting(true);
		const toastId = toast.loading("Importing clip…");
		try {
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			await commands.setProjectConfig(serializeProjectConfiguration(project));
			const count = await commands.addExistingRecordingToEditor(sourcePath);
			toast.success(count === 1 ? "Clip imported" : `${count} clips imported`, {
				id: toastId,
			});
			window.location.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Failed to import clip: ${message}`, { id: toastId });
			setImporting(false);
		}
	};

	const pickMp4 = async () => {
		const path = await open({
			filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
			multiple: false,
		});
		if (typeof path === "string") await importRecordingPath(path);
	};

	const pickCapRecording = async () => {
		const recordingsPath = await join(await appDataDir(), "recordings");
		const path = await open({
			defaultPath: recordingsPath,
			filters: [{ name: "Cap Recording", extensions: ["cap"] }],
			multiple: false,
		});
		if (typeof path === "string") await importRecordingPath(path);
	};

	const openImportMenu = async (event: MouseEvent) => {
		if (importing()) return;
		const menu = await Menu.new({
			items: [
				await MenuItem.new({
					text: "Existing recording",
					action: () => void pickCapRecording(),
				}),
				await MenuItem.new({
					text: "MP4 Video…",
					action: () => void pickMp4(),
				}),
			],
		});
		menu.popup(new LogicalPosition(event.clientX, event.clientY));
	};

	const segments = createMemo<EditorTimelineSegment[]>(
		() => project.timeline?.segments ?? [],
	);
	const recordedClipCount = () => editorInstance.recordings.segments.length;

	const clipLabel = (index: number) => `Clip ${index + 1}`;

	const segmentClipIndex = (segment: EditorTimelineSegment, index: number) =>
		segment.recordingSegment ??
		Math.min(index, Math.max(recordedClipCount() - 1, 0));

	const segmentSplitNumber = (
		segment: EditorTimelineSegment,
		index: number,
	) => {
		const clipIndex = segmentClipIndex(segment, index);
		let count = 0;
		for (let i = 0; i <= index; i++) {
			const current = segments()[i];
			if (current && segmentClipIndex(current, i) === clipIndex) count++;
		}
		return count;
	};

	const segmentLabel = (segment: EditorTimelineSegment, index: number) => {
		const splitNumber = segmentSplitNumber(segment, index);
		return splitNumber === 1
			? clipLabel(segmentClipIndex(segment, index))
			: `Split ${splitNumber - 1}`;
	};

	const displayName = (segment: EditorTimelineSegment, index: number) => {
		const name = segment.name?.trim();
		return name ? name : segmentLabel(segment, index);
	};
	const displayNameAt = (index: number) => {
		const segment = segments()[index];
		return segment ? displayName(segment, index) : clipLabel(index);
	};

	const segmentDescription = (
		segment: EditorTimelineSegment,
		index: number,
		duration: number,
	) => {
		const formattedDuration = formatClipDuration(duration);
		const splitNumber = segmentSplitNumber(segment, index);
		if (splitNumber > 1) {
			return `${clipLabel(segmentClipIndex(segment, index))} · ${formattedDuration}`;
		}
		return formattedDuration;
	};

	const [editingIndex, setEditingIndex] = createSignal<number | null>(null);
	const [draftName, setDraftName] = createSignal("");
	const startRename = (index: number, currentName: string) => {
		setDraftName(currentName);
		setEditingIndex(index);
	};
	const commitRename = (index: number) => {
		if (editingIndex() !== index) return;
		const value = draftName().trim();
		setProject(
			"timeline",
			"segments",
			index,
			"name",
			value.length ? value : null,
		);
		setEditingIndex(null);
	};
	const cancelRename = () => setEditingIndex(null);

	const [draggingIndex, setDraggingIndex] = createSignal<number | null>(null);
	const [dropIndex, setDropIndex] = createSignal<number | null>(null);
	const [pointerPos, setPointerPos] = createSignal<{
		x: number;
		y: number;
	} | null>(null);
	let listRef: HTMLDivElement | undefined;

	const moveClip = (from: number, insertionIndex: number) => {
		let to = insertionIndex;
		if (from < insertionIndex) to -= 1;
		if (from === to) return;
		setProject(
			"timeline",
			"segments",
			produce((segs) => {
				if (!segs) return;
				const [moved] = segs.splice(from, 1);
				segs.splice(to, 0, moved);
			}),
		);
	};

	const computeDropIndex = (clientY: number) => {
		if (!listRef) return segments().length;
		const cards = Array.from(
			listRef.querySelectorAll<HTMLElement>("[data-clip-card]"),
		);
		let insertion = 0;
		cards.forEach((card, i) => {
			const rect = card.getBoundingClientRect();
			if (clientY > rect.top + rect.height / 2) insertion = i + 1;
		});
		return insertion;
	};

	const commitDrop = () => {
		const from = draggingIndex();
		const insertion = dropIndex();
		setDraggingIndex(null);
		setDropIndex(null);
		setPointerPos(null);
		if (from === null || insertion === null) return;
		moveClip(from, insertion);
	};

	const startClipDrag = (index: number, downEvent: MouseEvent) => {
		if (downEvent.button !== 0) return;
		const target = downEvent.target as HTMLElement;
		if (target.closest("[data-clip-delete], [data-clip-edit], [data-no-drag]"))
			return;
		downEvent.preventDefault();

		const startX = downEvent.clientX;
		const startY = downEvent.clientY;
		let active = false;

		createRoot((dispose) => {
			const onMove = (event: MouseEvent) => {
				if (!active) {
					if (Math.hypot(event.clientX - startX, event.clientY - startY) < 5)
						return;
					active = true;
					setDraggingIndex(index);
				}
				setPointerPos({ x: event.clientX, y: event.clientY });
				setDropIndex(computeDropIndex(event.clientY));
			};

			const onUp = () => {
				if (active) {
					commitDrop();
				} else {
					setDraggingIndex(null);
					setDropIndex(null);
					setPointerPos(null);
				}
				dispose();
			};

			onCleanup(() => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
			});

			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		});
	};

	const deleteClip = (index: number) => {
		if (segments().length < 2) return;
		setProject(
			"timeline",
			"segments",
			produce((segs) => {
				if (!segs) return;
				segs.splice(index, 1);
			}),
		);
	};

	createEventListener(window, "keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!recordOpen() || rawOptions.targetMode != null) return;
		event.preventDefault();
		event.stopPropagation();
		if (activeTargetMenu()) {
			setDisplayMenuOpen(false);
			setWindowMenuOpen(false);
		} else {
			closeRecord();
		}
	});

	const areaButton = (
		mode: RecordingTargetMode,
		name: string,
		Icon: Component<ComponentProps<"svg">>,
	) => (
		<TargetTypeButton
			selected={rawOptions.targetMode === mode}
			Component={Icon}
			onClick={() => void openTargetMode(mode)}
			name={name}
			class="flex-1"
		/>
	);

	return (
		<div
			class={cx(
				"flex flex-col flex-1 min-h-0 rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 overflow-hidden",
				props.class,
			)}
		>
			<button
				type="button"
				onClick={backToEditor}
				class="flex flex-none gap-2 items-center px-4 w-full h-16 text-sm font-medium border-b transition-colors text-gray-12 border-gray-3 hover:bg-gray-3"
			>
				<IconCapMoveLeft class="size-4 text-gray-11" />
				Back to editor
			</button>

			<div class="flex flex-col flex-1 gap-3 p-3 min-h-0">
				<div class="flex flex-none gap-2">
					<Button
						variant="blue"
						class="flex flex-1 gap-2 justify-center items-center h-10"
						onClick={() => setRecordOpen(true)}
					>
						<IconLucideVideo class="size-4" />
						Record a new clip
					</Button>
					<Button
						variant="gray"
						class="flex gap-2 justify-center items-center h-10"
						disabled={importing()}
						onClick={openImportMenu}
					>
						<IconCapCirclePlus class="size-4" />
						Import
					</Button>
				</div>

				<div class="flex flex-none gap-2 items-center">
					<span class="text-sm font-medium text-gray-12">Clips</span>
					<Show when={recordedClipCount() > 0}>
						<span class="rounded-md bg-gray-3 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-gray-11">
							{recordedClipCount()}
						</span>
					</Show>
				</div>

				<div class="overflow-y-auto flex-1 -mx-1 px-1 min-h-0 custom-scroll">
					<Show
						when={segments().length > 0}
						fallback={
							<div class="flex flex-col gap-2 justify-center items-center px-4 py-12 text-center">
								<div class="flex justify-center items-center rounded-full size-10 bg-gray-3 text-gray-9">
									<IconCapClapperboard class="size-5" />
								</div>
								<p class="text-sm font-medium text-gray-12">No clips yet</p>
								<p class="max-w-[200px] text-xs text-gray-10">
									Record or import a clip and it will show up here.
								</p>
							</div>
						}
					>
						<div ref={listRef} class="flex flex-col gap-2">
							<For each={segments()}>
								{(segment, index) => {
									const duration = () =>
										(segment.end - segment.start) / segment.timescale;
									const isDragging = () => draggingIndex() === index();
									const showTopBar = () =>
										draggingIndex() !== null && dropIndex() === index();
									const showBottomBar = () =>
										draggingIndex() !== null &&
										index() === segments().length - 1 &&
										dropIndex() === segments().length;

									return (
										<div class="relative">
											<Show when={showTopBar()}>
												<div class="absolute right-0 -top-1 left-0 z-10 h-0.5 rounded-full bg-blue-9" />
											</Show>
											<Show when={showBottomBar()}>
												<div class="absolute right-0 -bottom-1 left-0 z-10 h-0.5 rounded-full bg-blue-9" />
											</Show>
											<div
												data-clip-card
												onMouseDown={(e) => startClipDrag(index(), e)}
												class={cx(
													"group flex items-center gap-3 rounded-lg border p-2 transition-all cursor-grab active:cursor-grabbing bg-gray-2 dark:bg-gray-3 border-gray-4 hover:border-gray-7",
													isDragging() && "opacity-40",
												)}
											>
												<div class="overflow-hidden relative w-24 rounded-md aspect-video shrink-0 bg-gray-4">
													<ClipThumbnail
														projectPath={editorInstance.path}
														recordingSegment={segment.recordingSegment ?? 0}
														start={segment.start}
														index={index()}
													/>
												</div>
												<div class="flex flex-col flex-1 gap-0.5 min-w-0">
													<Show
														when={editingIndex() === index()}
														fallback={
															<span
																onDblClick={() =>
																	startRename(index(), segment.name ?? "")
																}
																class="text-sm font-medium truncate text-gray-12"
															>
																{displayName(segment, index())}
															</span>
														}
													>
														<input
															data-no-drag
															ref={(el) => {
																requestAnimationFrame(() => {
																	el.focus();
																	el.select();
																});
															}}
															value={draftName()}
															placeholder={segmentLabel(segment, index())}
															onInput={(e) =>
																setDraftName(e.currentTarget.value)
															}
															onMouseDown={(e) => e.stopPropagation()}
															onKeyDown={(e) => {
																e.stopPropagation();
																if (e.key === "Enter") {
																	e.preventDefault();
																	commitRename(index());
																} else if (e.key === "Escape") {
																	e.preventDefault();
																	cancelRename();
																}
															}}
															onBlur={() => commitRename(index())}
															class="px-1.5 py-0.5 w-full text-sm rounded border outline-none bg-gray-1 dark:bg-gray-4 border-gray-6 text-gray-12 focus:border-blue-9"
														/>
													</Show>
													<span class="text-xs tabular-nums text-gray-10">
														{segmentDescription(segment, index(), duration())}
													</span>
												</div>
												<div class="flex flex-none gap-0.5 items-center">
													<button
														type="button"
														data-clip-edit
														onClick={() =>
															startRename(index(), segment.name ?? "")
														}
														aria-label="Rename clip"
														class="flex flex-none justify-center items-center rounded-md opacity-0 transition-colors size-7 text-gray-10 hover:bg-gray-5 hover:text-gray-12 group-hover:opacity-100"
													>
														<IconCapPencil class="size-3.5" />
													</button>
													<Show when={segments().length > 1}>
														<button
															type="button"
															data-clip-delete
															onClick={() => deleteClip(index())}
															aria-label="Remove clip"
															class="flex flex-none justify-center items-center rounded-md opacity-0 transition-colors size-7 text-gray-10 hover:bg-red-3 hover:text-red-11 group-hover:opacity-100"
														>
															<IconCapTrash class="size-3.5" />
														</button>
													</Show>
												</div>
											</div>
										</div>
									);
								}}
							</For>
						</div>
					</Show>
				</div>
			</div>

			<Show when={recordOpen()}>
				<Portal>
					<div
						class="flex fixed inset-0 z-[1000] justify-center items-center p-6 backdrop-blur-sm bg-black/60 animate-in fade-in duration-150"
						onMouseDown={(e) => {
							if (e.target === e.currentTarget) closeRecord();
						}}
					>
						<div class="flex flex-col w-full max-w-[460px] h-[480px] max-h-[calc(100vh-3rem)] overflow-hidden rounded-2xl border shadow-2xl bg-gray-1 dark:bg-gray-2 border-gray-3 animate-in fade-in zoom-in-95 duration-150">
							<div class="flex flex-none gap-3 items-center px-5 py-4 border-b border-gray-3">
								<div class="flex flex-none justify-center items-center rounded-xl size-10 bg-blue-3 text-blue-10">
									<IconCapClapperboard class="size-5" />
								</div>
								<div class="flex flex-col gap-0.5 min-w-0">
									<h2 class="text-sm font-medium text-gray-12">
										Record a new clip
									</h2>
									<p class="text-xs text-gray-10">
										Captured in Studio Mode and added to this project.
									</p>
								</div>
								<button
									type="button"
									onClick={closeRecord}
									aria-label="Close"
									class="flex flex-none justify-center items-center ml-auto rounded-md transition-colors size-7 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
								>
									<IconCapX class="size-3" />
								</button>
							</div>

							<div class="flex flex-col flex-1 p-5 min-h-0">
								<Show
									when={activeTargetMenu()}
									fallback={
										<div class="flex overflow-y-auto flex-col flex-1 gap-4 min-h-0 custom-scroll">
											<div class="flex flex-col gap-2 w-full text-xs text-gray-11">
												<div class="flex flex-row gap-2 items-stretch w-full">
													<div
														class={cx(
															"flex flex-1 overflow-hidden rounded-lg border border-gray-5 bg-gray-3 ring-1 ring-transparent ring-offset-2 ring-offset-gray-1 transition focus-within:ring-blue-9",
															(rawOptions.targetMode === "display" ||
																displayMenuOpen()) &&
																"ring-blue-9",
														)}
													>
														<TargetTypeButton
															selected={rawOptions.targetMode === "display"}
															Component={IconMdiMonitor}
															onClick={() => void openTargetMode("display")}
															name="Display"
															class="flex-1 pl-5 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
														/>
														<TargetDropdownButton
															ref={displayTriggerRef}
															class={cx(
																"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
																displayMenuOpen() && "bg-gray-5",
															)}
															expanded={displayMenuOpen()}
															onClick={() => {
																setDisplayMenuOpen((prev) => {
																	const next = !prev;
																	if (next) setWindowMenuOpen(false);
																	return next;
																});
															}}
															aria-haspopup="menu"
															aria-label="Choose display"
														/>
													</div>
													<div
														class={cx(
															"flex flex-1 overflow-hidden rounded-lg border border-gray-5 bg-gray-3 ring-1 ring-transparent ring-offset-2 ring-offset-gray-1 transition focus-within:ring-blue-9",
															(rawOptions.targetMode === "window" ||
																windowMenuOpen()) &&
																"ring-blue-9",
														)}
													>
														<TargetTypeButton
															selected={rawOptions.targetMode === "window"}
															Component={IconLucideAppWindowMac}
															onClick={() => void openTargetMode("window")}
															name="Window"
															class="flex-1 pl-5 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
														/>
														<TargetDropdownButton
															ref={windowTriggerRef}
															class={cx(
																"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
																windowMenuOpen() && "bg-gray-5",
															)}
															expanded={windowMenuOpen()}
															onClick={() => {
																setWindowMenuOpen((prev) => {
																	const next = !prev;
																	if (next) setDisplayMenuOpen(false);
																	return next;
																});
															}}
															aria-haspopup="menu"
															aria-label="Choose window"
														/>
													</div>
												</div>
												<div class="flex flex-row gap-2 items-stretch w-full">
													{areaButton(
														"area",
														"Area",
														IconMaterialSymbolsScreenshotFrame2Rounded,
													)}
													{areaButton("camera", "Camera Only", IconLucideVideo)}
												</div>
											</div>

											<div class="flex flex-col gap-2">
												<CameraSelectBase
													disabled={devices.isPending}
													options={cameras()}
													value={selectedCamera()}
													onChange={(camera) => {
														const isCameraOnly =
															rawOptions.captureTarget.variant === "cameraOnly";
														if (!camera) setCamera.mutate({ model: null });
														else if (camera.model_id)
															setCamera.mutate({
																model: { ModelID: camera.model_id },
																skipCameraWindow: isCameraOnly,
															});
														else
															setCamera.mutate({
																model: { DeviceID: camera.device_id },
																skipCameraWindow: isCameraOnly,
															});
													}}
													permissions={permissions()}
													PillComponent={InfoPill}
													class="flex flex-row gap-2 items-center px-2 w-full h-[42px] rounded-lg border border-gray-5 transition-colors cursor-default disabled:opacity-70 bg-gray-3 disabled:text-gray-11 KSelect"
													iconClass="text-gray-10 size-4"
												/>
												<MicrophoneSelectBase
													disabled={devices.isPending}
													options={mics()}
													value={selectedMicName()}
													onChange={(value) => {
														setOptions("micName", value);
														void commands.setMicInput(value);
													}}
													permissions={permissions()}
													PillComponent={InfoPill}
													class="flex overflow-hidden relative z-10 flex-row gap-2 items-center px-2 w-full h-[42px] rounded-lg border border-gray-5 transition-colors cursor-default disabled:opacity-70 bg-gray-3 disabled:text-gray-11 KSelect"
													levelIndicatorClass="bg-blue-7"
													iconClass="text-gray-10 size-4"
												/>
												<SystemAudio />
											</div>
										</div>
									}
								>
									<div class="flex flex-col flex-1 min-h-0">
										<div class="flex flex-none gap-3 items-center min-h-[36px]">
											<button
												type="button"
												onClick={() => {
													setDisplayMenuOpen(false);
													setWindowMenuOpen(false);
													(activeTargetMenu() === "window"
														? windowTriggerRef
														: displayTriggerRef
													)?.focus();
												}}
												class="flex h-[36px] gap-1 items-center shrink-0 rounded-md px-2 text-xs text-gray-11 transition-colors hover:text-gray-12 hover:bg-gray-4"
												aria-label="Back"
											>
												<IconLucideArrowLeft class="size-3 text-gray-11" />
												<span class="font-medium text-gray-12">Back</span>
											</button>
											<div class="relative flex-1 min-w-0 h-[36px] flex items-center">
												<IconLucideSearch class="absolute left-2 top-[48%] -translate-y-1/2 pointer-events-none size-3 text-gray-10" />
												<Input
													type="search"
													class="py-2 pl-6 w-full h-full"
													value={targetSearch()}
													onInput={(event) =>
														setTargetSearch(event.currentTarget.value)
													}
													onKeyDown={(event) => {
														if (event.key === "Escape" && targetSearch()) {
															event.preventDefault();
															event.stopPropagation();
															setTargetSearch("");
														}
													}}
													placeholder={
														activeTargetMenu() === "window"
															? "Search windows"
															: "Search displays"
													}
													autoCapitalize="off"
													autocorrect="off"
													autocomplete="off"
													spellcheck={false}
												/>
											</div>
										</div>
										<div class="overflow-y-auto flex-1 pt-4 min-h-0 custom-scroll">
											<Show when={activeTargetMenu() === "display"}>
												<TargetMenuGrid
													variant="display"
													targets={filteredDisplayTargets()}
													isLoading={displayTargets.isPending}
													errorMessage={
														displayTargets.error
															? "Unable to load displays."
															: undefined
													}
													onSelect={(target) =>
														void selectDisplayTarget(target)
													}
													highlightQuery={targetSearch().trim()}
													emptyMessage={
														targetSearch().trim()
															? "No matching displays"
															: undefined
													}
												/>
											</Show>
											<Show when={activeTargetMenu() === "window"}>
												<TargetMenuGrid
													variant="window"
													targets={filteredWindowTargets()}
													isLoading={windowTargets.isPending}
													errorMessage={
														windowTargets.error
															? "Unable to load windows."
															: undefined
													}
													onSelect={(target) => void selectWindowTarget(target)}
													highlightQuery={targetSearch().trim()}
													emptyMessage={
														targetSearch().trim()
															? "No matching windows"
															: undefined
													}
												/>
											</Show>
										</div>
									</div>
								</Show>
							</div>
						</div>
					</div>
				</Portal>
			</Show>

			<Show when={draggingIndex() !== null && pointerPos()}>
				{(pos) => (
					<Portal>
						<div
							class="flex fixed z-[1001] flex-col items-center px-3 py-2 rounded-lg border shadow-lg pointer-events-none bg-gray-2 dark:bg-gray-3 border-gray-6"
							style={{
								left: `${pos().x + 14}px`,
								top: `${pos().y + 14}px`,
							}}
						>
							<span class="text-sm font-medium text-gray-12">
								{displayNameAt(draggingIndex() ?? 0)}
							</span>
						</div>
					</Portal>
				)}
			</Show>
		</div>
	);
}
