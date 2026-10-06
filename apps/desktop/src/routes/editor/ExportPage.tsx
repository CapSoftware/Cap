import { Button } from "@cap/ui-solid";
import { createElementBounds } from "@solid-primitives/bounds";
import { debounce } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";
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
	type ParentProps,
	Show,
	Suspense,
	Switch,
	type ValidComponent,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import Tooltip from "~/components/Tooltip";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import {
	beginExportSessionGuard,
	createExportTask,
	createExportToFileTask,
} from "~/utils/export";
import { createSelectedOrganization } from "~/utils/organization-branding";
import {
	commands,
	type ExportCompression,
	type ExportSettings,
	type FramesRendered,
	type UploadProgress,
} from "~/utils/tauri";
import IconLucideGem from "~icons/lucide/gem";
import IconLucideSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import { type RenderState, useEditorContext } from "./context";
import { formatEstimatedSize, formatEstimatedTime } from "./export-estimates";
import { RESOLUTION_OPTIONS } from "./Header";
import { Dialog } from "./ui";

class SilentError extends Error {}

const EXPORT_CTA_CLASS =
	"flex w-full h-10 items-center justify-center gap-2 rounded-[10px] text-[13px] font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ed-accent/40 disabled:opacity-50 disabled:cursor-not-allowed";

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
	optimizeFilesize: boolean;
	organizationId?: string | null;
}

function buildExportSettings(
	settings: Settings,
	cursorOnly: boolean,
	compressionBpp: number | null,
	forceFfmpegDecoder: boolean,
): ExportSettings {
	const resolutionBase = {
		x: settings.resolution.width,
		y: settings.resolution.height,
	};

	if (cursorOnly) {
		return {
			format: "Mov",
			fps: settings.fps,
			resolution_base: resolutionBase,
			cursor_only: true,
		};
	}

	if (settings.format === "Mp4") {
		return {
			format: "Mp4",
			fps: settings.fps,
			resolution_base: resolutionBase,
			compression: settings.compression,
			custom_bpp: compressionBpp,
			force_ffmpeg_decoder: forceFfmpegDecoder,
			optimize_filesize: settings.optimizeFilesize,
		};
	}

	return {
		format: "Gif",
		fps: settings.fps,
		resolution_base: resolutionBase,
		quality: null,
	};
}

