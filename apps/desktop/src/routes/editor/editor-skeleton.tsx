import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";

const MIN_PLAYER_HEIGHT = 320;
const TIMELINE_SKELETON_HEIGHT = 22 + 26 + 4 + 2 * 44 + 6;

function SkeletonPulse(props: { class?: string }) {
	return (
		<div class={cx("animate-pulse rounded-sm bg-ed-ctl-hover", props.class)} />
	);
}

function HeaderSkeleton() {
	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-row items-center w-full h-13 pr-3"
		>
			<div
				data-tauri-drag-region
				class="flex flex-row flex-1 gap-1.5 items-center h-full"
			>
				{ostype() === "macos" && <div class="h-full w-[92px] shrink-0" />}
				{ostype() === "windows" && <div class="w-3 shrink-0" />}
				<SkeletonPulse class="h-4 w-40" />
				<SkeletonPulse class="h-4 w-7" />
				<SkeletonPulse class="ml-1.5 size-7 rounded-[7px]" />
				<SkeletonPulse class="size-7 rounded-[7px]" />
				<div data-tauri-drag-region class="flex-1 h-full" />
			</div>
			<div class="flex flex-row gap-1 items-center">
				<SkeletonPulse class="size-7 rounded-[7px]" />
				<SkeletonPulse class="size-7 rounded-[7px]" />
				<SkeletonPulse class="mx-1.5 w-px h-4" />
				<SkeletonPulse class="h-7 w-20 rounded-[7px]" />
				<SkeletonPulse class="h-7 w-16 rounded-[7px]" />
				<SkeletonPulse class="ml-1.5 h-[30px] w-[92px] rounded-lg" />
			</div>
			{ostype() === "windows" && <CaptionControlsWindows11 class="shrink-0" />}
		</div>
	);
}

function PlayerSkeleton() {
	return (
		<div class="flex flex-col flex-1 min-w-0 rounded-xl bg-ed-card shadow-ed-card overflow-hidden">
			<div class="flex flex-row items-center px-3 h-11 shrink-0">
				<div class="flex flex-row flex-1 gap-0.5 items-center">
					<SkeletonPulse class="h-7 w-16 rounded-[7px]" />
					<SkeletonPulse class="h-7 w-16 rounded-[7px]" />
					<SkeletonPulse class="h-7 w-20 rounded-[7px]" />
				</div>
				<div class="flex flex-row gap-2 items-center">
					<SkeletonPulse class="h-3 w-12" />
					<SkeletonPulse class="h-7 w-40 rounded-lg" />
				</div>
			</div>
			<div class="relative flex flex-1 min-h-0 justify-center items-center p-4">
				<div class="flex justify-center items-center w-full max-w-[85%] rounded-md aspect-video bg-ed-ctl">
					<div class="animate-spin opacity-60">
						<IconCapLogo class="size-16 text-ed-text-3" />
					</div>
				</div>
			</div>
			<div class="flex flex-row items-center px-3.5 h-12 shrink-0">
				<div class="flex flex-row flex-1 items-center">
					<SkeletonPulse class="h-4 w-24" />
				</div>
				<div class="flex flex-row gap-3.5 items-center">
					<SkeletonPulse class="size-3.5 rounded-sm" />
					<SkeletonPulse class="size-8 rounded-full" />
					<SkeletonPulse class="size-3.5 rounded-sm" />
				</div>
				<div class="flex flex-row flex-1 gap-0.5 justify-end items-center">
					<SkeletonPulse class="size-7 rounded-[7px]" />
					<SkeletonPulse class="mx-1.5 w-px h-4" />
					<SkeletonPulse class="size-7 rounded-[7px]" />
					<SkeletonPulse class="mx-1 w-[72px] h-[3px] rounded-full" />
					<SkeletonPulse class="size-7 rounded-[7px]" />
				</div>
			</div>
		</div>
	);
}

