import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import {
	createMemo,
	createResource,
	createSignal,
	For,
	type JSX,
	Show,
	type ValidComponent,
} from "solid-js";
import { produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { Toggle } from "~/components/Toggle";
import { listSystemFonts } from "~/utils/fonts";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import IconLucideAlignCenter from "~icons/lucide/align-center";
import IconLucideAlignLeft from "~icons/lucide/align-left";
import IconLucideAlignRight from "~icons/lucide/align-right";
import { useEditorContext } from "./context";
import { FontPicker } from "./FontPicker";
import "./text-animations.css";
import {
	TEXT_FONT_SIZE_MAX,
	TEXT_FONT_SIZE_MIN,
	type TextAlign,
	type TextAnimation,
	type TextBackgroundStyle,
	type TextLayout,
	type TextSegment,
} from "./text";
import {
	applyTextPreset,
	matchTextPreset,
	TEXT_PRESET_GROUPS,
	TEXT_PRESETS,
	type TextPreset,
} from "./text-presets";
import {
	HexColorInput,
	TEXT_ANIMATION_OPTIONS,
	TEXT_BACKGROUND_STYLE_OPTIONS,
	TEXT_SEGMENT_WEIGHT_OPTIONS,
} from "./text-style";
import {
	Field,
	MenuItem,
	MenuItemList,
	PopperContent,
	Section,
	Slider,
	topSlideAnimateClasses,
} from "./ui";

type SegmentedOption<T extends string> = {
	value: T;
	label: string;
	icon?: ValidComponent;
};

const TEXT_ALIGN_OPTIONS: SegmentedOption<TextAlign>[] = [
	{ value: "left", label: "Align left", icon: IconLucideAlignLeft },
	{ value: "center", label: "Align center", icon: IconLucideAlignCenter },
	{ value: "right", label: "Align right", icon: IconLucideAlignRight },
];

type BackgroundOption = "none" | TextBackgroundStyle;

const TEXT_BACKGROUND_OPTIONS: SegmentedOption<BackgroundOption>[] = [
	{ value: "none", label: "None" },
	...TEXT_BACKGROUND_STYLE_OPTIONS,
];

// The renderer also supports splitLeft/splitRight takeovers; only these two
// are exposed for now.
const TEXT_LAYOUT_OPTIONS: SegmentedOption<TextLayout>[] = [
	{ value: "overlay", label: "Overlay" },
	{ value: "fullscreen", label: "Fullscreen" },
];

const TEXT_LAYOUT_CENTERS: Partial<
	Record<TextLayout, { x: number; y: number }>
> = {
	fullscreen: { x: 0.5, y: 0.5 },
};

const ANIMATION_EDGE_OPTIONS: SegmentedOption<"in" | "out">[] = [
	{ value: "in", label: "In" },
	{ value: "out", label: "Out" },
];

const DEFAULT_GRADIENT_COLOR = "#7c9cff";

const clampNumber = (value: number, min: number, max: number) =>
	Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);

const fontStackCss = (stack: string[]) =>
	stack
		.map((family) =>
			["sans-serif", "serif", "monospace"].includes(family)
				? family
				: `"${family}"`,
		)
		.join(", ");

function Segmented<T extends string>(props: {
	options: SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	ariaLabel: string;
	stretch?: boolean;
}) {
	return (
		<div
			role="group"
			aria-label={props.ariaLabel}
			class={cx(
				"gap-0.5 p-0.5 rounded-lg bg-ed-ctl",
				props.stretch ? "flex w-full" : "inline-flex shrink-0",
			)}
		>
			<For each={props.options}>
				{(option) => {
					const selected = () => props.value === option.value;
					return (
						<button
							type="button"
							title={option.label}
							aria-label={option.label}
							aria-pressed={selected()}
							onClick={() => props.onChange(option.value)}
							class={cx(
								"flex justify-center items-center px-2.5 h-6 text-xs font-medium rounded-md transition-colors duration-100",
								props.stretch && "flex-1",
								selected()
									? "bg-ed-card text-ed-text-1 shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-white/12 dark:shadow-none"
									: "text-ed-text-2 hover:text-ed-text-1",
							)}
						>
							<Show when={option.icon} fallback={option.label}>
								{(icon) => <Dynamic component={icon()} class="size-3.5" />}
							</Show>
						</button>
					);
				}}
			</For>
		</div>
	);
}

