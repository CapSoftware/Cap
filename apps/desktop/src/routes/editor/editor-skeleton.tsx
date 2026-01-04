import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";

const DEFAULT_TIMELINE_HEIGHT = 260;
const MIN_PLAYER_HEIGHT = 328;
const RESIZE_HANDLE_HEIGHT = 8;

function SkeletonPulse(props: { class?: string }) {
	return (
		<div
			class={cx("animate-pulse rounded bg-gray-3 dark:bg-gray-4", props.class)}
		/>
	);
}

function SkeletonButton(props: { class?: string; width?: string }) {
	return (
		<SkeletonPulse
			class={cx("h-9 rounded-lg", props.width ?? "w-9", props.class)}
		/>
	);
}

function HeaderSkeleton() {
	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-row items-center w-full h-14"
		>
			<div
				data-tauri-drag-region
				class="flex flex-row flex-1 gap-2 items-center px-4 h-full"
			>
				{ostype() === "macos" && <div class="h-full w-[4rem]" />}
				<SkeletonButton />
				<SkeletonButton />
				<SkeletonPulse class="h-5 w-32" />
				<SkeletonPulse class="h-5 w-8" />
				<div data-tauri-drag-region class="flex-1 h-full" />
				<SkeletonButton />
				<SkeletonButton />
			</div>

			<div
				data-tauri-drag-region
				class="flex flex-col justify-center px-4 border-x border-black-transparent-10"
			>
				<SkeletonPulse class="h-9 w-28 rounded-lg" />
			</div>

			<div
				data-tauri-drag-region
				class={cx(
					"flex-1 h-full flex flex-row items-center gap-2 pl-2",
					ostype() !== "windows" && "pr-2",
				)}
			>
				<SkeletonButton />
				<SkeletonButton />
				<div data-tauri-drag-region class="flex-1 h-full" />
				<SkeletonPulse class="h-[40px] w-[100px] rounded-[0.5rem]" />
				{ostype() === "windows" && <CaptionControlsWindows11 />}
			</div>
		</div>
	);
}

function PlayerToolbarSkeleton() {
	return (
		<div class="flex items-center justify-between gap-3 p-3">
			<div class="flex items-center gap-3">
				<SkeletonPulse class="h-9 w-24 rounded-lg" />
				<SkeletonPulse class="h-9 w-16 rounded-lg" />
			</div>
			<div class="flex items-center gap-2">
				<SkeletonPulse class="h-4 w-24" />
				<SkeletonPulse class="h-9 w-20 rounded-lg" />
			</div>
		</div>
	);
}

function VideoPreviewSkeleton() {
	return (
		<div class="relative flex-1 flex justify-center items-center">
			<div class="relative w-full h-full flex justify-center items-center p-4">
				<div class="relative bg-gray-3 dark:bg-gray-4 rounded-lg w-full max-w-[85%] aspect-video flex items-center justify-center">
					<div class="animate-spin grayscale opacity-60">
						<IconCapLogo class="size-[4rem] text-gray-6" />
					</div>
				</div>
			</div>
		</div>
	);
}

function PlayerControlsSkeleton() {
	return (
		<div class="flex overflow-hidden z-10 flex-row gap-3 justify-between items-center p-5">
			<div class="flex-1 flex items-center gap-1">
				<SkeletonPulse class="h-4 w-12" />
				<SkeletonPulse class="h-4 w-3" />
				<SkeletonPulse class="h-4 w-12" />
			</div>
			<div class="flex flex-row items-center justify-center gap-8">
				<SkeletonPulse class="size-3 rounded" />
				<SkeletonPulse class="size-9 rounded-full" />
				<SkeletonPulse class="size-3 rounded" />
			</div>
			<div class="flex flex-row flex-1 gap-4 justify-end items-center">
				<div class="flex-1" />
				<SkeletonButton />
				<SkeletonPulse class="w-px h-8 rounded-full" />
				<SkeletonPulse class="size-5 rounded" />
				<SkeletonPulse class="size-5 rounded" />
				<SkeletonPulse class="w-24 h-2 rounded-full" />
			</div>
		</div>
	);
}

