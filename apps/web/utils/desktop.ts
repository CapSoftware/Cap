import type { HonoRequest } from "hono";

export function isFromDesktopSemver(
	request: HonoRequest,
	semver: readonly [number, number, number],
) {
	const xCapVersion = request.header("X-Cap-Desktop-Version");

	return xCapVersion ? isAtLeastSemver(xCapVersion, ...semver) : false;
}

export const UPLOAD_PROGRESS_VERSION = [0, 3, 68] as const;

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
