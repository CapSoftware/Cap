import { createElementBounds } from "@solid-primitives/bounds";
import { makePersisted } from "@solid-primitives/storage";
import { createSignal, For } from "solid-js";
import {
	CLIP_STRIP_SPACE,
	DEFAULT_TIMELINE_HEIGHT,
	editorVerticalLayout,
} from "./editor-layout";
import { editorLayout } from "./responsive-layout";
import "./web-layout.css";

const DISABLED_CONTROL =
	"h-7 px-2 rounded-[7px] text-xs text-ed-text-3 disabled:opacity-50 disabled:cursor-default";

function SkeletonHeader() {
	return (
		<div
			data-editor-header
			class="flex relative shrink-0 flex-row items-center w-full h-13 pr-3 max-[900px]:grid max-[900px]:grid-cols-1 max-[900px]:grid-rows-[36px_36px] max-[900px]:h-[72px] max-[900px]:pr-2"
		>
			<div class="flex flex-row flex-1 min-w-0 items-center h-full">
				<div class="w-3 shrink-0" />
				<span class="truncate text-[13px] font-medium">Recording</span>
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
				<div class="flex-1 h-full" />
			</div>
			<div class="flex gap-1 items-center justify-end max-[900px]:pr-1">
				<button type="button" disabled class={DISABLED_CONTROL}>
					Presets
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
		</div>
	);
}

function SkeletonPlayer() {
	return (
		<div
			data-editor-player
			class="flex flex-col flex-1 min-w-0 rounded-[14px] overflow-hidden"
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
			<div class="relative flex flex-1 min-h-0 justify-center items-center p-4">
				<div class="w-full max-h-full aspect-video rounded-[6px] bg-ed-ctl" />
			</div>
			<div class="flex flex-row items-center px-3.5 h-12 shrink-0">
				<div class="flex-1" />
				<div class="flex gap-3.5 items-center">
					<button
						type="button"
						aria-label="Play"
						disabled
						class="flex items-center justify-center size-8 rounded-full bg-ed-ctl-hover text-ed-text-1 disabled:opacity-40"
					>
						<IconCapPlay class="size-3" />
					</button>
				</div>
				<div class="flex-1" />
			</div>
		</div>
	);
}

function SkeletonSidebar() {
	return (
		<div
			data-editor-sheet
			class="flex flex-col min-h-0 w-104 min-w-104 flex-none overflow-hidden rounded-[14px] bg-ed-card shadow-ed-card"
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

export function EditorSkeleton() {
	const compact = editorLayout().compact;
	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const bounds = createElementBounds(layoutRef);
	const [savedHeight] = makePersisted(createSignal<number | null>(null), {
		name: "editorTimelineHeightOverride",
	});
	const layout = () =>
		editorVerticalLayout(
			(bounds.height ?? 576) - 16 - CLIP_STRIP_SPACE,
			savedHeight() ?? DEFAULT_TIMELINE_HEIGHT,
		);
	return (
		<section
			class="flex flex-col flex-1 min-h-0"
			aria-busy="true"
			aria-label="Recording editor"
			data-editor-skeleton
		>
			<SkeletonHeader />
			<div
				ref={setLayoutRef}
				data-editor-grid
				class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-2 w-full min-h-0 leading-5 opacity-55"
				inert
			>
				<div
					data-editor-player-row
					class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
					style={{ "min-height": `${layout().minPlayerHeight}px` }}
				>
					<SkeletonPlayer />
					<SkeletonSidebar />
				</div>
				<div data-editor-clip-strip class="flex-none px-2">
					<div class="h-[48px]" />
				</div>
				<div
					data-editor-timeline
					class="flex-none min-h-0 px-2 overflow-hidden"
					style={
						compact() ? undefined : { height: `${layout().timelineHeight}px` }
					}
				>
					<div class="h-full" />
				</div>
			</div>
		</section>
	);
}
