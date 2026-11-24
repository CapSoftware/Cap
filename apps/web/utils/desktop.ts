import type { HonoRequest } from "hono";

export function isFromDesktopSemver(
	request: HonoRequest,
	semver: readonly [number, number, number],
) {
	const xCapVersion = request.header("X-Cap-Desktop-Version");

	return xCapVersion ? isAtLeastSemver(xCapVersion, ...semver) : false;
}

export const UPLOAD_PROGRESS_VERSION = [0, 3, 68] as const;
export const GOOGLE_DRIVE_UPLOAD_FEATURE = "googleDriveUpload";

export function hasDesktopFeature(request: HonoRequest, feature: string) {
	return (
		request
			.header("X-Cap-Desktop-Features")
			?.split(",")
			.map((value) => value.trim())
			.includes(feature) ?? false
	);
}

const DESKTOP_VERSION_PATTERN =
	/^v?\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

export function desktopClientInfo(request: HonoRequest) {
	const version = request.header("X-Cap-Desktop-Version")?.trim();
	if (!version || !DESKTOP_VERSION_PATTERN.test(version)) return undefined;
	return { version, gpui: hasDesktopFeature(request, "gpui") };
}

export function isAtLeastSemver(
	versionString: string,
	major: number,
	minor: number,
	patch: number,
): boolean {
	const match = versionString
		.replace(/^v/, "")
		.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
	if (!match) return false;
	const [, vMajor, vMinor, vPatch, prerelease] = match;
	const M = vMajor ? parseInt(vMajor, 10) || 0 : 0;
	const m = vMinor ? parseInt(vMinor, 10) || 0 : 0;
	const p = vPatch ? parseInt(vPatch, 10) || 0 : 0;
	if (M > major) return true;
	if (M < major) return false;
	if (m > minor) return true;
	if (m < minor) return false;
	if (p > patch) return true;
	if (p < patch) return false;
	// Equal triplet: accept only non-prerelease
	return !prerelease;
}
