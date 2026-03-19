import { Button } from "@cap/ui-solid";
import { debounce } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { ask, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	createSignal,
	For,
	Match,
	mergeProps,
	on,
	onCleanup,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";
import Tooltip from "~/components/Tooltip";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import { createExportTask } from "~/utils/export";
import { createOrganizationsQuery } from "~/utils/queries";
import {
	commands,
	type ExportCompression,
	type ExportSettings,
	type FramesRendered,
	type UploadProgress,
} from "~/utils/tauri";
import { type RenderState, useEditorContext } from "./context";
import { RESOLUTION_OPTIONS } from "./Header";
import { Dialog, Field } from "./ui";

class SilentError extends Error {}

export const COMPRESSION_OPTIONS: Array<{
	label: string;
	value: ExportCompression;
	bpp: number;
}> = [
	{ label: "Maximum", value: "Maximum", bpp: 0.3 },
	{ label: "Social Media", value: "Social", bpp: 0.15 },
	{ label: "Web", value: "Web", bpp: 0.08 },
	{ label: "Potato", value: "Potato", bpp: 0.04 },
];

const COMPRESSION_TO_BPP: Record<ExportCompression, number> = {
	Maximum: 0.3,
	Social: 0.15,
	Web: 0.08,
	Potato: 0.04,
};

export const FPS_OPTIONS = [
	{ label: "15 FPS", value: 15 },
	{ label: "30 FPS", value: 30 },
	{ label: "60 FPS", value: 60 },
] satisfies Array<{ label: string; value: number }>;

export const GIF_FPS_OPTIONS = [
	{ label: "10 FPS", value: 10 },
	{ label: "15 FPS", value: 15 },
	{ label: "20 FPS", value: 20 },
	{ label: "25 FPS", value: 25 },
	{ label: "30 FPS", value: 30 },
] satisfies Array<{ label: string; value: number }>;

export const EXPORT_TO_OPTIONS = [
	{
		label: "File",
		value: "file",
		icon: IconCapFile,
		description: "Save to your computer",
	},
	{
		label: "Clipboard",
		value: "clipboard",
		icon: IconCapCopy,
		description: "Copy to paste anywhere",
	},
	{
		label: "Shareable Link",
		value: "link",
		icon: IconCapLink,
		description: "Share via Cap cloud",
	},
] as const;

type ExportFormat = ExportSettings["format"];

const FORMAT_OPTIONS = [
	{ label: "MP4", value: "Mp4" },
	{ label: "GIF", value: "Gif" },
] as { label: string; value: ExportFormat; disabled?: boolean }[];

type ExportToOption = (typeof EXPORT_TO_OPTIONS)[number]["value"];

interface Settings {
	format: ExportFormat;
	fps: number;
	exportTo: ExportToOption;
	resolution: { label: string; value: string; width: number; height: number };
	compression: ExportCompression;
	organizationId?: string | null;
}

export function ExportPage() {
	const {
		setDialog,
		editorInstance,
		editorState,
		setExportState,
		exportState,
		meta,
		refetchMeta,
	} = useEditorContext();

	const handleBack = () => {
		setDialog((d) => ({ ...d, open: false }));
	};

	const projectPath = editorInstance.path;

	const auth = authStore.createQuery();
	const organisations = createOrganizationsQuery();

	const hasTransparentBackground = () => {
		const backgroundSource =
			editorInstance.savedProjectConfig.background.source;
		return (
			backgroundSource.type === "color" &&
			backgroundSource.alpha !== undefined &&
			backgroundSource.alpha < 255
		);
	};

	const isCancellationError = (error: unknown) =>
		error instanceof SilentError ||
		error === "Export cancelled" ||
		(error instanceof Error && error.message === "Export cancelled");

	const [_settings, setSettings] = makePersisted(
		createStore<Settings>({
			format: "Mp4",
			fps: 30,
			exportTo: "file",
			resolution: { label: "720p", value: "720p", width: 1280, height: 720 },
			compression: "Maximum",
		}),
		{ name: "export_settings" },
	);

	const VALID_COMPRESSIONS: ExportCompression[] = [
		"Maximum",
		"Social",
		"Web",
		"Potato",
	];

	const settings = mergeProps(_settings, () => {
		const ret: Partial<Settings> = {};
		if (hasTransparentBackground() && _settings.format === "Mp4")
			ret.format = "Gif";
		else if (_settings.format === "Gif" && _settings.exportTo === "link")
			ret.format = "Mp4";
		else if (!["Mp4", "Gif"].includes(_settings.format)) ret.format = "Mp4";

		if (!VALID_COMPRESSIONS.includes(_settings.compression))
			ret.compression = "Maximum";

		Object.defineProperty(ret, "organizationId", {
			get() {
				if (!_settings.organizationId && organisations().length > 0)
					return organisations()[0].id;

				return _settings.organizationId;
			},
		});

		return ret;
	});

	const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
	const [previewLoading, setPreviewLoading] = createSignal(false);
	const [renderEstimate, setRenderEstimate] = createSignal<{
		frameRenderTimeMs: number;
		totalFrames: number;
		estimatedSizeMb: number;
	} | null>(null);

	type EstimateCacheKey = string;
	const estimateCache = new Map<
		EstimateCacheKey,
		{ frameRenderTimeMs: number; totalFrames: number; estimatedSizeMb: number }
	>();

	const getEstimateCacheKey = (
		fps: number,
		width: number,
		height: number,
		bpp: number,
	): EstimateCacheKey => `${fps}-${width}-${height}-${bpp}`;

	const updateSettings: typeof setSettings = ((
		...args: Parameters<typeof setSettings>
	) => {
		setPreviewLoading(true);
		return (setSettings as (...args: Parameters<typeof setSettings>) => void)(
			...args,
		);
	}) as typeof setSettings;
	const [previewDialogOpen, setPreviewDialogOpen] = createSignal(false);
	const [compressionBpp, setCompressionBpp] = createSignal(
		COMPRESSION_TO_BPP[_settings.compression] ?? 0.15,
	);
	const [advancedMode, setAdvancedMode] = createSignal(false);
	const [forceFfmpegDecoder, setForceFfmpegDecoder] = createSignal(false);

	const isCustomBpp = () => {
		const currentBpp = compressionBpp();
		return !COMPRESSION_OPTIONS.some(
			(opt) => Math.abs(opt.bpp - currentBpp) < 0.001,
		);
	};

	const matchingPreset = () => {
		const currentBpp = compressionBpp();
		return COMPRESSION_OPTIONS.find(
			(opt) => Math.abs(opt.bpp - currentBpp) < 0.001,
		);
	};

	createEffect(
		on(
			() => _settings.compression,
			(compression) => {
				const bpp = COMPRESSION_TO_BPP[compression];
				if (bpp !== undefined && !advancedMode()) setCompressionBpp(bpp);
			},
		),
	);

	const fetchPreview = async (
		frameTime: number,
		fps: number,
		resWidth: number,
		resHeight: number,
		bpp: number,
		retryCount = 0,
	) => {
		const cacheKey = getEstimateCacheKey(fps, resWidth, resHeight, bpp);
		const cachedEstimate = estimateCache.get(cacheKey);

		if (cachedEstimate) {
			setRenderEstimate(cachedEstimate);
		}

		const maxRetries = 2;

		try {
			const result = await commands.generateExportPreviewFast(frameTime, {
				fps,
				resolution_base: { x: resWidth, y: resHeight },
				compression_bpp: bpp,
			});

			const oldUrl = previewUrl();
			if (oldUrl) URL.revokeObjectURL(oldUrl);

			const byteArray = Uint8Array.from(atob(result.jpeg_base64), (c) =>
				c.charCodeAt(0),
			);
			const blob = new Blob([byteArray], { type: "image/jpeg" });
			setPreviewUrl(URL.createObjectURL(blob));

			const newEstimate = {
				frameRenderTimeMs: result.frame_render_time_ms,
				totalFrames: result.total_frames,
				estimatedSizeMb: result.estimated_size_mb,
			};

			if (!cachedEstimate) {
				estimateCache.set(cacheKey, newEstimate);
			}
			setRenderEstimate(newEstimate);
		} catch (e) {
			console.error("Failed to generate preview:", e);
			if (retryCount < maxRetries) {
				await new Promise((resolve) =>
					setTimeout(resolve, 200 * (retryCount + 1)),
				);
				return fetchPreview(
					frameTime,
					fps,
					resWidth,
					resHeight,
					bpp,
					retryCount + 1,
				);
			}
		} finally {
			setPreviewLoading(false);
		}
	};

	const debouncedFetchPreview = debounce(fetchPreview, 300);

	setPreviewLoading(true);
	fetchPreview(
		editorState.playbackTime ?? 0,
		settings.fps,
		settings.resolution.width,
		settings.resolution.height,
		compressionBpp(),
	);

	createEffect(
		on(
			[
				() => settings.format,
				() => settings.fps,
				() => settings.resolution.width,
				() => settings.resolution.height,
				compressionBpp,
			],
			() => {
				const frameTime = editorState.playbackTime ?? 0;
				setPreviewLoading(true);
				debouncedFetchPreview(
					frameTime,
					settings.fps,
					settings.resolution.width,
					settings.resolution.height,
					compressionBpp(),
				);
			},
		),
	);

	onCleanup(() => {
		const url = previewUrl();
		if (url) URL.revokeObjectURL(url);
	});

	let cancelCurrentExport: (() => void) | null = null;

	const exportWithSettings = (
		onProgress: (progress: FramesRendered) => void,
	) => {
		const customBpp = advancedMode() && isCustomBpp() ? compressionBpp() : null;
		const { promise, cancel } = createExportTask(
			projectPath,
			settings.format === "Mp4"
				? {
						format: "Mp4",
						fps: settings.fps,
						resolution_base: {
							x: settings.resolution.width,
							y: settings.resolution.height,
						},
						compression: settings.compression,
						custom_bpp: customBpp,
						force_ffmpeg_decoder: forceFfmpegDecoder(),
					}
				: {
						format: "Gif",
						fps: settings.fps,
						resolution_base: {
							x: settings.resolution.width,
							y: settings.resolution.height,
						},
						quality: null,
					},
			onProgress,
		);
		cancelCurrentExport = cancel;
		return promise.finally(() => {
			if (cancelCurrentExport === cancel) cancelCurrentExport = null;
		});
	};

	const [outputPath, setOutputPath] = createSignal<string | null>(null);
	const [isCancelled, setIsCancelled] = createSignal(false);

	const handleCancel = async () => {
		if (
			await ask("Are you sure you want to cancel the export?", {
				title: "Cancel Export",
				kind: "warning",
			})
		) {
			setIsCancelled(true);
			cancelCurrentExport?.();
			cancelCurrentExport = null;
			setExportState({ type: "idle" });
			const path = outputPath();
			if (path) {
				try {
					await remove(path);
				} catch (e) {
					console.error("Failed to delete cancelled file", e);
				}
			}
		}
	};

	const copy = createMutation(() => ({
		mutationFn: async () => {
			setIsCancelled(false);
			if (exportState.type !== "idle") return;
			setExportState(reconcile({ action: "copy", type: "starting" }));

			const outputPath = await exportWithSettings((progress) => {
				if (isCancelled()) throw new SilentError("Cancelled");
				setExportState({ type: "rendering", progress });
			});

			if (isCancelled()) throw new SilentError("Cancelled");

			setExportState({ type: "copying" });

			await commands.copyVideoToClipboard(outputPath);
		},
		onError: (error) => {
			if (isCancelled() || isCancellationError(error)) {
				setExportState(reconcile({ type: "idle" }));
				return;
			}
			commands.globalMessageDialog(
				error instanceof Error ? error.message : "Failed to copy recording",
			);
			setExportState(reconcile({ type: "idle" }));
		},
		onSuccess() {
			setExportState({ type: "done" });
			toast.success(
				`${
					settings.format === "Gif" ? "GIF" : "Recording"
				} exported to clipboard`,
			);
		},
	}));

	const save = createMutation(() => ({
		mutationFn: async () => {
			setIsCancelled(false);
			if (exportState.type !== "idle") return;

			const extension = settings.format === "Gif" ? "gif" : "mp4";
			const savePath = await saveDialog({
				filters: [
					{
						name: `${extension.toUpperCase()} filter`,
						extensions: [extension],
					},
				],
				defaultPath: `~/Desktop/${meta().prettyName}.${extension}`,
			});
			if (!savePath) {
				throw new SilentError("Save dialog cancelled");
			}

			setExportState(reconcile({ action: "save", type: "starting" }));

			setOutputPath(savePath);

			trackEvent("export_started", {
				resolution: settings.resolution,
				fps: settings.fps,
				path: savePath,
			});

			const videoPath = await exportWithSettings((progress) => {
				if (isCancelled()) throw new SilentError("Cancelled");
				setExportState({ type: "rendering", progress });
			});

			if (isCancelled()) throw new SilentError("Cancelled");

			setExportState({ type: "copying" });

			await commands.copyFileToPath(videoPath, savePath);

			setExportState({ type: "done" });
		},
		onError: (error) => {
			if (isCancelled() || isCancellationError(error)) {
				setExportState({ type: "idle" });
				return;
			}
			commands.globalMessageDialog(
				error instanceof Error
					? error.message
					: `Failed to export recording: ${error}`,
			);
			setExportState({ type: "idle" });
		},
		onSuccess() {
			toast.success(
				`${settings.format === "Gif" ? "GIF" : "Recording"} exported to file`,
			);
		},
	}));

	const upload = createMutation(() => ({
		mutationFn: async () => {
			setIsCancelled(false);
			if (exportState.type !== "idle") return;
			setExportState(reconcile({ action: "upload", type: "starting" }));

			const existingAuth = await authStore.get();
			if (!existingAuth) createSignInMutation();
			trackEvent("create_shareable_link_clicked", {
				resolution: settings.resolution,
				fps: settings.fps,
				has_existing_auth: !!existingAuth,
			});

			const metadata = await commands.getVideoMetadata(projectPath);
			const plan = await commands.checkUpgradedAndUpdate();
			const canShare = {
				allowed: plan || metadata.duration < 300,
				reason: !plan && metadata.duration >= 300 ? "upgrade_required" : null,
			};

			if (!canShare.allowed) {
				if (canShare.reason === "upgrade_required") {
					await commands.showWindow("Upgrade");
					await new Promise((resolve) => setTimeout(resolve, 1000));
					throw new SilentError();
				}
			}

			const uploadChannel = new Channel<UploadProgress>((progress) => {
				console.log("Upload progress:", progress);
				setExportState(
					produce((state) => {
						if (state.type !== "uploading") return;

						state.progress = Math.round(progress.progress * 100);
					}),
				);
			});

			await exportWithSettings((progress) => {
				if (isCancelled()) throw new SilentError("Cancelled");
				setExportState({ type: "rendering", progress });
			});

			if (isCancelled()) throw new SilentError("Cancelled");

			setExportState({ type: "uploading", progress: 0 });

			console.log({ organizationId: settings.organizationId });

			const result = meta().sharing
				? await commands.uploadExportedVideo(
						projectPath,
						"Reupload",
						uploadChannel,
						settings.organizationId ?? null,
					)
				: await commands.uploadExportedVideo(
						projectPath,
						{ Initial: { pre_created_video: null } },
						uploadChannel,
						settings.organizationId ?? null,
					);

			if (result === "NotAuthenticated")
				throw new Error("You need to sign in to share recordings");
			else if (result === "PlanCheckFailed")
				throw new Error("Failed to verify your subscription status");
			else if (result === "UpgradeRequired")
				throw new Error("This feature requires an upgraded plan");
		},
		onSuccess: async () => {
			await refetchMeta();
			setExportState({ type: "done" });
		},
		onError: (error) => {
			if (isCancelled() || isCancellationError(error)) {
				setExportState(reconcile({ type: "idle" }));
				return;
			}
			console.error(error);
			if (!(error instanceof SilentError)) {
				commands.globalMessageDialog(
					error instanceof Error ? error.message : "Failed to upload recording",
				);
			}

			setExportState(reconcile({ type: "idle" }));
		},
	}));

	const formatDuration = (seconds: number) => {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = seconds % 60;
		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
		}
		return `${minutes}:${secs.toString().padStart(2, "0")}`;
	};

	return (
		<div class="flex flex-col h-full bg-gray-1 overflow-hidden">
			<div
				data-tauri-drag-region
				class="flex relative flex-row items-center w-full h-14 border-b border-gray-3 shrink-0"
			>
				<h1 class="absolute inset-0 flex items-center justify-center text-sm font-medium text-gray-12 pointer-events-none">
					Export
				</h1>
				<div
					data-tauri-drag-region
					class={cx(
						"flex flex-row flex-1 gap-2 items-center px-4 h-full",
						ostype() !== "windows" && "pr-2",
					)}
				>
					{ostype() === "macos" && <div class="h-full w-[4rem]" />}
					<Button
						variant="gray"
						onClick={handleBack}
						class="flex items-center gap-1.5"
					>
						<IconLucideArrowLeft class="size-4" />
						<span>Back to Editor</span>
					</Button>
					<div data-tauri-drag-region class="flex-1 h-full" />
					{ostype() === "windows" && <CaptionControlsWindows11 />}
				</div>
			</div>

			<div class="flex-1 min-h-0 flex relative">
				<div class="flex-1 min-h-0 p-5 flex flex-col">
					<div class="flex items-center gap-1.5 mb-2">
						<span class="text-sm font-medium text-gray-11">Preview</span>
						<Tooltip content="This is a rendered frame from your video. Adjust the settings below to see the quality of the final exported video.">
							<IconLucideInfo class="size-3.5 text-gray-9 hover:text-gray-11 cursor-help transition-colors" />
						</Tooltip>
					</div>
					<div class="relative flex-1 min-h-0 rounded-xl overflow-hidden bg-gray-2 border border-gray-3 flex items-center justify-center group">
						<Show
							when={previewUrl()}
							fallback={
								<div class="absolute inset-0 flex items-center justify-center">
									<Show
										when={previewLoading()}
										fallback={
											<div class="flex flex-col items-center gap-3 text-gray-10">
												<IconLucideImage class="size-12 text-gray-8" />
												<span class="text-sm">Generating preview...</span>
											</div>
										}
									>
										<div class="absolute inset-4 rounded-lg bg-gray-4 overflow-hidden">
											<div class="absolute inset-y-0 w-full animate-shimmer bg-gradient-to-r from-transparent from-30% via-gray-6 via-50% to-transparent to-70%" />
										</div>
									</Show>
								</div>
							}
						>
							{(url) => (
								<>
									<img
										src={url()}
										alt="Export preview"
										class="relative z-0 w-full h-full object-contain"
									/>
									<Show when={previewLoading()}>
										<div class="absolute inset-0 z-50 overflow-hidden pointer-events-none">
											<div class="absolute inset-y-0 w-full animate-shimmer bg-gradient-to-r from-transparent from-30% via-white/60 via-50% to-transparent to-70%" />
										</div>
									</Show>
									<button
										type="button"
										onClick={() => setPreviewDialogOpen(true)}
										class="absolute bottom-3 right-3 p-2 rounded-lg bg-gray-12/80 hover:bg-gray-12 text-gray-1 opacity-0 group-hover:opacity-100 transition-opacity"
									>
										<IconLucideMaximize2 class="size-4" />
									</button>
								</>
							)}
						</Show>
					</div>

					<Show
						when={!previewLoading() && renderEstimate()}
						fallback={
							<div class="flex items-center justify-center gap-4 mt-4 h-4 text-xs text-gray-11">
								<span class="flex items-center gap-1.5">
									<IconLucideClock class="size-3.5" />
									<span class="h-3.5 w-10 bg-gray-4 rounded animate-pulse" />
								</span>
								<span class="flex items-center gap-1.5">
									<IconLucideMonitor class="size-3.5" />
									<span class="h-3.5 w-20 bg-gray-4 rounded animate-pulse" />
								</span>
								<span class="flex items-center gap-1.5">
									<IconLucideHardDrive class="size-3.5" />
									<span class="h-3.5 w-16 bg-gray-4 rounded animate-pulse" />
								</span>
								<span class="flex items-center gap-1.5">
									<IconLucideZap class="size-3.5" />
									<span class="h-3.5 w-12 bg-gray-4 rounded animate-pulse" />
								</span>
							</div>
						}
					>
						{(est) => {
							const data = est();
							const durationSeconds = data.totalFrames / settings.fps;

							const exportSpeedMultiplier = settings.format === "Gif" ? 4 : 10;
							const totalTimeMs =
								(data.frameRenderTimeMs * data.totalFrames) /
								exportSpeedMultiplier;
							const estimatedTimeSeconds = Math.max(1, totalTimeMs / 1000);

							const estimatedSizeMb = data.estimatedSizeMb;

							return (
								<div class="flex items-center justify-center gap-4 mt-4 h-4 text-xs text-gray-11">
									<span class="flex items-center gap-1.5">
										<IconLucideClock class="size-3.5" />
										<span class="min-w-10">
											{formatDuration(Math.round(durationSeconds))}
										</span>
									</span>
									<span class="flex items-center gap-1.5">
										<IconLucideMonitor class="size-3.5" />
										<span class="min-w-20">
											{settings.resolution.width}×{settings.resolution.height}
										</span>
									</span>
									<span class="flex items-center gap-1.5">
										<IconLucideHardDrive class="size-3.5" />
										<span class="min-w-16">
											~{estimatedSizeMb.toFixed(1)} MB
										</span>
									</span>
									<span class="flex items-center gap-1.5">
										<IconLucideZap class="size-3.5" />
										<span class="min-w-12">
											~{formatDuration(Math.round(estimatedTimeSeconds))}
										</span>
									</span>
								</div>
							);
						}}
					</Show>
				</div>

				<div class="w-[400px] border-l border-gray-3 flex flex-col bg-gray-1 dark:bg-gray-2">
					<div class="flex-1 overflow-y-auto p-4 space-y-5">
						<Field name="Destination" icon={<IconCapUpload class="size-4" />}>
							<div class="flex gap-1.5">
								<For each={EXPORT_TO_OPTIONS}>
									{(option) => {
										const Icon = option.icon;
										const isSelected = () => settings.exportTo === option.value;
										return (
											<button
												type="button"
												class={cx(
													"flex-1 flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-lg border transition-colors",
													isSelected()
														? "bg-gray-3 border-gray-5 text-gray-12"
														: "bg-transparent border-transparent text-gray-11 hover:bg-gray-3 hover:border-gray-4",
												)}
												onClick={() => {
													setSettings(
														produce((newSettings) => {
															newSettings.exportTo =
																option.value as ExportToOption;
															if (
																option.value === "link" &&
																settings.format === "Gif"
															) {
																newSettings.format = "Mp4";
															}
														}),
													);
												}}
											>
												<Icon
													class={cx(
														"size-5",
														isSelected() ? "text-gray-12" : "text-gray-10",
													)}
												/>
												<span class="text-xs font-medium">{option.label}</span>
											</button>
										);
									}}
								</For>
							</div>

							<Suspense>
								<Show
									when={
										settings.exportTo === "link" && organisations().length > 1
									}
								>
									<button
										type="button"
										class="w-full flex items-center justify-between px-3 py-2 mt-3 rounded-lg bg-gray-3 hover:bg-gray-4 transition-colors text-sm"
										onClick={async () => {
											const menu = await Menu.new({
												items: await Promise.all(
													organisations().map((org) =>
														CheckMenuItem.new({
															text: org.name,
															action: () => {
																setSettings("organizationId", org.id);
															},
															checked: settings.organizationId === org.id,
														}),
													),
												),
											});
											menu.popup();
										}}
									>
										<span class="text-gray-11">Organization</span>
										<span class="flex items-center gap-1 text-gray-12">
											{
												(
													organisations().find(
														(o) => o.id === settings.organizationId,
													) ?? organisations()[0]
												)?.name
											}
											<IconCapChevronDown class="size-4" />
										</span>
									</button>
								</Show>
							</Suspense>
						</Field>

						<Field name="Format" icon={<IconLucideVideo class="size-4" />}>
							<div class="flex gap-1.5">
								<For each={FORMAT_OPTIONS}>
									{(option) => {
										const isDisabled = () =>
											(option.value === "Mp4" && hasTransparentBackground()) ||
											(option.value === "Gif" && settings.exportTo === "link");

										const disabledReason = () =>
											option.value === "Mp4" && hasTransparentBackground()
												? "MP4 doesn't support transparency"
												: option.value === "Gif" && settings.exportTo === "link"
													? "Links require MP4 format"
													: undefined;

										const button = (
											<button
												type="button"
												class={cx(
													"flex-1 py-2 text-sm font-medium rounded-lg border transition-colors",
													settings.format === option.value
														? "bg-gray-3 border-gray-5 text-gray-12"
														: "bg-transparent border-transparent text-gray-11 hover:bg-gray-3 hover:border-gray-4",
													isDisabled() && "opacity-50 cursor-not-allowed",
												)}
												disabled={isDisabled()}
												onClick={() => {
													updateSettings(
														produce((newSettings) => {
															newSettings.format = option.value;
															if (
																option.value === "Gif" &&
																!(
																	settings.resolution.value === "720p" ||
																	settings.resolution.value === "1080p"
																)
															)
																newSettings.resolution = {
																	...RESOLUTION_OPTIONS._720p,
																};
															if (
																option.value === "Gif" &&
																GIF_FPS_OPTIONS.every(
																	(v) => v.value !== settings.fps,
																)
															)
																newSettings.fps = 15;
															if (
																option.value === "Mp4" &&
																FPS_OPTIONS.every(
																	(v) => v.value !== settings.fps,
																)
															)
																newSettings.fps = 30;
														}),
													);
												}}
											>
												{option.label}
											</button>
										);

										return disabledReason() ? (
											<Tooltip content={disabledReason()}>{button}</Tooltip>
										) : (
											button
										);
									}}
								</For>
							</div>
						</Field>

						<Field
							name="Resolution"
							icon={<IconLucideMonitor class="size-4" />}
						>
							<div class="flex gap-1.5">
								<For
									each={
										settings.format === "Gif"
											? [RESOLUTION_OPTIONS._720p, RESOLUTION_OPTIONS._1080p]
											: [
													RESOLUTION_OPTIONS._720p,
													RESOLUTION_OPTIONS._1080p,
													RESOLUTION_OPTIONS._4k,
												]
									}
								>
									{(option) => (
										<button
											type="button"
											class={cx(
												"flex-1 py-2 text-sm font-medium rounded-lg border transition-colors",
												settings.resolution.value === option.value
													? "bg-gray-3 border-gray-5 text-gray-12"
													: "bg-transparent border-transparent text-gray-11 hover:bg-gray-3 hover:border-gray-4",
											)}
											onClick={() => updateSettings("resolution", option)}
										>
											{option.label}
										</button>
									)}
								</For>
							</div>
						</Field>

						<Field name="Frame Rate" icon={<IconLucideGauge class="size-4" />}>
							<div class="flex gap-1.5">
								<For
									each={
										settings.format === "Gif" ? GIF_FPS_OPTIONS : FPS_OPTIONS
									}
								>
									{(option) => (
										<button
											type="button"
											class={cx(
												"flex-1 py-2 text-sm font-medium rounded-lg border transition-colors",
												settings.fps === option.value
													? "bg-gray-3 border-gray-5 text-gray-12"
													: "bg-transparent border-transparent text-gray-11 hover:bg-gray-3 hover:border-gray-4",
											)}
											onClick={() => {
												trackEvent("export_fps_changed", {
													fps: option.value,
												});
												updateSettings("fps", option.value);
											}}
										>
											{option.value}
										</button>
									)}
								</For>
							</div>
						</Field>

						<Show when={settings.format === "Mp4"}>
							<Field
								name="Quality"
								icon={<IconLucideSparkles class="size-4" />}
							>
								<div class="grid grid-cols-4 gap-1.5">
									<For each={[...COMPRESSION_OPTIONS].reverse()}>
										{(option) => {
											const isSelected = () => {
												if (advancedMode() && isCustomBpp()) return false;
												return settings.compression === option.value;
											};
											return (
												<button
													type="button"
													class={cx(
														"px-2 py-2 text-xs font-medium rounded-lg border transition-colors",
														isSelected()
															? "bg-gray-3 border-gray-5 text-gray-12"
															: "bg-transparent border-transparent text-gray-11 hover:bg-gray-3 hover:border-gray-4",
													)}
													onClick={() => {
														setPreviewLoading(true);
														setCompressionBpp(option.bpp);
														setSettings("compression", option.value);
													}}
												>
													{option.label === "Social Media"
														? "Social"
														: option.label}
												</button>
											);
										}}
									</For>
								</div>
								<div class="flex justify-between text-[10px] text-gray-10 mt-1.5 px-0.5">
									<span>Smaller file</span>
									<span>Larger file</span>
								</div>

								<button
									type="button"
									class="flex items-center gap-2 mt-3 text-xs text-gray-11 hover:text-gray-12 transition-colors"
									onClick={() => setAdvancedMode(!advancedMode())}
								>
									<div
										class={cx(
											"w-8 h-4 rounded-full transition-colors relative",
											advancedMode() ? "bg-blue-9" : "bg-gray-5",
										)}
									>
										<div
											class={cx(
												"absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
												advancedMode() ? "translate-x-4" : "translate-x-0.5",
											)}
										/>
									</div>
									<span>Advanced</span>
								</button>

								<Show when={advancedMode()}>
									<div class="mt-3 space-y-2">
										<div class="flex items-center justify-between text-xs">
											<span class="text-gray-11">Bits per pixel</span>
											<span class="text-gray-12 font-medium tabular-nums">
												{compressionBpp().toFixed(2)}
											</span>
										</div>
										<input
											type="range"
											min="0.02"
											max="0.5"
											step="0.01"
											value={compressionBpp()}
											onInput={(e) => {
												const value = Number.parseFloat(e.currentTarget.value);
												setPreviewLoading(true);
												setCompressionBpp(value);
												const preset = COMPRESSION_OPTIONS.find(
													(opt) => Math.abs(opt.bpp - value) < 0.001,
												);
												if (preset) {
													setSettings("compression", preset.value);
												}
											}}
											class="w-full h-1.5 bg-gray-4 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-9 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110"
										/>
										<div class="flex justify-between text-[10px] text-gray-9">
											<span>0.02 (tiny)</span>
											<span>0.50 (huge)</span>
										</div>
										<Show when={isCustomBpp()}>
											<p class="text-[10px] text-amber-11 mt-1">
												Using custom bitrate
											</p>
										</Show>

										<Show when={ostype() === "macos"}>
											<div class="mt-4 pt-3 border-t border-gray-4">
												<button
													type="button"
													role="switch"
													aria-checked={forceFfmpegDecoder()}
													aria-label="Force FFmpeg decoder"
													class="flex items-center gap-2 text-xs text-gray-11 hover:text-gray-12 transition-colors w-full"
													onClick={() =>
														setForceFfmpegDecoder(!forceFfmpegDecoder())
													}
												>
													<div
														class={cx(
															"w-8 h-4 rounded-full transition-colors relative flex-shrink-0",
															forceFfmpegDecoder() ? "bg-blue-9" : "bg-gray-5",
														)}
													>
														<div
															class={cx(
																"absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
																forceFfmpegDecoder()
																	? "translate-x-4"
																	: "translate-x-0.5",
															)}
														/>
													</div>
													<div class="text-left">
														<span class="block">Force FFmpeg decoder</span>
														<span class="text-[10px] text-gray-9">
															Skip hardware decoder (auto-fallback enabled)
														</span>
													</div>
												</button>
											</div>
										</Show>
									</div>
								</Show>
							</Field>
						</Show>
					</div>

					<div class="p-4 border-t border-gray-3">
						{settings.exportTo === "link" && !auth.data ? (
							<SignInButton class="w-full justify-center">
								<IconCapLink class="size-4" />
								<span>Sign in to share</span>
							</SignInButton>
						) : (
							<Button
								class="w-full gap-2 h-12 text-base"
								variant="blue"
								size="lg"
								onClick={() => {
									if (settings.exportTo === "file") save.mutate();
									else if (settings.exportTo === "link") upload.mutate();
									else copy.mutate();
								}}
							>
								{settings.exportTo === "file" && (
									<>
										<IconCapFile class="size-5" />
										Export to File
									</>
								)}
								{settings.exportTo === "clipboard" && (
									<>
										<IconCapCopy class="size-5" />
										Export to Clipboard
									</>
								)}
								{settings.exportTo === "link" && (
									<>
										<IconCapLink class="size-5" />
										Export to Link
									</>
								)}
							</Button>
						)}
					</div>
				</div>
			</div>

			<Dialog.Root
				open={previewDialogOpen()}
				onOpenChange={setPreviewDialogOpen}
				size="lg"
				contentClass="max-w-[90vw] w-full"
			>
				<div class="p-4">
					<div class="flex items-center justify-between mb-4">
						<h2 class="text-gray-12 font-medium">Quality Preview</h2>
						<button
							type="button"
							onClick={() => setPreviewDialogOpen(false)}
							class="p-1.5 rounded-md hover:bg-gray-3 text-gray-11 hover:text-gray-12 transition-colors"
						>
							<IconLucideX class="size-5" />
						</button>
					</div>
					<div class="relative aspect-video rounded-lg overflow-hidden bg-gray-4 flex items-center justify-center">
						<Show when={previewUrl()}>
							{(url) => (
								<img
									src={url()}
									alt="Export preview full size"
									class="w-full h-full object-contain"
								/>
							)}
						</Show>
					</div>
					<div class="flex justify-between text-sm text-gray-11 mt-4">
						<span>
							{settings.resolution.width}×{settings.resolution.height}
						</span>
						<Show when={renderEstimate()}>
							{(est) => {
								return (
									<span>
										Estimated size: {est().estimatedSizeMb.toFixed(1)} MB
									</span>
								);
							}}
						</Show>
					</div>
				</div>
			</Dialog.Root>

			<Show when={exportState.type !== "idle" && exportState} keyed>
				{(exportState) => {
					const [copyPressed, setCopyPressed] = createSignal(false);
					const [clipboardCopyPressed, setClipboardCopyPressed] =
						createSignal(false);
					const [showCompletionScreen, setShowCompletionScreen] = createSignal(
						exportState.type === "done" && exportState.action === "save",
					);

					createEffect(() => {
						if (exportState.type === "done" && exportState.action === "save") {
							setShowCompletionScreen(true);
						}
					});

					return (
						<div
							class="absolute inset-0 z-50 flex flex-col items-center justify-center p-6 text-gray-12 backdrop-blur-sm"
							style={{
								"background-color":
									"color-mix(in srgb, var(--gray-1) 85%, transparent)",
							}}
						>
							<div class="relative z-10 space-y-6 w-full max-w-md text-center">
								<Switch>
									<Match
										when={exportState.action === "copy" && exportState}
										keyed
									>
										{(copyState) => (
											<div class="flex flex-col gap-4 justify-center items-center h-full">
												<h1 class="text-lg font-medium text-gray-12">
													{copyState.type === "starting"
														? "Preparing..."
														: copyState.type === "rendering"
															? settings.format === "Gif"
																? "Rendering GIF..."
																: "Rendering video..."
															: copyState.type === "copying"
																? "Copying to clipboard..."
																: "Copied to clipboard"}
												</h1>
												<Show
													when={
														(copyState.type === "rendering" ||
															copyState.type === "starting") &&
														copyState
													}
													keyed
												>
													{(copyState) => (
														<>
															<RenderProgress
																state={copyState}
																format={settings.format}
															/>
															<Button
																variant="ghost"
																size="sm"
																onClick={handleCancel}
																class="mt-4 hover:bg-red-500 hover:text-white"
															>
																Cancel
															</Button>
														</>
													)}
												</Show>
											</div>
										)}
									</Match>
									<Match
										when={exportState.action === "save" && exportState}
										keyed
									>
										{(saveState) => (
											<div class="flex flex-col gap-4 justify-center items-center h-full">
												<Show
													when={
														showCompletionScreen() && saveState.type === "done"
													}
													fallback={
														<>
															<h1 class="text-lg font-medium text-gray-12">
																{saveState.type === "starting"
																	? "Preparing..."
																	: saveState.type === "rendering"
																		? settings.format === "Gif"
																			? "Rendering GIF..."
																			: "Rendering video..."
																		: saveState.type === "copying"
																			? "Exporting to file..."
																			: "Export completed"}
															</h1>
															<Show
																when={
																	(saveState.type === "rendering" ||
																		saveState.type === "starting") &&
																	saveState
																}
																keyed
															>
																{(copyState) => (
																	<>
																		<RenderProgress
																			state={copyState}
																			format={settings.format}
																		/>
																		<Button
																			variant="ghost"
																			size="sm"
																			onClick={handleCancel}
																			class="mt-4 hover:bg-red-500 hover:text-white"
																		>
																			Cancel
																		</Button>
																	</>
																)}
															</Show>
														</>
													}
												>
													<div class="flex flex-col gap-6 items-center duration-500 animate-in fade-in">
														<div class="flex flex-col gap-3 items-center">
															<div class="flex justify-center items-center mb-2 rounded-full bg-gray-12 size-10">
																<IconLucideCheck class="text-gray-1 size-5" />
															</div>
															<div class="flex flex-col gap-1 items-center">
																<h1 class="text-xl font-medium text-gray-12">
																	Export Complete
																</h1>
																<p class="text-sm text-gray-11">
																	Your{" "}
																	{settings.format === "Gif" ? "GIF" : "video"}{" "}
																	is ready
																</p>
															</div>
														</div>
													</div>
												</Show>
											</div>
										)}
									</Match>
									<Match
										when={exportState.action === "upload" && exportState}
										keyed
									>
										{(uploadState) => (
											<Switch>
												<Match
													when={uploadState.type !== "done" && uploadState}
													keyed
												>
													{(uploadState) => (
														<div class="flex flex-col gap-4 justify-center items-center">
															<h1 class="text-lg font-medium text-center text-gray-12">
																{uploadState.type === "uploading"
																	? "Uploading..."
																	: "Preparing..."}
															</h1>
															<Switch>
																<Match
																	when={
																		uploadState.type === "uploading" &&
																		uploadState
																	}
																	keyed
																>
																	{(uploadState) => (
																		<ProgressView
																			amount={uploadState.progress}
																			label={`Uploading - ${Math.floor(uploadState.progress)}%`}
																		/>
																	)}
																</Match>
																<Match
																	when={
																		uploadState.type !== "uploading" &&
																		uploadState
																	}
																	keyed
																>
																	{(renderState) => (
																		<>
																			<RenderProgress
																				state={renderState}
																				format={settings.format}
																			/>
																			<Button
																				variant="ghost"
																				size="sm"
																				onClick={handleCancel}
																				class="mt-4 hover:bg-red-500 hover:text-white"
																			>
																				Cancel
																			</Button>
																		</>
																	)}
																</Match>
															</Switch>
														</div>
													)}
												</Match>
												<Match when={uploadState.type === "done"}>
													<div class="flex flex-col gap-5 justify-center items-center">
														<div class="flex flex-col gap-1 items-center">
															<h1 class="mx-auto text-lg font-medium text-center text-gray-12">
																Upload Complete
															</h1>
															<p class="text-sm text-gray-11">
																Your Cap has been uploaded successfully
															</p>
														</div>
													</div>
												</Match>
											</Switch>
										)}
									</Match>
								</Switch>
							</div>
							<Show
								when={
									exportState.type === "done" &&
									(exportState.action === "save" ||
										exportState.action === "upload")
								}
							>
								<div class="mt-6 flex justify-center gap-4">
									<Show
										when={
											exportState.action === "upload" &&
											exportState.type === "done"
										}
									>
										<Show when={meta().sharing?.link}>
											{(link) => (
												<div class="flex gap-2">
													<Button
														onClick={() => {
															setCopyPressed(true);
															setTimeout(() => {
																setCopyPressed(false);
															}, 2000);
															navigator.clipboard.writeText(link());
														}}
														variant="dark"
														class="flex gap-2 justify-center items-center"
													>
														{!copyPressed() ? (
															<IconCapCopy class="transition-colors duration-200 text-gray-1 size-4 group-hover:text-gray-12" />
														) : (
															<IconLucideCheck class="transition-colors duration-200 text-gray-1 size-4 svgpathanimation group-hover:text-gray-12" />
														)}
														<p>Copy Link</p>
													</Button>
													<a href={link()} target="_blank" rel="noreferrer">
														<Button
															variant="dark"
															class="flex gap-2 justify-center items-center"
														>
															<IconCapLink class="transition-colors duration-200 text-gray-1 size-4 group-hover:text-gray-12" />
															<p>Open Link</p>
														</Button>
													</a>
												</div>
											)}
										</Show>
									</Show>

									<Show
										when={
											exportState.action === "save" &&
											exportState.type === "done"
										}
									>
										<div class="flex gap-4 w-full">
											<Button
												variant="dark"
												class="flex gap-2 items-center"
												onClick={() => {
													const path = outputPath();
													if (path) {
														commands.openFilePath(path);
													}
												}}
											>
												<IconCapFile class="size-4" />
												Open File
											</Button>
											<Button
												variant="dark"
												class="flex gap-2 items-center"
												onClick={async () => {
													const path = outputPath();
													if (path) {
														setClipboardCopyPressed(true);
														setTimeout(() => {
															setClipboardCopyPressed(false);
														}, 2000);
														await commands.copyVideoToClipboard(path);
														toast.success(
															`${
																settings.format === "Gif" ? "GIF" : "Video"
															} copied to clipboard`,
														);
													}
												}}
											>
												{!clipboardCopyPressed() ? (
													<IconCapCopy class="size-4" />
												) : (
													<IconLucideCheck class="size-4 svgpathanimation" />
												)}
												Copy to Clipboard
											</Button>
										</div>
									</Show>
								</div>
							</Show>
							<Show when={exportState.type === "done"}>
								<Button
									variant="gray"
									class="mt-4 hover:underline"
									onClick={() => {
										setExportState({ type: "idle" });
										handleBack();
									}}
								>
									<IconLucideArrowLeft class="size-4" />
									Back to Editor
								</Button>
							</Show>
						</div>
					);
				}}
			</Show>
		</div>
	);
}

function RenderProgress(props: { state: RenderState; format?: ExportFormat }) {
	return (
		<ProgressView
			amount={
				props.state.type === "rendering"
					? (props.state.progress.renderedCount /
							props.state.progress.totalFrames) *
						100
					: 0
			}
			label={
				props.state.type === "rendering"
					? `Rendering ${props.format === "Gif" ? "GIF" : "video"} (${
							props.state.progress.renderedCount
						}/${props.state.progress.totalFrames} frames)`
					: "Preparing to render..."
			}
		/>
	);
}

function ProgressView(props: { amount: number; label?: string }) {
	return (
		<>
			<div class="w-full bg-gray-3 rounded-full h-2.5">
				<div
					class="bg-blue-9 h-2.5 rounded-full"
					style={{ width: `${props.amount}%` }}
				/>
			</div>
			<p class="text-xs tabular-nums">{props.label}</p>
		</>
	);
}
