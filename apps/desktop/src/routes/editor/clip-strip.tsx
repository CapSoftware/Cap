import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createMemo,
	createRoot,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import IconLucideMic from "~icons/lucide/mic";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideUpload from "~icons/lucide/upload";
import IconLucideVideo from "~icons/lucide/video";
import {
	forgetClipInsert,
	rememberClipInsert,
	takeClipInsert,
} from "./clip-insert";
import { moveTimelineClip } from "./clip-move";
import {
	ClipThumbnail,
	cachedClipThumbnail,
	clipThumbnailKey,
} from "./clip-thumbnail";
import { clipDuration, clipTimelineOffsets } from "./clip-transitions";
import { type EditorTimelineSegment, useEditorContext } from "./context";
import { effectiveToOutput, holdWindows } from "./timeline-holds";
import { MenuItem, PopperContent, topCenterAnimateClasses } from "./ui";
import { formatTime } from "./utils";
import { createWebMediaImport } from "./web-media-import";

const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "capbundle"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"];

const formatDuration = (seconds: number) =>
	formatTime(Math.max(0, Math.round(seconds)));

/**
 * The web editor's clips, in order, above the timeline: jump to one, drag to
 * reorder, and add a recording, a video or audio at any point.
 */
export function ClipStrip() {
	const {
		project,
		setProject,
		projectActions,
		editorInstance,
		editorState,
		setEditorState,
		flushProjectConfig,
	} = useEditorContext();
	const media = createWebMediaImport();

	const segments = () => project.timeline?.segments ?? [];
	const starts = createMemo(() => {
		const holds = holdWindows(project.timeline?.textSegments);
		return clipTimelineOffsets(
			segments(),
			project.timeline?.transitions ?? [],
		).map((offset) => effectiveToOutput(holds, Math.max(0, offset)));
	});
	const total = createMemo(() => {
		const last = segments().length - 1;
		if (last < 0) return 0;
		return (starts()[last] ?? 0) + clipDuration(segments()[last]);
	});
	const activeIndex = createMemo(() => {
		const time = editorState.previewTime ?? editorState.playbackTime;
		let active = 0;
		starts().forEach((start, index) => {
			if (time >= start - 0.001) active = index;
		});
		return active;
	});

	const name = (segment: EditorTimelineSegment, index: number) =>
		segment.name?.trim() || `Clip ${index + 1}`;

	onMount(() => {
		const pending = takeClipInsert(editorInstance.path, segments().length);
		if (pending) {
			setProject(
				produce((draft) => {
					for (let offset = 0; offset < pending.added; offset++) {
						moveTimelineClip(
							draft,
							pending.from + offset,
							pending.insertAt + offset,
						);
					}
				}),
			);
		}
		const listeners = [
			listen("webEditorClipRecorderClosed", forgetClipInsert),
			listen("webEditorRequestClipRecorder", () => recordAt(segments().length)),
		];
		onCleanup(() => {
			for (const listener of listeners) void listener.then((stop) => stop());
		});
	});

	const jumpTo = async (index: number) => {
		if (editorState.playing) {
			await commands.stopPlayback();
			setEditorState("playing", false);
		}
		setEditorState("timeline", "selection", {
			type: "clip",
			indices: [index],
		});
		setEditorState("playbackTime", starts()[index] ?? 0);
	};

	const boundaryFrame = async (insertAt: number) => {
		const before = segments()[insertAt - 1];
		const after = segments()[insertAt];
		const frame = before
			? commands.getClipThumbnail(
					before.recordingSegment ?? 0,
					Math.max(before.start, before.end - 0.1),
				)
			: after
				? commands.getClipThumbnail(after.recordingSegment ?? 0, after.start)
				: null;
		if (!frame) return null;
		const timeout = new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), 1500),
		);
		return await Promise.race([frame.catch(() => null), timeout]);
	};

	const recordAt = async (insertAt: number) => {
		try {
			await flushProjectConfig();
			rememberClipInsert(editorInstance.path, insertAt, segments().length);
			await invoke("webEditorOpenClipRecorder", {
				insertAt,
				boundaryFrame: await boundaryFrame(insertAt),
				clips: segments().map((segment, index) => ({
					name: name(segment, index),
					duration: clipDuration(segment),
					thumbnail: cachedClipThumbnail(
						clipThumbnailKey(
							editorInstance.path,
							segment.recordingSegment ?? 0,
							segment.start,
						),
					),
				})),
			});
		} catch (error) {
			forgetClipInsert();
			toast.error(
				error instanceof Error ? error.message : "Couldn't open the recorder",
			);
		}
	};

	const uploadAt = async (insertAt: number) => {
		const path = await open({
			filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
		});
		if (typeof path === "string") await media.addClip(path, "video", insertAt);
	};

	const addAudio = async () => {
		const path = await open({
			filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
		});
		if (typeof path === "string") await media.addAudio(path, "audio");
	};

	const [renaming, setRenaming] = createSignal<number | null>(null);
	let renameInput: HTMLInputElement | undefined;
	const focusRenameInput = () => {
		renameInput?.focus();
		renameInput?.select();
	};
	const rename = (index: number, value: string) => {
		setRenaming(null);
		setProject("timeline", "segments", index, "name", value.trim() || null);
	};

	const [dragging, setDragging] = createSignal<number | null>(null);
	const [dropAt, setDropAt] = createSignal<number | null>(null);
	let row: HTMLDivElement | undefined;

	const dropIndexAt = (clientX: number) => {
		const tiles = row?.querySelectorAll<HTMLElement>("[data-clip-tile]") ?? [];
		let insertion = 0;
		tiles.forEach((tile, index) => {
			const rect = tile.getBoundingClientRect();
			if (clientX > rect.left + rect.width / 2) insertion = index + 1;
		});
		return insertion;
	};

	const startDrag = (index: number, down: PointerEvent) => {
		if (down.button !== 0) return;
		if ((down.target as HTMLElement).closest("button, input")) return;
		const startX = down.clientX;
		createRoot((dispose) => {
			let active = false;
			const move = (event: PointerEvent) => {
				if (
					!active &&
					(segments().length < 2 || Math.abs(event.clientX - startX) < 5)
				)
					return;
				active = true;
				setDragging(index);
				setDropAt(dropIndexAt(event.clientX));
			};
			const up = () => {
				const target = dropAt();
				if (active && target !== null) {
					setProject(
						produce((draft) => moveTimelineClip(draft, index, target)),
					);
					setEditorState("timeline", "selection", null);
				} else if (!active) {
					void jumpTo(index);
				}
				setDragging(null);
				setDropAt(null);
				dispose();
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up, { once: true });
			onCleanup(() => window.removeEventListener("pointermove", move));
		});
	};

	return (
		<div class="flex h-[48px] shrink-0 items-center gap-3 rounded-xl bg-ed-card pl-3.5 pr-1.5 shadow-ed-card">
			<div data-clip-strip-label class="flex shrink-0 items-baseline gap-1.5">
				<span class="text-[13px] font-medium text-ed-text-1">Clips</span>
				<span class="text-[12px] tabular-nums text-ed-text-3">
					{formatDuration(total())}
				</span>
			</div>
			<div
				ref={row}
				class="flex h-full min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]"
			>
				<For each={segments()}>
					{(segment, index) => (
						<>
							<AddClipGap
								insertAt={index()}
								label={
									index() === 0
										? "Add a clip at the start"
										: `Add a clip after ${name(segments()[index() - 1], index() - 1)}`
								}
								dropping={dragging() !== null && dropAt() === index()}
								onRecord={recordAt}
								onUpload={uploadAt}
								onAudio={addAudio}
							/>
							<div
								data-clip-tile
								onPointerDown={(event) => startDrag(index(), event)}
								class={cx(
									"group relative flex h-9 w-[150px] shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg bg-ed-ctl pr-1.5 outline-hidden transition-[box-shadow,opacity] duration-150",
									activeIndex() === index()
										? "shadow-[0_0_0_2px_var(--ed-accent)]"
										: "shadow-[0_0_0_1px_var(--ed-line)] hover:shadow-[0_0_0_1px_var(--ed-line-strong)]",
									dragging() === index() && "opacity-40",
								)}
							>
								<div class="relative h-full w-16 shrink-0 overflow-hidden">
									<ClipThumbnail
										projectPath={editorInstance.path}
										recordingSegment={segment.recordingSegment ?? 0}
										start={segment.start}
										index={index()}
									/>
								</div>
								<div class="flex min-w-0 flex-1 flex-col text-[12px] leading-4">
									<Show
										when={renaming() === index()}
										fallback={
											<span class="truncate font-medium text-ed-text-1">
												{name(segment, index())}
											</span>
										}
									>
										<input
											class="w-full rounded bg-ed-card px-1 text-[12px] text-ed-text-1 outline-hidden ring-1 ring-ed-accent"
											value={segment.name ?? ""}
											placeholder={`Clip ${index() + 1}`}
											ref={(input) => {
												renameInput = input;
												queueMicrotask(focusRenameInput);
											}}
											onKeyDown={(event) => {
												event.stopPropagation();
												if (event.key === "Enter")
													rename(index(), event.currentTarget.value);
												if (event.key === "Escape") setRenaming(null);
											}}
											onBlur={(event) =>
												rename(index(), event.currentTarget.value)
											}
										/>
									</Show>
									<span class="tabular-nums text-ed-text-3">
										{formatDuration(clipDuration(segment))}
									</span>
								</div>
								<ClipMenu
									canRemove={segments().length > 1}
									onRename={() => setRenaming(index())}
									onRenameFocus={focusRenameInput}
									onRemove={() => projectActions.deleteClipSegment(index())}
								/>
							</div>
						</>
					)}
				</For>
				<AddClipGap
					insertAt={segments().length}
					label="Add a clip at the end"
					dropping={dragging() !== null && dropAt() === segments().length}
					onRecord={recordAt}
					onUpload={uploadAt}
					onAudio={addAudio}
					trailing
				/>
			</div>
		</div>
	);
}

