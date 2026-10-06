import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import Tooltip from "~/components/Tooltip";
import {
	CAPTION_STYLE_PRESETS,
	type CaptionAnimation,
	type CaptionHighlightStyle,
	type CaptionStylePreset,
	defaultCaptionSettings,
	type EditorCaptionSettings,
} from "~/store/captions";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import { commands, events } from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCircleCheck from "~icons/cap/circle-check";
import IconLucideDownload from "~icons/lucide/download";
import IconLucideInfo from "~icons/lucide/info";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import {
	applyCaptionResultToProject,
	CAPTION_MODEL_FOLDER,
	DEFAULT_CAPTION_MODEL,
	DEFAULT_WHISPER_CAPTION_MODEL,
	getCaptionGenerationErrorMessage,
	getModelPath,
	mapEditedTimeToSource,
	PARAKEET_DIR_MODELS,
	resolveCaptionModel,
	sourceCaptionId,
	supportsParakeetTranscription,
	syncCaptionWordsWithText,
	transcribeEditorCaptions,
} from "./captions";
import { useEditorContext } from "./context";
import {
	CAPTION_ANIMATION_OPTIONS,
	CAPTION_HIGHLIGHT_STYLE_OPTIONS,
	CAPTION_POSITION_OPTIONS,
	FONT_OPTIONS,
	getTextWeightLabel,
	HexColorInput,
	TEXT_WEIGHT_OPTIONS,
} from "./text-style";
import {
	EditorButton,
	Field,
	Input,
	MenuItem,
	MenuItemList,
	PopperContent,
	Section,
	SectionLabel,
	Slider,
	Subfield,
	topLeftAnimateClasses,
	topSlideAnimateClasses,
} from "./ui";

const selectTriggerClass =
	"flex flex-row gap-1.5 items-center px-2 h-7 max-w-full rounded-[7px] text-[13px] transition-colors outline-hidden bg-ed-ctl text-ed-text-1 hover:bg-ed-ctl-hover focus-visible:ring-1 focus-visible:ring-ed-accent disabled:text-ed-text-3";

interface ModelOption {
	name: string;
	label: string;
	modelName: string;
	size: string;
	description: string;
}

interface LanguageOption {
	code: string;
	label: string;
}

const MODEL_DOWNLOAD_STATUS_POLL_MS = 1000;

const MODEL_OPTIONS: ModelOption[] = [
	{
		name: "best",
		label: "Recommended",
		modelName: "parakeet-tdt-0.6b-v3 int8",
		size: "~640MB",
		description: "Best balance for most recordings",
	},
	{
		name: "best-max",
		label: "High Accuracy",
		modelName: "parakeet-tdt-0.6b-v3",
		size: "~2.4GB",
		description: "Larger download, higher accuracy",
	},
	{
		name: "small",
		modelName: "whisper.cpp small",
		label: "Small",
		size: "466MB",
		description: "Smallest download",
	},
	{
		name: "medium",
		modelName: "whisper.cpp medium",
		label: "Medium",
		size: "1.5GB",
		description: "Slower, more accurate",
	},
];

const LANGUAGE_OPTIONS: LanguageOption[] = [
	{ code: "auto", label: "Auto Detect" },
	{ code: "en", label: "English" },
	{ code: "es", label: "Spanish" },
	{ code: "fr", label: "French" },
	{ code: "de", label: "German" },
	{ code: "it", label: "Italian" },
	{ code: "pt", label: "Portuguese" },
	{ code: "nl", label: "Dutch" },
	{ code: "pl", label: "Polish" },
	{ code: "ru", label: "Russian" },
	{ code: "sk", label: "Slovak" },
	{ code: "tr", label: "Turkish" },
	{ code: "ja", label: "Japanese" },
	{ code: "ko", label: "Korean" },
	{ code: "zh", label: "Chinese" },
	{ code: "ar", label: "Arabic" },
	{ code: "hi", label: "Hindi" },
	{ code: "bn", label: "Bengali" },
	{ code: "ta", label: "Tamil" },
	{ code: "te", label: "Telugu" },
	{ code: "mr", label: "Marathi" },
	{ code: "gu", label: "Gujarati" },
	{ code: "pa", label: "Punjabi" },
	{ code: "ur", label: "Urdu" },
	{ code: "fa", label: "Persian" },
	{ code: "he", label: "Hebrew" },
	{ code: "ar", label: "Arabic" },
	{ code: "hi", label: "Hindi" },
	{ code: "bn", label: "Bengali" },
	{ code: "ta", label: "Tamil" },
];

const STYLE_PRESET_KEYS = new Set<keyof EditorCaptionSettings>([
	"font",
	"fontWeight",
	"size",
	"color",
	"backgroundColor",
	"backgroundOpacity",
	"outline",
	"outlineColor",
	"highlightColor",
	"activeWordHighlight",
	"highlightStyle",
	"animation",
	"uppercase",
	"fadeDuration",
]);

