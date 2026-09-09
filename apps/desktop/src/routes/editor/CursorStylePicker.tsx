import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { RadioGroup as KRadioGroup } from "@kobalte/core/radio-group";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createMemo, For, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import Tooltip from "~/components/Tooltip";
import type { CursorRippleConfig, CursorType } from "~/utils/tauri";
import macArrow from "../../../../../crates/cursor-info/assets/mac/arrow.svg?raw";
import tahoeArrow from "../../../../../crates/cursor-info/assets/mac/tahoe/default.svg?raw";
import windowsArrow from "../../../../../crates/cursor-info/assets/windows/arrow.svg?raw";
import { RgbInput } from "./color-utils";
import { type TransformedMeta, useEditorContext } from "./context";
import { Field, Section, Slider } from "./ui";

export type CursorFamily = "macos" | "tahoe" | "windows";
type CursorStyle = CursorFamily | "circle";

const CURSOR_FAMILIES = {
	macos: { label: "macOS", arrow: macArrow },
	tahoe: { label: "macOS Tahoe", arrow: tahoeArrow },
	windows: { label: "Windows", arrow: windowsArrow },
} satisfies Record<CursorFamily, { label: string; arrow: string }>;

export const DEFAULT_CURSOR_RIPPLE: CursorRippleConfig = {
	enabled: false,
	color: [71, 133, 255],
	strength: 0.7,
	size: 1,
	duration: 0.6,
};

export function cursorFamilyFromShape(
	shape: string | null | undefined,
): CursorFamily | undefined {
	if (!shape) return undefined;
	const [namespace, name] = shape.split("|");
	if (namespace === "Windows") return "windows";
	if (namespace === "MacOS")
		return name?.startsWith("Tahoe") ? "tahoe" : "macos";
	return undefined;
}

export function recordedCursorFamily(
	meta: TransformedMeta,
): CursorFamily | undefined {
	if (meta.type !== "multiple") return undefined;
	for (const cursor of Object.values(meta.cursors)) {
		if (typeof cursor === "string") continue;
		const family = cursorFamilyFromShape(cursor.shape);
		if (family) return family;
	}
	return undefined;
}

export function isExplicitCursorFamily(type: CursorType): type is CursorFamily {
	return type === "macos" || type === "tahoe" || type === "windows";
}

function hostCursorFamily(): CursorFamily {
	return ostype() === "windows" ? "windows" : "macos";
}

function cursorStyleOrder(): CursorStyle[] {
	return ostype() === "windows"
		? ["windows", "macos", "tahoe", "circle"]
		: ["macos", "tahoe", "windows", "circle"];
}

function CursorArrow(props: { svg: string }) {
	return (
		<div class="h-[34px] [&>svg]:h-full [&>svg]:w-auto" innerHTML={props.svg} />
	);
}

function CircleCursor() {
	return (
		<div class="size-7 rounded-full bg-white/15 shadow-[0_0_0_1px_rgba(0,0,0,0.38),inset_0_0_0_1px_rgba(255,255,255,0.42),0_0_5px_rgba(0,0,0,0.16)]" />
	);
}

function CursorStyleCard(props: { style: CursorStyle; recorded: boolean }) {
	const label = () =>
		props.style === "circle" ? "Circle" : CURSOR_FAMILIES[props.style].label;

	const tile = () => (
		<div class="flex justify-center items-center w-full h-[60px] rounded-[10px] transition-shadow bg-ed-card-2 ring-1 ring-ed-line group-hover:ring-ed-line-strong group-data-checked:ring-2 group-data-checked:ring-ed-accent group-data-checked:ring-offset-2 group-data-checked:ring-offset-ed-card group-has-[input:focus-visible]:ring-2 group-has-[input:focus-visible]:ring-ed-accent">
			<Show
				when={props.style !== "circle" && props.style}
				fallback={<CircleCursor />}
			>
				{(family) => <CursorArrow svg={CURSOR_FAMILIES[family()].arrow} />}
			</Show>
		</div>
	);

	return (
		<KRadioGroup.Item value={props.style} class="group min-w-0">
			<KRadioGroup.ItemInput class="sr-only" />
			<KRadioGroup.ItemLabel class="flex cursor-pointer flex-col items-center gap-1.5">
				<Show when={props.recorded} fallback={tile()}>
					<Tooltip content="Recorded with this cursor" childClass="w-full">
						{tile()}
					</Tooltip>
				</Show>
				<span class="max-w-full text-[11px] font-medium leading-none truncate transition-colors text-ed-text-2 group-hover:text-ed-text-1 group-data-checked:text-ed-text-1">
					{label()}
				</span>
			</KRadioGroup.ItemLabel>
		</KRadioGroup.Item>
	);
}

export function CursorStylePicker() {
	const { project, setProject, meta } = useEditorContext();

	const recorded = createMemo(() => recordedCursorFamily(meta()));

	const selected = createMemo<CursorStyle>(() => {
		const type = project.cursor.type;
		if (type === "circle" || isExplicitCursorFamily(type)) return type;
		return recorded() ?? hostCursorFamily();
	});

	return (
		<Section name="Cursor style">
			<KRadioGroup
				class="grid grid-cols-4 gap-2"
				value={selected()}
				onChange={(value) => setProject("cursor", "type", value as CursorType)}
			>
				<For each={cursorStyleOrder()}>
					{(style) => (
						<CursorStyleCard style={style} recorded={recorded() === style} />
					)}
				</For>
			</KRadioGroup>
		</Section>
	);
}

export function CursorRippleSection() {
	const { project, setProject } = useEditorContext();

	const ripple = () => project.cursor.ripple ?? DEFAULT_CURSOR_RIPPLE;
	const updateRipple = (patch: Partial<CursorRippleConfig>) =>
		setProject("cursor", "ripple", { ...ripple(), ...patch });

	return (
		<KCollapsible open={ripple().enabled}>
			<Field name="Click Ripple" inline>
				<Toggle
					checked={ripple().enabled}
					onChange={(value) => updateRipple({ enabled: value })}
				/>
			</Field>
			<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
				<div class="flex flex-col gap-2 pt-1 pb-3.5">
					<Field name="Color">
						<RgbInput
							value={ripple().color}
							onChange={(color) => updateRipple({ color })}
						/>
					</Field>
					<Field
						name="Strength"
						inline
						value={`${Math.round(ripple().strength * 100)}%`}
					>
						<Slider
							value={[Math.round(ripple().strength * 100)]}
							onChange={(v) => updateRipple({ strength: v[0] / 100 })}
							minValue={0}
							maxValue={100}
							step={1}
							formatTooltip={(v) => `${Math.round(v)}%`}
						/>
					</Field>
					<Field
						name="Size"
						inline
						value={`${Math.round(ripple().size * 100)}%`}
					>
						<Slider
							value={[Math.round(ripple().size * 100)]}
							onChange={(v) => updateRipple({ size: v[0] / 100 })}
							minValue={25}
							maxValue={300}
							step={1}
							formatTooltip={(v) => `${Math.round(v)}%`}
						/>
					</Field>
					<Field
						name="Duration"
						inline
						value={`${ripple().duration.toFixed(2)}s`}
					>
						<Slider
							value={[ripple().duration]}
							onChange={(v) => updateRipple({ duration: v[0] })}
							minValue={0.2}
							maxValue={1.5}
							step={0.05}
							formatTooltip={(v) => `${v.toFixed(2)}s`}
						/>
					</Field>
				</div>
				<div class="w-full border-t border-ed-line" />
			</KCollapsible.Content>
		</KCollapsible>
	);
}
