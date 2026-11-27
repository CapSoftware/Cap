export function normalizeHexColor(value: string) {
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;

	const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
	if (!/^[\dA-F]+$/i.test(raw)) return null;

	if (raw.length === 3 || raw.length === 4) {
		return `#${raw
			.split("")
			.map((char) => `${char}${char}`)
			.join("")
			.toUpperCase()}`;
	}

	if (raw.length === 6 || raw.length === 8) {
		return `#${raw.toUpperCase()}`;
	}

	return null;
}

export function getHexColorDigitCount(value: string) {
	const trimmed = value.trim();
	if (trimmed.length === 0) return 0;

	const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
	if (!/^[\dA-F]+$/i.test(raw)) return 0;

	return raw.length;
}

export function normalizeOpaqueHexColor(value: string) {
	const normalized = normalizeHexColor(value);
	if (!normalized || normalized.length !== 7) return null;
	return normalized;
}

export function hexToRgb(hex: string): [number, number, number, number] | null {
	const normalized = normalizeHexColor(hex);
	if (!normalized) return null;

	const raw = normalized.slice(1);
	const r = Number.parseInt(raw.slice(0, 2), 16);
	const g = Number.parseInt(raw.slice(2, 4), 16);
	const b = Number.parseInt(raw.slice(4, 6), 16);
	const a = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) : 255;

	return [r, g, b, a];
}
