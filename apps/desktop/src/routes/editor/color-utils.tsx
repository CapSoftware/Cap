import { createWritableMemo } from "@solid-primitives/memo";
import { getHexColorDigitCount, hexToRgb } from "~/utils/hex-color";
import { TextInput } from "./TextInput";

export { hexToRgb } from "~/utils/hex-color";

export function getColorPreviewBorderColor(color: string) {
	return `color-mix(in srgb, ${color} 82%, black)`;
}

export function rgbToHex(rgb: [number, number, number]) {
	return `#${rgb
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}`;
}

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
		<div class="flex flex-row items-center gap-[0.75rem] relative">
			<button
				type="button"
				class="size-[2rem] rounded-[0.5rem]"
				style={{
					"background-color": rgbToHex(props.value),
					"box-shadow": `inset 0 0 0 1px ${getColorPreviewBorderColor(
						rgbToHex(props.value),
					)}`,
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 w-[3rem] opacity-0"
				value={rgbToHex(props.value)}
				onChange={(e) => {
					const value = hexToRgb(e.target.value);
					if (!value) return;

					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
			/>
			<TextInput
				class="w-[4.60rem] p-[0.375rem] text-gray-12 text-[13px] border rounded-[0.5rem] bg-gray-1 outline-none focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
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
