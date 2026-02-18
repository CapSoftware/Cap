import { cx } from "cva";
import { createMemo, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import {
	type KeyboardSettings,
	defaultKeyboardSettings,
} from "~/store/keyboard";
import { useEditorContext } from "./context";
import {
	Field,
	Input,
	Slider,
	Subfield,
} from "./ui";

export function KeyboardTab() {
	const { project, setProject, editorState } = useEditorContext();

	const getSetting = <K extends keyof KeyboardSettings>(
		key: K,
	): NonNullable<KeyboardSettings[K]> => {
		const settings = project?.keyboard?.settings;
		if (settings && key in settings) {
			return (settings as Record<string, unknown>)[key as string] as NonNullable<
				KeyboardSettings[K]
			>;
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
		<Field name="Keyboard" icon={<IconLucideKeyboard />}>
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
					<Field name="Appearance" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<Subfield name="Font Size">
								<Slider
									value={[getSetting("size")]}
									onChange={(v) => updateSetting("size", v[0])}
									minValue={12}
									maxValue={72}
									step={1}
								/>
							</Subfield>

							<Subfield name="Font Weight">
								<Slider
									value={[getSetting("fontWeight")]}
									onChange={(v) => updateSetting("fontWeight", v[0])}
									minValue={100}
									maxValue={900}
									step={100}
								/>
							</Subfield>

							<Subfield name="Background Opacity">
								<Slider
									value={[getSetting("backgroundOpacity")]}
									onChange={(v) => updateSetting("backgroundOpacity", v[0])}
									minValue={0}
									maxValue={100}
									step={1}
								/>
							</Subfield>
						</div>
					</Field>

					<Field name="Behavior" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<Subfield name="Fade Duration">
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
							</Subfield>

							<Subfield name="Linger Duration">
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
							</Subfield>

							<Subfield name="Grouping Threshold">
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
							</Subfield>

							<Subfield name="Show Modifier Keys">
								<Toggle
									checked={getSetting("showModifiers")}
									onChange={(checked) =>
										updateSetting("showModifiers", checked)
									}
								/>
							</Subfield>

							<Subfield name="Show Special Keys">
								<Toggle
									checked={getSetting("showSpecialKeys")}
									onChange={(checked) =>
										updateSetting("showSpecialKeys", checked)
									}
								/>
							</Subfield>
						</div>
					</Field>

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
							<p>No keyboard events recorded.</p>
							<p class="text-xs mt-1 text-gray-10">
								Keyboard presses are automatically recorded during studio mode
								recording.
							</p>
						</div>
					</Show>
				</div>
			</div>
		</Field>
	);
}
