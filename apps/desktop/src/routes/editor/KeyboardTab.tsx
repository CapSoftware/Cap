import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import { batch, createMemo, createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import {
	defaultKeyboardSettings,
	type KeyboardSettings,
} from "~/store/keyboard";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import { commands } from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCircleCheck from "~icons/cap/circle-check";
import { useEditorContext } from "./context";
import {
	generateForStableKeyboardTimeline,
	keyboardTimelineSignature,
} from "./keyboard-timing";
import {
	FONT_OPTIONS,
	getTextWeightLabel,
	HexColorInput,
	KEYBOARD_POSITION_OPTIONS,
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
	topSlideAnimateClasses,
} from "./ui";

const selectTriggerClass =
	"flex flex-row gap-1.5 items-center px-2 h-7 max-w-full rounded-[7px] text-[13px] transition-colors outline-hidden bg-ed-ctl text-ed-text-1 hover:bg-ed-ctl-hover focus-visible:ring-1 focus-visible:ring-ed-accent";

export function KeyboardTab(props: {
	brandColorSwatches: OrganizationBrandColorSwatch[];
}) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		flushProjectConfig,
	} = useEditorContext();

	const getSetting = <K extends keyof KeyboardSettings>(
		key: K,
	): NonNullable<KeyboardSettings[K]> => {
		const settings = project?.keyboard?.settings;
		if (settings && key in settings) {
			return (settings as Record<string, unknown>)[
				key as string
			] as NonNullable<KeyboardSettings[K]>;
		}
		return defaultKeyboardSettings[key] as NonNullable<KeyboardSettings[K]>;
	};

	const updateSetting = <K extends keyof KeyboardSettings>(
		key: K,
		value: KeyboardSettings[K],
	) => {
		if (!project?.keyboard) {
			setProject("keyboard", {
				settings: { ...defaultKeyboardSettings, [key]: value },
			});
			return;
		}
		setProject("keyboard", "settings", key, value);
	};

	const hasKeyboardSegments = createMemo(
		() => (project.timeline?.keyboardSegments?.length ?? 0) > 0,
	);

	const [isGenerating, setIsGenerating] = createSignal(false);

	const ensureKeyboardSettings = (enabled: boolean) => {
		if (!project?.keyboard) {
			setProject("keyboard", {
				settings: { ...defaultKeyboardSettings, enabled },
			});
			return;
		}
		setProject("keyboard", "settings", "enabled", enabled);
	};

	const setKeyboardVisible = (enabled: boolean) => {
		batch(() => {
			ensureKeyboardSettings(enabled);
			setEditorState("timeline", "tracks", "keyboard", enabled);
			if (!enabled && editorState.timeline.selection?.type === "keyboard") {
				setEditorState("timeline", "selection", null);
			}
		});
	};

	const generateSegments = async () => {
		if (!project.timeline || isGenerating()) return;
		setIsGenerating(true);
		try {
			const segments = await generateForStableKeyboardTimeline(
				() => {
					const timeline = keyboardTimelineSignature(project.timeline);
					if (timeline === null) return null;
					return [
						timeline,
						getSetting("groupingThresholdMs"),
						getSetting("lingerDuration"),
						getSetting("showModifiers"),
						getSetting("showSpecialKeys"),
					].join("@@");
				},
				async () => {
					await flushProjectConfig();
					return commands.generateKeyboardSegments(
						getSetting("groupingThresholdMs"),
						getSetting("lingerDuration") * 1000,
						getSetting("showModifiers"),
						getSetting("showSpecialKeys"),
					);
				},
			);

			if (!segments) {
				toast.error(
					"The timeline changed while keyboard events were generated. Try again.",
				);
				return;
			}
			batch(() => {
				setProject("timeline", "keyboardSegments", segments);
				if (segments.length > 0) {
					ensureKeyboardSettings(true);
					setEditorState("timeline", "tracks", "keyboard", true);
				} else if (editorState.timeline.selection?.type === "keyboard") {
					setEditorState("timeline", "selection", null);
				}
			});
		} catch (e) {
			console.error("Failed to generate keyboard segments:", e);
			toast.error("Unable to generate keyboard events");
		} finally {
			setIsGenerating(false);
		}
	};

	const selectedSegment = () => {
		const selection = editorState.timeline.selection;
		if (selection?.type !== "keyboard" || selection.indices.length !== 1)
			return null;
		return project.timeline?.keyboardSegments?.[selection.indices[0]] ?? null;
	};

	const selectedIndex = () => {
		const selection = editorState.timeline.selection;
		if (selection?.type !== "keyboard" || selection.indices.length !== 1)
			return -1;
		return selection.indices[0];
	};

	return (
		<div class="flex flex-col gap-3.5">
			<div class="flex flex-row gap-2 items-center min-h-[22px]">
				<SectionLabel name="Show keyboard" />
				<span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-ed-ctl text-ed-text-2">
					Beta
				</span>
				<div class="ml-auto">
					<Toggle
						checked={getSetting("enabled")}
						onChange={setKeyboardVisible}
					/>
				</div>
			</div>
			<div
				class={cx(
					"flex flex-col gap-3.5",
					!getSetting("enabled") && "opacity-50 pointer-events-none",
				)}
			>
				<Section name="Font settings">
					<div class="flex flex-col gap-2">
						<Field name="Font Family" inline>
							<KSelect<string>
								options={FONT_OPTIONS.map((f) => f.value)}
								value={getSetting("font")}
								onChange={(value) => {
									if (value === null) return;
									updateSetting("font", value);
								}}
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
										class={topSlideAnimateClasses}
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
								onChange={(v) => updateSetting("size", v[0])}
								minValue={12}
								maxValue={100}
								step={1}
							/>
						</Field>

						<Field name="Text Color">
							<HexColorInput
								value={getSetting("color")}
								brandColorSwatches={props.brandColorSwatches}
								onChange={(value) => updateSetting("color", value)}
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
								onChange={(value) => updateSetting("backgroundColor", value)}
							/>
						</Field>

						<Field name="Background Opacity" inline>
							<Slider
								value={[getSetting("backgroundOpacity")]}
								onChange={(v) => updateSetting("backgroundOpacity", v[0])}
								minValue={0}
								maxValue={100}
								step={1}
							/>
						</Field>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<div class="flex flex-col gap-2">
					<Field name="Position" inline>
						<KSelect<string>
							options={KEYBOARD_POSITION_OPTIONS.map((p) => p.value)}
							value={getSetting("position")}
							onChange={(value) => {
								if (value === null) return;
								updateSetting("position", value);
							}}
							itemComponent={(props) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={props.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{
											KEYBOARD_POSITION_OPTIONS.find(
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
												KEYBOARD_POSITION_OPTIONS.find(
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
									class={topSlideAnimateClasses}
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
								updateSetting("fontWeight", value.value);
							}}
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
						<Field
							name="Fade Duration"
							inline
							value={`${(getSetting("fadeDuration") * 1000).toFixed(0)}ms`}
						>
							<Slider
								value={[getSetting("fadeDuration") * 100]}
								onChange={(v) => updateSetting("fadeDuration", v[0] / 100)}
								minValue={0}
								maxValue={50}
								step={1}
							/>
						</Field>

						<Field
							name="Linger Duration"
							inline
							value={`${(getSetting("lingerDuration") * 1000).toFixed(0)}ms`}
						>
							<Slider
								value={[getSetting("lingerDuration") * 100]}
								onChange={(v) => updateSetting("lingerDuration", v[0] / 100)}
								minValue={0}
								maxValue={300}
								step={5}
							/>
						</Field>

						<Field
							name="Grouping Threshold"
							inline
							value={`${getSetting("groupingThresholdMs").toFixed(0)}ms`}
						>
							<Slider
								value={[getSetting("groupingThresholdMs")]}
								onChange={(v) => updateSetting("groupingThresholdMs", v[0])}
								minValue={50}
								maxValue={1000}
								step={10}
							/>
						</Field>
					</div>
				</Section>

				<div class="w-full border-t border-ed-line" />

				<Section name="Behavior">
					<div class="flex flex-col gap-2">
						<Field name="Show Modifier Keys" inline>
							<Toggle
								checked={getSetting("showModifiers")}
								onChange={(checked) => updateSetting("showModifiers", checked)}
							/>
						</Field>

						<Field name="Show Special Keys" inline>
							<Toggle
								checked={getSetting("showSpecialKeys")}
								onChange={(checked) =>
									updateSetting("showSpecialKeys", checked)
								}
							/>
						</Field>

						<Field name="Uppercase" inline>
							<Toggle
								checked={getSetting("uppercase")}
								onChange={(checked) => updateSetting("uppercase", checked)}
							/>
						</Field>
					</div>
				</Section>

				<Button
					onClick={generateSegments}
					disabled={isGenerating()}
					class="w-full"
				>
					{isGenerating()
						? "Generating..."
						: hasKeyboardSegments()
							? "Regenerate Keyboard Segments"
							: "Generate Keyboard Segments"}
				</Button>

				<Show when={selectedSegment()}>
					{(seg) => (
						<>
							<div class="w-full border-t border-ed-line" />
							<Section name="Selected segment override">
								<div class="flex flex-col gap-1">
									<Subfield name="Start Time">
										<Input
											type="number"
											value={seg().start.toFixed(2)}
											step="0.1"
											min={0}
											onChange={(e) =>
												setProject(
													"timeline",
													"keyboardSegments",
													selectedIndex(),
													"start",
													Number.parseFloat(e.target.value),
												)
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
												setProject(
													"timeline",
													"keyboardSegments",
													selectedIndex(),
													"end",
													Number.parseFloat(e.target.value),
												)
											}
										/>
									</Subfield>
									<Subfield name="Display Text">
										<Input
											type="text"
											value={seg().displayText}
											onChange={(e) =>
												setProject(
													"timeline",
													"keyboardSegments",
													selectedIndex(),
													"displayText",
													e.target.value,
												)
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
												setProject(
													"timeline",
													"keyboardSegments",
													selectedIndex(),
													"fadeDurationOverride",
													v[0] / 100,
												)
											}
											minValue={0}
											maxValue={50}
											step={1}
										/>
									</Subfield>
									<Subfield name="Uppercase">
										<Toggle
											checked={
												seg().uppercaseOverride ?? getSetting("uppercase")
											}
											onChange={(checked) =>
												setProject(
													"timeline",
													"keyboardSegments",
													selectedIndex(),
													"uppercaseOverride",
													checked,
												)
											}
										/>
									</Subfield>
								</div>
							</Section>
						</>
					)}
				</Show>

				<Show when={!hasKeyboardSegments()}>
					<div class="py-2 text-center text-ed-text-2">
						<p class="text-[13px]">No keyboard segments yet.</p>
						<p class="mt-1 text-[11px] text-ed-text-3">
							Click "Generate Keyboard Segments" to create segments from
							recorded keyboard presses.
						</p>
					</div>
				</Show>
			</div>
		</div>
	);
}
