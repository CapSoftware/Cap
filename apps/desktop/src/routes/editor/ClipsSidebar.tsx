import { Button } from "@cap/ui-solid";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { Portal } from "solid-js/web";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import {
	clipTimelineOffsets,
	getClipTransition,
	rippleTimelineTrack,
	transitionsAfterClipMove,
} from "./clip-transitions";
import { type EditorTimelineSegment, useEditorContext } from "./context";
import { getExistingRecordingPickerOptions } from "./existing-recording-picker";
import { rippleKeyboardTrack } from "./keyboard-timing";
import { routeEditorPlaybackIntent } from "./playback-intent-routing";
import { scaleKeyframeTimes } from "./three-d";
import { effectiveToOutput, holdWindows } from "./timeline-holds";

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

export function ClipsSidebar(props: { class?: string }) {
	const {
		project,
		flushProjectConfig,
		setProject,
		projectActions,
		editorInstance,
		editorState,
		setEditorState,
		setDialog,
		requestHandoffPlayback,
	} = useEditorContext();

	const backToEditor = () => setDialog((d) => ({ ...d, open: false }));

	const [importing, setImporting] = createSignal(false);
	const [openingRecorder, setOpeningRecorder] = createSignal(false);

	const pauseForProjectChange = () =>
		routeEditorPlaybackIntent(
			requestHandoffPlayback,
			{ playing: false },
			async () => {
				if (editorState.playing) {
					await commands.stopPlayback();
					setEditorState("playing", false);
				}
			},
		);

	const recordNewClip = async () => {
		if (openingRecorder() || importing()) return;
		setOpeningRecorder(true);
		try {
			if (!(await pauseForProjectChange())) return;
			await flushProjectConfig();
			await commands.openEditorRecordingMain(editorInstance.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Could not open the recorder: ${message}`);
		} finally {
			setOpeningRecorder(false);
		}
	};

	const importRecordingPath = async (sourcePath: string) => {
		if (importing()) return;
		setImporting(true);
		const toastId = toast.loading("Importing clip…");
		try {
			if (!(await pauseForProjectChange())) {
				toast.dismiss(toastId);
				setImporting(false);
				return;
			}
			await flushProjectConfig();
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
		const path = await open(
			getExistingRecordingPickerOptions(ostype(), recordingsPath),
		);
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
			produce((project) => {
				const timeline = project.timeline;
				if (!timeline) return;
				const proposedSegments = [...timeline.segments];
				const [proposedMoved] = proposedSegments.splice(from, 1);
				proposedSegments.splice(to, 0, proposedMoved);
				const { kept, dropped } = transitionsAfterClipMove(
					timeline.segments.length,
					timeline.transitions ?? [],
					from,
					to,
				);
				dropped.sort((a, b) => b.segmentIndex - a.segmentIndex);

				for (const transition of dropped) {
					const effective = getClipTransition(
						timeline.segments,
						timeline.transitions,
						transition.segmentIndex,
					);
					if (!effective) continue;
					const boundary = effectiveToOutput(
						holdWindows(timeline.textSegments),
						clipTimelineOffsets(timeline.segments, timeline.transitions)[
							transition.segmentIndex
						] + effective.duration,
					);
					timeline.transitions = timeline.transitions.filter(
						(candidate) => candidate.segmentIndex !== transition.segmentIndex,
					);
					const camera3dSegments = timeline.camera3dSegments ?? [];
					const previousCamera3dDurations = camera3dSegments.map(
						(segment) => segment.end - segment.start,
					);
					for (const track of [
						timeline.styleSegments,
						timeline.imageSegments,
						timeline.zoomSegments,
						timeline.sceneSegments ?? [],
						timeline.maskSegments,
						timeline.textSegments,
						timeline.captionSegments ?? [],
						timeline.audioSegments ?? [],
						camera3dSegments,
					]) {
						rippleTimelineTrack(track, boundary, effective.duration);
					}
					rippleKeyboardTrack(
						timeline.keyboardSegments ?? [],
						boundary,
						effective.duration,
					);
					for (let index = 0; index < camera3dSegments.length; index++) {
						const segment = camera3dSegments[index];
						const previousDuration = previousCamera3dDurations[index];
						const nextDuration = segment.end - segment.start;
						if (previousDuration <= 0 || previousDuration === nextDuration)
							continue;
						scaleKeyframeTimes(segment.tracks, nextDuration / previousDuration);
					}
				}

				timeline.segments = proposedSegments;
				timeline.transitions = kept;
			}),
		);
		setEditorState("timeline", "selection", null);
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
		projectActions.deleteClipSegment(index);
	};

	return (
		<div
			class={cx(
				"flex overflow-hidden flex-col flex-1 min-h-0 rounded-xl bg-ed-card shadow-ed-card",
				props.class,
			)}
		>
			<button
				type="button"
				onClick={backToEditor}
				class="flex flex-none gap-2 items-center px-4 w-full h-[46px] text-[13px] font-medium border-b transition-colors text-ed-text-1 border-ed-line hover:bg-ed-ctl"
			>
				<IconCapMoveLeft class="size-4 text-ed-text-2" />
				Back to editor
			</button>

			<div class="flex flex-col flex-1 gap-3 p-3 min-h-0">
				<div class="flex flex-none gap-2">
					<Button
						variant="blue"
						class="flex flex-1 gap-2 justify-center items-center h-10"
						disabled={openingRecorder() || importing()}
						onClick={() => void recordNewClip()}
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
