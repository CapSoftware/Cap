import { ProgressCircle } from "@cap/ui-solid";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import type { ComponentProps } from "solid-js";
import { createMemo, createSignal, Show, splitProps } from "solid-js";
import toast from "solid-toast";
import Tooltip from "~/components/Tooltip";
import {
	type CaptureDisplayWithThumbnail,
	type CaptureWindowWithThumbnail,
	commands,
	type RecordingMeta,
	type RecordingMetaWithMetadata,
} from "~/utils/tauri";
import IconCapLink from "~icons/cap/link";
import IconCapTrash from "~icons/cap/trash";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideEdit from "~icons/lucide/edit";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideImage from "~icons/lucide/image";
import IconLucideRotateCcw from "~icons/lucide/rotate-ccw";
import IconLucideSave from "~icons/lucide/save";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import IconMdiMonitor from "~icons/mdi/monitor";
import IconPhWarningBold from "~icons/ph/warning-bold";

export type RecordingWithPath = RecordingMetaWithMetadata & { path: string };
export type ScreenshotWithPath = RecordingMeta & { path: string };

function formatResolution(width?: number, height?: number) {
	if (!width || !height) return undefined;

	const roundedWidth = Math.round(width);
	const roundedHeight = Math.round(height);

	if (roundedWidth <= 0 || roundedHeight <= 0) return undefined;

	return `${roundedWidth}×${roundedHeight}`;
}

function formatRefreshRate(refreshRate?: number) {
	if (!refreshRate) return undefined;

	return `${refreshRate} Hz`;
}

type TargetCardProps = (
	| {
			variant: "display";
			target: CaptureDisplayWithThumbnail;
	  }
	| {
			variant: "window";
			target: CaptureWindowWithThumbnail;
	  }
	| {
			variant: "recording";
			target: RecordingWithPath;
			uploadProgress?: number;
			isReuploading?: boolean;
			onReupload?: (path: string) => void;
			onRefetch?: () => void;
	  }
	| {
			variant: "screenshot";
			target: ScreenshotWithPath;
	  }
) &
	Omit<ComponentProps<"button">, "children"> & {
		highlightQuery?: string;
	};