function SidebarSkeleton() {
	return (
		<div class="flex flex-col min-h-0 w-104 min-w-104 flex-none overflow-hidden rounded-xl bg-ed-card shadow-ed-card">
			<div class="flex flex-row justify-around items-center px-2.5 h-[46px] border-b border-ed-line shrink-0">
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
				<SkeletonPulse class="w-10 h-[30px] rounded-[9px]" />
			</div>
			<div class="flex flex-col flex-1 gap-3.5 px-4 pt-3.5 pb-4 overflow-hidden">
				<div class="flex justify-between items-center h-5">
					<SkeletonPulse class="h-3 w-20" />
					<SkeletonPulse class="h-5 w-12 rounded-md" />
				</div>
				<SkeletonPulse class="h-[30px] w-full rounded-lg" />
				<div class="flex gap-1">
					<SkeletonPulse class="h-6 w-16 rounded-[7px]" />
					<SkeletonPulse class="h-6 w-12 rounded-[7px]" />
					<SkeletonPulse class="h-6 w-12 rounded-[7px]" />
					<SkeletonPulse class="h-6 w-14 rounded-[7px]" />
				</div>
				<div class="grid grid-cols-6 gap-1.5">
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
					<SkeletonPulse class="h-[34px] rounded-md" />
				</div>
				<div class="h-px w-full bg-ed-line" />
				<SkeletonPulse class="h-3 w-14" />
				<div class="flex items-center gap-3 h-[34px]">
					<SkeletonPulse class="h-3.5 w-16" />
					<SkeletonPulse class="flex-1 h-[3px] rounded-full" />
					<SkeletonPulse class="h-3 w-8" />
				</div>
				<div class="flex items-center gap-3 h-[34px]">
					<SkeletonPulse class="h-3.5 w-14" />
					<SkeletonPulse class="flex-1 h-[3px] rounded-full" />
					<SkeletonPulse class="h-3 w-8" />
				</div>
				<div class="flex items-center justify-between h-[34px]">
					<SkeletonPulse class="h-3.5 w-16" />
					<SkeletonPulse class="h-5 w-[34px] rounded-full" />
				</div>
			</div>
		</div>
	);
}

function TimelineTrackSkeleton() {
	return (
		<div class="flex items-center h-11 rounded-lg bg-ed-ctl">
			<div class="flex gap-1.5 items-center pl-2 w-[104px] shrink-0">
				<SkeletonPulse class="size-[22px] rounded-md" />
				<SkeletonPulse class="h-3 w-10" />
			</div>
			<SkeletonPulse class="flex-1 h-full rounded-r-lg" />
		</div>
	);
}

function TimelineSkeleton() {
	return (
		<div class="flex flex-col h-full rounded-xl bg-ed-card shadow-ed-card overflow-hidden px-3 pt-2.5 pb-3">
			<div class="flex items-end h-[26px] shrink-0">
				<div class="w-[104px] pl-1 shrink-0">
					<SkeletonPulse class="h-6 w-[88px] rounded-md" />
				</div>
				<div class="flex flex-1 gap-[92px] items-end pb-2.5">
					<SkeletonPulse class="h-2.5 w-7" />
					<SkeletonPulse class="h-2.5 w-7" />
					<SkeletonPulse class="h-2.5 w-7" />
					<SkeletonPulse class="h-2.5 w-7" />
					<SkeletonPulse class="h-2.5 w-7" />
					<SkeletonPulse class="h-2.5 w-7" />
				</div>
			</div>
			<div class="flex flex-col gap-1.5 mt-1">
				<TimelineTrackSkeleton />
				<TimelineTrackSkeleton />
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
				class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-2 w-full min-h-0 leading-5"
			>
				<div
					class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
					style={{ "min-height": `${MIN_PLAYER_HEIGHT}px` }}
				>
					<PlayerSkeleton />
					<SidebarSkeleton />
				</div>
				<div
					class="flex-none min-h-0 px-2 overflow-hidden"
					style={{ height: `${TIMELINE_SKELETON_HEIGHT}px` }}
				>
					<TimelineSkeleton />
				</div>
			</div>
		</div>
	);
}
