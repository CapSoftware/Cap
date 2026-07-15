import { createWritableMemo } from "@solid-primitives/memo";
import {
	getHexColorDigitCount,
	normalizeOpaqueHexColor,
} from "~/utils/hex-color";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import { BrandColorsDropdown } from "./BrandColorsDropdown";
import { getColorPreviewBorderColor } from "./color-utils";
import { TextInput } from "./TextInput";

export const FONT_OPTIONS = [
	{ value: "System Sans-Serif", label: "系统无衬线体" },
	{ value: "System Serif", label: "系统衬线体" },
	{ value: "System Monospace", label: "系统等宽体" },
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
	{ label: "中等", value: 500 },
	{ label: "粗体", value: 700 },
];

export const CAPTION_ANIMATION_OPTIONS = [
	{ value: "none", label: "无" },
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
			<div class="flex flex-row items-center gap-[0.75rem] relative">
				<button
					type="button"
					class="size-[2rem] rounded-[0.5rem]"
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
					class="absolute left-0 bottom-0 size-[2rem] opacity-0"
					value={text()}
					onChange={(e) => {
						setText(e.target.value);
						props.onChange(e.target.value);
					}}
				/>
				<TextInput
					class="w-[5rem] p-[0.375rem] border border-gray-3 text-gray-12 rounded-[0.5rem] bg-gray-2"
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
