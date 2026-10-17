import { createWritableMemo } from "@solid-primitives/memo";
import {
	getHexColorDigitCount,
	normalizeOpaqueHexColor,
} from "~/utils/hex-color";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import { BrandColorsDropdown } from "./BrandColorsDropdown";
import { getColorPreviewBorderColor } from "./color-utils";
import { TextInput } from "./TextInput";
import type { TextAnimation, TextBackgroundStyle } from "./text";

export const FONT_OPTIONS = [
	{ value: "System Sans-Serif", label: "System Sans-Serif" },
	{ value: "System Serif", label: "System Serif" },
	{ value: "System Monospace", label: "System Monospace" },
];

export const CAPTION_POSITION_OPTIONS = [
	{ value: "manual", label: "手动" },
	{ value: "top-left", label: "左上" },
	{ value: "top-center", label: "顶部居中" },
	{ value: "top-right", label: "右上" },
	{ value: "bottom-left", label: "左下" },
	{ value: "bottom-center", label: "底部居中" },
	{ value: "bottom-right", label: "右下" },
];

export const KEYBOARD_POSITION_OPTIONS = [
	{ value: "top-left", label: "左上" },
	{ value: "top-center", label: "顶部居中" },
	{ value: "top-right", label: "右上" },
	{ value: "bottom-left", label: "左下" },
	{ value: "bottom-center", label: "底部居中" },
	{ value: "bottom-right", label: "右下" },
];

export const TEXT_WEIGHT_OPTIONS = [
	{ label: "常规", value: 400 },
	{ label: "中", value: 500 },
	{ label: "粗体", value: 700 },
];

export const TEXT_SEGMENT_WEIGHT_OPTIONS = [
	{ label: "浅色", value: 300 },
	{ label: "常规", value: 400 },
	{ label: "中", value: 500 },
	{ label: "半粗", value: 600 },
	{ label: "粗体", value: 700 },
	{ label: "特粗", value: 800 },
	{ label: "黑色", value: 900 },
];

export const TEXT_ANIMATION_OPTIONS: {
	value: TextAnimation;
	label: string;
}[] = [
	{ value: "none", label: "None" },
	{ value: "fade", label: "淡入淡出" },
	{ value: "slideUp", label: "向上滑动" },
	{ value: "slideDown", label: "向下滑动" },
	{ value: "slideLeft", label: "向左滑动" },
	{ value: "slideRight", label: "向右滑动" },
	{ value: "pop", label: "弹出" },
	{ value: "zoom", label: "缩放" },
	{ value: "bounce", label: "弹跳" },
	{ value: "wipe", label: "擦除" },
	{ value: "words", label: "文字" },
	{ value: "letters", label: "字母" },
	{ value: "tracking", label: "字距" },
	{ value: "typewriter", label: "打字机" },
];

export const TEXT_BACKGROUND_STYLE_OPTIONS: {
	value: TextBackgroundStyle;
	label: string;
}[] = [
	{ value: "box", label: "方框" },
	{ value: "pill", label: "胶囊" },
	{ value: "highlight", label: "高亮" },
];

export const CAPTION_ANIMATION_OPTIONS = [
	{ value: "none", label: "None" },
	{ value: "bounce", label: "弹跳" },
	{ value: "pop", label: "弹出" },
];

export const CAPTION_HIGHLIGHT_STYLE_OPTIONS = [
	{ value: "color", label: "颜色" },
	{ value: "pill", label: "胶囊" },
];

export function getTextWeightLabel(weight: number | null | undefined) {
	const option = TEXT_WEIGHT_OPTIONS.find((option) => option.value === weight);
	if (option) return option.label;
	if (weight != null) return `Custom (${weight})`;
	return "常规";
}

export function HexColorInput(props: {
	value: string;
	onChange: (value: string) => void;
	brandColorSwatches?: OrganizationBrandColorSwatch[];
}) {
	const [text, setText] = createWritableMemo(() => props.value);
	let prevColor = props.value;
	let colorInput!: HTMLInputElement;

	const commitValue = (raw: string) => {
		const normalized = normalizeOpaqueHexColor(raw);
		if (normalized) {
			props.onChange(normalized);
			setText(normalized);
			return true;
		}
		return false;
	};

	const selectBrandColor = (color: string) => {
		setText(color);
		prevColor = color;
		props.onChange(color);
	};

	return (
		<div class="flex flex-col gap-2">
			<div class="flex relative flex-row gap-2 items-center">
				<button
					type="button"
					class="size-[30px] shrink-0 rounded-[7px]"
					style={{
						"background-color": text(),
						"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(
							text(),
						)}`,
					}}
					onClick={() => colorInput.click()}
				/>
				<input
					ref={colorInput}
					type="color"
					class="absolute bottom-0 left-0 opacity-0 size-[30px]"
					value={text()}
					onChange={(e) => {
						setText(e.target.value);
						props.onChange(e.target.value);
					}}
				/>
				<TextInput
					class="h-[30px] min-w-0 flex-1 rounded-[7px] border-0 bg-ed-ctl px-2 text-[12px] text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
					value={text()}
					onFocus={() => {
						prevColor = props.value;
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (!commitValue(e.currentTarget.value)) {
								setText(prevColor);
							}
							e.currentTarget.blur();
						}
					}}
					onInput={(e) => {
						setText(e.currentTarget.value);
						if (getHexColorDigitCount(e.currentTarget.value) !== 6) return;

						const normalized = normalizeOpaqueHexColor(e.currentTarget.value);
						if (normalized) {
							props.onChange(normalized);
						}
					}}
					onBlur={(e) => {
						if (!commitValue(e.target.value)) {
							setText(prevColor);
							props.onChange(props.value);
						}
					}}
				/>
			</div>
			<BrandColorsDropdown
				swatches={props.brandColorSwatches ?? []}
				onSelect={selectBrandColor}
			/>
		</div>
	);
}
