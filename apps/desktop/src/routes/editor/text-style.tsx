import { createWritableMemo } from "@solid-primitives/memo";
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
		const trimmed = raw.trim();
		if (/^#[0-9A-F]{6}$/i.test(trimmed)) {
			const normalized = `#${trimmed.slice(1).toUpperCase()}`;
			props.onChange(normalized);
			setText(normalized);
			return true;
		}
		return false;
	};

	return (
		<div class="flex flex-row items-center gap-[0.75rem] relative">
			<button
				type="button"
				class="size-[2rem] rounded-[0.5rem]"
				style={{
					"background-color": text(),
					"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(text())}`,
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
					const trimmed = e.currentTarget.value.trim();
					if (/^#[0-9A-F]{6}$/i.test(trimmed)) {
						const normalized = `#${trimmed.slice(1).toUpperCase()}`;
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
