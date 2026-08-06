import type { Appearance } from "./tauri";

export function appearanceIsDark(
	appearance: Appearance | null | undefined,
	prefersDark: boolean,
) {
	if (appearance === "dark") return true;
	if (appearance === "light") return false;
	return prefersDark;
}