function PlayerSkeleton() {
	return (
		<div class="flex flex-col flex-1 rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 overflow-hidden">
			<div class="flex flex-col flex-1 min-h-0">
				<PlayerToolbarSkeleton />
				<VideoPreviewSkeleton />
				<PlayerControlsSkeleton />
			</div>
			<div
				class="flex-none transition-colors"
				style={{ height: `${RESIZE_HANDLE_HEIGHT}px` }}
			>
				<div class="flex justify-center items-center h-full">
					<div class="h-1 w-12 rounded-full bg-gray-4" />
				</div>
			</div>
		</div>
	);
}

function SidebarSkeleton() {
	return (
		<div class="flex flex-col min-h-0 shrink-0 flex-1 max-w-[26rem] overflow-hidden rounded-xl z-10 bg-gray-1 dark:bg-gray-2 border border-gray-3">
			<div class="flex overflow-hidden sticky top-0 z-[60] flex-row items-center justify-center gap-4 h-16 border-b border-gray-3 shrink-0 bg-gray-1 dark:bg-gray-2">
				<SkeletonPulse class="size-9 rounded-lg" />
				<SkeletonPulse class="size-9 rounded-lg" />
				<SkeletonPulse class="size-9 rounded-lg" />
				<SkeletonPulse class="size-9 rounded-lg" />
				<SkeletonPulse class="size-9 rounded-lg" />
				<SkeletonPulse class="size-9 rounded-lg" />
			</div>
			<div class="flex-1 p-4 space-y-4 overflow-hidden">
				<SkeletonPulse class="h-4 w-20" />
				<div class="flex gap-2">
					<SkeletonPulse class="h-16 flex-1 rounded-lg" />
					<SkeletonPulse class="h-16 flex-1 rounded-lg" />
					<SkeletonPulse class="h-16 flex-1 rounded-lg" />
					<SkeletonPulse class="h-16 flex-1 rounded-lg" />
				</div>
				<SkeletonPulse class="h-px w-full" />
				<SkeletonPulse class="h-4 w-16" />
				<div class="grid grid-cols-4 gap-2">
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
					<SkeletonPulse class="aspect-video rounded" />
				</div>
			</div>
		</div>
	);
}

function TimelineTrackSkeleton() {
	return (
		<div class="flex items-center gap-2 h-[3.25rem]">
			<div class="w-16 flex items-center justify-center">
				<SkeletonPulse class="size-4 rounded" />
			</div>
			<div class="flex-1 h-full py-1">
				<SkeletonPulse class="h-full w-full rounded-lg" />
			</div>
		</div>
	);
}

function TimelineSkeleton() {
	return (
		<div class="h-full rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 overflow-hidden">
			<div class="pt-[2rem] relative flex flex-col gap-2 h-full px-4">
				<div class="relative h-[32px] flex items-end">
					<div class="flex items-center gap-8 w-full pl-16">
						<SkeletonPulse class="h-3 w-8" />
						<SkeletonPulse class="h-3 w-8" />
						<SkeletonPulse class="h-3 w-8" />
						<SkeletonPulse class="h-3 w-8" />
						<SkeletonPulse class="h-3 w-8" />
					</div>
					<div class="absolute bottom-0 left-0">
						<SkeletonPulse class="size-8 rounded-lg" />
					</div>
				</div>
				<div class="relative flex-1 min-h-0 space-y-1">
					<TimelineTrackSkeleton />
					<TimelineTrackSkeleton />
				</div>
			</div>
		</div>
	);
}

export function EditorSkeleton() {
	return (
		<div class="flex flex-col flex-1 min-h-0">
			<HeaderSkeleton />
			<div
				data-tauri-drag-region
				class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-4 w-full min-h-0 leading-5"
			>
				<div class="flex overflow-hidden flex-col flex-1 min-h-0">
					<div
						class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
						style={{
							"min-height": `${MIN_PLAYER_HEIGHT}px`,
						}}
					>
						<PlayerSkeleton />
						<SidebarSkeleton />
					</div>
					<div
						class="flex-none min-h-0 px-2 pb-0.5 overflow-hidden relative"
						style={{ height: `${DEFAULT_TIMELINE_HEIGHT}px` }}
					>
						<div class="h-full">
							<TimelineSkeleton />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
