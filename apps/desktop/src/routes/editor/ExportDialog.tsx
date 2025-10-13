import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation, keepPreviousData } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	type JSX,
	Match,
	on,
	Show,
	Switch,
	type ValidComponent,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import { exportVideo } from "~/utils/export";
import {
	commands,
	type ExportCompression,
	type ExportSettings,
	events,
	type FramesRendered,
	type UploadProgress,
} from "~/utils/tauri";
import { type RenderState, useEditorContext } from "./context";
import { RESOLUTION_OPTIONS } from "./Header";
import {
	Dialog,
	DialogContent,
	MenuItem,
	MenuItemList,
	PopperContent,
	topSlideAnimateClasses,
} from "./ui";

class SilentError extends Error {}

export const COMPRESSION_OPTIONS: Array<{
	label: string;
	value: ExportCompression;
}> = [
	{ label: "Minimal", value: "Minimal" },
	{ label: "Social Media", value: "Social" },
	{ label: "Web", value: "Web" },
	{ label: "Potato", value: "Potato" },
];

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
		icon: <IconCapFile class="size-3.5" />,
	},
	{
		label: "Clipboard",
		value: "clipboard",
		icon: <IconCapCopy class="size-3.5" />,
	},
	{
		label: "Shareable link",
		value: "link",
		icon: <IconCapLink class="size-3.5" />,
	},
] as const;

type ExportFormat = ExportSettings["format"];

