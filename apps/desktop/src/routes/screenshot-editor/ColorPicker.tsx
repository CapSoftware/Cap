import { createWritableMemo } from "@solid-primitives/memo";
import { TextInput } from "./TextInput";

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
				class="w-[4.60rem] p-1.5 text-gray-12 text-[13px] border rounded-lg bg-gray-1 outline-none focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
				value={text()}
				onFocus={() => {
					prevHex = rgbToHex(props.value);
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);
					const value = hexToRgb(e.target.value);
					if (!value) return;
					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
				onBlur={(e) => {
					const value = hexToRgb(e.target.value);
					if (value) {
						const [r, g, b] = value;
						props.onChange([r, g, b]);
					} else {
						setText(prevHex);
						const fallbackValue = hexToRgb(text());
						if (!fallbackValue) return;
						const [r, g, b] = fallbackValue;
						props.onChange([r, g, b]);
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

export function hexToRgb(hex: string): [number, number, number, number] | null {
	const match = hex.match(
		/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i,
	);
	if (!match) return null;
	const [, r, g, b, a] = match;
	const rgb = [
		Number.parseInt(r, 16),
		Number.parseInt(g, 16),
		Number.parseInt(b, 16),
	] as const;
	if (a) {
		return [...rgb, Number.parseInt(a, 16)];
	}
	return [...rgb, 255];
}
