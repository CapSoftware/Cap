import { createWritableMemo } from "@solid-primitives/memo";
import {
	getHexColorDigitCount,
	normalizeOpaqueHexColor,
} from "~/utils/hex-color";
import { getColorPreviewBorderColor } from "./color-utils";
import { TextInput } from "./TextInput";

export const FONT_OPTIONS = [
	{ value: "System Sans-Serif", label: "System Sans-Serif" },
	{ value: "System Serif", label: "System Serif" },
	{ value: "System Monospace", label: "System Monospace" },
];

export const CAPTION_POSITION_OPTIONS = [
	{ value: "top-left", label: "Top Left" },
	{ value: "top-center", label: "Top Center" },
	{ value: "top-right", label: "Top Right" },
	{ value: "bottom-left", label: "Bottom Left" },
	{ value: "bottom-center", label: "Bottom Center" },
	{ value: "bottom-right", label: "Bottom Right" },
];

export const KEYBOARD_POSITION_OPTIONS = [
	{ value: "top-left", label: "Top Left" },
	{ value: "top-center", label: "Top Center" },
	{ value: "top-right", label: "Top Right" },
	{ value: "bottom-left", label: "Bottom Left" },
	{ value: "bottom-center", label: "Bottom Center" },
	{ value: "bottom-right", label: "Bottom Right" },
];

export const TEXT_WEIGHT_OPTIONS = [
	{ label: "Normal", value: 400 },
	{ label: "Medium", value: 500 },
	{ label: "Bold", value: 700 },
];

export function getTextWeightLabel(weight: number | null | undefined) {
	const option = TEXT_WEIGHT_OPTIONS.find((option) => option.value === weight);
	if (option) return option.label;
	if (weight != null) return `Custom (${weight})`;
	return "Normal";
}

export function HexColorInput(props: {
	value: string;
	onChange: (value: string) => void;
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

	return (
		<div class="flex flex-row items-center gap-3 relative">
			<button
				type="button"
				class="size-8 rounded-lg"
				style={{
					"background-color": text(),
					"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(text())}`,
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 size-8 opacity-0"
				value={text()}
				onChange={(e) => {
					setText(e.target.value);
					props.onChange(e.target.value);
				}}
			/>
			<TextInput
				class="w-20 p-1.5 border border-gray-3 text-gray-12 rounded-lg bg-gray-2"
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
	);
}
