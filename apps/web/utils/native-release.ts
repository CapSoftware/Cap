import { isAtLeastSemver } from "@/utils/desktop";

export const LAST_TAURI_VERSION = "0.6.0";

const FIRST_NATIVE_DESKTOP_VERSION = [0, 6, 1] as const;

export function nativeDesktopReleaseIsLive(
	releases: readonly { version: string }[],
): boolean {
	const [major, minor, patch] = FIRST_NATIVE_DESKTOP_VERSION;
	return releases.some((release) =>
		isAtLeastSemver(release.version, major, minor, patch),
	);
}