export const FORMAT_OPTIONS = [
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
export function ExportDialog() {
	const {
		dialog,
		setDialog,
		editorInstance,
		setExportState,
		exportState,
		meta,
		refetchMeta,
	} = useEditorContext();

	const auth = authStore.createQuery();

	// Organizations are cached in auth store - much more efficient
	const organizations = createMemo(() => auth.data?.organizations ?? []);

	const [settings, setSettings] = makePersisted(
		createStore<Settings>({
			format: "Mp4",
			fps: 30,
			exportTo: "file",
			resolution: { label: "720p", value: "720p", width: 1280, height: 720 },
			compression: "Minimal",
			organizationId: null,
		}),
		{ name: "export_settings" },
	);

	if (!["Mp4", "Gif"].includes(settings.format)) setSettings("format", "Mp4");

	// Auto-select first organization if none selected and user is authenticated
	createEffect(() => {
		const orgs = organizations();
		if (!settings.organizationId && orgs.length > 0 && auth.data) {
			setSettings("organizationId", orgs[0].id);
		}
	});

	const exportWithSettings = (onProgress: (progress: FramesRendered) => void) =>
		exportVideo(
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

	const [outputPath, setOutputPath] = createSignal<string | null>(null);

	const selectedStyle = "bg-gray-7";

	const projectPath = editorInstance.path;

	const exportEstimates = createQuery(() => ({
		// prevents flicker when modifying settings
		placeholderData: keepPreviousData,
		queryKey: [
			"exportEstimates",
			{
				resolution: {
					x: settings.resolution.width,
					y: settings.resolution.height,
				},
				fps: settings.fps,
			},
		] as const,
		queryFn: ({ queryKey: [_, { resolution, fps }] }) =>
			commands.getExportEstimates(projectPath, resolution, fps),
	}));

	const exportButtonIcon: Record<"file" | "clipboard" | "link", JSX.Element> = {
		file: <IconCapFile class="text-gray-1 size-3.5" />,
		clipboard: <IconCapCopy class="text-gray-1 size-3.5" />,
		link: <IconCapLink class="text-gray-1 size-3.5" />,
	};

	const copy = createMutation(() => ({
		mutationFn: async () => {
			if (exportState.type !== "idle") return;
			setExportState(reconcile({ action: "copy", type: "starting" }));

			const outputPath = await exportWithSettings((progress) => {
				setExportState({ type: "rendering", progress });
			});

			setExportState({ type: "copying" });

			await commands.copyVideoToClipboard(outputPath);
		},
		onError: (error) => {
			commands.globalMessageDialog(
				error instanceof Error ? error.message : "Failed to copy recording",
			);
			setExportState(reconcile({ type: "idle" }));
		},
		onSuccess() {
			setExportState({ type: "done" });

			if (dialog().open) {
				createRoot((dispose) => {
					createEffect(
						on(
							() => dialog().open,
							() => {
								dispose();
							},
							{ defer: true },
						),
					);
				});
			} else
				toast.success(
					`${
						settings.format === "Gif" ? "GIF" : "Recording"
					} exported to clipboard`,
				);
		},
	}));

	const save = createMutation(() => ({
		mutationFn: async () => {
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
				setExportState({ type: "rendering", progress });
			});

			setExportState({ type: "copying" });

			await commands.copyFileToPath(videoPath, savePath);

			setExportState({ type: "done" });
		},
		onError: (error) => {
			commands.globalMessageDialog(
				error instanceof Error
					? error.message
					: `Failed to export recording: ${error}`,
			);
			setExportState({ type: "idle" });
		},
		onSuccess() {
			if (dialog().open) {
				createRoot((dispose) => {
					createEffect(
						on(
							() => dialog().open,
							() => {
								dispose();
							},
							{ defer: true },
						),
					);
				});
			} else
				toast.success(
					`${settings.format === "Gif" ? "GIF" : "Recording"} exported to file`,
				);
		},
	}));

	const upload = createMutation(() => ({
		mutationFn: async () => {
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

			await exportWithSettings((progress) =>
				setExportState({ type: "rendering", progress }),
			);

			setExportState({ type: "uploading", progress: 0 });

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
						{
							Initial: { pre_created_video: null },
						},
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
			const d = dialog();
			if ("type" in d && d.type === "export") setDialog({ ...d, open: true });

			await refetchMeta();

			console.log(meta().sharing);

			setExportState({ type: "done" });
		},
		onError: (error) => {
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
		<>
			<Show when={exportState.type === "idle"}>
				<DialogContent
					title="Export Cap"
					confirm={
						settings.exportTo === "link" && !auth.data ? (
							<SignInButton>
								{exportButtonIcon[settings.exportTo]}
								<span class="ml-1.5">Sign in to share</span>
							</SignInButton>
						) : (
							<Button
								class="flex gap-1.5 items-center"
								variant="blue"
								onClick={() => {
									if (settings.exportTo === "file") save.mutate();
									else if (settings.exportTo === "link") upload.mutate();
									else copy.mutate();
								}}
							>
								Export to
								{exportButtonIcon[settings.exportTo]}
							</Button>
						)
					}
					leftFooterContent={
						<div>
							<Show when={exportEstimates.data}>
								{(est) => (
									<div
										class={cx(
											"flex overflow-hidden z-40 justify-between items-center max-w-full text-xs font-medium transition-all pointer-events-none",
										)}
									>
										<p class="flex gap-4 items-center">
											<span class="flex items-center text-gray-12">
												<IconCapCamera class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
												{(() => {
													const totalSeconds = Math.round(
														est().duration_seconds,
													);
													const hours = Math.floor(totalSeconds / 3600);
													const minutes = Math.floor(
														(totalSeconds % 3600) / 60,
													);
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
													const minutes = Math.floor(
														(totalSeconds % 3600) / 60,
													);
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
										</p>
									</div>
								)}
							</Show>
						</div>
					}
				>
					<div class="flex flex-col gap-4 px-2 min-w-[650px]">
						{/* Export to */}
						<div class="flex flex-col gap-3">
							<h3 class="text-gray-12 font-medium">Export to</h3>
							<KTabs
								value={settings.exportTo}
								onChange={(v: string) => {
									setSettings("exportTo", v as ExportToOption);
								}}
							>
								<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
									<For each={EXPORT_TO_OPTIONS}>
										{(option) => (
											<KTabs.Trigger
												value={option.value}
												class="z-10 flex flex-1 gap-2 items-center justify-center py-2.5 px-3 text-gray-11 text-nowrap transition-colors duration-100 outline-none ui-selected:text-gray-1 peer"
											>
												{option.icon}
												{option.label}
											</KTabs.Trigger>
										)}
									</For>
									<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
										<div class="flex-1 bg-gray-12" />
									</KTabs.Indicator>
								</KTabs.List>
							</KTabs>

							{/* Organization selector - appears inline when shareable link is selected */}
							<Show
								when={
									settings.exportTo === "link" &&
									auth.data &&
									organizations().length > 1
								}
							>
								<div class="flex flex-col gap-3 p-4 rounded-lg bg-gray-2 border animate-in fade-in slide-in-from-top duration-200">
									<label class="flex items-center gap-2 text-sm text-gray-11">
										<IconLucideBuilding2 class="size-4" />
										Organization
									</label>
									<KSelect<{ id: string; name: string; ownerId: string }>
										options={organizations()}
										optionValue="id"
										optionTextValue="name"
										placeholder="Select organization"
										value={organizations().find(
											(org) => org.id === settings.organizationId,
										)}
										onChange={(option) =>
											setSettings("organizationId", option?.id ?? null)
										}
										itemComponent={(props) => (
											<MenuItem<typeof KSelect.Item>
												as={KSelect.Item}
												item={props.item}
											>
												<div class="flex items-center gap-2 w-full">
													<KSelect.ItemLabel class="flex-1">
														{props.item.rawValue.name}
													</KSelect.ItemLabel>
													{/* Show ownership indicator */}
													<Show
														when={
															props.item.rawValue.ownerId === auth.data?.user_id
														}
													>
														<span class="text-xs text-blue-10 bg-blue-3 px-1.5 py-0.5 rounded">
															Owner
														</span>
													</Show>
												</div>
											</MenuItem>
										)}
									>
										<KSelect.Trigger class="flex flex-row gap-2 items-center px-3 py-2.5 w-full rounded-lg transition-colors bg-white border disabled:text-gray-11">
											<KSelect.Value<{
												id: string;
												name: string;
												ownerId: string;
											}> class="flex-1 text-sm text-left truncate text-gray-12">
												{(state) => (
													<span>
														{state.selectedOption()?.name ??
															"Select organization"}
													</span>
												)}
											</KSelect.Value>
											<KSelect.Icon<ValidComponent>
												as={(props) => (
													<IconCapChevronDown
														{...props}
														class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-gray-10"
													/>
												)}
											/>
										</KSelect.Trigger>
										<KSelect.Portal>
											<PopperContent<typeof KSelect.Content>
												as={KSelect.Content}
												class={cx(topSlideAnimateClasses, "z-50")}
											>
												<MenuItemList<typeof KSelect.Listbox>
													class="max-h-32 custom-scroll"
													as={KSelect.Listbox}
												/>
											</PopperContent>
										</KSelect.Portal>
									</KSelect>
								</div>
							</Show>
						</div>

						{/* Divider */}
						<div class="w-full border-t border-gray-5" />

						{/* Output Settings Group */}
						<div class="flex flex-col gap-4">
							<h3 class="text-gray-12 font-medium">Output Settings</h3>

							{/* Format & Frame Rate Row */}
							<div class="flex gap-3">
								<div class="flex flex-col gap-2 flex-1">
									<h4 class="text-xs text-gray-11 font-medium uppercase tracking-wide">
										Format
									</h4>
									<KTabs
										value={settings.format}
										onChange={(v: string) => {
											setSettings(
												produce((newSettings) => {
													newSettings.format = v as ExportFormat;

													if (
														v === "Gif" &&
														!(
															settings.resolution.value === "720p" ||
															settings.resolution.value === "1080p"
														)
													)
														newSettings.resolution = {
															...RESOLUTION_OPTIONS._720p,
														};

													if (
														v === "Gif" &&
														GIF_FPS_OPTIONS.every(
															(v) => v.value === settings.fps,
														)
													)
														newSettings.fps = 15;

													if (
														v === "Mp4" &&
														FPS_OPTIONS.every((v) => v.value !== settings.fps)
													)
														newSettings.fps = 30;
												}),
											);
										}}
									>
										<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
											<For each={FORMAT_OPTIONS}>
												{(option) => (
													<KTabs.Trigger
														value={option.value}
														class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-1 peer"
													>
														{option.label}
													</KTabs.Trigger>
												)}
											</For>
											<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
												<div class="flex-1 bg-gray-12" />
											</KTabs.Indicator>
										</KTabs.List>
									</KTabs>
								</div>

								<div class="flex flex-col gap-2 flex-1">
									<h4 class="text-xs text-gray-11 font-medium uppercase tracking-wide">
										Frame Rate
									</h4>
									<KSelect<{ label: string; value: number }>
										options={
											settings.format === "Gif" ? GIF_FPS_OPTIONS : FPS_OPTIONS
										}
										optionValue="value"
										optionTextValue="label"
										placeholder="Select FPS"
										value={(settings.format === "Gif"
											? GIF_FPS_OPTIONS
											: FPS_OPTIONS
										).find((opt) => opt.value === settings.fps)}
										onChange={(option) => {
											const value =
												option?.value ?? (settings.format === "Gif" ? 10 : 30);
											trackEvent("export_fps_changed", {
												fps: value,
											});
											setSettings("fps", value);
										}}
										itemComponent={(props) => (
											<MenuItem<typeof KSelect.Item>
												as={KSelect.Item}
												item={props.item}
											>
												<KSelect.ItemLabel class="flex-1">
													{props.item.rawValue.label}
												</KSelect.ItemLabel>
											</MenuItem>
										)}
									>
										<KSelect.Trigger class="flex flex-row gap-2 items-center px-3 py-3 w-full rounded-lg transition-colors bg-white border disabled:text-gray-11">
											<KSelect.Value<
												(typeof FPS_OPTIONS)[number]
											> class="flex-1 text-xs text-left truncate tabular-nums text-gray-12">
												{(state) => (
													<span>{state.selectedOption()?.label}</span>
												)}
											</KSelect.Value>
											<KSelect.Icon<ValidComponent>
												as={(props) => (
													<IconCapChevronDown
														{...props}
														class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-gray-10"
													/>
												)}
											/>
										</KSelect.Trigger>
										<KSelect.Portal>
											<PopperContent<typeof KSelect.Content>
												as={KSelect.Content}
												class={cx(topSlideAnimateClasses, "z-50")}
											>
												<MenuItemList<typeof KSelect.Listbox>
													class="max-h-32 custom-scroll"
													as={KSelect.Listbox}
												/>
											</PopperContent>
										</KSelect.Portal>
									</KSelect>
								</div>
							</div>

							{/* Resolution Row */}
							<div class="flex flex-col gap-2">
								<h4 class="text-xs text-gray-11 font-medium uppercase tracking-wide">
									Resolution
								</h4>
								<KTabs
									value={settings.resolution.value}
									onChange={(v: string) => {
										const option = (
											settings.format === "Gif"
												? [RESOLUTION_OPTIONS._720p, RESOLUTION_OPTIONS._1080p]
												: [
														RESOLUTION_OPTIONS._720p,
														RESOLUTION_OPTIONS._1080p,
														RESOLUTION_OPTIONS._4k,
													]
										).find((opt) => opt.value === v);
										if (option) setSettings("resolution", option);
									}}
								>
									<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
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
												<KTabs.Trigger
													value={option.value}
													class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-1 peer"
												>
													{option.label}
												</KTabs.Trigger>
											)}
										</For>
										<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
											<div class="flex-1 bg-gray-12" />
										</KTabs.Indicator>
									</KTabs.List>
								</KTabs>
							</div>

							{/* Quality Row */}
							<div class="flex flex-col gap-2">
								<h4 class="text-xs text-gray-11 font-medium uppercase tracking-wide">
									Quality
								</h4>
								<KTabs
									value={settings.compression}
									onChange={(v: string) => {
										setSettings("compression", v as ExportCompression);
									}}
								>
									<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
										<For each={COMPRESSION_OPTIONS}>
											{(option) => (
												<KTabs.Trigger
													value={option.value}
													class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-1 peer"
												>
													{option.label}
												</KTabs.Trigger>
											)}
										</For>
										<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
											<div class="flex-1 bg-gray-12" />
										</KTabs.Indicator>
									</KTabs.List>
								</KTabs>
							</div>
						</div>
					</div>
				</DialogContent>
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
						<>
							<Dialog.Header>
								<div class="flex justify-between items-center w-full">
									<span class="text-gray-12">Export</span>
									<div
										onClick={() => setDialog((d) => ({ ...d, open: false }))}
										class="flex justify-center items-center p-1 rounded-full transition-colors cursor-pointer hover:bg-gray-3"
									>
										<IconCapCircleX class="text-gray-12 size-4" />
									</div>
								</div>
							</Dialog.Header>
							<Dialog.Content class="text-gray-12">
								<div class="relative z-10 px-5 py-4 mx-auto space-y-6 w-full text-center">
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
															<RenderProgress
																state={copyState}
																format={settings.format}
															/>
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
															showCompletionScreen() &&
															saveState.type === "done"
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
																		<RenderProgress
																			state={copyState}
																			format={settings.format}
																		/>
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
																		{settings.format === "Gif"
																			? "GIF"
																			: "video"}{" "}
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
																			<RenderProgress
																				state={renderState}
																				format={settings.format}
																			/>
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
							</Dialog.Content>
							<Dialog.Footer>
								<Show
									when={
										exportState.action === "upload" &&
										exportState.type === "done"
									}
								>
									<div class="relative">
										<a
											href={meta().sharing!.link}
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
													navigator.clipboard.writeText(meta().sharing!.link!);
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
										exportState.action === "save" && exportState.type === "done"
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
							</Dialog.Footer>
						</>
					);
				}}
			</Show>
		</>
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