export function ExportPage() {
	const {
		dialog,
		setDialog,
		editorInstance,
		editorState,
		setExportState,
		exportState,
		meta,
		refetchMeta,
		flushProjectConfig,
		projectRevision,
		project,
	} = useEditorContext();

	const projectPath = editorInstance.path;
	const [reuploading, setReuploading] = createSignal(false);

	const auth = authStore.createQuery();
	const signIn = createSignInMutation();
	const organizationSelection = createSelectedOrganization();
	const organisations = organizationSelection.organizations;

	const hasTransparentBackground = () => {
		const backgroundSource = project.background.source;
		return (
			backgroundSource.type === "color" &&
			backgroundSource.alpha !== undefined &&
			backgroundSource.alpha < 255
		);
	};

	const isCancellationError = (error: unknown) =>
		error instanceof SilentError ||
		error === "Export cancelled" ||
		error === "Save dialog cancelled" ||
		(error instanceof Error &&
			(error.message === "Export cancelled" ||
				error.message === "Save dialog cancelled"));

	const [_settings, setSettings] = makePersisted(
		createStore<Settings>({
			format: "Mp4",
			fps: 30,
			exportTo: "file",
			resolution: { label: "720p", value: "720p", width: 1280, height: 720 },
			compression: "Maximum",
			optimizeFilesize: false,
		}),
		{ name: "export_settings" },
	);
	const initialDialog = dialog();
	if (
		"type" in initialDialog &&
		initialDialog.type === "export" &&
		initialDialog.destination
	) {
		setSettings("exportTo", initialDialog.destination);
	}

	const VALID_COMPRESSIONS: ExportCompression[] = [
		"Maximum",
		"Social",
		"Web",
		"Potato",
	];
	const [cursorOnly, setCursorOnly] = createSignal(false);

	const requiresTransparentExport = () => hasTransparentBackground();
	const disablesLinkExport = () => hasTransparentBackground() || cursorOnly();
	const shouldUseGifMode = () =>
		!cursorOnly() &&
		(hasTransparentBackground() ||
			(_settings.format === "Gif" && _settings.exportTo !== "link"));
	const isMovCursorOnlyExport = () => cursorOnly();
	const resetTransientExportOptions = () => {
		setCursorOnly(false);
	};
	const handleBack = () => {
		resetTransientExportOptions();
		setDialog((d) => ({ ...d, open: false }));
	};

	const settings = mergeProps(_settings, () => {
		const ret: Partial<Settings> = {};
		if (!["Mp4", "Gif"].includes(_settings.format)) ret.format = "Mp4";
		else if (!cursorOnly()) {
			if (requiresTransparentExport() && _settings.format === "Mp4")
				ret.format = "Gif";
			else if (
				!requiresTransparentExport() &&
				_settings.format === "Gif" &&
				_settings.exportTo === "link"
			)
				ret.format = "Mp4";
		}

		if (disablesLinkExport() && _settings.exportTo === "link")
			ret.exportTo = "file";

		if (shouldUseGifMode()) {
			if (!["720p", "1080p"].includes(_settings.resolution.value)) {
				ret.resolution = { ...RESOLUTION_OPTIONS._720p };
			}
			if (GIF_FPS_OPTIONS.every((option) => option.value !== _settings.fps)) {
				ret.fps = 15;
			}
		} else if (FPS_OPTIONS.every((option) => option.value !== _settings.fps)) {
			ret.fps = 30;
		}

		if (!VALID_COMPRESSIONS.includes(_settings.compression))
			ret.compression = "Maximum";

		Object.defineProperty(ret, "organizationId", {
			get() {
				const selectedOrganizationId =
					organizationSelection.selectedOrganizationId();
				if (!_settings.organizationId) return selectedOrganizationId;
				if (
					organisations().some(
						(organization) => organization.id === _settings.organizationId,
					)
				) {
					return _settings.organizationId;
				}

				return selectedOrganizationId;
			},
		});

		return ret;
	});

	const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
	const [previewLoading, setPreviewLoading] = createSignal(false);
	const [previewUnavailable, setPreviewUnavailable] = createSignal(false);
	const [previewError, setPreviewError] = createSignal<string | null>(null);
	type MeasuredEstimate = Awaited<
		ReturnType<typeof commands.getExportEstimates>
	>;
	const [renderEstimate, setRenderEstimate] =
		createSignal<MeasuredEstimate | null>(null);
	const [estimateLoading, setEstimateLoading] = createSignal(false);
	const estimatedSizeLabel = () => {
		const estimate = renderEstimate();
		return estimate
			? formatEstimatedSize(estimate.size_range_mb)
			: estimateLoading()
				? "Calculating…"
				: "Unavailable";
	};
	const estimatedTimeLabel = () => {
		const estimate = renderEstimate();
		return estimate
			? formatEstimatedTime(estimate.time_range_seconds)
			: estimateLoading()
				? "Calculating…"
				: "Unavailable";
	};

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

	const _matchingPreset = () => {
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

	type PreviewRequest = {
		projectRevision: number;
		frameTime: number;
		fps: number;
		resWidth: number;
		resHeight: number;
		bpp: number;
		mode: "video" | "gif" | "cursor";
		exportSettings: ExportSettings;
	};

	let previewDisposed = false;
	let previewInFlight = false;
	let latestPreviewRequest: PreviewRequest | null = null;
	let pendingPreviewRequest: PreviewRequest | null = null;
	let cancelPreviewRetry: (() => void) | null = null;
	let ownedPreviewUrl: string | null = null;
	const [previewDimensions, setPreviewDimensions] = createSignal<{
		request: PreviewRequest;
		durationSeconds: number;
		width: number;
		height: number;
	} | null>(null);

	const previewMode = () =>
		isMovCursorOnlyExport() ? "cursor" : shouldUseGifMode() ? "gif" : "video";
	const matchesPreviewSettings = (request: PreviewRequest) =>
		request.projectRevision === projectRevision() &&
		request.fps === settings.fps &&
		request.resWidth === settings.resolution.width &&
		request.resHeight === settings.resolution.height &&
		request.bpp === compressionBpp() &&
		request.mode === previewMode() &&
		JSON.stringify(request.exportSettings) ===
			JSON.stringify(currentExportSettings());
	const isPreviewCurrent = (request: PreviewRequest) =>
		!previewDisposed &&
		latestPreviewRequest === request &&
		matchesPreviewSettings(request);
	const currentPreviewDimensions = () => {
		const dimensions = previewDimensions();
		return dimensions && matchesPreviewSettings(dimensions.request)
			? dimensions
			: null;
	};
	const outputDimensions = () =>
		currentPreviewDimensions() ?? settings.resolution;
	const outputDescription = () => {
		const dimensions = currentPreviewDimensions();
		return dimensions
			? `${dimensions.width}×${dimensions.height} · ${settings.fps} fps`
			: undefined;
	};

	const currentExportSettings = () =>
		buildExportSettings(
			settings,
			isMovCursorOnlyExport(),
			advancedMode() && isCustomBpp() ? compressionBpp() : null,
			forceFfmpegDecoder(),
		);
	let estimateGeneration = 0;
	let estimateCancellation = Promise.resolve();
	let pendingEstimate: PreviewRequest | null = null;
	let estimating = false;
	const fetchEstimate = async (request: PreviewRequest) => {
		if (exportState.type !== "idle" || !isPreviewCurrent(request)) return;
		pendingEstimate = request;
		if (estimating) return;
		estimating = true;
		try {
			while (!previewDisposed && pendingEstimate) {
				const current = pendingEstimate;
				pendingEstimate = null;
				const generation = estimateGeneration;
				let settled = false;
				const onEstimate = new Channel<MeasuredEstimate>((estimate) => {
					if (
						!settled &&
						generation === estimateGeneration &&
						isPreviewCurrent(current)
					)
						setRenderEstimate(estimate);
				});
				try {
					const estimate = await commands.getExportEstimates(
						projectPath,
						current.exportSettings,
						onEstimate,
					);
					if (generation === estimateGeneration && isPreviewCurrent(current))
						setRenderEstimate(estimate);
				} catch (error) {
					if (generation === estimateGeneration && isPreviewCurrent(current))
						console.warn("Export estimate unavailable", error);
				} finally {
					settled = true;
					const internals = (
						globalThis as {
							__TAURI_INTERNALS__?: {
								unregisterCallback?: (id: number) => void;
							};
						}
					).__TAURI_INTERNALS__;
					internals?.unregisterCallback?.(onEstimate.id);
					if (generation === estimateGeneration && isPreviewCurrent(current))
						setEstimateLoading(false);
				}
			}
		} finally {
			estimating = false;
		}
	};

	const runPreviewRequest = async (request: PreviewRequest, retryCount = 0) => {
		if (!isPreviewCurrent(request)) return;
		const { frameTime, fps, resWidth, resHeight, bpp, mode } = request;

		try {
			await estimateCancellation;
			await flushProjectConfig();
		} catch (error) {
			if (!isPreviewCurrent(request)) return;
			if (ownedPreviewUrl) URL.revokeObjectURL(ownedPreviewUrl);
			ownedPreviewUrl = null;
			setPreviewUrl(null);
			setPreviewDimensions(null);
			setRenderEstimate(null);
			setPreviewError(error instanceof Error ? error.message : String(error));
			setPreviewUnavailable(true);
			setEstimateLoading(false);
			return;
		}
		if (!isPreviewCurrent(request)) return;

		const maxRetries = 2;

		try {
			const result = await commands.generateExportPreviewFast(frameTime, {
				fps,
				resolution_base: { x: resWidth, y: resHeight },
				compression_bpp: bpp,
				cursor_only: mode === "cursor",
			});
			if (!isPreviewCurrent(request)) return;

			const byteArray = Uint8Array.from(atob(result.jpeg_base64), (c) =>
				c.charCodeAt(0),
			);
			const blob = new Blob([byteArray], { type: "image/jpeg" });
			const nextUrl = URL.createObjectURL(blob);
			if (ownedPreviewUrl) URL.revokeObjectURL(ownedPreviewUrl);
			ownedPreviewUrl = nextUrl;
			setPreviewUrl(nextUrl);
			setPreviewDimensions({
				request,
				durationSeconds: result.total_frames / request.fps,
				width: result.actual_width,
				height: result.actual_height,
			});

			setPreviewUnavailable(false);
			void fetchEstimate(request);
		} catch (e) {
			if (!isPreviewCurrent(request)) return;
			console.error("Failed to generate preview:", e);
			if (retryCount < maxRetries) {
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(
						() => {
							cancelPreviewRetry = null;
							resolve();
						},
						200 * (retryCount + 1),
					);
					cancelPreviewRetry = () => {
						clearTimeout(timeout);
						cancelPreviewRetry = null;
						resolve();
					};
				});
				if (!isPreviewCurrent(request)) return;
				return runPreviewRequest(request, retryCount + 1);
			}
			setPreviewUnavailable(true);
			setEstimateLoading(false);
		}
	};

	const fetchPreview = async (request: PreviewRequest) => {
		if (!isPreviewCurrent(request)) return;
		setPreviewUnavailable(false);
		pendingPreviewRequest = request;
		if (previewInFlight) return;

		previewInFlight = true;
		let completedRequest: PreviewRequest | null = null;
		try {
			while (!previewDisposed && pendingPreviewRequest) {
				const request = pendingPreviewRequest;
				pendingPreviewRequest = null;
				await runPreviewRequest(request);
				completedRequest = request;
			}
		} finally {
			previewInFlight = false;
			if (completedRequest && isPreviewCurrent(completedRequest))
				setPreviewLoading(false);
		}
	};

	const debouncedFetchPreview = debounce(fetchPreview, 300);
	const requestPreview = (debounced = false) => {
		if (previewDisposed) return;
		const request: PreviewRequest = {
			projectRevision: projectRevision(),
			frameTime: editorState.playbackTime ?? 0,
			fps: settings.fps,
			resWidth: settings.resolution.width,
			resHeight: settings.resolution.height,
			bpp: compressionBpp(),
			mode: previewMode(),
			exportSettings: currentExportSettings(),
		};
		if (
			previewDimensions()?.request.projectRevision !== request.projectRevision
		) {
			if (ownedPreviewUrl) URL.revokeObjectURL(ownedPreviewUrl);
			ownedPreviewUrl = null;
			setPreviewUrl(null);
			setPreviewDimensions(null);
		}
		estimateGeneration += 1;
		pendingEstimate = null;
		setRenderEstimate(null);
		setEstimateLoading(true);
		estimateCancellation = commands.cancelExportEstimates().catch(console.warn);
		setPreviewError(null);
		latestPreviewRequest = request;
		pendingPreviewRequest = null;
		cancelPreviewRetry?.();
		setPreviewLoading(true);
		if (debounced) debouncedFetchPreview(request);
		else void fetchPreview(request);
	};

	requestPreview();

	createEffect(
		on(
			[
				() => settings.format,
				() => settings.fps,
				() => settings.resolution.width,
				() => settings.resolution.height,
				cursorOnly,
				compressionBpp,
				projectRevision,
				() => settings.optimizeFilesize,
				() => settings.compression,
				forceFfmpegDecoder,
				advancedMode,
			],
			() => requestPreview(true),
			{ defer: true },
		),
	);

	onCleanup(() => {
		previewDisposed = true;
		estimateGeneration += 1;
		pendingEstimate = null;
		void commands.cancelExportEstimates().catch(console.warn);
		latestPreviewRequest = null;
		pendingPreviewRequest = null;
		debouncedFetchPreview.clear();
		cancelPreviewRetry?.();
		if (ownedPreviewUrl) {
			URL.revokeObjectURL(ownedPreviewUrl);
			ownedPreviewUrl = null;
		}
	});

	createEffect(() => {
		if (exportState.type !== "idle") {
			estimateGeneration += 1;
			pendingEstimate = null;
			setEstimateLoading(false);
			void commands.cancelExportEstimates().catch(console.warn);
		}
	});

	let cancelCurrentExport: (() => void) | null = null;

	onCleanup(() => {
		cancelCurrentExport?.();
		cancelCurrentExport = null;
	});

	const exportWithSettings = async (
		onProgress: (progress: FramesRendered) => void,
	) => {
		const customBpp = advancedMode() && isCustomBpp() ? compressionBpp() : null;
		const exportSettings = buildExportSettings(
			settings,
			isMovCursorOnlyExport(),
			customBpp,
			forceFfmpegDecoder(),
		);
		await flushProjectConfig();
		if (previewDisposed || isCancelled()) throw new SilentError("Cancelled");
		const { promise, cancel } = createExportTask(
			projectPath,
			exportSettings,
			onProgress,
		);
		cancelCurrentExport = cancel;
		return promise.finally(() => {
			if (cancelCurrentExport === cancel) cancelCurrentExport = null;
		});
	};

	const [outputPath, setOutputPath] = createSignal<string | null>(null);
	const [isCancelled, setIsCancelled] = createSignal(false);
	const exportFileExtension = () =>
		isMovCursorOnlyExport() ? "mov" : settings.format === "Gif" ? "gif" : "mp4";
	const exportedAssetLabel = () =>
		isMovCursorOnlyExport()
			? "Cursor track"
			: settings.format === "Gif"
				? "GIF"
				: "Recording";
	const exportMediumLabel = () =>
		isMovCursorOnlyExport()
			? "cursor track"
			: settings.format === "Gif"
				? "GIF"
				: "video";

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
			const releaseExportSession = await beginExportSessionGuard();
			try {
				setExportState(reconcile({ action: "copy", type: "starting" }));

				const outputPath = await exportWithSettings((progress) => {
					if (isCancelled()) throw new SilentError("Cancelled");
					setExportState({ type: "rendering", progress });
				});

				if (isCancelled()) throw new SilentError("Cancelled");

				setExportState({ type: "copying" });

				await commands.copyVideoToClipboard(outputPath);
			} finally {
				await releaseExportSession();
			}
		},
		onError: (error) => {
			if (previewDisposed) return;
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
			if (previewDisposed) return;
			setExportState({ type: "done" });
			toast.success(`${exportedAssetLabel()} exported to clipboard`);
		},
	}));

	const save = createMutation(() => ({
		mutationFn: async () => {
			setIsCancelled(false);
			if (exportState.type !== "idle") return;
			const extension = exportFileExtension();
			const customBpp =
				advancedMode() && isCustomBpp() ? compressionBpp() : null;
			const exportSettings = buildExportSettings(
				settings,
				isMovCursorOnlyExport(),
				customBpp,
				forceFfmpegDecoder(),
			);
			setExportState(reconcile({ action: "save", type: "starting" }));
			await flushProjectConfig();
			if (previewDisposed || isCancelled()) throw new SilentError("Cancelled");
			const task = createExportToFileTask(
				projectPath,
				exportSettings,
				`${meta().prettyName}.${extension}`,
				extension,
				(progress) => {
					if (isCancelled()) throw new SilentError("Cancelled");
					setExportState({ type: "rendering", progress });
				},
				() => {
					setExportState(reconcile({ action: "save", type: "starting" }));
				},
				() => {
					setExportState({ action: "save", type: "copying" });
				},
			);
			cancelCurrentExport = task.cancel;
			const savePath = await task.promise.finally(() => {
				if (cancelCurrentExport === task.cancel) cancelCurrentExport = null;
			});

			if (isCancelled()) throw new SilentError("Cancelled");

			setOutputPath(savePath);
			setExportState({ type: "done" });
		},
		onError: (error) => {
			if (previewDisposed) return;
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
			if (previewDisposed) return;
			toast.success(`${exportedAssetLabel()} exported to file`);
		},
	}));

	const upload = createMutation(() => ({
		mutationFn: async () => {
			setIsCancelled(false);
			if (exportState.type !== "idle") return;
			const releaseExportSession = await beginExportSessionGuard();
			try {
				setExportState(reconcile({ action: "upload", type: "starting" }));
				await refetchMeta();
				setReuploading(!!meta().sharing);

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

				await exportWithSettings((progress) => {
					if (isCancelled()) throw new SilentError("Cancelled");
					setExportState({ type: "rendering", progress });
				});

				if (isCancelled()) throw new SilentError("Cancelled");

				const uploadChannel = new Channel<UploadProgress>((progress) => {
					console.log("Upload progress:", progress);
					setExportState(
						produce((state) => {
							if (state.type !== "uploading") return;

							state.progress = Math.round(progress.progress * 100);
						}),
					);
				});

				setExportState({ type: "uploading", progress: 0 });

				console.log({ organizationId: settings.organizationId });

				const result = meta().sharing
					? await commands.uploadExportedVideo(
							projectPath,
							"Reupload",
							uploadChannel,
							null,
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
			} finally {
				await releaseExportSession();
			}
		},
		onSuccess: async () => {
			await refetchMeta();
			if (previewDisposed) return;
			setExportState({ type: "done" });
		},
		onError: (error) => {
			if (previewDisposed) return;
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

	const [stageRef, setStageRef] = createSignal<HTMLDivElement>();
	const stageBounds = createElementBounds(stageRef);
	const previewBox = () => {
		const availWidth = Math.max(120, stageBounds.width ?? 0);
		const availHeight = Math.max(68, stageBounds.height ?? 0);
		const { width, height } = outputDimensions();
		const scale = Math.min(availWidth / width, availHeight / height);
		return {
			width: Math.floor(width * scale),
			height: Math.floor(height * scale),
		};
	};

	const destinationOptions = () =>
		EXPORT_TO_OPTIONS.map((option) => ({
			value: option.value,
			label:
				option.value === "link" && meta().sharing ? "Reupload" : option.label,
			icon: option.icon,
			disabled: option.value === "link" && disablesLinkExport(),
			disabledReason:
				option.value === "link" && disablesLinkExport()
					? cursorOnly()
						? "Cursor-only exports can only be saved to a file or clipboard"
						: "Transparent exports can only be saved to a file or clipboard"
					: undefined,
		}));

	const formatOptions = () =>
		FORMAT_OPTIONS.map((option) => {
			const disabled =
				cursorOnly() ||
				(option.value === "Mp4" && requiresTransparentExport()) ||
				(option.value === "Gif" && settings.exportTo === "link");
			return {
				value: option.value,
				label: option.label,
				disabled,
				disabledReason: cursorOnly()
					? "Cursor-only export always uses transparent MOV"
					: option.value === "Mp4" && requiresTransparentExport()
						? "MP4 doesn't support transparency"
						: option.value === "Gif" && settings.exportTo === "link"
							? "Links require MP4 format"
							: undefined,
			};
		});

	const resolutionOptions = () =>
		(shouldUseGifMode()
			? [RESOLUTION_OPTIONS._720p, RESOLUTION_OPTIONS._1080p]
			: [
					RESOLUTION_OPTIONS._720p,
					RESOLUTION_OPTIONS._1080p,
					RESOLUTION_OPTIONS._4k,
				]
		).map((option) => ({ value: option.value, label: option.label }));

	const fpsOptions = () =>
		(shouldUseGifMode() ? GIF_FPS_OPTIONS : FPS_OPTIONS).map((option) => ({
			value: option.value,
			label: option.label,
		}));

	const qualityOptions = () =>
		[...COMPRESSION_OPTIONS].reverse().map((option) => ({
			value: option.value,
			label: option.label === "Social Media" ? "Social" : option.label,
		}));

	const selectedQuality = () => (isCustomBpp() ? null : settings.compression);

	const showBitrateControls = () => settings.format === "Mp4" && !cursorOnly();

	return (
		<div class="flex flex-col h-full bg-ed-window text-ed-text-1 overflow-hidden">
			<div
				data-tauri-drag-region
				class={cx(
					"flex relative flex-row items-center w-full h-[52px] pr-3 border-b border-ed-line shrink-0",
					ostype() === "macos" ? "pl-[92px]" : "pl-3",
				)}
			>
				<div data-tauri-drag-region class="flex flex-1 items-center h-full">
					<button
						type="button"
						onClick={handleBack}
						class="flex gap-1.5 items-center h-7 pl-2 pr-2.5 rounded-lg text-[12px] font-medium text-ed-text-2 transition-colors hover:bg-ed-ctl hover:text-ed-text-1 outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent"
					>
						<IconCapMoveLeft class="size-3.5" />
						Back to editor
					</button>
				</div>
				<h1 class="text-[13px] font-medium text-ed-text-1 pointer-events-none">
					Export
				</h1>
				<div data-tauri-drag-region class="flex flex-1 justify-end h-full">
					{ostype() === "windows" && <CaptionControlsWindows11 />}
				</div>
			</div>

			<div class="flex-1 min-h-0 flex relative">
				<div class="flex-1 min-w-0 flex flex-col bg-ed-stage pt-4 px-6 pb-5">
					<div class="flex items-center gap-1.5 h-[22px] text-[12px] font-medium text-ed-text-2">
						Preview
						<Tooltip content="This is a rendered frame from your video. Adjust the settings to see the quality of the final export.">
							<IconLucideInfo class="size-[13px] text-ed-text-3 hover:text-ed-text-2 cursor-help transition-colors" />
						</Tooltip>
					</div>
					<div class="flex-1 min-h-0 flex items-center justify-center pt-3.5 pb-[18px]">
						<div ref={setStageRef} class="relative size-full">
							<div
								class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[10px] overflow-hidden group"
								classList={{
									"shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(0,0,0,0.12)]":
										!!previewUrl(),
									"bg-ed-ctl": !previewUrl(),
								}}
								style={{
									width: `${previewBox().width}px`,
									height: `${previewBox().height}px`,
								}}
							>
								<Show
									when={previewUrl()}
									fallback={
										<div class="absolute inset-0 flex items-center justify-center px-6">
											<Show
												when={previewLoading()}
												fallback={
													<span class="text-[12px] text-center text-ed-text-2 break-words">
														{previewError() ??
															(previewUnavailable()
																? "Preview unavailable"
																: "Generating preview...")}
													</span>
												}
											>
												<div class="absolute inset-0 overflow-hidden">
													<div class="absolute inset-y-0 w-full animate-shimmer bg-linear-to-r from-transparent from-30% via-ed-ctl-hover via-50% to-transparent to-70%" />
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
												class="relative z-0 size-full object-contain"
											/>
											<Show when={previewLoading()}>
												<div class="absolute inset-0 z-50 overflow-hidden pointer-events-none">
													<div class="absolute inset-y-0 w-full animate-shimmer bg-linear-to-r from-transparent from-30% via-white/60 via-50% to-transparent to-70%" />
												</div>
											</Show>
											<button
												type="button"
												aria-label="Open full-size preview"
												onClick={() => setPreviewDialogOpen(true)}
												class="absolute bottom-3 right-3 p-2 rounded-lg bg-black/60 hover:bg-black/75 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity outline-hidden"
											>
												<IconLucideMaximize2 class="size-4" />
											</button>
										</>
									)}
								</Show>
							</div>
						</div>
					</div>

					<div class="flex justify-center">
						<div class="flex h-11 min-w-[520px] rounded-[10px] bg-ed-card shadow-ed-card">
							<ExportStat
								label="Duration"
								value={
									previewDimensions()
										? formatDuration(
												Math.round(
													renderEstimate()?.duration_seconds ??
														previewDimensions()?.durationSeconds ??
														0,
												),
											)
										: undefined
								}
							/>
							<ExportStat label="Output" value={outputDescription()} divided />
							<ExportStat
								label={
									estimateLoading() && renderEstimate()
										? "Refining size…"
										: "Estimated size"
								}
								value={estimatedSizeLabel()}
								divided
							/>
							<ExportStat
								label={
									estimateLoading() && renderEstimate()
										? "Refining time…"
										: "Export time"
								}
								value={estimatedTimeLabel()}
								divided
							/>
						</div>
					</div>
				</div>

				<div class="w-[400px] shrink-0 border-l border-ed-line flex flex-col bg-ed-card">
					<div class="custom-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col gap-5">
						<ExportSection
							name="Destination"
							icon={<IconCapUpload class="size-3.5" />}
						>
							<ExportSegmented
								options={destinationOptions()}
								value={settings.exportTo}
								tall
								onChange={(value) => {
									setSettings(
										produce((newSettings) => {
											newSettings.exportTo = value;
											if (value === "link" && settings.format === "Gif") {
												newSettings.format = "Mp4";
											}
										}),
									);
								}}
							/>
							<Show when={disablesLinkExport()}>
								<p class="text-[11px] text-ed-text-3">
									{cursorOnly()
										? "Cursor-only exports can only be saved to a file or clipboard."
										: "Transparent exports can only be saved to a file or clipboard."}
								</p>
							</Show>

							<Show when={settings.exportTo === "link" && meta().sharing}>
								{(sharing) => (
									<div class="p-3 rounded-[10px] bg-ed-card-2 flex flex-col gap-1">
										<p class="text-[12.5px] font-medium text-ed-text-1">
											Update your existing link
										</p>
										<p class="text-[11.5px] leading-[15px] text-ed-text-3">
											Reupload replaces the video at this link with your latest
											edit. Everyone with the link will see the updated version.
										</p>
										<a
											class="block text-[11.5px] text-ed-accent truncate hover:underline"
											href={sharing().link}
											target="_blank"
											rel="noreferrer"
										>
											{sharing().link}
										</a>
									</div>
								)}
							</Show>

							<Suspense>
								<Show
									when={
										settings.exportTo === "link" &&
										!meta().sharing &&
										organisations().length > 1
									}
								>
									<button
										type="button"
										class="w-full flex items-center justify-between h-[30px] px-2.5 rounded-[7px] bg-ed-ctl hover:bg-ed-ctl-hover transition-colors text-[12px] outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent"
										onClick={async () => {
											const menu = await Menu.new({
												items: await Promise.all(
													organisations().map((org) =>
														CheckMenuItem.new({
															text: org.name,
															action: () => {
																setSettings("organizationId", org.id);
																void organizationSelection
																	.setSelectedOrganizationId(org.id)
																	.catch(console.error);
															},
															checked: settings.organizationId === org.id,
														}),
													),
												),
											});
											menu.popup();
										}}
									>
										<span class="text-ed-text-2">Organization</span>
										<span class="flex items-center gap-1 text-ed-text-1">
											{
												(
													organisations().find(
														(o) => o.id === settings.organizationId,
													) ?? organisations()[0]
												)?.name
											}
											<IconCapChevronDown class="size-3.5 text-ed-text-3" />
										</span>
									</button>
								</Show>
							</Suspense>
						</ExportSection>

						<ExportSection
							name="Format"
							icon={<IconLucideVideo class="size-3.5" />}
							disabled={cursorOnly()}
						>
							<ExportSegmented
								options={formatOptions()}
								value={settings.format}
								onChange={(value) => {
									updateSettings(
										produce((newSettings) => {
											newSettings.format = value;
											if (
												value === "Gif" &&
												!(
													settings.resolution.value === "720p" ||
													settings.resolution.value === "1080p"
												)
											)
												newSettings.resolution = {
													...RESOLUTION_OPTIONS._720p,
												};
											if (
												value === "Gif" &&
												GIF_FPS_OPTIONS.every((v) => v.value !== settings.fps)
											)
												newSettings.fps = 15;
											if (
												value === "Mp4" &&
												FPS_OPTIONS.every((v) => v.value !== settings.fps)
											)
												newSettings.fps = 30;
										}),
									);
								}}
							/>
						</ExportSection>

						<ExportSection
							name="Resolution"
							icon={<IconLucideMonitor class="size-3.5" />}
						>
							<ExportSegmented
								options={resolutionOptions()}
								value={settings.resolution.value}
								onChange={(value) => {
									const option = Object.values(RESOLUTION_OPTIONS).find(
										(candidate) => candidate.value === value,
									);
									if (option) updateSettings("resolution", { ...option });
								}}
							/>
						</ExportSection>

						<ExportSection
							name="Frame rate"
							icon={<IconLucideGauge class="size-3.5" />}
						>
							<ExportSegmented
								options={fpsOptions()}
								value={settings.fps}
								onChange={(value) => {
									trackEvent("export_fps_changed", { fps: value });
									updateSettings("fps", value);
								}}
							/>
						</ExportSection>

						<Show when={showBitrateControls()}>
							<ExportSection
								name="Quality"
								icon={<IconLucideGem class="size-3.5" />}
							>
								<ExportSegmented
									options={qualityOptions()}
									value={selectedQuality()}
									onChange={(value) => {
										const option = COMPRESSION_OPTIONS.find(
											(candidate) => candidate.value === value,
										);
										if (!option) return;
										setPreviewLoading(true);
										setCompressionBpp(option.bpp);
										setSettings("compression", option.value);
									}}
								/>
								<div class="flex justify-between px-0.5 text-[10.5px] text-ed-text-3">
									<span>Smaller file</span>
									<span>Larger file</span>
								</div>
								<ExportToggleRow
									title="Optimize file size"
									description="Re-encodes with software for much smaller files (slower)"
									checked={settings.optimizeFilesize}
									onChange={(value) =>
										updateSettings("optimizeFilesize", value)
									}
								/>
							</ExportSection>
						</Show>

						<div class="h-px shrink-0 bg-ed-line" />

						<div class="flex flex-col gap-1">
							<button
								type="button"
								aria-expanded={advancedMode()}
								class="flex items-center gap-1.5 h-[30px] -mx-1.5 px-1.5 rounded-lg text-[12px] font-medium text-ed-text-2 transition-colors hover:bg-ed-ctl hover:text-ed-text-1 outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent"
								onClick={() => setAdvancedMode(!advancedMode())}
							>
								<IconLucideSlidersHorizontal class="size-3.5" />
								Advanced
								<IconCapChevronDown
									class={cx(
										"ml-auto size-3.5 text-ed-text-3 transition-transform",
										advancedMode() && "rotate-180",
									)}
								/>
							</button>

							<Show when={advancedMode()}>
								<ExportToggleRow
									title="Export cursor only"
									description="Keeps the same cursor motion and clicks on a transparent background"
									checked={cursorOnly()}
									onChange={setCursorOnly}
								/>

								<Show when={cursorOnly()}>
									<div class="mt-1 p-3 rounded-[10px] bg-ed-card-2 flex items-start gap-2">
										<IconLucideAlertTriangle class="mt-px size-3.5 shrink-0 text-ed-text-2" />
										<p class="text-[11.5px] leading-[15px] text-ed-text-2">
											Exports as a transparent MOV. Files are large and best for
											compositing or editing.
										</p>
									</div>
								</Show>

								<Show when={showBitrateControls()}>
									<div class="flex items-center gap-2.5 h-[34px]">
										<span class="min-w-24 shrink-0 text-[13px] text-ed-text-1">
											Bits per pixel
										</span>
										<div class="flex flex-1 items-center min-w-0 px-1 h-8">
											<input
												type="range"
												aria-label="Bits per pixel"
												min="0.02"
												max="0.5"
												step="0.01"
												value={compressionBpp()}
												onInput={(e) => {
													const value = Number.parseFloat(
														e.currentTarget.value,
													);
													setPreviewLoading(true);
													setCompressionBpp(value);
													const preset = COMPRESSION_OPTIONS.find(
														(opt) => Math.abs(opt.bpp - value) < 0.001,
													);
													if (preset) {
														setSettings("compression", preset.value);
													}
												}}
												class="w-full h-[3px] rounded-full appearance-none cursor-pointer outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ed-thumb [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.12)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110"
												style={{
													background: `linear-gradient(to right, var(--ed-accent) 0%, var(--ed-accent) ${((compressionBpp() - 0.02) / 0.48) * 100}%, var(--ed-ctl-active) ${((compressionBpp() - 0.02) / 0.48) * 100}%, var(--ed-ctl-active) 100%)`,
												}}
											/>
										</div>
										<span class="min-w-9 shrink-0 text-right text-[11px] tabular-nums text-ed-text-3">
											{compressionBpp().toFixed(2)}
										</span>
									</div>
									<Show when={isCustomBpp()}>
										<p class="text-[11px] text-ed-text-3">
											Using a custom bitrate
										</p>
									</Show>

									<Show when={ostype() === "macos"}>
										<ExportToggleRow
											title="Force FFmpeg decoder"
											description="Skip hardware decoder (auto-fallback enabled)"
											checked={forceFfmpegDecoder()}
											onChange={setForceFfmpegDecoder}
										/>
									</Show>
								</Show>
							</Show>
						</div>
					</div>

					<div class="px-4 pt-3 pb-4 border-t border-ed-line">
						{settings.exportTo === "link" && !auth.data ? (
							<button
								type="button"
								class={cx(
									EXPORT_CTA_CLASS,
									signIn.isPending
										? "bg-ed-ctl text-ed-text-1 hover:bg-ed-ctl-hover"
										: "bg-ed-accent text-white hover:bg-ed-accent-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]",
								)}
								onClick={() => {
									if (signIn.isPending) {
										signIn.variables?.abort();
										signIn.reset();
									} else {
										signIn.mutate(new AbortController());
									}
								}}
							>
								{signIn.isPending ? (
									"Cancel Sign In"
								) : (
									<>
										<IconCapLink class="size-4" />
										Sign in to share
									</>
								)}
							</button>
						) : (
							<button
								type="button"
								class={cx(
									EXPORT_CTA_CLASS,
									"bg-ed-accent text-white hover:bg-ed-accent-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]",
								)}
								onClick={() => {
									if (settings.exportTo === "file") save.mutate();
									else if (settings.exportTo === "link") upload.mutate();
									else copy.mutate();
								}}
							>
								{settings.exportTo === "file" && (
									<>
										<IconCapFile class="size-4" />
										Export to File
									</>
								)}
								{settings.exportTo === "clipboard" && (
									<>
										<IconCapCopy class="size-4" />
										Export to Clipboard
									</>
								)}
								{settings.exportTo === "link" && (
									<>
										<IconCapLink class="size-4" />
										{meta().sharing
											? "Reupload to same link"
											: "Create shareable link"}
									</>
								)}
							</button>
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
						<h2 class="text-ed-text-1 text-[13px] font-medium">
							Quality preview
						</h2>
						<button
							type="button"
							aria-label="Close preview"
							onClick={() => setPreviewDialogOpen(false)}
							class="p-1.5 rounded-md hover:bg-ed-ctl text-ed-text-2 hover:text-ed-text-1 transition-colors outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent"
						>
							<IconLucideX class="size-4" />
						</button>
					</div>
					<div class="relative aspect-video rounded-[10px] overflow-hidden bg-ed-stage flex items-center justify-center">
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
					<div class="flex justify-between text-[12px] text-ed-text-2 mt-3 tabular-nums">
						<span>
							{outputDimensions().width}×{outputDimensions().height}
						</span>
						<Show when={renderEstimate()}>
							{(est) => (
								<span>
									Estimated size: {formatEstimatedSize(est().size_range_mb)}
								</span>
							)}
						</Show>
					</div>
				</div>
			</Dialog.Root>

			<Show when={exportState.type !== "idle" && exportState} keyed>
				{(exportState) => {
					const [copyPressed, setCopyPressed] = createSignal(false);
					const [clipboardCopyPressed, setClipboardCopyPressed] =
						createSignal(false);

					return (
						<div
							class="flex absolute inset-0 z-50 flex-col gap-6 justify-center items-center p-6 backdrop-blur-md text-ed-text-1"
							style={{
								"background-color":
									"color-mix(in srgb, var(--ed-window) 94%, transparent)",
							}}
						>
							<Switch>
								<Match
									when={exportState.action === "copy" && exportState}
									keyed
								>
									{(copyState) => (
										<Switch>
											<Match
												when={
													(copyState.type === "starting" ||
														copyState.type === "rendering") &&
													copyState
												}
												keyed
											>
												{(renderState) => (
													<ActiveExport
														heading={
															renderState.type === "rendering"
																? `Rendering ${exportMediumLabel()}`
																: "Preparing export"
														}
														state={renderState}
														onCancel={handleCancel}
													/>
												)}
											</Match>
											<Match when={copyState.type === "copying"}>
												<ActiveExport heading="Copying to clipboard" />
											</Match>
											<Match when={copyState.type === "done"}>
												<CompletedExport
													title="Copied to clipboard"
													subtitle={`Your ${exportMediumLabel()} is ready to paste`}
												/>
											</Match>
										</Switch>
									)}
								</Match>

								<Match
									when={exportState.action === "save" && exportState}
									keyed
								>
									{(saveState) => (
										<Switch>
											<Match
												when={
													(saveState.type === "starting" ||
														saveState.type === "rendering") &&
													saveState
												}
												keyed
											>
												{(renderState) => (
													<ActiveExport
														heading={
															renderState.type === "rendering"
																? `Rendering ${exportMediumLabel()}`
																: "Preparing export"
														}
														state={renderState}
														onCancel={handleCancel}
													/>
												)}
											</Match>
											<Match when={saveState.type === "copying"}>
												<ActiveExport heading="Saving to file" />
											</Match>
											<Match when={saveState.type === "done"}>
												<CompletedExport
													title="Export complete"
													subtitle={`Your ${exportMediumLabel()} is ready`}
												/>
											</Match>
										</Switch>
									)}
								</Match>

								<Match
									when={exportState.action === "upload" && exportState}
									keyed
								>
									{(uploadState) => (
										<Switch>
											<Match
												when={uploadState.type === "uploading" && uploadState}
												keyed
											>
												{(uploading) => (
													<ActiveExport
														heading={
															reuploading()
																? "Reuploading to your link"
																: "Uploading"
														}
														percent={uploading.progress}
													/>
												)}
											</Match>
											<Match
												when={
													(uploadState.type === "starting" ||
														uploadState.type === "rendering") &&
													uploadState
												}
												keyed
											>
												{(renderState) => (
													<ActiveExport
														heading={
															renderState.type === "rendering"
																? `Rendering ${exportMediumLabel()}`
																: "Preparing export"
														}
														state={renderState}
														onCancel={handleCancel}
													/>
												)}
											</Match>
											<Match when={uploadState.type === "done"}>
												<CompletedExport
													title={
														reuploading()
															? "Reupload complete"
															: "Upload complete"
													}
													subtitle={
														reuploading()
															? "Your latest edit is ready at the same link"
															: "Your Cap has been uploaded successfully"
													}
												/>
											</Match>
										</Switch>
									)}
								</Match>
							</Switch>

							<Show when={exportState.type === "done"}>
								<div class="flex flex-col gap-3 items-center">
									<Show
										when={
											exportState.action === "upload" && meta().sharing?.link
										}
									>
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

									<Show when={exportState.action === "save"}>
										<div class="flex gap-3">
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
															`${exportedAssetLabel()} copied to clipboard`,
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

									<Button
										variant="gray"
										class="flex gap-1.5 items-center"
										onClick={() => {
											setExportState({ type: "idle" });
											handleBack();
										}}
									>
										<IconCapMoveLeft class="size-4" />
										Back to editor
									</Button>
								</div>
							</Show>

							<Show when={exportState.type !== "done"}>
								<p class="max-w-sm text-xs leading-relaxed text-center text-ed-text-2">
									<span class="font-semibold text-ed-text-1">Tip:</span> Use
									Instant Mode for your next recording to record and upload on
									the fly, with no exporting required.
								</p>
							</Show>
						</div>
					);
				}}
			</Show>
		</div>
	);
}

function ExportSection(
	props: ParentProps<{ name: string; icon: JSX.Element; disabled?: boolean }>,
) {
	return (
		<div class="flex flex-col gap-2">
			<div
				class={cx(
					"flex items-center gap-1.5 h-[18px] text-[12px] font-medium",
					props.disabled ? "text-ed-text-3" : "text-ed-text-2",
				)}
			>
				{props.icon}
				{props.name}
			</div>
			{props.children}
		</div>
	);
}

type SegmentedOption<T> = {
	value: T;
	label: string;
	icon?: ValidComponent;
	disabled?: boolean;
	disabledReason?: string;
};

function ExportSegmented<T extends string | number>(props: {
	options: SegmentedOption<T>[];
	value: T | null;
	onChange: (value: T) => void;
	tall?: boolean;
}) {
	return (
		<div role="radiogroup" class="flex gap-0.5 p-0.5 rounded-lg bg-ed-ctl">
			<For each={props.options}>
				{(option) => {
					const selected = () => props.value === option.value;
					const button = (
						<button
							type="button"
							role="radio"
							aria-checked={selected()}
							disabled={option.disabled}
							class={cx(
								"flex flex-1 items-center justify-center gap-1.5 px-1 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent",
								props.tall ? "h-[30px]" : "h-[26px]",
								selected()
									? "bg-ed-card text-ed-text-1 shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_.5px_rgba(0,0,0,.06)] dark:bg-white/11 dark:shadow-none"
									: "text-ed-text-2 not-disabled:hover:text-ed-text-1 not-disabled:hover:bg-ed-ctl-hover",
								option.disabled && "opacity-40 cursor-not-allowed",
							)}
							onClick={() => {
								if (!option.disabled && !selected())
									props.onChange(option.value);
							}}
						>
							<Show when={option.icon}>
								{(icon) => <Dynamic component={icon()} class="size-3.5" />}
							</Show>
							{option.label}
						</button>
					);
					return option.disabledReason ? (
						<Tooltip content={option.disabledReason}>{button}</Tooltip>
					) : (
						button
					);
				}}
			</For>
		</div>
	);
}

function ExportToggleRow(props: {
	title: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<div class="flex items-center gap-3 min-h-[34px]">
			<div class="flex flex-col flex-1 min-w-0 gap-px">
				<span class="text-[12.5px] font-medium text-ed-text-1">
					{props.title}
				</span>
				<span class="text-[11px] leading-[14px] text-ed-text-3">
					{props.description}
				</span>
			</div>
			<Toggle
				size="sm"
				aria-label={props.title}
				checked={props.checked}
				onChange={props.onChange}
			/>
		</div>
	);
}

function ExportStat(props: {
	label: string;
	value?: string;
	divided?: boolean;
}) {
	return (
		<div
			class={cx(
				"flex flex-1 flex-col justify-center px-4 gap-px",
				props.divided && "border-l border-ed-line",
			)}
		>
			<span class="text-[10.5px] font-medium text-ed-text-3">
				{props.label}
			</span>
			<Show
				when={props.value}
				fallback={
					<span class="my-[3px] h-3 w-14 rounded bg-ed-ctl-active animate-pulse" />
				}
			>
				<span class="text-[12.5px] font-medium text-ed-text-1 tabular-nums whitespace-nowrap">
					{props.value}
				</span>
			</Show>
		</div>
	);
}

function ProgressRing(props: { percent?: number; indeterminate?: boolean }) {
	const pct = () => Math.max(0, Math.min(100, props.percent ?? 0));

	return (
		<div class="relative size-20">
			<svg
				class={cx("size-20 -rotate-90", props.indeterminate && "animate-spin")}
				viewBox="0 0 64 64"
				fill="none"
			>
				<circle
					cx="32"
					cy="32"
					r="28"
					stroke="currentColor"
					stroke-width="4"
					class="text-ed-ctl-active"
				/>
				<circle
					cx="32"
					cy="32"
					r="28"
					stroke="currentColor"
					stroke-width="4"
					stroke-linecap="round"
					stroke-dasharray={
						props.indeterminate ? "44 176" : `${pct() * 1.76} 176`
					}
					class="transition-all duration-300 text-ed-accent"
				/>
			</svg>
			<Show when={!props.indeterminate}>
				<div class="flex absolute inset-0 justify-center items-center">
					<span class="text-sm font-medium tabular-nums text-ed-text-1">
						{Math.round(pct())}%
					</span>
				</div>
			</Show>
		</div>
	);
}

function ActiveExport(props: {
	heading: string;
	state?: RenderState;
	percent?: number;
	onCancel?: () => void;
}) {
	const frames = () =>
		props.state?.type === "rendering" ? props.state.progress : null;

	const percent = () => {
		const rendered = frames();
		if (rendered) return (rendered.renderedCount / rendered.totalFrames) * 100;
		return props.percent;
	};

	return (
		<div class="flex flex-col gap-5 items-center w-72 text-center">
			<ProgressRing
				percent={percent()}
				indeterminate={percent() === undefined}
			/>
			<div class="flex flex-col gap-1 items-center">
				<h2 class="text-base font-medium text-ed-text-1">{props.heading}</h2>
				<Show when={frames()}>
					{(rendered) => (
						<p class="text-[12px] tabular-nums text-ed-text-2">
							{rendered().renderedCount.toLocaleString()} /{" "}
							{rendered().totalFrames.toLocaleString()} frames
						</p>
					)}
				</Show>
			</div>
			<Show when={props.onCancel}>
				<Button variant="gray" size="sm" onClick={() => props.onCancel?.()}>
					Cancel
				</Button>
			</Show>
		</div>
	);
}

function CompletedExport(props: { title: string; subtitle: string }) {
	return (
		<div class="flex flex-col gap-4 items-center text-center">
			<div class="flex justify-center items-center rounded-full size-16 bg-ed-accent/12">
				<IconLucideCheck class="size-8 text-ed-accent" />
			</div>
			<div class="flex flex-col gap-1 items-center">
				<h2 class="text-base font-medium text-ed-text-1">{props.title}</h2>
				<p class="text-[12px] text-ed-text-2">{props.subtitle}</p>
			</div>
		</div>
	);
}