function AddClipGap(props: {
	insertAt: number;
	label: string;
	dropping: boolean;
	trailing?: boolean;
	onRecord: (insertAt: number) => void;
	onUpload: (insertAt: number) => void;
	onAudio: () => void;
}) {
	return (
		<KDropdownMenu gutter={8} placement="top">
			<Show
				when={props.trailing}
				fallback={
					<div class="group/gap relative flex h-9 w-4 shrink-0 items-center justify-center">
						<span
							class={cx(
								"absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-ed-accent transition-opacity",
								props.dropping ? "opacity-100" : "opacity-0",
							)}
						/>
						<KDropdownMenu.Trigger
							aria-label={props.label}
							title={props.label}
							class="relative z-10 flex size-5 items-center justify-center rounded-full bg-ed-accent text-white opacity-0 shadow-sm outline-hidden transition-[opacity,transform] duration-150 group-hover/gap:opacity-100 focus-visible:opacity-100 data-expanded:opacity-100 hover:scale-110"
						>
							<IconLucidePlus class="size-3" />
						</KDropdownMenu.Trigger>
					</div>
				}
			>
				<div class="flex shrink-0 items-center pl-1.5">
					<span
						class={cx(
							"mr-1.5 h-8 w-0.5 rounded-full bg-ed-accent transition-opacity",
							props.dropping ? "opacity-100" : "opacity-0",
						)}
					/>
					<KDropdownMenu.Trigger
						aria-label={props.label}
						class="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-ed-line-strong px-3 text-[12px] font-medium text-ed-text-2 outline-hidden transition-colors hover:border-ed-accent hover:bg-ed-accent/6 hover:text-ed-accent data-expanded:border-ed-accent data-expanded:text-ed-accent"
					>
						<IconLucidePlus class="size-3.5" />
						Add clip
					</KDropdownMenu.Trigger>
				</div>
			</Show>
			<KDropdownMenu.Portal>
				<PopperContent<typeof KDropdownMenu.Content>
					as={KDropdownMenu.Content}
					class={cx("w-72 p-1", topCenterAnimateClasses)}
				>
					<AddClipItem
						icon={<IconLucideVideo class="size-4" />}
						title="Record a new clip"
						detail="Screen, camera and mic, straight into this spot"
						onSelect={() => props.onRecord(props.insertAt)}
					/>
					<AddClipItem
						icon={<IconLucideUpload class="size-4" />}
						title="Upload a video"
						detail="MP4, MOV, WebM or a Cap recording"
						onSelect={() => props.onUpload(props.insertAt)}
					/>
					<AddClipItem
						icon={<IconLucideMic class="size-4" />}
						title="Add music or a voiceover"
						detail="Audio on its own track, from the playhead"
						onSelect={props.onAudio}
					/>
				</PopperContent>
			</KDropdownMenu.Portal>
		</KDropdownMenu>
	);
}

