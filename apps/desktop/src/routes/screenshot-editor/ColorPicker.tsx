import { createWritableMemo } from "@solid-primitives/memo";
import { getHexColorDigitCount, hexToRgb } from "~/utils/hex-color";
import { TextInput } from "./TextInput";

export { hexToRgb } from "~/utils/hex-color";

export const BACKGROUND_COLORS = [
	"#FF0000", // Red
	"#FF4500", // Orange-Red
	"#FF8C00", // Orange
	"#FFD700", // Gold
	"#FFFF00", // Yellow
	"#ADFF2F", // Green-Yellow
	"#32CD32", // Lime Green
	"#008000", // Green
	"#00CED1", // Dark Turquoise
	"#4785FF", // Dodger Blue
	"#0000FF", // Blue
	"#4B0082", // Indigo
	"#800080", // Purple
	"#A9A9A9", // Dark Gray
	"#FFFFFF", // White
	"#000000", // Black
	"#00000000", // Transparent
];

export function RgbInput(props: {
	value: [number, number, number];
	onChange: (value: [number, number, number]) => void;
}) {
	const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
	let prevHex = rgbToHex(props.value);
	let colorInput!: HTMLInputElement;

	const commitValue = (raw: string) => {
		const trimmed = raw.trim();
		const value = hexToRgb(trimmed);
		if (value) {
			const [r, g, b] = value;
			props.onChange([r, g, b]);
			setText(rgbToHex([r, g, b]));
			return true;
		}
		return false;
	};

	return (
		<div class="flex flex-row items-center gap-3 relative">
			<button
				type="button"
				class="size-8 rounded-lg border border-gray-4"
				style={{
					"background-color": rgbToHex(props.value),
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 w-12 opacity-0"
				value={rgbToHex(props.value)}
				onChange={(e) => {
					const value = hexToRgb(e.target.value);
					if (!value) return;
					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
			/>
			<TextInput
				class="w-[4.60rem] p-1.5 text-gray-12 text-[13px] border rounded-lg bg-gray-1 outline-hidden focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
				value={text()}
				onFocus={() => {
					prevHex = rgbToHex(props.value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (!commitValue(e.currentTarget.value)) {
							setText(prevHex);
						}
						e.currentTarget.blur();
					}
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);
					const digitCount = getHexColorDigitCount(e.currentTarget.value);
					if (digitCount !== 6 && digitCount !== 8) return;

					const value = hexToRgb(e.currentTarget.value.trim());
					if (!value) return;
					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
				onBlur={(e) => {
					if (!commitValue(e.target.value)) {
						setText(prevHex);
						props.onChange(props.value);
					}
				}}
			/>
		</div>
	);
}

export function rgbToHex(rgb: [number, number, number]) {
	return `#${rgb
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}`;
}
