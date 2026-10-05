import { createElementBounds } from "@solid-primitives/bounds";
import { makePersisted } from "@solid-primitives/storage";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createSignal, For, onCleanup, Show } from "solid-js";
import CaptionControlsMacOS from "~/components/titlebar/controls/CaptionControlsMacOS";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { BufferingStatus, createBufferingDisplay } from "./buffering-status";
import { createConnectionLevel } from "./connection-status";
import {
	CLIP_STRIP_SPACE,
	DEFAULT_TIMELINE_HEIGHT,
	editorVerticalLayout,
} from "./editor-layout";
import {
	createPlayRequested,
	requestPlayWhenReady,
} from "./playback-buffering";
import { usePreparingEditorModel } from "./preparing-editor-context";
import {
	type PreparingEditorModel,
	preparingTime,
} from "./preparing-editor-model";
import { PreparingFrame } from "./preparing-frame";
import { PreparingTimeline } from "./preparing-timeline";
import { editorLayout } from "./responsive-layout";
import "./web-layout.css";

const isWebEditor = import.meta.env.VITE_CAP_WEB_EDITOR === "true";

const OPENING_SLOW_AFTER_MS = 6000;

const DISABLED_CONTROL =
	"h-7 px-2 rounded-[7px] text-xs text-ed-text-3 disabled:opacity-50 disabled:cursor-default";

function PreparingHeader(props: { model: PreparingEditorModel }) {
	return (
		<div
			data-tauri-drag-region
			data-editor-header
			class="flex relative shrink-0 flex-row items-center w-full h-13 pr-3 max-[900px]:grid max-[900px]:grid-cols-1 max-[900px]:grid-rows-[36px_36px] max-[900px]:h-[72px] max-[900px]:pr-2"
		>
			<div
				data-tauri-drag-region
				class="flex flex-row flex-1 min-w-0 items-center h-full"
			>
				{ostype() === "macos" && (
					<div data-tauri-drag-region class="h-full w-[92px] shrink-0" />
				)}
				{ostype() === "linux" && (
					<CaptionControlsMacOS class="mr-1 ml-3 shrink-0" />
				)}
				{ostype() === "windows" && <div class="w-3 shrink-0" />}
				<span class="truncate text-[13px] font-medium">
					{props.model.seed().title || "Recording"}
				</span>
				<span class="ml-1.5 text-[13px] text-ed-text-3">.cap</span>
				<div class="flex gap-1 ml-3">
					<button
						type="button"
						disabled
						class={DISABLED_CONTROL}
						aria-label="Undo"
					>
						↶
					</button>
					<button
						type="button"
						disabled
						class={DISABLED_CONTROL}
						aria-label="Redo"
					>
						↷
					</button>
				</div>
				<div data-tauri-drag-region class="flex-1 h-full" />
			</div>
			<div class="flex gap-1 items-center justify-end max-[900px]:pr-1">
				<button type="button" disabled class={DISABLED_CONTROL}>
					Presets
				</button>
				<button type="button" disabled class={DISABLED_CONTROL}>
					Clips
				</button>
				<button
					type="button"
					disabled
					class="ml-1.5 h-[30px] px-3.5 rounded-lg bg-ed-accent/40 text-white/70 text-[13px] font-medium"
					title="Available when your recording is ready to edit"
				>
					Export
				</button>
			</div>
			{ostype() === "windows" && (
				<CaptionControlsWindows11 class="shrink-0 max-[900px]:absolute max-[900px]:top-0 max-[900px]:right-0" />
			)}
		</div>
	);
}