function hexToRgba(hex: string, opacityPercent: number) {
	const value = hex.replace("#", "");
	const alpha = Math.min(Math.max(opacityPercent / 100, 0), 1);
	if (value.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clampDownloadProgress(progress: number) {
	return Math.min(Math.max(progress, 0), 100);
}

function CaptionPresetPreview(props: { preset: CaptionStylePreset }) {
	const style = () => props.preset.style;
	const words = ["Make", "it", "pop"];
	const emphasizeIndex = 2;

	const textShadow = () => {
		const outlineColor = style().outlineColor;
		return style().outline
			? `-1px -1px 0 ${outlineColor}, 1px -1px 0 ${outlineColor}, -1px 1px 0 ${outlineColor}, 1px 1px 0 ${outlineColor}`
			: "0 1px 2px rgba(0, 0, 0, 0.55)";
	};

	return (
		<div
			class="flex h-12 items-center justify-center overflow-hidden rounded-md"
			style={{ background: "linear-gradient(135deg, #4b4f57, #232427)" }}
		>
			<div
				class="flex items-center gap-1 rounded px-2 py-1"
				style={{
					background:
						style().backgroundOpacity > 0
							? hexToRgba(style().backgroundColor, style().backgroundOpacity)
							: "transparent",
				}}
			>
				<For each={words}>
					{(word, index) => {
						const isEmphasized = () =>
							style().activeWordHighlight && index() === emphasizeIndex;
						const usePill = () =>
							isEmphasized() && style().highlightStyle === "pill";
						const useColor = () =>
							isEmphasized() && style().highlightStyle === "color";
						return (
							<span
								style={{
									"font-weight": `${style().fontWeight}`,
									"font-size": "11px",
									"line-height": "1.4",
									"text-transform": style().uppercase ? "uppercase" : "none",
									color: useColor() ? style().highlightColor : style().color,
									"text-shadow": textShadow(),
									background: usePill()
										? style().highlightColor
										: "transparent",
									"border-radius": usePill() ? "4px" : undefined,
									padding: usePill() ? "0 4px" : undefined,
								}}
							>
								{word}
							</span>
						);
					}}
				</For>
			</div>
		</div>
	);
}

export function CaptionsTab(props: {
	brandColorSwatches: OrganizationBrandColorSwatch[];
}) {
	const { project, setProject, editorInstance, editorState, setEditorState } =
		useEditorContext();

	const selectedCaptionIndex = () =>
		editorState.timeline.selection?.type === "caption" &&
		editorState.timeline.selection.indices.length === 1
			? editorState.timeline.selection.indices[0]
			: -1;

	const selectedCaptionSegment = () =>
		project.timeline?.captionSegments?.[selectedCaptionIndex()];

	const updateSelectedCaption = (
		update: (
			segment: NonNullable<ReturnType<typeof selectedCaptionSegment>>,
		) => void,
	) => {
		const index = selectedCaptionIndex();
		if (index < 0) return;

		setProject(
			produce((currentProject: typeof project) => {
				const timeline = currentProject.timeline;
				const timelineSegment = timeline?.captionSegments?.[index];
				if (!timeline || !timelineSegment) return;

				// Apply the edit to the rendered (output-time) segment so style
				// overrides take effect immediately and survive re-derivation.
				update(timelineSegment);

				// Route content/timing onto the source-time caption master so the
				// edit persists across future clip changes. Style overrides stay on
				// the track and are carried across by source id when re-derived.
				const sourceId = sourceCaptionId(timelineSegment.id);
				const source = currentProject.captions?.segments?.find(
					(segment) => segment.id === sourceId,
				);
				if (!source) return;

				const recordingSegments = editorInstance.recordings.segments;
				const sourceRange = { start: source.start, end: source.end };
				const start = mapEditedTimeToSource(
					timelineSegment.start,
					timeline.segments,
					recordingSegments,
					timeline.transitions ?? [],
					sourceRange,
					"outgoing",
					timeline.textSegments,
				);
				const end = mapEditedTimeToSource(
					timelineSegment.end,
					timeline.segments,
					recordingSegments,
					timeline.transitions ?? [],
					sourceRange,
					"outgoing",
					timeline.textSegments,
				);
				if (start !== null) source.start = start;
				if (end !== null) source.end = end;
				source.text = timelineSegment.text;
				source.words = syncCaptionWordsWithText(
					source.text,
					source.words,
					source.start,
					source.end,
				);
			}),
		);
	};

	const getSetting = <K extends keyof EditorCaptionSettings>(
		key: K,
	): NonNullable<EditorCaptionSettings[K]> =>
		(project?.captions?.settings?.[key] ??
			defaultCaptionSettings[key]) as NonNullable<EditorCaptionSettings[K]>;

	const updateCaptionSetting = <K extends keyof EditorCaptionSettings>(
		key: K,
		value: EditorCaptionSettings[K],
	) => {
		if (!project?.captions) return;

		setProject(
			"captions",
			"settings",
			produce((settings) => {
				settings[key] = value;
				if (STYLE_PRESET_KEYS.has(key)) {
					settings.preset = "custom";
				}
			}),
		);
	};

	const selectedPresetId = () => getSetting("preset");

	const applyCaptionPreset = (preset: CaptionStylePreset) => {
		if (!project?.captions) return;

		setProject(
			"captions",
			"settings",
			produce((settings) => {
				Object.assign(settings, preset.style);
				settings.preset = preset.id;
			}),
		);
	};

	const captionPositionCenter = (position: string) => {
		switch (position) {
			case "top-left":
				return { x: 0.05, y: 0.08 };
			case "top-center":
			case "top":
				return { x: 0.5, y: 0.08 };
			case "top-right":
				return { x: 0.95, y: 0.08 };
			case "bottom-left":
				return { x: 0.05, y: 0.85 };
			case "bottom-right":
				return { x: 0.95, y: 0.85 };
			default:
				return { x: 0.5, y: 0.85 };
		}
	};

	const updateCaptionPosition = (position: string) => {
		if (!project?.captions) return;

		const previousPosition = getSetting("position");
		setProject(
			"captions",
			"settings",
			produce((settings) => {
				settings.position = position;
				if (position === "manual" && !settings.manualPosition) {
					settings.manualPosition = captionPositionCenter(previousPosition);
				}
			}),
		);
	};

	const [selectedModel, setSelectedModel] = createSignal(
		resolveCaptionModel(DEFAULT_CAPTION_MODEL),
	);
	const [selectedLanguage, setSelectedLanguage] = createSignal("auto");
	const [downloadedModels, setDownloadedModels] = createSignal<string[]>([]);
	const [deletingModel, setDeletingModel] = createSignal<string | null>(null);
	const [downloadMessage, setDownloadMessage] = createSignal("");
	let downloadStatusPoll: ReturnType<typeof setInterval> | undefined;
	let unlistenDownloadProgress: (() => void) | undefined;

	const isDownloading = () => editorState.captions.isDownloading;
	const setIsDownloading = (value: boolean) =>
		setEditorState("captions", "isDownloading", value);
	const downloadProgress = () => editorState.captions.downloadProgress;
	const setDownloadProgress = (value: number) =>
		setEditorState("captions", "downloadProgress", value);
	const downloadPercent = createMemo(() =>
		Math.round(clampDownloadProgress(downloadProgress())),
	);
	const downloadingModel = () => editorState.captions.downloadingModel;
	const setDownloadingModel = (value: string | null) =>
		setEditorState("captions", "downloadingModel", value);
	const isGenerating = () => editorState.captions.isGenerating;
	const setIsGenerating = (value: boolean) =>
		setEditorState("captions", "isGenerating", value);
	const [hasAudio, setHasAudio] = createSignal(false);
	const availableModelOptions = createMemo(() =>
		supportsParakeetTranscription()
			? MODEL_OPTIONS
			: MODEL_OPTIONS.filter((model) => !PARAKEET_DIR_MODELS.has(model.name)),
	);
	const selectedModelOption = createMemo(
		() =>
			availableModelOptions().find((model) => model.name === selectedModel()) ??
			null,
	);
	const downloadingModelOption = createMemo(
		() =>
			availableModelOptions().find(
				(model) => model.name === downloadingModel(),
			) ?? selectedModelOption(),
	);

	createEffect(
		on(
			() => project && editorInstance && !project.captions,
			(shouldInit) => {
				if (shouldInit) {
					setProject("captions", {
						segments: [],
						settings: { ...defaultCaptionSettings },
						sourceTimed: true,
					});
				}
			},
		),
	);

	const getModelDownloadTargetPath = async (modelName: string) => {
		if (PARAKEET_DIR_MODELS.has(modelName))
			return await getModelPath(modelName);

		const appDataDirPath = await appLocalDataDir();
		const modelsPath = await join(appDataDirPath, CAPTION_MODEL_FOLDER);
		return await join(modelsPath, `${modelName}.bin`);
	};

	const checkModelExists = async (modelName: string) => {
		if (PARAKEET_DIR_MODELS.has(modelName)) {
			const modelPath = await getModelDownloadTargetPath(modelName);
			return await commands.checkParakeetModelExists(modelPath);
		}
		const modelPath = await getModelDownloadTargetPath(modelName);
		return await commands.checkModelExists(modelPath);
	};

	const getModelDownloadStatus = async (modelName: string) => {
		const targetPath = await getModelDownloadTargetPath(modelName);
		return await commands.getModelDownloadStatus(targetPath);
	};

	const addDownloadedModel = (modelName: string) => {
		setDownloadedModels((prev) =>
			prev.includes(modelName) ? prev : [...prev, modelName],
		);
	};

	const removeDownloadedModel = (modelName: string) => {
		setDownloadedModels((prev) => prev.filter((name) => name !== modelName));
	};

	const refreshDownloadedModels = async () => {
		const models = await Promise.all(
			availableModelOptions().map(async (model) => {
				const downloaded = await checkModelExists(model.name);
				return { name: model.name, downloaded };
			}),
		);

		setDownloadedModels(
			models.filter((model) => model.downloaded).map((model) => model.name),
		);
	};

	const stopDownloadStatusPolling = () => {
		if (!downloadStatusPoll) return;
		clearInterval(downloadStatusPoll);
		downloadStatusPoll = undefined;
	};

	const syncModelDownloadStatus = async (modelName: string) => {
		const status = await getModelDownloadStatus(modelName);
		if (!status) return false;

		const progress = clampDownloadProgress(status.progress);
		setDownloadMessage(status.message);

		if (status.state === "downloading") {
			setDownloadingModel(modelName);
			setDownloadProgress(progress);
			setIsDownloading(true);
			return true;
		}

		if (status.state === "completed") {
			addDownloadedModel(modelName);
			setDownloadProgress(100);
			setIsDownloading(false);
			setDownloadingModel(null);
			setDownloadMessage("");
			return false;
		}

		setDownloadProgress(0);
		setIsDownloading(false);
		setDownloadingModel(null);
		return false;
	};

	const syncAnyActiveDownloadStatus = async () => {
		for (const model of availableModelOptions()) {
			const active = await syncModelDownloadStatus(model.name);
			if (active) return true;
		}

		return false;
	};

	const pollDownloadStatus = async () => {
		const model = downloadingModel();
		const active = model
			? await syncModelDownloadStatus(model)
			: await syncAnyActiveDownloadStatus();

		if (!active) {
			stopDownloadStatusPolling();
			await refreshDownloadedModels();
		}
	};

	const startDownloadStatusPolling = () => {
		if (downloadStatusPoll) return;
		downloadStatusPoll = setInterval(() => {
			void pollDownloadStatus();
		}, MODEL_DOWNLOAD_STATUS_POLL_MS);
	};

	onMount(async () => {
		try {
			unlistenDownloadProgress = await events.downloadProgress.listen(
				(event) => {
					if (!downloadingModel()) return;
					setDownloadProgress(clampDownloadProgress(event.payload.progress));
					setDownloadMessage(event.payload.message);
				},
			);

			const appDataDirPath = await appLocalDataDir();
			const modelsPath = await join(appDataDirPath, CAPTION_MODEL_FOLDER);

			if (!(await exists(modelsPath))) {
				await commands.createDir(modelsPath, true);
			}

			await refreshDownloadedModels();

			const savedModel = resolveCaptionModel(
				localStorage.getItem("selectedTranscriptionModel"),
			);
			if (
				savedModel &&
				availableModelOptions().some((model) => model.name === savedModel)
			) {
				setSelectedModel(savedModel);
			} else {
				setSelectedModel(
					availableModelOptions()[0]?.name ?? DEFAULT_WHISPER_CAPTION_MODEL,
				);
			}

			const savedLanguage = localStorage.getItem(
				"selectedTranscriptionLanguage",
			);
			if (
				savedLanguage &&
				LANGUAGE_OPTIONS.some((l) => l.code === savedLanguage)
			) {
				setSelectedLanguage(savedLanguage);
			}

			if (editorInstance?.recordings) {
				const hasAudioTrack = editorInstance.recordings.segments.some(
					(segment) => segment.mic !== null || segment.system_audio !== null,
				);
				setHasAudio(hasAudioTrack);
			}

			localStorage.removeItem("modelDownloadState");

			if (await syncAnyActiveDownloadStatus()) {
				startDownloadStatusPolling();
			}
		} catch (error) {
			console.error("Error checking models:", error);
		}
	});

	onCleanup(() => {
		if (unlistenDownloadProgress) unlistenDownloadProgress();
		stopDownloadStatusPolling();
	});

	createEffect(
		on(
			selectedModel,
			(model) => {
				if (model) localStorage.setItem("selectedTranscriptionModel", model);
			},
			{ defer: true },
		),
	);

	createEffect(
		on(
			selectedLanguage,
			(language) => {
				if (language)
					localStorage.setItem("selectedTranscriptionLanguage", language);
			},
			{ defer: true },
		),
	);

	const downloadModel = async () => {
		const modelToDownload = selectedModel();
		try {
			setIsDownloading(true);
			setDownloadProgress(0);
			setDownloadingModel(modelToDownload);
			setDownloadMessage("Preparing model download");
			startDownloadStatusPolling();

			if (PARAKEET_DIR_MODELS.has(modelToDownload)) {
				const modelDir = await getModelDownloadTargetPath(modelToDownload);
				try {
					await commands.createDir(modelDir, true);
				} catch (err) {
					console.error("Error creating directory:", err);
				}
				await commands.downloadParakeetModel(modelDir);
			} else {
				const appDataDirPath = await appLocalDataDir();
				const modelsPath = await join(appDataDirPath, CAPTION_MODEL_FOLDER);
				const modelPath = await getModelDownloadTargetPath(modelToDownload);

				try {
					await commands.createDir(modelsPath, true);
				} catch (err) {
					console.error("Error creating directory:", err);
				}
				await commands.downloadWhisperModel(modelToDownload, modelPath);
			}

			await syncModelDownloadStatus(modelToDownload);
			addDownloadedModel(modelToDownload);
			toast.success("Caption model downloaded");
		} catch (error) {
			console.error("Error downloading model:", error);
			const active = await syncModelDownloadStatus(modelToDownload).catch(
				() => false,
			);
			if (!active) {
				toast.error("Failed to download caption model");
				setDownloadProgress(0);
				setIsDownloading(false);
				setDownloadingModel(null);
			}
		} finally {
			void pollDownloadStatus();
		}
	};

	const deleteModel = async () => {
		const modelToDelete = selectedModel();
		setDeletingModel(modelToDelete);

		try {
			const modelPath = await getModelDownloadTargetPath(modelToDelete);
			if (PARAKEET_DIR_MODELS.has(modelToDelete)) {
				await commands.deleteParakeetModel(modelPath);
			} else {
				await commands.deleteWhisperModel(modelPath);
			}

			removeDownloadedModel(modelToDelete);
			toast.success("Caption model deleted");
		} catch (error) {
			console.error("Error deleting model:", error);
			toast.error("Failed to delete caption model");
			await refreshDownloadedModels();
		} finally {
			setDeletingModel(null);
		}
	};

	const generateCaptions = async () => {
		if (!editorInstance) {
			toast.error("Editor instance not found");
			return;
		}

		setIsGenerating(true);

		try {
			const result = await transcribeEditorCaptions(
				editorInstance.path,
				selectedModel(),
				selectedLanguage(),
			);

			if (result && result.segments.length > 0) {
				setProject(
					produce((p) => {
						applyCaptionResultToProject(
							p,
							result.segments,
							editorInstance.recordings.segments,
							editorInstance.recordingDuration,
						);
					}),
				);
				setEditorState("timeline", "tracks", "caption", true);
				setEditorState("captions", "isStale", false);

				toast.success("Captions generated successfully!");
			} else {
				toast.error(
					"No captions were generated. The audio might be too quiet or unclear.",
				);
			}
		} catch (error) {
			console.error("Error generating captions:", error);
			const errorMessage = getCaptionGenerationErrorMessage(error);
			toast.error(`Failed to generate captions: ${errorMessage}`);
		} finally {
			setIsGenerating(false);
		}
	};

	const hasCaptions = createMemo(
		() =>
			(project.timeline?.captionSegments?.length ?? 0) > 0 ||
			(project.captions?.segments?.length ?? 0) > 0,
	);

	return (
		<div class="flex flex-col gap-3.5">
			<div class="flex flex-row gap-2 items-center min-h-[22px]">
				<SectionLabel name="Captions" />
				<span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-ed-ctl text-ed-text-2">
					Beta
				</span>
			</div>

			<div class="flex flex-col gap-2">
				<Field name="Model">
					<KSelect<string>
						options={availableModelOptions().map((model) => model.name)}
						value={selectedModel()}
						onChange={(value: string | null) => {
							if (value) setSelectedModel(value);
						}}
						itemComponent={(props) => {
							const model = availableModelOptions().find(
								(option) => option.name === props.item.rawValue,
							);

							return (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={props.item}
								>
									<div class="flex gap-3 items-center w-full">
										<div class="flex-1 min-w-0">
											<div class="flex gap-1.5 items-center text-ed-text-1">
												<KSelect.ItemLabel class="font-medium truncate">
													{model?.label ?? props.item.rawValue}
												</KSelect.ItemLabel>
												<Show when={model}>
													<Tooltip openDelay={0} content={model?.modelName}>
														<button
															type="button"
															class="flex shrink-0 transition-colors text-ed-text-3 hover:text-ed-text-1"
															onPointerDown={(event) => event.stopPropagation()}
															onClick={(event) => event.stopPropagation()}
														>
															<IconLucideInfo class="size-3.5" />
														</button>
													</Tooltip>
												</Show>
											</div>
											<Show when={model}>
												<div class="text-[11px] truncate text-ed-text-2">
													{model?.description}
												</div>
											</Show>
										</div>
										<Show when={model}>
											<span class="shrink-0 text-[10px] text-ed-text-3">
												{model?.size}
											</span>
										</Show>
									</div>
								</MenuItem>
							);
						}}
					>
						<KSelect.Trigger class="flex flex-row gap-2 items-center px-2.5 py-1.5 w-full min-w-0 rounded-lg transition-colors outline-hidden bg-ed-ctl text-ed-text-1 hover:bg-ed-ctl-hover focus-visible:ring-1 focus-visible:ring-ed-accent">
							<div class="flex-1 min-w-0 text-left">
								<div class="flex gap-1.5 items-center">
									<span class="text-[13px] font-medium truncate">
										{selectedModelOption()?.label || "Select a model"}
									</span>
									<Show when={selectedModelOption()}>
										<Tooltip
											openDelay={0}
											content={selectedModelOption()?.modelName}
										>
											<button
												type="button"
												class="flex shrink-0 transition-colors text-ed-text-3 hover:text-ed-text-1"
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => event.stopPropagation()}
											>
												<IconLucideInfo class="size-3.5" />
											</button>
										</Tooltip>
									</Show>
								</div>
								<Show when={selectedModelOption()}>
									<div class="text-[11px] truncate text-ed-text-2">
										{selectedModelOption()?.description}
									</div>
								</Show>
							</div>
							<Show when={selectedModelOption()}>
								<span class="shrink-0 text-[10px] text-ed-text-3">
									{selectedModelOption()?.size}
								</span>
							</Show>
							<KSelect.Icon>
								<IconCapChevronDown class="shrink-0 size-3.5 transition-transform transform text-ed-text-3 data-expanded:rotate-180" />
							</KSelect.Icon>
						</KSelect.Trigger>
						<KSelect.Portal>
							<PopperContent<typeof KSelect.Content>
								as={KSelect.Content}
								class={topLeftAnimateClasses}
							>
								<MenuItemList<typeof KSelect.Listbox> as={KSelect.Listbox} />
							</PopperContent>
						</KSelect.Portal>
					</KSelect>
				</Field>

				<Show when={!supportsParakeetTranscription()}>
					<p class="text-[11px] leading-relaxed text-ed-text-3">
						Parakeet caption models are unavailable on Intel Macs. Whisper
						models remain available.
					</p>
				</Show>

				<p class="text-[11px] leading-relaxed text-ed-text-3">
					One time download to your system. All captions are stored locally.
				</p>

				<Field name="Language" inline>
					<KSelect<string>
						options={LANGUAGE_OPTIONS.map((l) => l.code)}
						value={selectedLanguage()}
						onChange={(value: string | null) => {
							if (value) setSelectedLanguage(value);
						}}
						itemComponent={(props) => (
							<MenuItem<typeof KSelect.Item>
								as={KSelect.Item}
								item={props.item}
							>
								<KSelect.ItemLabel class="flex-1">
									{
										LANGUAGE_OPTIONS.find((l) => l.code === props.item.rawValue)
											?.label
									}
								</KSelect.ItemLabel>
							</MenuItem>
						)}
					>
						<KSelect.Trigger class={selectTriggerClass}>
							<KSelect.Value<string> class="truncate">
								{(state) => {
									const language = LANGUAGE_OPTIONS.find(
										(l) => l.code === state.selectedOption(),
									);
									return <span>{language?.label || "Select a language"}</span>;
								}}
							</KSelect.Value>
							<KSelect.Icon>
								<IconCapChevronDown class="shrink-0 size-3.5 transition-transform transform text-ed-text-3 data-expanded:rotate-180" />
							</KSelect.Icon>
						</KSelect.Trigger>
						<KSelect.Portal>
							<PopperContent<typeof KSelect.Content>
								as={KSelect.Content}
								class={topLeftAnimateClasses}
							>
								<MenuItemList<typeof KSelect.Listbox>
									class="overflow-y-auto max-h-48"
									as={KSelect.Listbox}
								/>
							</PopperContent>
						</KSelect.Portal>
					</KSelect>
				</Field>

				<Show
					when={downloadedModels().includes(selectedModel())}
					fallback={
						<div class="flex flex-col gap-2">
							<Button
								class="flex gap-2 justify-center items-center w-full"
								onClick={downloadModel}
								disabled={isDownloading()}
							>
								<Show
									when={isDownloading()}
									fallback={
										<>
											<IconLucideDownload class="size-4" />
											Download{" "}
											{
												availableModelOptions().find(
													(m) => m.name === selectedModel(),
												)?.label
											}{" "}
											Model
										</>
									}
								>
									{`Downloading ${
										downloadingModelOption()?.label ?? "model"
									}... ${downloadPercent()}%`}
								</Show>
							</Button>
							<Show when={isDownloading()}>
								<div class="flex flex-col gap-1.5">
									<div
										class="overflow-hidden w-full h-1.5 rounded-full bg-ed-ctl"
										role="progressbar"
										aria-valuemin="0"
										aria-valuemax="100"
										aria-valuenow={downloadPercent()}
									>
										<div
											class="h-1.5 rounded-full transition-all duration-300 bg-ed-accent"
											style={{
												width: `${clampDownloadProgress(downloadProgress())}%`,
											}}
										/>
									</div>
									<p class="text-[11px] leading-relaxed text-ed-text-3">
										{downloadMessage() ||
											"Keep Cap open while the model downloads. Editor reloads will reconnect automatically."}
									</p>
								</div>
							</Show>
						</div>
					}
				>
					<div class="flex flex-col gap-2">
						<Show when={hasAudio()}>
							<Button
								onClick={generateCaptions}
								disabled={isGenerating() || deletingModel() !== null}
								class="w-full"
							>
								{isGenerating()
									? "Generating..."
									: hasCaptions()
										? "Regenerate Captions"
										: "Generate Captions"}
							</Button>
						</Show>
						<div class="flex gap-2 justify-between items-center text-[11px] text-ed-text-3">
							<span class="flex gap-1.5 items-center min-w-0">
								<IconCapCircleCheck class="shrink-0 size-3.5 text-ed-text-3" />
								<span class="truncate">
									{selectedModelOption()?.label ?? "Caption"} model downloaded
								</span>
							</span>
							<EditorButton
								size="sm"
								leftIcon={<IconLucideTrash2 />}
								onClick={deleteModel}
								disabled={
									isGenerating() ||
									isDownloading() ||
									deletingModel() === selectedModel()
								}
							>
								{deletingModel() === selectedModel() ? "Deleting..." : "Delete"}
							</EditorButton>
						</div>
					</div>
				</Show>
			</div>

			<div class="w-full border-t border-ed-line" />

			<div
				class={cx(
					"flex flex-col gap-3.5",
					!hasCaptions() && "opacity-50 pointer-events-none",
				)}
			>
				<Section name="Style">
					<div class="grid grid-cols-2 gap-2">
						<For each={CAPTION_STYLE_PRESETS}>
							{(preset) => (
								<button
									type="button"
									title={preset.description}
									onClick={() => applyCaptionPreset(preset)}
									disabled={!hasCaptions()}
									class={cx(
										"flex flex-col gap-1.5 p-1.5 text-left rounded-lg transition-shadow",
										selectedPresetId() === preset.id
											? "ring-2 ring-ed-accent ring-offset-2 ring-offset-ed-card"
											: "ring-1 ring-ed-line hover:ring-ed-line-strong",
									)}
								>
									<CaptionPresetPreview preset={preset} />
									<span class="px-0.5 text-[11px] font-medium text-ed-text-1">
										{preset.label}
									</span>
								</button>
							)}
						</For>
						<Show when={selectedPresetId() === "custom"}>
							<div class="flex flex-col gap-1.5 p-1.5 text-left rounded-lg ring-2 ring-ed-accent ring-offset-2 ring-offset-ed-card">
								<div class="flex justify-center items-center h-12 text-[11px] rounded-md bg-ed-card-2 text-ed-text-3">
									Custom
								</div>
								<span class="px-0.5 text-[11px] font-medium text-ed-text-1">
									Custom
								</span>
							</div>
						</Show>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<Section name="Font settings">
					<div class="flex flex-col gap-2">
						<Field name="Font Family" inline>
							<KSelect<string>
								options={FONT_OPTIONS.map((f) => f.value)}
								value={getSetting("font")}
								onChange={(value) => {
									if (value === null) return;
									updateCaptionSetting("font", value);
								}}
								disabled={!hasCaptions()}
								itemComponent={(props) => (
									<MenuItem<typeof KSelect.Item>
										as={KSelect.Item}
										item={props.item}
									>
										<KSelect.ItemLabel class="flex-1">
											{
												FONT_OPTIONS.find(
													(f) => f.value === props.item.rawValue,
												)?.label
											}
										</KSelect.ItemLabel>
									</MenuItem>
								)}
							>
								<KSelect.Trigger class={selectTriggerClass}>
									<KSelect.Value<string> class="truncate">
										{(state) =>
											FONT_OPTIONS.find(
												(f) => f.value === state.selectedOption(),
											)?.label
										}
									</KSelect.Value>
									<KSelect.Icon>
										<IconCapChevronDown class="shrink-0 size-3.5 text-ed-text-3" />
									</KSelect.Icon>
								</KSelect.Trigger>
								<KSelect.Portal>
									<PopperContent<typeof KSelect.Content>
										as={KSelect.Content}
										class={topLeftAnimateClasses}
									>
										<MenuItemList<typeof KSelect.Listbox>
											class="overflow-y-auto max-h-48"
											as={KSelect.Listbox}
										/>
									</PopperContent>
								</KSelect.Portal>
							</KSelect>
						</Field>

						<Field name="Size" inline>
							<Slider
								value={[getSetting("size")]}
								onChange={(v) => updateCaptionSetting("size", v[0])}
								minValue={12}
								maxValue={100}
								step={1}
								disabled={!hasCaptions()}
							/>
						</Field>

						<Field name="Uppercase" inline>
							<Toggle
								checked={getSetting("uppercase")}
								onChange={(checked) =>
									updateCaptionSetting("uppercase", checked)
								}
								disabled={!hasCaptions()}
							/>
						</Field>

						<Field name="Active Word Highlight" inline>
							<Toggle
								checked={getSetting("activeWordHighlight")}
								onChange={(checked) =>
									updateCaptionSetting("activeWordHighlight", checked)
								}
								disabled={!hasCaptions()}
							/>
						</Field>
						<p class="text-[11px] leading-relaxed text-ed-text-3">
							This is the first version of captions in Cap. Active word
							highlighting may be inaccurate in some situations. We're working
							on a fix for this and it will be released in upcoming versions.
						</p>

						<Show when={getSetting("activeWordHighlight")}>
							<Field name="Highlight Style" inline>
								<KSelect<string>
									options={CAPTION_HIGHLIGHT_STYLE_OPTIONS.map((o) => o.value)}
									value={getSetting("highlightStyle")}
									onChange={(value) => {
										if (value === null) return;
										updateCaptionSetting(
											"highlightStyle",
											value as CaptionHighlightStyle,
										);
									}}
									disabled={!hasCaptions()}
									itemComponent={(itemProps) => (
										<MenuItem<typeof KSelect.Item>
											as={KSelect.Item}
											item={itemProps.item}
										>
											<KSelect.ItemLabel class="flex-1">
												{
													CAPTION_HIGHLIGHT_STYLE_OPTIONS.find(
														(o) => o.value === itemProps.item.rawValue,
													)?.label
												}
											</KSelect.ItemLabel>
										</MenuItem>
									)}
								>
									<KSelect.Trigger class={selectTriggerClass}>
										<KSelect.Value<string> class="truncate">
											{(state) =>
												CAPTION_HIGHLIGHT_STYLE_OPTIONS.find(
													(o) => o.value === state.selectedOption(),
												)?.label
											}
										</KSelect.Value>
										<KSelect.Icon>
											<IconCapChevronDown class="shrink-0 size-3.5 text-ed-text-3" />
										</KSelect.Icon>
									</KSelect.Trigger>
									<KSelect.Portal>
										<PopperContent<typeof KSelect.Content>
											as={KSelect.Content}
											class={topLeftAnimateClasses}
										>
											<MenuItemList<typeof KSelect.Listbox>
												as={KSelect.Listbox}
											/>
										</PopperContent>
									</KSelect.Portal>
								</KSelect>
							</Field>
						</Show>

						<Field name="Text Color">
							<HexColorInput
								value={getSetting("color")}
								brandColorSwatches={props.brandColorSwatches}
								onChange={(value) => updateCaptionSetting("color", value)}
							/>
						</Field>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<Section name="Background settings">
					<div class="flex flex-col gap-2">
						<Field name="Background Color">
							<HexColorInput
								value={getSetting("backgroundColor")}
								brandColorSwatches={props.brandColorSwatches}
								onChange={(value) =>
									updateCaptionSetting("backgroundColor", value)
								}
							/>
						</Field>

						<Field name="Background Opacity" inline>
							<Slider
								value={[getSetting("backgroundOpacity")]}
								onChange={(v) =>
									updateCaptionSetting("backgroundOpacity", v[0])
								}
								minValue={0}
								maxValue={100}
								step={1}
								disabled={!hasCaptions()}
							/>
						</Field>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<div class="flex flex-col gap-2">
					<Field name="Position" inline>
						<KSelect<string>
							options={CAPTION_POSITION_OPTIONS.map((p) => p.value)}
							value={getSetting("position")}
							onChange={(value) => {
								if (value === null) return;
								updateCaptionPosition(value);
							}}
							disabled={!hasCaptions()}
							itemComponent={(props) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={props.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{
											CAPTION_POSITION_OPTIONS.find(
												(p) => p.value === props.item.rawValue,
											)?.label
										}
									</KSelect.ItemLabel>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class={selectTriggerClass}>
								<KSelect.Value<string> class="truncate">
									{(state) => (
										<span>
											{
												CAPTION_POSITION_OPTIONS.find(
													(p) => p.value === state.selectedOption(),
												)?.label
											}
										</span>
									)}
								</KSelect.Value>
								<KSelect.Icon>
									<IconCapChevronDown class="shrink-0 size-3.5 text-ed-text-3" />
								</KSelect.Icon>
							</KSelect.Trigger>
							<KSelect.Portal>
								<PopperContent<typeof KSelect.Content>
									as={KSelect.Content}
									class={topLeftAnimateClasses}
								>
									<MenuItemList<typeof KSelect.Listbox> as={KSelect.Listbox} />
								</PopperContent>
							</KSelect.Portal>
						</KSelect>
					</Field>

					<Field name="Font Weight" inline>
						<KSelect
							options={TEXT_WEIGHT_OPTIONS}
							optionValue="value"
							optionTextValue="label"
							value={{
								label: "Custom",
								value: getSetting("fontWeight"),
							}}
							onChange={(value) => {
								if (!value) return;
								updateCaptionSetting("fontWeight", value.value);
							}}
							disabled={!hasCaptions()}
							itemComponent={(selectItemProps) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={selectItemProps.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{selectItemProps.item.rawValue.label}
									</KSelect.ItemLabel>
									<KSelect.ItemIndicator class="ml-auto text-ed-accent">
										<IconCapCircleCheck />
									</KSelect.ItemIndicator>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class={selectTriggerClass}>
								<KSelect.Value<{
									label: string;
									value: number;
								}> class="truncate">
									{(state) =>
										state.selectedOption()?.label ??
										getTextWeightLabel(getSetting("fontWeight"))
									}
								</KSelect.Value>
								<KSelect.Icon>
									<IconCapChevronDown class="shrink-0 size-3.5 transition-transform transform text-ed-text-3 data-expanded:rotate-180" />
								</KSelect.Icon>
							</KSelect.Trigger>
							<KSelect.Portal>
								<PopperContent<typeof KSelect.Content>
									as={KSelect.Content}
									class={cx(topSlideAnimateClasses, "z-50")}
								>
									<MenuItemList<typeof KSelect.Listbox>
										class="overflow-y-auto max-h-40"
										as={KSelect.Listbox}
									/>
								</PopperContent>
							</KSelect.Portal>
						</KSelect>
					</Field>
				</div>

				<div class="w-full border-t border-ed-line" />

				<Section name="Animation">
					<div class="flex flex-col gap-2">
						<Field name="Animation Style" inline>
							<KSelect<string>
								options={CAPTION_ANIMATION_OPTIONS.map((o) => o.value)}
								value={getSetting("animation")}
								onChange={(value) => {
									if (value === null) return;
									updateCaptionSetting("animation", value as CaptionAnimation);
								}}
								disabled={!hasCaptions()}
								itemComponent={(itemProps) => (
									<MenuItem<typeof KSelect.Item>
										as={KSelect.Item}
										item={itemProps.item}
									>
										<KSelect.ItemLabel class="flex-1">
											{
												CAPTION_ANIMATION_OPTIONS.find(
													(o) => o.value === itemProps.item.rawValue,
												)?.label
											}
										</KSelect.ItemLabel>
									</MenuItem>
								)}
							>
								<KSelect.Trigger class={selectTriggerClass}>
									<KSelect.Value<string> class="truncate">
										{(state) =>
											CAPTION_ANIMATION_OPTIONS.find(
												(o) => o.value === state.selectedOption(),
											)?.label
										}
									</KSelect.Value>
									<KSelect.Icon>
										<IconCapChevronDown class="shrink-0 size-3.5 text-ed-text-3" />
									</KSelect.Icon>
								</KSelect.Trigger>
								<KSelect.Portal>
									<PopperContent<typeof KSelect.Content>
										as={KSelect.Content}
										class={topLeftAnimateClasses}
									>
										<MenuItemList<typeof KSelect.Listbox>
											as={KSelect.Listbox}
										/>
									</PopperContent>
								</KSelect.Portal>
							</KSelect>
						</Field>

						<Field name="Highlight Color">
							<HexColorInput
								value={getSetting("highlightColor")}
								brandColorSwatches={props.brandColorSwatches}
								onChange={(value) =>
									updateCaptionSetting("highlightColor", value)
								}
							/>
						</Field>

						<Field
							name="Fade Duration"
							inline
							value={`${(getSetting("fadeDuration") * 1000).toFixed(0)}ms`}
						>
							<Slider
								value={[getSetting("fadeDuration") * 100]}
								onChange={(v) =>
									updateCaptionSetting("fadeDuration", v[0] / 100)
								}
								minValue={0}
								maxValue={50}
								step={1}
								disabled={!hasCaptions()}
							/>
						</Field>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<Section name="Export options">
					<Field name="Export with Subtitles" inline>
						<Toggle
							checked={getSetting("exportWithSubtitles")}
							onChange={(checked) =>
								updateCaptionSetting("exportWithSubtitles", checked)
							}
							disabled={!hasCaptions()}
						/>
					</Field>
				</Section>
			</div>

			<Show
				when={
					editorState.timeline.selection?.type === "caption" &&
					editorState.timeline.selection.indices.length === 1
				}
			>
				<div class="w-full border-t border-ed-line" />
				<Section name="Selected caption override">
					<Show when={selectedCaptionSegment()}>
						{(seg) => (
							<div class="flex flex-col gap-1">
								<Subfield name="Start Time">
									<Input
										type="number"
										value={seg().start.toFixed(2)}
										step="0.1"
										min={0}
										onChange={(e) =>
											updateSelectedCaption((segment) => {
												segment.start = Number.parseFloat(e.target.value);
											})
										}
									/>
								</Subfield>
								<Subfield name="End Time">
									<Input
										type="number"
										value={seg().end.toFixed(2)}
										step="0.1"
										min={seg().start}
										onChange={(e) =>
											updateSelectedCaption((segment) => {
												segment.end = Number.parseFloat(e.target.value);
											})
										}
									/>
								</Subfield>
								<Subfield name="Caption Text">
									<Input
										type="text"
										value={seg().text}
										onChange={(e) =>
											updateSelectedCaption((segment) => {
												segment.text = e.target.value;
												segment.words = syncCaptionWordsWithText(
													e.target.value,
													segment.words,
													segment.start,
													segment.end,
												);
											})
										}
									/>
								</Subfield>
								<Subfield name="Fade Duration Override">
									<Slider
										class="flex-1"
										value={[
											(seg().fadeDurationOverride ??
												getSetting("fadeDuration")) * 100,
										]}
										onChange={(v) =>
											updateSelectedCaption((segment) => {
												segment.fadeDurationOverride = v[0] / 100;
											})
										}
										minValue={0}
										maxValue={50}
										step={1}
									/>
								</Subfield>
							</div>
						)}
					</Show>
				</Section>
			</Show>
		</div>
	);
}
