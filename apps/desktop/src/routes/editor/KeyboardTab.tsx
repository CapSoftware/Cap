import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import { createMemo, createSignal, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import {
	defaultKeyboardSettings,
	type KeyboardSettings,
} from "~/store/keyboard";
import { commands } from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import { useEditorContext } from "./context";
import {
	Field,
	Input,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	Subfield,
	topSlideAnimateClasses,
} from "./ui";

export function KeyboardTab() {
	const { project, setProject, editorState, setEditorState } =
		useEditorContext();

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
		setProject("keyboard", "settings", key as string, value);
	};

	const hasKeyboardSegments = createMemo(
		() => (project.timeline?.keyboardSegments?.length ?? 0) > 0,
	);

	const [isGenerating, setIsGenerating] = createSignal(false);

	const generateSegments = async () => {
		setIsGenerating(true);
		try {
			const segments = await commands.generateKeyboardSegments(
				getSetting("groupingThresholdMs"),
				getSetting("lingerDuration") * 1000,
				getSetting("showModifiers"),
				getSetting("showSpecialKeys"),
			);

			if (segments.length > 0) {
				setProject("timeline", "keyboardSegments", segments);
				setEditorState("timeline", "tracks", "keyboard", true);
			}
		} catch (e) {
			console.error("Failed to generate keyboard segments:", e);
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
		<Field name="Keyboard" icon={<IconLucideKeyboard />} badge="Beta">
			<div class="flex flex-col gap-4">
				<Subfield name="Show Keyboard Presses">
					<Toggle
						checked={getSetting("enabled")}
						onChange={(checked) => updateSetting("enabled", checked)}
					/>
				</Subfield>

				<div
					class={cx(
						"space-y-4",
						!getSetting("enabled") && "opacity-50 pointer-events-none",
					)}
				>
					<Field name="Font Settings" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">Size</span>
								<Slider
									value={[getSetting("size")]}
									onChange={(v) => updateSetting("size", v[0])}
									minValue={12}
									maxValue={72}
									step={1}
								/>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">Background Opacity</span>
								<Slider
									value={[getSetting("backgroundOpacity")]}
									onChange={(v) => updateSetting("backgroundOpacity", v[0])}
									minValue={0}
									maxValue={100}
									step={1}
								/>
							</div>
						</div>
					</Field>

					<Field name="Font Weight" icon={<IconLucideKeyboard />}>
						<KSelect
							options={[
								{ label: "Normal", value: 400 },
								{ label: "Medium", value: 500 },
								{ label: "Bold", value: 700 },
							]}
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
								</MenuItem>
							)}
						>
							<KSelect.Trigger class="flex w-full items-center justify-between rounded-md border border-gray-3 bg-gray-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:border-gray-4 hover:bg-gray-3 focus:border-blue-9 focus:outline-none focus:ring-1 focus:ring-blue-9">
								<KSelect.Value<{
									label: string;
									value: number;
								}> class="truncate">
									{(state) => {
										const selected = state.selectedOption();
										if (selected) return selected.label;
										const weight = getSetting("fontWeight");
										const option = [
											{ label: "Normal", value: 400 },
											{ label: "Medium", value: 500 },
											{ label: "Bold", value: 700 },
										].find((o) => o.value === weight);
										return option ? option.label : "Bold";
									}}
								</KSelect.Value>
								<KSelect.Icon>
									<IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
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

					<Field name="Animation" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">Fade Duration</span>
								<Slider
									value={[getSetting("fadeDuration") * 100]}
									onChange={(v) => updateSetting("fadeDuration", v[0] / 100)}
									minValue={0}
									maxValue={50}
									step={1}
								/>
								<span class="text-xs text-gray-11 text-right">
									{(getSetting("fadeDuration") * 1000).toFixed(0)}ms
								</span>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">Linger Duration</span>
								<Slider
									value={[getSetting("lingerDuration") * 100]}
									onChange={(v) => updateSetting("lingerDuration", v[0] / 100)}
									minValue={0}
									maxValue={300}
									step={5}
								/>
								<span class="text-xs text-gray-11 text-right">
									{(getSetting("lingerDuration") * 1000).toFixed(0)}ms
								</span>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">Grouping Threshold</span>
								<Slider
									value={[getSetting("groupingThresholdMs")]}
									onChange={(v) => updateSetting("groupingThresholdMs", v[0])}
									minValue={50}
									maxValue={1000}
									step={10}
								/>
								<span class="text-xs text-gray-11 text-right">
									{getSetting("groupingThresholdMs").toFixed(0)}ms
								</span>
							</div>
						</div>
					</Field>

					<Field name="Behavior" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<div class="flex items-center justify-between">
									<span class="text-gray-11 text-sm">Show Modifier Keys</span>
									<Toggle
										checked={getSetting("showModifiers")}
										onChange={(checked) =>
											updateSetting("showModifiers", checked)
										}
									/>
								</div>
							</div>

							<div class="flex flex-col gap-2">
								<div class="flex items-center justify-between">
									<span class="text-gray-11 text-sm">Show Special Keys</span>
									<Toggle
										checked={getSetting("showSpecialKeys")}
										onChange={(checked) =>
											updateSetting("showSpecialKeys", checked)
										}
									/>
								</div>
							</div>
						</div>
					</Field>

					<div class="pt-2">
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
					</div>

					<Show when={selectedSegment()}>
						{(seg) => (
							<Field
								name="Selected Segment Override"
								icon={<IconLucideKeyboard />}
							>
								<div class="space-y-3">
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
								</div>
							</Field>
						)}
					</Show>

					<Show when={!hasKeyboardSegments()}>
						<div class="text-center text-sm text-gray-11 py-4">
							<p>No keyboard segments yet.</p>
							<p class="text-xs mt-1 text-gray-10">
								Click "Generate Keyboard Segments" to create segments from
								recorded keyboard presses.
							</p>
						</div>
					</Show>
				</div>
			</div>
		</Field>
	);
}
