export type DownloadFamily = "macos" | "windows" | "linux";

export type DownloadTarget = {
	key: string;
	family: DownloadFamily;
	name: string;
	installerUrl: string;
	steps: readonly string[];
};

const LAST_STEP = "Open Cap and record your first video.";

const target = (
	key: string,
	family: DownloadFamily,
	name: string,
	steps: readonly string[],
): DownloadTarget => ({
	key,
	family,
	name,
	installerUrl: `/download/${key}`,
	steps: [...steps, LAST_STEP],
});

const MAC_STEPS = [
	"Open the Cap disk image from your Downloads folder.",
	"Drag Cap into Applications.",
];

const LINUX_PACKAGE_STEPS = [
	"Find the Cap package in your Downloads folder.",
	"Install it with your package manager or software installer.",
];

export const DOWNLOAD_TARGETS: Record<string, DownloadTarget> = {
	"apple-silicon": target("apple-silicon", "macos", "macOS", MAC_STEPS),
	"apple-intel": target("apple-intel", "macos", "macOS", MAC_STEPS),
	windows: target("windows", "windows", "Windows", [
		"Run the Cap installer from your Downloads folder.",
		"Follow the setup. If Windows SmartScreen appears, choose More info, then Run anyway.",
	]),
	"linux-deb": target("linux-deb", "linux", "Linux", LINUX_PACKAGE_STEPS),
	"linux-rpm": target("linux-rpm", "linux", "Linux", LINUX_PACKAGE_STEPS),
	"linux-pacman": target("linux-pacman", "linux", "Linux", LINUX_PACKAGE_STEPS),
	"linux-appimage": target("linux-appimage", "linux", "Linux", [
		"Find the Cap AppImage in your Downloads folder.",
		"Make it executable, then open it.",
	]),
};

export const getDownloadTarget = (
	key: string | string[] | null | undefined,
): DownloadTarget | null => {
	if (typeof key !== "string") return null;
	return Object.hasOwn(DOWNLOAD_TARGETS, key)
		? (DOWNLOAD_TARGETS[key] ?? null)
		: null;
};

const STARTED_FLAG = "capDownloadStarted";

// The flag lives on the history entry, so a reload or a trip back to the page
// does not fetch the installer a second time, while a fresh click does.
export const claimDownloadStart = (
	history: Pick<History, "state" | "replaceState">,
): boolean => {
	const state: unknown = history.state;
	const previous =
		state && typeof state === "object"
			? (state as Record<string, unknown>)
			: {};
	if (previous[STARTED_FLAG]) return false;
	history.replaceState({ ...previous, [STARTED_FLAG]: true }, "");
	return true;
};

export const getDownloadStartedUrl = (installerUrl: string): string => {
	const key = installerUrl.replace(/^\/download\//, "");
	return getDownloadTarget(key)
		? `/download/started?platform=${key}`
		: installerUrl;
};