export default function TargetCard(props: TargetCardProps) {
	const [local, rest] = splitProps(props, [
		"variant",
		"target",
		"class",
		"disabled",
		"highlightQuery",
	]);
	const [imageExists, setImageExists] = createSignal(true);

	const recordingProps = () => {
		if (local.variant !== "recording") return undefined;
		return props as Extract<TargetCardProps, { variant: "recording" }>;
	};

	const displayTarget = createMemo(() => {
		if (local.variant !== "display") return undefined;
		return local.target as CaptureDisplayWithThumbnail;
	});

	const windowTarget = createMemo(() => {
		if (local.variant !== "window") return undefined;
		return local.target as CaptureWindowWithThumbnail;
	});

	const recordingTarget = createMemo(() => {
		if (local.variant !== "recording") return undefined;
		return local.target as RecordingWithPath;
	});

	const screenshotTarget = createMemo(() => {
		if (local.variant !== "screenshot") return undefined;
		return local.target as ScreenshotWithPath;
	});

	const renderIcon = (className: string) =>
		local.variant === "display" ? (
			<IconMdiMonitor class={className} />
		) : local.variant === "window" ? (
			<IconLucideAppWindowMac class={className} />
		) : local.variant === "recording" ? (
			<IconLucideSquarePlay class={className} />
		) : (
			<IconLucideImage class={className} />
		);

	const label = createMemo(() => {
		const display = displayTarget();
		if (display) return display.name;
		const target = windowTarget();
		if (target) return target.name || target.owner_name;
		const recording = recordingTarget();
		if (recording) return recording.pretty_name;
		const screenshot = screenshotTarget();
		return screenshot?.pretty_name;
	});

	const subtitle = createMemo(() => {
		const target = windowTarget();
		if (target) return target.owner_name;
		const recording = recordingTarget();
		if (recording) {
			return recording.mode === "studio" ? "Studio Mode" : "Instant Mode";
		}
		return undefined;
	});

	const metadata = createMemo(() => {
		if (local.variant === "window") {
			const target = windowTarget();
			if (!target) return undefined;
			const bounds = target.bounds;
			const resolution = formatResolution(
				bounds?.size.width,
				bounds?.size.height,
			);
			const refreshRate = formatRefreshRate(target.refresh_rate);

			if (resolution && refreshRate) return `${resolution} @ ${refreshRate}`;
			return resolution ?? refreshRate ?? undefined;
		}

		const target = displayTarget();
		return target ? formatRefreshRate(target.refresh_rate) : undefined;
	});

	const thumbnailSrc = createMemo(() => {
		const recording = recordingTarget();
		if (recording) {
			return `${convertFileSrc(
				`${recording.path}/screenshots/display.jpg`,
			)}?t=${Date.now()}`;
		}
		const screenshot = screenshotTarget();
		if (screenshot) {
			return `${convertFileSrc(screenshot.path)}?t=${Date.now()}`;
		}
		const target = displayTarget() ?? windowTarget();
		if (!target?.thumbnail) return undefined;
		return `data:image/png;base64,${target.thumbnail}`;
	});

	const appIconSrc = createMemo(() => {
		const target = windowTarget();
		if (!target?.app_icon) return undefined;
		return `data:image/png;base64,${target.app_icon}`;
	});

	const normalizedQuery = createMemo(() => local.highlightQuery?.trim() ?? "");

	const highlight = (text?: string | null) => {
		if (!text) return text;
		const query = normalizedQuery();
		if (!query) return text;

		const regex = new RegExp(`(${escapeRegExp(query)})`, "ig");
		const parts = text.split(regex);
		if (parts.length === 1) return text;

		const lowercaseQuery = query.toLowerCase();

		return parts.map((part) => {
			if (part.toLowerCase() === lowercaseQuery) {
				return (
					<span class="rounded bg-blue-9/20 px-[1px] text-gray-12">{part}</span>
				);
			}
			return part;
		});
	};

	const handleOpenEditor = (e: MouseEvent) => {
		e.stopPropagation();
		const screenshot = screenshotTarget();
		if (!screenshot) return;
		commands.showWindow({
			ScreenshotEditor: {
				path: screenshot.path,
			},
		});
	};

	const handleCopy = async (e: MouseEvent) => {
		e.stopPropagation();
		const screenshot = screenshotTarget();
		if (!screenshot) return;
		try {
			await commands.copyScreenshotToClipboard(screenshot.path);
			toast.success("Screenshot copied to clipboard");
		} catch (error) {
			console.error("Failed to copy screenshot:", error);
			toast.error("Failed to copy screenshot");
		}
	};

	const handleSave = async (e: MouseEvent) => {
		e.stopPropagation();
		const screenshot = screenshotTarget();
		if (!screenshot) return;
		try {
			const path = await save({
				defaultPath: `${screenshot.pretty_name}.png`,
				filters: [
					{
						name: "Image",
						extensions: ["png"],
					},
				],
			});
			if (!path) return;
			await commands.copyFileToPath(screenshot.path, path);
			toast.success("Screenshot saved");
		} catch (error) {
			console.error("Failed to save screenshot:", error);
			toast.error("Failed to save screenshot");
		}
	};

	const handleOpenRecordingEditor = (e: MouseEvent) => {
		e.stopPropagation();
		const recording = recordingTarget();
		if (!recording) return;
		commands.showWindow({
			Editor: { project_path: recording.path },
		});
	};

	const handleOpenRecordingLink = (e: MouseEvent) => {
		e.stopPropagation();
		const recording = recordingTarget();
		if (!recording?.sharing) return;
		shell.open(recording.sharing.link);
	};

	const handleOpenRecordingFolder = (e: MouseEvent) => {
		e.stopPropagation();
		const recording = recordingTarget();
		if (!recording) return;
		commands.openFilePath(recording.path);
	};

	const handleDeleteRecording = async (e: MouseEvent) => {
		e.stopPropagation();
		const recording = recordingTarget();
		if (!recording) return;
		if (!(await ask("Are you sure you want to delete this recording?"))) return;
		await remove(recording.path, { recursive: true });
		recordingProps()?.onRefetch?.();
	};

	const handleReupload = (e: MouseEvent) => {
		e.stopPropagation();
		const recording = recordingTarget();
		if (!recording) return;
		recordingProps()?.onReupload?.(recording.path);
	};

	const recordingUploadFailed = createMemo(() => {
		const recording = recordingTarget();
		if (!recording) return false;
		return recording.upload?.state === "Failed";
	});

	const recordingFailed = createMemo(() => {
		const recording = recordingTarget();
		if (!recording) return false;
		return recording.status.status === "Failed";
	});

	const getUploadProgress = () => recordingProps()?.uploadProgress;

	const getIsReuploading = () => recordingProps()?.isReuploading ?? false;

	return (
		<button
			type="button"
			{...rest}
			disabled={local.disabled}
			data-variant={local.variant}
			class={cx(
				"group flex flex-col overflow-hidden rounded-lg border border-transparent bg-gray-3 text-left outline-none transition-colors duration-100 hover:bg-gray-4 focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				local.disabled && "pointer-events-none opacity-60",
				local.class,
			)}
		>
			<div class="relative h-[4.75rem] w-full overflow-hidden bg-gray-4/40">
				<Show
					when={imageExists() ? thumbnailSrc() : undefined}
					fallback={
						<div class="flex justify-center items-center w-full h-full bg-gray-4">
							{renderIcon("size-6 text-gray-9 opacity-70")}
						</div>
					}
				>
					{(src) => (
						<img
							src={src()}
							alt={`${
								local.variant === "display" ? "Display" : "Window"
							} preview for ${label()}`}
							class="object-cover w-full h-full"
							loading="lazy"
							draggable={false}
							onError={() => setImageExists(false)}
						/>
					)}
				</Show>
				<Show when={appIconSrc()}>
					{(src) => (
						<div class="flex absolute inset-0 justify-center items-center pointer-events-none bg-black/45">
							<img
								src={src()}
								alt={`${label()} icon`}
								class="h-16 w-16 max-h-[55%] max-w-[55%] rounded-lg border border-black/20 object-contain shadow-lg shadow-black/30"
								draggable={false}
							/>
						</div>
					)}
				</Show>
				<div class="absolute inset-0 border opacity-60 pointer-events-none border-black/5" />
				<div class="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent pointer-events-none from-black/40" />
				<Show when={recordingFailed() || recordingUploadFailed()}>
					<div class="absolute inset-0 flex items-center justify-center bg-black/75">
						<div class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-9/20 text-red-11">
							<IconPhWarningBold class="size-2.5" />
							<span class="text-[10px] font-medium">
								{recordingFailed() ? "Recording failed" : "Upload failed"}
							</span>
						</div>
					</div>
				</Show>
			</div>
			<div class="flex flex-col w-full">
				<div class="flex flex-row items-start gap-2 px-2 py-1.5">
					<div class="flex-1 min-w-0">
						<p class="truncate text-[11px] font-medium text-gray-12">
							{highlight(label())}
						</p>
						<Show when={subtitle()}>
							<p class="truncate text-[11px] text-gray-11">
								{highlight(subtitle())}
							</p>
						</Show>
						<Show when={metadata()}>
							<p class="truncate text-[11px] text-gray-10">
								{highlight(metadata())}
							</p>
						</Show>
					</div>
				</div>
				<Show when={local.variant === "screenshot"}>
					<div class="flex items-center justify-between px-2 pb-1.5 pt-0.5 gap-1">
						<div
							role="button"
							tabIndex={-1}
							onClick={handleOpenEditor}
							class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
							title="Editor"
						>
							<IconLucideEdit class="size-3.5" />
						</div>
						<div
							role="button"
							tabIndex={-1}
							onClick={handleCopy}
							class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
							title="Copy to clipboard"
						>
							<IconLucideCopy class="size-3.5" />
						</div>
						<div
							role="button"
							tabIndex={-1}
							onClick={handleSave}
							class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
							title="Save as..."
						>
							<IconLucideSave class="size-3.5" />
						</div>
					</div>
				</Show>
				<Show when={local.variant === "recording"}>
					{(() => {
						const recording = recordingTarget();
						if (!recording) return null;
						const isStudio = recording.mode === "studio";
						const uploadFailed = recordingUploadFailed();
						const progress = getUploadProgress();
						const reuploading = getIsReuploading();
						const hasProgress = progress !== undefined || reuploading;

						return (
							<div class="flex items-center justify-between px-2 pb-1.5 pt-0.5 gap-1">
								<Show when={isStudio}>
									<Tooltip content="Edit">
										<div
											role="button"
											tabIndex={-1}
											onClick={handleOpenRecordingEditor}
											class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
										>
											<IconLucideEdit class="size-3.5" />
										</div>
									</Tooltip>
								</Show>
								<Show when={!isStudio}>
									<Show
										when={hasProgress}
										fallback={
											<Tooltip
												content={uploadFailed ? "Retry upload" : "Reupload"}
											>
												<div
													role="button"
													tabIndex={-1}
													onClick={handleReupload}
													class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
												>
													<IconLucideRotateCcw class="size-3.5" />
												</div>
											</Tooltip>
										}
									>
										<div class="flex-1 flex items-center justify-center p-1">
											<ProgressCircle
												variant="primary"
												progress={progress ?? 0}
												size="xs"
											/>
										</div>
									</Show>
								</Show>
								<Show when={recording.sharing}>
									<Tooltip content="Open link">
										<div
											role="button"
											tabIndex={-1}
											onClick={handleOpenRecordingLink}
											class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
										>
											<IconCapLink class="size-3.5" />
										</div>
									</Tooltip>
								</Show>
								<Tooltip content="Open folder">
									<div
										role="button"
										tabIndex={-1}
										onClick={handleOpenRecordingFolder}
										class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
									>
										<IconLucideFolder class="size-3.5" />
									</div>
								</Tooltip>
								<Tooltip content="Delete">
									<div
										role="button"
										tabIndex={-1}
										onClick={handleDeleteRecording}
										class="flex-1 flex items-center justify-center p-1 rounded hover:bg-gray-5 text-gray-11 hover:text-gray-12 transition-colors"
									>
										<IconCapTrash class="size-3.5" />
									</div>
								</Tooltip>
							</div>
						);
					})()}
				</Show>
			</div>
		</button>
	);
}

function escapeRegExp(value: string) {
	return value.replace(/[\^$*+?.()|[\]{}-]/g, "\\$&");
}

export function TargetCardSkeleton(props: { class?: string }) {
	return (
		<div
			class={cx(
				"flex flex-col overflow-hidden rounded-lg bg-gray-3",
				props.class,
			)}
		>
			<div class="h-[4.75rem] w-full animate-pulse bg-gray-4" />
			<div class="flex flex-row items-start gap-2 px-2 py-1.5">
				<div class="flex-1 space-y-1">
					<div class="w-3/4 h-3 rounded bg-gray-4" />
					<div class="h-2.5 w-1/2 rounded bg-gray-4" />
					<div class="h-2.5 w-2/5 rounded bg-gray-4" />
				</div>
			</div>
		</div>
	);
}
