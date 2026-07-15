import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import { batch, createMemo, createSignal, Show } from "solid-js";
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
	Slider,
	Subfield,
	topSlideAnimateClasses,
} from "./ui";

export function KeyboardTab(props: {
	brandColorSwatches: OrganizationBrandColorSwatch[];
}) {
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
		setIsGenerating(true);
		try {
			const segments = await commands.generateKeyboardSegments(
				getSetting("groupingThresholdMs"),
				getSetting("lingerDuration") * 1000,
				getSetting("showModifiers"),
				getSetting("showSpecialKeys"),
			);

			if (segments.length > 0) {
				batch(() => {
					ensureKeyboardSettings(true);
					setProject("timeline", "keyboardSegments", segments);
					setEditorState("timeline", "tracks", "keyboard", true);
				});
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
		<Field
			name="显示按键"
			value={
				<Toggle checked={getSetting("enabled")} onChange={setKeyboardVisible} />
			}
			badge="Beta"
		>
			<div class="flex flex-col gap-4">
				<div
					class={cx(
						"space-y-4",
						!getSetting("enabled") && "opacity-50 pointer-events-none",
					)}
				>
					<Field name="字体设置" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">字体</span>
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
									<KSelect.Trigger class="w-full flex items-center justify-between rounded-lg px-3 py-2 bg-gray-2 border border-gray-3 text-gray-12 hover:border-gray-4 hover:bg-gray-3 focus:border-blue-9 focus:ring-1 focus:ring-blue-9 transition-colors">
										<KSelect.Value<string>>
											{(state) =>
												FONT_OPTIONS.find(
													(f) => f.value === state.selectedOption(),
												)?.label
											}
										</KSelect.Value>
										<KSelect.Icon>
											<IconCapChevronDown />
										</KSelect.Icon>
									</KSelect.Trigger>
									<KSelect.Portal>
										<PopperContent<typeof KSelect.Content>
											as={KSelect.Content}
											class={topSlideAnimateClasses}
										>
											<MenuItemList<typeof KSelect.Listbox>
												class="max-h-48 overflow-y-auto"
												as={KSelect.Listbox}
											/>
										</PopperContent>
									</KSelect.Portal>
								</KSelect>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">字号</span>
								<Slider
									value={[getSetting("size")]}
									onChange={(v) => updateSetting("size", v[0])}
									minValue={12}
									maxValue={100}
									step={1}
								/>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">文字颜色</span>
								<HexColorInput
									value={getSetting("color")}
									brandColorSwatches={props.brandColorSwatches}
									onChange={(value) => updateSetting("color", value)}
								/>
							</div>
						</div>
					</Field>

					<Field name="背景设置" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">背景颜色</span>
								<HexColorInput
									value={getSetting("backgroundColor")}
									brandColorSwatches={props.brandColorSwatches}
									onChange={(value) => updateSetting("backgroundColor", value)}
								/>
							</div>

							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">背景不透明度</span>
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

					<Field name="位置" icon={<IconLucideKeyboard />}>
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
							<KSelect.Trigger class="w-full flex items-center justify-between rounded-lg px-3 py-2 bg-gray-2 border border-gray-3 text-gray-12 hover:border-gray-4 hover:bg-gray-3 focus:border-blue-9 focus:ring-1 focus:ring-blue-9 transition-colors">
								<KSelect.Value<string>>
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
									<IconCapChevronDown />
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

					<Field name="字重" icon={<IconLucideKeyboard />}>
						<KSelect
							options={TEXT_WEIGHT_OPTIONS}
							optionValue="value"
							optionTextValue="label"
							value={{
								label: "自定义",
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
									<KSelect.ItemIndicator class="ml-auto text-blue-9">
										<IconCapCircleCheck />
									</KSelect.ItemIndicator>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class="flex w-full items-center justify-between rounded-md border border-gray-3 bg-gray-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:border-gray-4 hover:bg-gray-3 focus:border-blue-9 focus:outline-hidden focus:ring-1 focus:ring-blue-9">
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
									<IconCapChevronDown class="size-4 shrink-0 transform transition-transform data-expanded:rotate-180 text-(--gray-500)" />
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

					<Field name="动画" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<span class="text-gray-11 text-sm">淡化时长</span>
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
								<span class="text-gray-11 text-sm">停留时长</span>
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
								<span class="text-gray-11 text-sm">分组时间阈值</span>
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

					<Field name="行为" icon={<IconLucideKeyboard />}>
						<div class="space-y-3">
							<div class="flex flex-col gap-2">
								<div class="flex items-center justify-between">
									<span class="text-gray-11 text-sm">显示修饰键</span>
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
									<span class="text-gray-11 text-sm">显示特殊按键</span>
									<Toggle
										checked={getSetting("showSpecialKeys")}
										onChange={(checked) =>
											updateSetting("showSpecialKeys", checked)
										}
									/>
								</div>
							</div>

							<div class="flex flex-col gap-2">
								<div class="flex items-center justify-between">
									<span class="text-gray-11 text-sm">大写</span>
									<Toggle
										checked={getSetting("uppercase")}
										onChange={(checked) => updateSetting("uppercase", checked)}
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
								? "正在生成…"
								: hasKeyboardSegments()
									? "重新生成按键片段"
									: "生成按键片段"}
						</Button>
					</div>

					<Show when={selectedSegment()}>
						{(seg) => (
							<Field name="所选片段覆盖设置" icon={<IconLucideKeyboard />}>
								<div class="space-y-3">
									<Subfield name="开始时间">
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
									<Subfield name="结束时间">
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
									<Subfield name="显示文字">
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
									<Subfield name="淡化时长覆盖设置">
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
									<Subfield name="大写">
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
							</Field>
						)}
					</Show>

					<Show when={!hasKeyboardSegments()}>
						<div class="text-center text-sm text-gray-11 py-4">
							<p>暂无按键片段。</p>
							<p class="text-xs mt-1 text-gray-10">
								点击“生成按键片段”，即可根据录制的按键事件创建片段 recorded
								keyboard presses.
							</p>
						</div>
					</Show>
				</div>
			</div>
		</Field>
	);
}
