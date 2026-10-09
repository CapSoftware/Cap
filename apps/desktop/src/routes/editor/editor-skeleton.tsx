import { createElementBounds } from "@solid-primitives/bounds";
import { makePersisted } from "@solid-primitives/storage";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createSignal, For, Show } from "solid-js";
import CaptionControlsMacOS from "~/components/titlebar/controls/CaptionControlsMacOS";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { DEFAULT_TIMELINE_HEIGHT, editorVerticalLayout } from "./editor-layout";
import { usePreparingEditorModel } from "./preparing-editor-context";
import {
	type PreparingEditorModel,
	preparingTime,
} from "./preparing-editor-model";
import { PreparingFrame } from "./preparing-frame";
import { PreparingTimeline } from "./preparing-timeline";

const DISABLED_CONTROL =
	"h-7 px-2 rounded-[7px] text-xs text-ed-text-3 disabled:opacity-50 disabled:cursor-default";

function PreparingHeader(props: { model: PreparingEditorModel }) {
	return (
		<div
			data-tauri-drag-region
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

function PreparingPlayer(props: { model: PreparingEditorModel }) {
	return (
		<div class="flex flex-col flex-1 min-w-0 rounded-xl bg-ed-card shadow-ed-card overflow-hidden">
			<div class="flex flex-row items-center px-3 h-11 shrink-0">
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
			<div class="relative flex flex-1 min-h-0 justify-center items-center p-4">
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
					{props.model.playback().buffering ? "Preparing playback" : ""}
				</div>
			</div>
		</div>
	);
}

function PreparingSidebar() {
	return (
		<div class="flex flex-col min-h-0 w-104 min-w-104 flex-none overflow-hidden rounded-xl bg-ed-card shadow-ed-card">
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

export function EditorSkeleton() {
	const model = usePreparingEditorModel();
	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const bounds = createElementBounds(layoutRef);
	const [savedHeight] = makePersisted(createSignal<number | null>(null), {
		name: "editorTimelineHeightOverride",
	});
	const layout = () =>
		editorVerticalLayout(
			(bounds.height ?? 576) - 16,
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
				class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-2 w-full min-h-0 leading-5 opacity-55"
				inert
			>
				<div
					class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
					style={{ "min-height": `${layout().minPlayerHeight}px` }}
				>
					<PreparingPlayer model={model} />
					<PreparingSidebar />
				</div>
				<div
					class="flex-none min-h-0 px-2 overflow-hidden"
					style={{ height: `${layout().timelineHeight}px` }}
				>
					<PreparingTimeline model={model} />
				</div>
			</div>
		</div>
	);
}