function PreparingPlayer(props: {
	model: PreparingEditorModel;
	playButtonRef?: (element: HTMLButtonElement) => void;
	previewRef?: (element: HTMLDivElement) => void;
	quiet?: boolean;
}) {
	return (
		<div
			data-editor-player
			class="flex flex-col flex-1 min-w-0 rounded-xl bg-ed-card shadow-ed-card overflow-hidden"
		>
			<div
				data-player-toolbar
				class="flex flex-row items-center px-3 h-11 shrink-0"
			>
				<div class="flex flex-row flex-1 gap-0.5 items-center">
					<button type="button" disabled class={DISABLED_CONTROL}>
						Aspect ratio
					</button>
					<button type="button" disabled class={DISABLED_CONTROL}>
						Captions
					</button>
				</div>
				<span class="text-[11px] text-ed-text-3">Preview</span>
			</div>
			<div
				ref={props.previewRef}
				class="relative flex flex-1 min-h-0 justify-center items-center p-4"
			>
				<PreparingFrame />
			</div>
			<div class="flex flex-row items-center px-3.5 h-12 shrink-0">
				<div class="flex-1 tabular-nums text-[11px] text-ed-text-3">
					{preparingTime(props.model.playback().playheadSeconds)}
					<Show when={props.model.timeline().totalDuration}>
						{(duration) => <span> / {preparingTime(duration())}</span>}
					</Show>
				</div>
				<div class="flex gap-3.5 items-center">
					<button
						type="button"
						aria-label="Go to beginning"
						disabled={!props.model.canPlay()}
						class={DISABLED_CONTROL}
						onClick={() => void props.model.seek(0)}
					>
						↤
					</button>
					<button
						ref={props.playButtonRef}
						type="button"
						aria-label={props.model.playback().playing ? "Pause" : "Play"}
						disabled={!props.model.canPlay()}
						class="flex items-center justify-center size-8 rounded-full bg-ed-ctl-hover text-ed-text-1 disabled:opacity-40"
						onClick={() =>
							void props.model.setPlaying(!props.model.playback().playing)
						}
					>
						<Show
							when={props.model.playback().playing}
							fallback={<IconCapPlay class="size-3" />}
						>
							<IconCapPause class="size-3" />
						</Show>
					</button>
					<button
						type="button"
						aria-label="Go to playable end"
						disabled={!props.model.canPlay()}
						class={DISABLED_CONTROL}
						onClick={() =>
							void props.model.seek(props.model.timeline().playableUntil)
						}
					>
						↦
					</button>
				</div>
				<div class="flex-1 text-right text-[11px] text-ed-text-3" role="status">
					{props.model.playback().buffering && !props.quiet
						? "Preparing playback"
						: ""}
				</div>
			</div>
		</div>
	);
}