function TextStyleSelect<T extends string | number>(props: {
	options: { label: string; value: T }[];
	value: T;
	onChange: (value: T) => void;
	fallbackLabel?: (value: T) => string;
}) {
	const selected = () =>
		props.options.find((option) => option.value === props.value) ?? {
			label: props.fallbackLabel?.(props.value) ?? String(props.value),
			value: props.value,
		};

	return (
		<KSelect
			options={props.options}
			optionValue="value"
			optionTextValue="label"
			value={selected()}
			onChange={(option) => {
				if (option) props.onChange(option.value);
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
			<KSelect.Trigger class="flex justify-between items-center px-2.5 w-full h-[30px] text-[12px] rounded-[7px] border-0 transition-colors duration-150 bg-ed-ctl text-ed-text-1 hover:bg-ed-ctl-hover focus:outline-hidden focus:ring-1 focus:ring-ed-accent">
				<KSelect.Value<{ label: string; value: T }> class="truncate">
					{(state) => state.selectedOption()?.label ?? selected().label}
				</KSelect.Value>
				<KSelect.Icon>
					<IconCapChevronDown class="transition-transform transform size-3.5 shrink-0 data-expanded:rotate-180 text-ed-text-3" />
				</KSelect.Icon>
			</KSelect.Trigger>
			<KSelect.Portal>
				<PopperContent<typeof KSelect.Content>
					as={KSelect.Content}
					class={cx(topSlideAnimateClasses, "z-50")}
				>
					<MenuItemList<typeof KSelect.Listbox>
						class="overflow-y-auto max-h-52"
						as={KSelect.Listbox}
					/>
				</PopperContent>
			</KSelect.Portal>
		</KSelect>
	);
}

function ToggleChip(props: {
	label: string;
	title: string;
	active: boolean;
	onClick: () => void;
	italic?: boolean;
}) {
	return (
		<button
			type="button"
			title={props.title}
			aria-label={props.title}
			aria-pressed={props.active}
			onClick={() => props.onClick()}
			class={cx(
				"flex items-center px-2.5 h-7 text-[12px] font-medium rounded-[7px] transition-colors",
				props.italic && "italic",
				props.active
					? "bg-ed-accent/12 text-ed-accent"
					: "bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1",
			)}
		>
			{props.label}
		</button>
	);
}

function TextPresetCard(props: {
	preset: TextPreset;
	active: boolean;
	onApply: () => void;
}) {
	const style = () => props.preset.style;

	const textColor = () => style().color ?? "#ffffff";

	const textStyle = (): JSX.CSSProperties => {
		const s = style();
		const shadows: string[] = [];
		if (s.shadow > 0)
			shadows.push(`0 1px 3px rgba(0, 0, 0, ${0.45 + s.shadow * 0.4})`);
		if (s.glow > 0)
			shadows.push(`0 0 6px ${textColor()}`, `0 0 14px ${textColor()}`);

		const css: JSX.CSSProperties = {
			"font-family": fontStackCss(s.fontStack),
			"font-weight": String(s.fontWeight),
			"font-style": s.italic ? "italic" : "normal",
			"text-transform": s.uppercase ? "uppercase" : "none",
			"font-size": `${Math.min(Math.max(s.fontSize * 0.2, 11), 22)}px`,
			"letter-spacing": `${s.letterSpacing * 0.35}px`,
			"line-height": "1.1",
			color: textColor(),
		};
		if (shadows.length > 0) css["text-shadow"] = shadows.join(", ");
		if (s.strokeWidth > 0) {
			css["-webkit-text-stroke"] = `${s.strokeWidth * 0.18}px ${s.strokeColor}`;
			css["paint-order"] = "stroke fill";
		}
		if (s.gradientColor) {
			css.background = `linear-gradient(90deg, ${textColor()}, ${s.gradientColor})`;
			css["-webkit-background-clip"] = "text";
			css["background-clip"] = "text";
			css.color = "transparent";
		}
		return css;
	};

	const backgroundStyle = (): JSX.CSSProperties => {
		const s = style();
		if (!s.backgroundColor) return {};
		return {
			"background-color": s.backgroundColor,
			padding: s.backgroundStyle === "highlight" ? "0 0.25em" : "0.15em 0.4em",
			"border-radius":
				s.backgroundStyle === "pill"
					? "9999px"
					: s.backgroundStyle === "highlight"
						? "0.15em"
						: "0.2em",
		};
	};

	return (
		<button
			type="button"
			onClick={() => props.onApply()}
			class={cx(
				"overflow-hidden relative flex justify-center items-center px-2 pb-3 h-[68px] rounded-[10px] transition-shadow",
				props.active
					? "ring-2 ring-ed-accent ring-offset-2 ring-offset-ed-card-2"
					: "ring-1 ring-ed-line hover:ring-ed-line-strong",
			)}
			style={{
				background: "linear-gradient(160deg, #1e1f26 0%, #2c2d36 100%)",
			}}
		>
			<span class="inline-block max-w-full" style={backgroundStyle()}>
				<span class="block max-w-full truncate" style={textStyle()}>
					{props.preset.sample}
				</span>
			</span>
			<span class="absolute inset-x-0 bottom-1.5 text-center text-[10px] font-medium text-white/55">
				{props.preset.name}
			</span>
		</button>
	);
}

const DEPICTION_FX: Record<TextAnimation, string> = {
	none: "",
	fade: "ta-fx-fade",
	slideUp: "ta-fx-slide-up",
	slideDown: "ta-fx-slide-down",
	slideLeft: "ta-fx-slide-left",
	slideRight: "ta-fx-slide-right",
	pop: "ta-fx-pop",
	zoom: "ta-fx-zoom",
	bounce: "ta-fx-bounce",
	wipe: "ta-fx-wipe",
	words: "ta-fx-stagger",
	letters: "ta-fx-stagger",
	tracking: "ta-fx-tracking",
	typewriter: "ta-fx-typewriter",
};

function AnimationDepiction(props: { value: TextAnimation }) {
	const fx = () => DEPICTION_FX[props.value];

	return (
		<span class="flex gap-1 justify-center items-center h-5 text-[13px] font-semibold leading-none">
			<Show when={props.value === "none"}>
				<span>Aa</span>
			</Show>
			<Show when={props.value === "fade"}>
				<span class={fx()} style={{ opacity: 0.45 }}>
					Aa
				</span>
			</Show>
			<Show when={props.value === "slideUp"}>
				<span class={fx()}>Aa ↑</span>
			</Show>
			<Show when={props.value === "slideDown"}>
				<span class={fx()}>Aa ↓</span>
			</Show>
			<Show when={props.value === "slideLeft"}>
				<span class={fx()}>← Aa</span>
			</Show>
			<Show when={props.value === "slideRight"}>
				<span class={fx()}>Aa →</span>
			</Show>
			<Show when={props.value === "pop"}>
				<span class={fx()} style={{ transform: "scale(1.15)" }}>
					Aa
				</span>
			</Show>
			<Show when={props.value === "zoom"}>
				<span class={fx()} style={{ transform: "scale(0.85)" }}>
					Aa
				</span>
			</Show>
			<Show when={props.value === "bounce"}>
				<span class="flex flex-col gap-[3px] items-center">
					<span class={fx()} style={{ transform: "translateY(-2px)" }}>
						Aa
					</span>
					<span
						class="w-[14px] h-[1.5px] bg-current"
						style={{ opacity: 0.4 }}
					/>
				</span>
			</Show>
			<Show when={props.value === "wipe"}>
				<span
					class={cx("inline-flex gap-[2px] items-center", fx())}
					style={{ "clip-path": "inset(0 0 0 0)" }}
				>
					<span>A</span>
					<span class="w-px h-[12px] bg-current" />
					<span style={{ opacity: 0.35 }}>a</span>
				</span>
			</Show>
			<Show when={props.value === "words"}>
				<span class={cx("inline-flex gap-[3px] items-center", fx())}>
					<span>Aa</span>
					<span style={{ opacity: 0.35 }}>Bb</span>
				</span>
			</Show>
			<Show when={props.value === "letters"}>
				<span class={cx("inline-flex items-center", fx())}>
					<span>A</span>
					<span style={{ opacity: 0.35 }}>a</span>
				</span>
			</Show>
			<Show when={props.value === "tracking"}>
				<span class={fx()} style={{ "letter-spacing": "4px" }}>
					Aa
				</span>
			</Show>
			<Show when={props.value === "typewriter"}>
				<span class="inline-flex items-center">
					<span class={fx()} style={{ "clip-path": "inset(0 0 0 0)" }}>
						Aa
					</span>
					<span class="text-ed-accent">▏</span>
				</span>
			</Show>
		</span>
	);
}

function AnimationTile(props: {
	value: TextAnimation;
	label: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={props.active}
			onClick={() => props.onSelect()}
			class={cx(
				"ta-tile flex flex-col gap-1 justify-center items-center h-[52px] rounded-[9px] transition-colors",
				props.active
					? "bg-ed-accent/12 text-ed-accent ring-1 ring-inset ring-ed-accent/40"
					: "bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover",
			)}
		>
			<AnimationDepiction value={props.value} />
			<span class="text-[10.5px] font-medium leading-none">{props.label}</span>
		</button>
	);
}

export function TextSegmentConfig(props: {
	segmentIndex: number;
	segment: TextSegment;
	brandColorSwatches: OrganizationBrandColorSwatch[];
}) {
	const { setProject } = useEditorContext();
	const [installedFonts] = createResource(listSystemFonts, {
		initialValue: [],
	});
	const [styleGroup, setStyleGroup] = createSignal(TEXT_PRESET_GROUPS[0]);
	const [animationEdge, setAnimationEdge] = createSignal<"in" | "out">("in");

	const updateSegment = (fn: (segment: TextSegment) => void) => {
		setProject(
			"timeline",
			"textSegments",
			produce((segments) => {
				const target = segments?.[props.segmentIndex];
				if (!target) return;
				fn(target);
			}),
		);
	};

	const activePresetId = createMemo(() =>
		matchTextPreset(props.segment, installedFonts()),
	);

	const visiblePresets = createMemo(() =>
		styleGroup() === TEXT_PRESET_GROUPS[0]
			? TEXT_PRESETS
			: TEXT_PRESETS.filter((preset) => preset.group === styleGroup()),
	);

	const backgroundOption = (): BackgroundOption =>
		props.segment.backgroundColor == null
			? "none"
			: (props.segment.backgroundStyle ?? "box");

	const edgeAnimation = () =>
		animationEdge() === "in"
			? (props.segment.animationIn ?? "fade")
			: (props.segment.animationOut ?? "fade");

	const edgeDuration = () =>
		clampNumber(
			animationEdge() === "in"
				? (props.segment.animationInDuration ?? 0.15)
				: (props.segment.animationOutDuration ?? 0.15),
			0,
			3,
		);

	const setEdgeAnimation = (value: TextAnimation) =>
		updateSegment((segment) => {
			if (animationEdge() === "in") segment.animationIn = value;
			else segment.animationOut = value;
		});

	const setEdgeDuration = (value: number) =>
		updateSegment((segment) => {
			const clamped = clampNumber(value, 0, 3);
			if (animationEdge() === "in") segment.animationInDuration = clamped;
			else segment.animationOutDuration = clamped;
			// Old builds only know fadeDuration; keep it tracking the slower
			// edge so a project opened there still fades sensibly.
			segment.fadeDuration = Math.max(
				segment.animationInDuration ?? 0.15,
				segment.animationOutDuration ?? 0.15,
			);
		});

	const layout = () => props.segment.layout ?? "overlay";

	return (
		<div class="flex flex-col gap-4">
			<Section
				name={`Text ${props.segmentIndex + 1}`}
				action={
					<div class="flex gap-2 items-center">
						<span class="text-[11px] text-ed-text-3">Enabled</span>
						<Toggle
							size="sm"
							checked={props.segment.enabled}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.enabled = value;
								})
							}
						/>
					</div>
				}
			>
				<textarea
					class="min-h-[72px] w-full resize-none rounded-[9px] border-0 bg-ed-ctl px-3 py-2 text-[13px] leading-[18px] text-ed-text-1 caret-ed-accent outline-hidden placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
					placeholder="Type something…"
					value={props.segment.content}
					onInput={(e) =>
						updateSegment((segment) => {
							segment.content = e.currentTarget.value;
						})
					}
				/>
				<div class="flex gap-2 items-center">
					<ToggleChip
						label="I"
						title="Italic"
						italic
						active={props.segment.italic}
						onClick={() =>
							updateSegment((segment) => {
								segment.italic = !segment.italic;
							})
						}
					/>
					<ToggleChip
						label="AA"
						title="Uppercase"
						active={props.segment.uppercase ?? false}
						onClick={() =>
							updateSegment((segment) => {
								segment.uppercase = !segment.uppercase;
							})
						}
					/>
					<div class="ml-auto">
						<Segmented
							ariaLabel="Text alignment"
							options={TEXT_ALIGN_OPTIONS}
							value={props.segment.align ?? "center"}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.align = value;
								})
							}
						/>
					</div>
				</div>
			</Section>

			<Section name="Style">
				<div class="flex overflow-x-auto gap-1 hide-scroll">
					<For each={TEXT_PRESET_GROUPS}>
						{(group) => (
							<button
								type="button"
								aria-pressed={styleGroup() === group}
								onClick={() => setStyleGroup(group)}
								class={cx(
									"flex shrink-0 items-center px-1.5 h-[22px] text-[11px] font-medium rounded-full transition-colors",
									styleGroup() === group
										? "bg-ed-ctl-active text-ed-text-1"
										: "text-ed-text-2 hover:text-ed-text-1",
								)}
							>
								{group}
							</button>
						)}
					</For>
				</div>
				<div class="grid grid-cols-2 gap-2">
					<For each={visiblePresets()}>
						{(preset) => (
							<TextPresetCard
								preset={preset}
								active={activePresetId() === preset.id}
								onApply={() =>
									updateSegment((segment) =>
										applyTextPreset(segment, preset, installedFonts()),
									)
								}
							/>
						)}
					</For>
				</div>
			</Section>

			<Section name="Font">
				<FontPicker
					value={props.segment.fontFamily ?? "sans-serif"}
					onChange={(family) =>
						updateSegment((segment) => {
							segment.fontFamily = family;
						})
					}
				/>
				<TextStyleSelect
					options={TEXT_SEGMENT_WEIGHT_OPTIONS}
					value={props.segment.fontWeight}
					onChange={(value) =>
						updateSegment((segment) => {
							segment.fontWeight = value;
						})
					}
					fallbackLabel={(value) => `Custom (${value})`}
				/>
				<div class="flex flex-col">
					<Field
						inline
						name="Size"
						value={Math.round(
							clampNumber(
								props.segment.fontSize,
								TEXT_FONT_SIZE_MIN,
								TEXT_FONT_SIZE_MAX,
							),
						)}
					>
						<Slider
							value={[
								clampNumber(
									props.segment.fontSize,
									TEXT_FONT_SIZE_MIN,
									TEXT_FONT_SIZE_MAX,
								),
							]}
							onChange={([value]) =>
								updateSegment((segment) => {
									const newFontSize = clampNumber(
										value,
										TEXT_FONT_SIZE_MIN,
										TEXT_FONT_SIZE_MAX,
									);
									const oldFontSize = segment.fontSize || 48;
									const scale = newFontSize / oldFontSize;

									segment.fontSize = newFontSize;

									// Scale the box with the font so line wrapping is
									// preserved; keep the top edge fixed since the renderer
									// anchors text at the top of the box (the canvas overlay
									// re-hugs the box to the exact glyph bounds when visible).
									if (segment.size && segment.center) {
										const topEdge = segment.center.y - segment.size.y / 2;
										segment.size.x = Math.min(segment.size.x * scale, 1);
										segment.size.y = segment.size.y * scale;
										segment.center.y = topEdge + segment.size.y / 2;
									}
								})
							}
							minValue={TEXT_FONT_SIZE_MIN}
							maxValue={TEXT_FONT_SIZE_MAX}
							step={1}
						/>
					</Field>
					<Field
						inline
						name="Line height"
						value={clampNumber(props.segment.lineHeight ?? 1.2, 0.8, 2).toFixed(
							2,
						)}
					>
						<Slider
							value={[clampNumber(props.segment.lineHeight ?? 1.2, 0.8, 2)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.lineHeight = clampNumber(value, 0.8, 2);
								})
							}
							minValue={0.8}
							maxValue={2}
							step={0.05}
						/>
					</Field>
					<Field
						inline
						name="Letter spacing"
						value={`${clampNumber(
							props.segment.letterSpacing ?? 0,
							-2,
							20,
						).toFixed(1)}px`}
					>
						<Slider
							value={[clampNumber(props.segment.letterSpacing ?? 0, -2, 20)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.letterSpacing = clampNumber(value, -2, 20);
								})
							}
							minValue={-2}
							maxValue={20}
							step={0.5}
							formatTooltip="px"
						/>
					</Field>
				</div>
			</Section>

			<Section name="Look">
				<Field name="Color">
					<HexColorInput
						value={props.segment.color}
						brandColorSwatches={props.brandColorSwatches}
						onChange={(value) =>
							updateSegment((segment) => {
								segment.color = value;
							})
						}
					/>
				</Field>
				<Field inline name="Gradient">
					<Toggle
						size="sm"
						checked={props.segment.gradientColor != null}
						onChange={(enabled) =>
							updateSegment((segment) => {
								segment.gradientColor = enabled
									? DEFAULT_GRADIENT_COLOR
									: undefined;
							})
						}
					/>
				</Field>
				<Show when={props.segment.gradientColor != null}>
					<HexColorInput
						value={props.segment.gradientColor ?? DEFAULT_GRADIENT_COLOR}
						brandColorSwatches={props.brandColorSwatches}
						onChange={(value) =>
							updateSegment((segment) => {
								segment.gradientColor = value;
							})
						}
					/>
				</Show>
				<Field name="Background">
					<Segmented
						stretch
						ariaLabel="Text background"
						options={TEXT_BACKGROUND_OPTIONS}
						value={backgroundOption()}
						onChange={(value) =>
							updateSegment((segment) => {
								if (value === "none") {
									segment.backgroundColor = undefined;
									return;
								}
								segment.backgroundStyle = value;
								if (segment.backgroundColor == null)
									segment.backgroundColor = "#000000";
							})
						}
					/>
				</Field>
				<Show when={props.segment.backgroundColor != null}>
					<HexColorInput
						value={props.segment.backgroundColor ?? "#000000"}
						brandColorSwatches={props.brandColorSwatches}
						onChange={(value) =>
							updateSegment((segment) => {
								segment.backgroundColor = value;
							})
						}
					/>
				</Show>
				<div class="flex flex-col">
					<Field
						inline
						name="Outline"
						value={`${clampNumber(
							props.segment.strokeWidth ?? 0,
							0,
							12,
						).toFixed(1)}px`}
					>
						<Slider
							value={[clampNumber(props.segment.strokeWidth ?? 0, 0, 12)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.strokeWidth = clampNumber(value, 0, 12);
								})
							}
							minValue={0}
							maxValue={12}
							step={0.5}
							formatTooltip="px"
						/>
					</Field>
					<Show when={(props.segment.strokeWidth ?? 0) > 0}>
						<HexColorInput
							value={props.segment.strokeColor ?? "#000000"}
							brandColorSwatches={props.brandColorSwatches}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.strokeColor = value;
								})
							}
						/>
					</Show>
					<Field
						inline
						name="Shadow"
						value={`${Math.round(clampNumber(props.segment.shadow ?? 0, 0, 1) * 100)}%`}
					>
						<Slider
							value={[clampNumber(props.segment.shadow ?? 0, 0, 1)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.shadow = clampNumber(value, 0, 1);
								})
							}
							minValue={0}
							maxValue={1}
							step={0.01}
						/>
					</Field>
					<Field
						inline
						name="Glow"
						value={`${Math.round(clampNumber(props.segment.glow ?? 0, 0, 1) * 100)}%`}
					>
						<Slider
							value={[clampNumber(props.segment.glow ?? 0, 0, 1)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.glow = clampNumber(value, 0, 1);
								})
							}
							minValue={0}
							maxValue={1}
							step={0.01}
						/>
					</Field>
					<Field
						inline
						name="Opacity"
						value={`${Math.round(clampNumber(props.segment.opacity ?? 1, 0, 1) * 100)}%`}
					>
						<Slider
							value={[clampNumber(props.segment.opacity ?? 1, 0, 1)]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.opacity = clampNumber(value, 0, 1);
								})
							}
							minValue={0}
							maxValue={1}
							step={0.01}
						/>
					</Field>
				</div>
			</Section>

			<Section
				name="Animation"
				action={
					<Segmented
						ariaLabel="Animation edge"
						options={ANIMATION_EDGE_OPTIONS}
						value={animationEdge()}
						onChange={setAnimationEdge}
					/>
				}
			>
				<div class="grid grid-cols-3 gap-1.5">
					<For each={TEXT_ANIMATION_OPTIONS}>
						{(option) => (
							<AnimationTile
								value={option.value}
								label={option.label}
								active={edgeAnimation() === option.value}
								onSelect={() => setEdgeAnimation(option.value)}
							/>
						)}
					</For>
				</div>
				<Show when={edgeAnimation() !== "none"}>
					<Field inline name="Duration" value={`${edgeDuration().toFixed(2)}s`}>
						<Slider
							value={[edgeDuration()]}
							onChange={([value]) => setEdgeDuration(value)}
							minValue={0}
							maxValue={3}
							step={0.05}
							formatTooltip="s"
						/>
					</Field>
				</Show>
			</Section>

			<Section name="Layout">
				<Segmented
					stretch
					ariaLabel="Text layout"
					options={TEXT_LAYOUT_OPTIONS}
					value={layout()}
					onChange={(value) =>
						updateSegment((segment) => {
							if ((segment.layout ?? "overlay") === value) return;
							segment.layout = value;
							// A takeover layout implies where the text belongs; place it
							// there so the result reads immediately (still draggable
							// afterwards).
							const center = TEXT_LAYOUT_CENTERS[value];
							if (center) segment.center = { ...center };
						})
					}
				/>
				<Show when={layout() === "fullscreen"}>
					<p class="text-[12px] leading-snug text-ed-text-3">
						Pauses the video while the text is shown, then resumes where it left
						off.
					</p>
				</Show>
				<Show when={layout() !== "overlay"}>
					<Field
						inline
						name="Screen transition"
						value={`${clampNumber(
							props.segment.layoutTransition ?? 0.5,
							0.1,
							1.5,
						).toFixed(2)}s`}
					>
						<Slider
							value={[
								clampNumber(props.segment.layoutTransition ?? 0.5, 0.1, 1.5),
							]}
							onChange={([value]) =>
								updateSegment((segment) => {
									segment.layoutTransition = clampNumber(value, 0.1, 1.5);
								})
							}
							minValue={0.1}
							maxValue={1.5}
							step={0.05}
							formatTooltip="s"
						/>
					</Field>
				</Show>
			</Section>
		</div>
	);
}