function AddClipItem(props: {
	icon: JSX.Element;
	title: string;
	detail: string;
	onSelect: () => void;
}) {
	return (
		<MenuItem<typeof KDropdownMenu.Item>
			as={KDropdownMenu.Item}
			class="!items-start !gap-2.5 !py-2"
			onSelect={props.onSelect}
		>
			<span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-ed-ctl text-ed-text-1">
				{props.icon}
			</span>
			<span class="flex min-w-0 flex-col whitespace-normal">
				<span class="text-[13px] font-medium text-ed-text-1">
					{props.title}
				</span>
				<span class="text-[12px] leading-snug text-ed-text-3">
					{props.detail}
				</span>
			</span>
		</MenuItem>
	);
}

function ClipMenu(props: {
	canRemove: boolean;
	onRename: () => void;
	onRenameFocus: () => void;
	onRemove: () => void;
}) {
	let renaming = false;
	return (
		<KDropdownMenu gutter={6} placement="bottom-end">
			<KDropdownMenu.Trigger
				aria-label="Clip options"
				class="flex size-6 shrink-0 items-center justify-center rounded-md text-ed-text-2 opacity-0 outline-hidden transition-opacity hover:bg-ed-ctl-hover hover:text-ed-text-1 group-hover:opacity-100 focus-visible:opacity-100 data-expanded:opacity-100"
			>
				<IconLucideMoreHorizontal class="size-3.5" />
			</KDropdownMenu.Trigger>
			<KDropdownMenu.Portal>
				<PopperContent<typeof KDropdownMenu.Content>
					as={KDropdownMenu.Content}
					class={cx("w-44 p-1", topCenterAnimateClasses)}
					// The menu hands focus back to its button as it closes; the
					// rename field takes it right after so typing lands there.
					onCloseAutoFocus={() => {
						if (!renaming) return;
						renaming = false;
						queueMicrotask(props.onRenameFocus);
					}}
				>
					<MenuItem<typeof KDropdownMenu.Item>
						as={KDropdownMenu.Item}
						onSelect={() => {
							renaming = true;
							props.onRename();
						}}
					>
						<IconLucidePencil class="size-3.5" />
						Rename
					</MenuItem>
					<MenuItem<typeof KDropdownMenu.Item>
						as={KDropdownMenu.Item}
						disabled={!props.canRemove}
						onSelect={props.onRemove}
					>
						<IconLucideTrash2 class="size-3.5" />
						Remove clip
					</MenuItem>
				</PopperContent>
			</KDropdownMenu.Portal>
		</KDropdownMenu>
	);
}