function PreparingSidebar() {
	return (
		<div
			data-editor-sheet
			class="flex flex-col min-h-0 w-104 min-w-104 flex-none overflow-hidden rounded-xl bg-ed-card shadow-ed-card"
		>
			<div class="flex justify-around items-center px-2.5 h-[46px] border-b border-ed-line shrink-0">
				<For each={["Background", "Camera", "Audio", "Cursor", "Keyboard"]}>
					{(name) => (
						<button
							type="button"
							disabled
							class="px-1 text-[10px] text-ed-text-3 opacity-50"
						>
							{name}
						</button>
					)}
				</For>
			</div>
			<div class="flex flex-col gap-5 px-4 py-4">
				<div>
					<h2 class="text-[12px] font-medium text-ed-text-2">Background</h2>
					<p class="mt-2 text-[12px] text-ed-text-3">
						Choose a background for your recording.
					</p>
				</div>
				<div class="h-px bg-ed-line" />
				<For each={["Padding", "Rounding", "Shadow"]}>
					{(name) => (
						<div class="flex items-center justify-between h-[34px] text-[12px] text-ed-text-3">
							<span>{name}</span>
							<span class="h-1 w-24 rounded-full bg-ed-ctl-hover" />
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

/// Play on the web editor's loading screen: the editor starts playing once it
/// has mounted and its first frame is ready. It sits over the dimmed, inert
/// layout, on the play button it stands in for.
function PlayWhenReady(props: {
	anchor: HTMLButtonElement | undefined;
	preview: HTMLDivElement | undefined;
}) {
	const bounds = createElementBounds(() => props.anchor);
	const preview = createElementBounds(() => props.preview);
	const requested = createPlayRequested();
	// The whole loading screen is a wait, so its status shows from the start
	// rather than only once Play is pressed.
	const status = createBufferingDisplay(() => true, requested);
	// Opening takes a few seconds on any connection, so the reason for the
	// wait shows early only when the connection is the reason.
	const connection = createConnectionLevel();
	const [late, setLate] = createSignal(false);
	const lateTimer = setTimeout(() => setLate(true), OPENING_SLOW_AFTER_MS);
	onCleanup(() => clearTimeout(lateTimer));
	const slow = () =>
		status.slow() &&
		(late() || (connection() !== null && connection() !== "good"));
	return (
		<Show when={bounds.width && bounds.height}>
			<Show when={status.shown() && preview.width && preview.height}>
				<div
					class="fixed z-10 pointer-events-none"
					style={{
						left: `${preview.left}px`,
						top: `${preview.top}px`,
						width: `${preview.width}px`,
						height: `${preview.height}px`,
					}}
				>
					<BufferingStatus
						playing={requested()}
						slow={slow()}
						title={requested() ? "Loading video" : "Loading editor"}
						then={
							requested()
								? "Playback starts as soon as enough has loaded."
								: "The editor opens as soon as it has loaded."
						}
					/>
				</div>
			</Show>
			<button
				type="button"
				aria-label={requested() ? "Pause video" : "Play video"}
				aria-busy={requested() || undefined}
				class="flex fixed z-10 justify-center items-center rounded-full size-8 bg-ed-text-1 text-ed-card transition-opacity hover:opacity-90"
				style={{ left: `${bounds.left}px`, top: `${bounds.top}px` }}
				onClick={() => requestPlayWhenReady(!requested())}
			>
				<Show when={requested()} fallback={<IconCapPlay class="size-3" />}>
					<IconCapPause class="size-3" />
					<span
						aria-hidden="true"
						class="absolute -inset-[3px] rounded-full border-2 border-transparent border-t-ed-text-1 animate-spin will-change-transform motion-reduce:animate-none"
					/>
				</Show>
			</button>
		</Show>
	);
}

export function EditorSkeleton(
	props: { model?: PreparingEditorModel; playWhenReady?: boolean } = {},
) {
	const model = props.model ?? usePreparingEditorModel();
	const compact = editorLayout().compact;
	const [playButton, setPlayButton] = createSignal<HTMLButtonElement>();
	const [preview, setPreview] = createSignal<HTMLDivElement>();
	// A recording still being prepared plays from its own controls instead.
	// On the web every loading screen shows it, including the editor's own
	// while it loads the project after its code has.
	const playWhenReady = () =>
		(props.playWhenReady ?? isWebEditor) && !model.canPlay();
	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const bounds = createElementBounds(layoutRef);
	const [savedHeight] = makePersisted(createSignal<number | null>(null), {
		name: "editorTimelineHeightOverride",
	});
	const layout = () =>
		editorVerticalLayout(
			(bounds.height ?? 576) - 16 - (isWebEditor ? CLIP_STRIP_SPACE : 0),
			savedHeight() ?? DEFAULT_TIMELINE_HEIGHT,
		);
	return (
		<div
			class="flex flex-col flex-1 min-h-0"
			aria-busy="true"
			aria-label="Recording editor"
			data-preparing-editor
		>
			<PreparingHeader model={model} />
			<div
				ref={setLayoutRef}
				data-tauri-drag-region
				data-editor-grid
				class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-2 w-full min-h-0 leading-5 opacity-55"
				inert
			>
				<div
					data-editor-player-row
					class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
					style={{ "min-height": `${layout().minPlayerHeight}px` }}
				>
					<PreparingPlayer
						model={model}
						playButtonRef={setPlayButton}
						previewRef={setPreview}
						quiet={playWhenReady()}
					/>
					<PreparingSidebar />
				</div>
				<Show when={isWebEditor}>
					<div data-editor-clip-strip class="flex-none px-2">
						<div class="h-[48px] rounded-xl bg-ed-card shadow-ed-card" />
					</div>
				</Show>
				<div
					data-editor-timeline
					class="flex-none min-h-0 px-2 overflow-hidden"
					style={
						compact() ? undefined : { height: `${layout().timelineHeight}px` }
					}
				>
					<PreparingTimeline model={model} quiet={playWhenReady()} />
				</div>
			</div>
			<Show when={playWhenReady()}>
				<PlayWhenReady anchor={playButton()} preview={preview()} />
			</Show>
		</div>
	);
}
