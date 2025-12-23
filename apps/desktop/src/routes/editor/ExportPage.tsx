import { Button } from "@cap/ui-solid";
import { debounce } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import {
	createMutation,
	createQuery,
	keepPreviousData,
} from "@tanstack/solid-query";
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
	type JSX,
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
import { Dialog, Slider } from "./ui";

class SilentError extends Error {}

export const COMPRESSION_OPTIONS: Array<{
	label: string;
	value: ExportCompression;
	bpp: number;
}> = [
	{ label: "Minimal", value: "Minimal", bpp: 0.3 },
	{ label: "Social Media", value: "Social", bpp: 0.15 },
	{ label: "Web", value: "Web", bpp: 0.08 },
	{ label: "Potato", value: "Potato", bpp: 0.04 },
];

const BPP_TO_COMPRESSION: Record<number, ExportCompression> = {
	0.3: "Minimal",
	0.15: "Social",
	0.08: "Web",
	0.04: "Potato",
};

const COMPRESSION_TO_BPP: Record<ExportCompression, number> = {
	Minimal: 0.3,
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
		icon: <IconCapFile class="text-gray-12 size-3.5" />,
	},
	{
		label: "Clipboard",
		value: "clipboard",
		icon: <IconCapCopy class="text-gray-12 size-3.5" />,
	},
	{
		label: "Shareable link",
		value: "link",
		icon: <IconCapLink class="text-gray-12 size-3.5" />,
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
			compression: "Minimal",
		}),
		{ name: "export_settings" },
	);

	const settings = mergeProps(_settings, () => {
		const ret: Partial<Settings> = {};
		if (hasTransparentBackground() && _settings.format === "Mp4")
			ret.format = "Gif";
		// Ensure GIF is not selected when exportTo is "link"
		else if (_settings.format === "Gif" && _settings.exportTo === "link")
			ret.format = "Mp4";
		else if (!["Mp4", "Gif"].includes(_settings.format)) ret.format = "Mp4";

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
	const [previewDialogOpen, setPreviewDialogOpen] = createSignal(false);
	const [compressionBpp, setCompressionBpp] = createSignal(
		COMPRESSION_TO_BPP[_settings.compression] ?? 0.15,
	);

	createEffect(
		on(
			() => _settings.compression,
			(compression) => {
				const bpp = COMPRESSION_TO_BPP[compression];
				if (bpp !== undefined) setCompressionBpp(bpp);
			},
		),
	);

	const debouncedFetchPreview = debounce(
		async (
			frameTime: number,
			fps: number,
			resWidth: number,
			resHeight: number,
			bpp: number,
		) => {
			setPreviewLoading(true);
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
			} catch (e) {
				console.error("Failed to generate preview:", e);
			} finally {
				setPreviewLoading(false);
			}
		},
		300,
	);

	createEffect(
		on(
			[
				() => settings.fps,
				() => settings.resolution.width,
				() => settings.resolution.height,
				compressionBpp,
			],
			([fps, width, height, bpp]) => {
				if (settings.format === "Gif") return;
				const frameTime = editorState.playbackTime ?? 0;
				debouncedFetchPreview(frameTime, fps, width, height, bpp);
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

	const exportEstimates = createQuery(() => ({
		placeholderData: keepPreviousData,
		queryKey: [
			"exportEstimates",
			{
				format: settings.format,
				resolution: {
					x: settings.resolution.width,
					y: settings.resolution.height,
				},
				fps: settings.fps,
				compression: settings.compression,
			},
		] as const,
		queryFn: ({ queryKey: [_, { format, resolution, fps, compression }] }) => {
			const exportSettings =
				format === "Mp4"
					? {
							format: "Mp4" as const,
							fps,
							resolution_base: resolution,
							compression,
						}
					: {
							format: "Gif" as const,
							fps,
							resolution_base: resolution,
							quality: null,
						};
			return commands.getExportEstimates(projectPath, exportSettings);
		},
	}));

	const exportButtonIcon: Record<"file" | "clipboard" | "link", JSX.Element> = {
		file: <IconCapFile class="text-gray-1 size-3.5" />,
		clipboard: <IconCapCopy class="text-gray-1 size-3.5" />,
		link: <IconCapLink class="text-gray-1 size-3.5" />,
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
				setExportState(reconcile({ type: "idle" }));
				return;
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

			// Check authentication first
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
					// The window takes a little to show and this prevents the user seeing it glitch
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

			// Now proceed with upload
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

	return (
		<div class="flex flex-col h-full bg-gray-1 overflow-hidden">
			<div
				data-tauri-drag-region
				class="flex relative flex-row items-center w-full h-14 border-b border-gray-3 shrink-0"
			>
				<div
					data-tauri-drag-region
					class="flex flex-row flex-1 gap-2 items-center px-4 h-full"
				>
					{ostype() === "macos" && <div class="h-full w-[4rem]" />}
					<button
						type="button"
						onClick={handleBack}
						class="flex items-center gap-2 text-sm text-gray-11 hover:text-gray-12 transition-colors"
					>
						<IconLucideArrowLeft class="size-4" />
						<span>Back to Editor</span>
					</button>
					<div data-tauri-drag-region class="flex-1 h-full" />
					<h1 class="text-gray-12 font-medium">Export Cap</h1>
					<div data-tauri-drag-region class="flex-1 h-full" />
				</div>
			</div>

			<Show when={exportState.type === "idle"}>
				<div class="flex-1 min-h-0 p-6 flex flex-col">
					<div class="flex-1 min-h-0 flex flex-row gap-5">
						<div class="flex-1 flex flex-col gap-3 overflow-y-auto">
							<div class="p-4 rounded-xl dark:bg-gray-2 bg-gray-3">
								<div class="flex flex-col gap-3">
									<div class="flex flex-row justify-between items-center">
										<h3 class="text-gray-12">Export to</h3>
										<Suspense>
											<Show
												when={
													settings.exportTo === "link" &&
													organisations().length > 1
												}
											>
												<div
													class="text-sm text-gray-12 flex flex-row hover:opacity-60 transition-opacity duration-200"
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
													<span class="opacity-70">Organization:</span>
													<span class="ml-1 flex flex-row ">
														{
															(
																organisations().find(
																	(o) => o.id === settings.organizationId,
																) ?? organisations()[0]
															)?.name
														}
														<IconCapChevronDown />
													</span>
												</div>
											</Show>
										</Suspense>
									</div>
									<div class="flex gap-2">
										<For each={EXPORT_TO_OPTIONS}>
											{(option) => (
												<Button
													onClick={() => {
														setSettings(
															produce((newSettings) => {
																newSettings.exportTo = option.value;
																if (
																	option.value === "link" &&
																	settings.format === "Gif"
																) {
																	newSettings.format = "Mp4";
																}
															}),
														);
													}}
													data-selected={settings.exportTo === option.value}
													class="flex flex-1 gap-2 items-center text-nowrap"
													variant="gray"
												>
													{option.icon}
													{option.label}
												</Button>
											)}
										</For>
									</div>
								</div>
							</div>

							<div class="p-4 rounded-xl dark:bg-gray-2 bg-gray-3">
								<div class="flex flex-col gap-3">
									<h3 class="text-gray-12">Format</h3>
									<div class="flex flex-row gap-2">
										<For each={FORMAT_OPTIONS}>
											{(option) => {
												const disabledReason = () => {
													if (
														option.value === "Mp4" &&
														hasTransparentBackground()
													)
														return "MP4 format does not support transparent backgrounds";
													if (
														option.value === "Gif" &&
														settings.exportTo === "link"
													)
														return "Shareable links cannot be made from GIFs";
												};

												return (
													<Tooltip
														content={disabledReason()}
														disabled={disabledReason() === undefined}
													>
														<Button
															variant="gray"
															onClick={() => {
																setSettings(
																	produce((newSettings) => {
																		newSettings.format =
																			option.value as ExportFormat;

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
															autofocus={false}
															data-selected={settings.format === option.value}
															disabled={!!disabledReason()}
														>
															{option.label}
														</Button>
													</Tooltip>
												);
											}}
										</For>
									</div>
								</div>
							</div>

							<div class="p-4 rounded-xl dark:bg-gray-2 bg-gray-3">
								<div class="flex flex-col gap-3">
									<h3 class="text-gray-12">Resolution</h3>
									<div class="flex gap-2">
										<For
											each={
												settings.format === "Gif"
													? [
															RESOLUTION_OPTIONS._720p,
															RESOLUTION_OPTIONS._1080p,
														]
													: [
															RESOLUTION_OPTIONS._720p,
															RESOLUTION_OPTIONS._1080p,
															RESOLUTION_OPTIONS._4k,
														]
											}
										>
											{(option) => (
												<Button
													data-selected={
														settings.resolution.value === option.value
													}
													class="flex-1"
													variant="gray"
													onClick={() => setSettings("resolution", option)}
												>
													{option.label}
												</Button>
											)}
										</For>
									</div>
								</div>
							</div>

							<div class="p-4 rounded-xl dark:bg-gray-2 bg-gray-3">
								<div class="flex flex-col gap-3">
									<div class="flex justify-between items-center">
										<h3 class="text-gray-12">Frame Rate</h3>
										<span class="text-sm text-gray-11 tabular-nums">
											{settings.fps} FPS
										</span>
									</div>
									<Slider
										minValue={
											settings.format === "Gif"
												? GIF_FPS_OPTIONS[0].value
												: FPS_OPTIONS[0].value
										}
										maxValue={
											settings.format === "Gif"
												? GIF_FPS_OPTIONS[GIF_FPS_OPTIONS.length - 1].value
												: FPS_OPTIONS[FPS_OPTIONS.length - 1].value
										}
										step={settings.format === "Gif" ? 5 : 15}
										value={[settings.fps]}
										onChange={([v]) => {
											if (v === undefined) return;
											trackEvent("export_fps_changed", { fps: v });
											setSettings("fps", v);
										}}
										history={{ pause: () => () => {} }}
									/>
								</div>
							</div>

							<Show when={settings.format === "Mp4"}>
								<div class="p-4 rounded-xl dark:bg-gray-2 bg-gray-3">
									<div class="flex flex-col gap-3">
										<div class="flex justify-between items-center">
											<h3 class="text-gray-12">Quality</h3>
											<span class="text-sm text-gray-11">
												{(() => {
													const bpp = compressionBpp();
													if (bpp >= 0.25) return "Minimal compression";
													if (bpp >= 0.12) return "Social Media quality";
													if (bpp >= 0.06) return "Web optimized";
													return "Maximum compression";
												})()}
											</span>
										</div>
										<Slider
											minValue={0.04}
											maxValue={0.3}
											step={0.01}
											value={[compressionBpp()]}
											onChange={([v]) => {
												if (v === undefined) return;
												setCompressionBpp(v);
												const closest = Object.entries(BPP_TO_COMPRESSION)
													.map(([bpp, comp]) => ({
														bpp: Number(bpp),
														comp,
														diff: Math.abs(Number(bpp) - v),
													}))
													.sort((a, b) => a.diff - b.diff)[0];
												if (closest) setSettings("compression", closest.comp);
											}}
											history={{ pause: () => () => {} }}
										/>
										<div class="flex justify-between text-xs text-gray-10">
											<span>Smaller file</span>
											<span>Higher quality</span>
										</div>
									</div>
								</div>
							</Show>
						</div>

						<Show when={settings.format === "Mp4"}>
							<div class="flex-1 flex flex-col min-h-0">
								<div class="flex-1 min-h-0 p-4 rounded-xl dark:bg-gray-2 bg-gray-3 flex flex-col gap-3">
									<h3 class="text-gray-12 text-sm shrink-0">Quality Preview</h3>
									<div class="relative flex-1 min-h-0 rounded-lg overflow-hidden bg-gray-4 flex items-center justify-center group">
										<Show
											when={previewUrl()}
											fallback={
												<div class="flex flex-col items-center gap-2 text-gray-10">
													<Show
														when={previewLoading()}
														fallback={
															<>
																<IconLucideImage class="size-8" />
																<span class="text-xs">Preview loading...</span>
															</>
														}
													>
														<div class="animate-spin">
															<IconLucideLoader2 class="size-6" />
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
														class={cx(
															"w-full h-full object-contain transition-opacity",
															previewLoading() ? "opacity-50" : "opacity-100",
														)}
													/>
													<Show when={previewLoading()}>
														<div class="absolute inset-0 flex items-center justify-center bg-black/30">
															<div class="animate-spin">
																<IconLucideLoader2 class="size-6 text-white" />
															</div>
														</div>
													</Show>
													<button
														type="button"
														onClick={() => setPreviewDialogOpen(true)}
														class="absolute bottom-2 right-2 p-1.5 rounded-md bg-gray-1/80 hover:bg-gray-1 text-gray-11 hover:text-gray-12 opacity-0 group-hover:opacity-100 transition-opacity"
													>
														<IconLucideMaximize2 class="size-4" />
													</button>
												</>
											)}
										</Show>
									</div>
									<div class="flex justify-between text-xs text-gray-11">
										<span>
											{settings.resolution.width}×{settings.resolution.height}
										</span>
										<Suspense>
											<Show when={exportEstimates.data}>
												{(est) => (
													<span>{est().estimated_size_mb.toFixed(1)} MB</span>
												)}
											</Show>
										</Suspense>
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
										<Suspense>
											<Show when={exportEstimates.data}>
												{(est) => (
													<span>
														Estimated size: {est().estimated_size_mb.toFixed(1)}{" "}
														MB
													</span>
												)}
											</Show>
										</Suspense>
									</div>
								</div>
							</Dialog.Root>
						</Show>
					</div>
				</div>

				<div class="flex items-center justify-between px-6 py-4 border-t border-gray-3 bg-gray-2 shrink-0">
					<div class="flex items-center text-xs font-medium text-gray-11">
						<Suspense>
							<Show when={exportEstimates.data}>
								{(est) => (
									<div class="flex gap-4 items-center">
										<span class="flex items-center text-gray-12">
											<IconCapCamera class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
											{(() => {
												const totalSeconds = Math.round(est().duration_seconds);
												const hours = Math.floor(totalSeconds / 3600);
												const minutes = Math.floor((totalSeconds % 3600) / 60);
												const seconds = totalSeconds % 60;

												if (hours > 0) {
													return `${hours}:${minutes
														.toString()
														.padStart(2, "0")}:${seconds
														.toString()
														.padStart(2, "0")}`;
												}
												return `${minutes}:${seconds
													.toString()
													.padStart(2, "0")}`;
											})()}
										</span>
										<span class="flex items-center text-gray-12">
											<IconLucideMonitor class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
											{settings.resolution.width}×{settings.resolution.height}
										</span>
										<span class="flex items-center text-gray-12">
											<IconLucideHardDrive class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
											{est().estimated_size_mb.toFixed(2)} MB
										</span>
										<span class="flex items-center text-gray-12">
											<IconLucideClock class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
											{(() => {
												const totalSeconds = Math.round(
													est().estimated_time_seconds,
												);
												const hours = Math.floor(totalSeconds / 3600);
												const minutes = Math.floor((totalSeconds % 3600) / 60);
												const seconds = totalSeconds % 60;

												if (hours > 0) {
													return `~${hours}:${minutes
														.toString()
														.padStart(2, "0")}:${seconds
														.toString()
														.padStart(2, "0")}`;
												}
												return `~${minutes}:${seconds
													.toString()
													.padStart(2, "0")}`;
											})()}
										</span>
									</div>
								)}
							</Show>
						</Suspense>
					</div>
					<div>
						{settings.exportTo === "link" && !auth.data ? (
							<SignInButton>
								{exportButtonIcon[settings.exportTo]}
								<span class="ml-1.5">Sign in to share</span>
							</SignInButton>
						) : (
							<Button
								class="flex gap-1.5 items-center"
								variant="dark"
								onClick={() => {
									if (settings.exportTo === "file") save.mutate();
									else if (settings.exportTo === "link") upload.mutate();
									else copy.mutate();
								}}
							>
								Export to
								{exportButtonIcon[settings.exportTo]}
							</Button>
						)}
					</div>
				</div>
			</Show>
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
						<div class="flex-1 flex flex-col items-center justify-center p-6 text-gray-12">
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
																	Export Completed
																</h1>
																<p class="text-sm text-gray-11">
																	Your{" "}
																	{settings.format === "Gif" ? "GIF" : "video"}{" "}
																	has successfully been exported
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
																Uploading Cap...
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
																			label={`Uploading - ${Math.floor(
																				uploadState.progress,
																			)}%`}
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
										<div class="relative">
											<a
												href={meta().sharing?.link}
												target="_blank"
												rel="noreferrer"
												class="block"
											>
												<Button
													onClick={() => {
														setCopyPressed(true);
														setTimeout(() => {
															setCopyPressed(false);
														}, 2000);
														navigator.clipboard.writeText(
															meta().sharing?.link!,
														);
													}}
													variant="dark"
													class="flex gap-2 justify-center items-center"
												>
													{!copyPressed() ? (
														<IconCapCopy class="transition-colors duration-200 text-gray-1 size-4 group-hover:text-gray-12" />
													) : (
														<IconLucideCheck class="transition-colors duration-200 text-gray-1 size-4 svgpathanimation group-hover:text-gray-12" />
													)}
													<p>Open Link</p>
												</Button>
											</a>
										</div>
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
