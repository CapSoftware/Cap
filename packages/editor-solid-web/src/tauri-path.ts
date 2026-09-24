const wallpaperPath =
	/^assets\/backgrounds\/(macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg$/;

export const BaseDirectory = {
	Audio: 1,
	Cache: 2,
	Config: 3,
	Data: 4,
	LocalData: 5,
	Document: 6,
	Download: 7,
	Picture: 8,
	Public: 9,
	Video: 10,
	Resource: 11,
	Temp: 12,
	AppConfig: 13,
	AppData: 14,
	AppLocalData: 15,
	AppCache: 16,
	AppLog: 17,
	Desktop: 18,
	Executable: 19,
	Font: 20,
	Home: 21,
	Runtime: 22,
	Template: 23,
} as const;

export async function resolveResource(path: string) {
	if (!wallpaperPath.test(path)) {
		throw new Error("Editor resource is unavailable in the browser");
	}
	return `cap-web-wallpaper://${path}`;
}

export async function appDataDir() {
	return "cap-web-editor://app-data";
}

export async function appLocalDataDir() {
	return "cap-web-editor://app-local-data";
}

export async function join(first: string, ...parts: string[]) {
	return [
		first.replace(/\/+$/, ""),
		...parts.map((part) => part.replace(/^\/+|\/+$/g, "")),
	].join("/");
}
