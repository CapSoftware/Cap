import { Select as KSelect } from "@kobalte/core/select";
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
import {
	CAPTION_STYLE_PRESETS,
	type CaptionAnimation,
	type CaptionHighlightStyle,
	type CaptionStylePreset,
	defaultCaptionSettings,
	type EditorCaptionSettings,
} from "~/store/captions";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCircleCheck from "~icons/cap/circle-check";
import { Button } from "../../../ui";
import {
	applyCaptionResultToProject,
	getCaptionGenerationErrorMessage,
	syncCaptionSourceFromTrack,
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

interface LanguageOption {
	code: string;
	label: string;
}

const webCaptionsEnabled = () =>
	(window as Window & { capWebEditorCaptionsEnabled?: boolean })
		.capWebEditorCaptionsEnabled === true;

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

const WEB_LANGUAGE_OPTIONS = LANGUAGE_OPTIONS.filter(
	(option) => option.code !== "pa",
);

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
	const [webCaptionsProEnabled, setWebCaptionsProEnabled] = createSignal(
		webCaptionsEnabled(),
	);
	const syncWebCaptionPlan = () =>
		setWebCaptionsProEnabled(webCaptionsEnabled());

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

				update(timelineSegment);

				// Route content/timing onto the source-time caption master so the
				// edit persists across future clip changes. Style overrides stay on
				// the track and are carried across by source id when re-derived.
				syncCaptionSourceFromTrack(
					currentProject,
					index,
					editorInstance.recordings.segments,
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

	const [selectedLanguage, setSelectedLanguage] = createSignal("auto");
	const isGenerating = () => editorState.captions.isGenerating;
	const setIsGenerating = (value: boolean) =>
		setEditorState("captions", "isGenerating", value);
	const [hasAudio, setHasAudio] = createSignal(false);
	const [generationError, setGenerationError] = createSignal<string | null>(
		null,
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

	onMount(() => {
		window.addEventListener("cap-web-editor-captions-plan", syncWebCaptionPlan);
		syncWebCaptionPlan();
		const savedLanguage = localStorage.getItem("selectedTranscriptionLanguage");
		if (
			savedLanguage &&
			WEB_LANGUAGE_OPTIONS.some((option) => option.code === savedLanguage)
		) {
			setSelectedLanguage(savedLanguage);
		}
		if (editorInstance?.recordings) {
			setHasAudio(
				editorInstance.recordings.segments.some(
					(segment) => segment.mic !== null || segment.system_audio !== null,
				),
			);
		}
	});

	onCleanup(() => {
		window.removeEventListener(
			"cap-web-editor-captions-plan",
			syncWebCaptionPlan,
		);
	});

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

	const generateCaptions = async () => {
		if (!editorInstance) {
			toast.error("Editor instance not found");
			return;
		}

		setIsGenerating(true);
		setGenerationError(null);

		try {
			const result = await transcribeEditorCaptions(
				editorInstance.path,
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
				const message =
					"No captions were generated. The audio might be too quiet or unclear.";
				setGenerationError(message);
				toast.error(message);
			}
		} catch (error) {
			console.error("Error generating captions:", error);
			const errorMessage = getCaptionGenerationErrorMessage(error);
			setGenerationError(errorMessage);
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
				<p class="text-[11px] leading-relaxed text-ed-text-3">
					Cap Pro captions use the same AssemblyAI transcription as your
					shareable link.
				</p>
				<Show when={!webCaptionsProEnabled()}>
					<a
						href="/pricing"
						target="_blank"
						rel="noreferrer"
						class="rounded-lg bg-ed-accent px-3 py-2 text-center text-[12px] font-medium text-white"
					>
						Upgrade to Cap Pro
					</a>
				</Show>
				<Show when={webCaptionsProEnabled() && hasAudio()}>
					<Field name="Language" inline>
						<KSelect<string>
							options={WEB_LANGUAGE_OPTIONS.map((option) => option.code)}
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
											WEB_LANGUAGE_OPTIONS.find(
												(option) => option.code === props.item.rawValue,
											)?.label
										}
									</KSelect.ItemLabel>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class={selectTriggerClass}>
								<KSelect.Value<string> class="truncate">
									{(state) => {
										const language = WEB_LANGUAGE_OPTIONS.find(
											(option) => option.code === state.selectedOption(),
										);
										return (
											<span>{language?.label || "Select a language"}</span>
										);
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
					<Button
						onClick={generateCaptions}
						disabled={isGenerating()}
						class="w-full"
					>
						{isGenerating()
							? "Generating..."
							: hasCaptions()
								? "Regenerate Captions"
								: "Generate Captions"}
					</Button>
					<Show when={generationError()}>
						{(message) => (
							<p role="alert" class="text-[11px] leading-relaxed text-red-11">
								{message()}
							</p>
						)}
					</Show>
				</Show>
			</div>

			<div
				class={cx(
					"w-full border-t border-ed-line",
					!webCaptionsProEnabled() && "hidden",
				)}
			/>

			<div
				class={cx(
					"flex flex-col gap-3.5",
					!hasCaptions() && "opacity-50 pointer-events-none",
					!webCaptionsProEnabled() && "hidden",
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
									<KSelect.ItemIndicator class="ml-auto text-ed-accent-ink">
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
			</div>

			<Show
				when={
					webCaptionsProEnabled() &&
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
