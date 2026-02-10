type ChromeStorageArea = {
	get: (
		keys: string[],
		callback: (items: Record<string, unknown>) => void,
	) => void;
	set: (items: Record<string, unknown>, callback?: () => void) => void;
	remove: (keys: string[], callback?: () => void) => void;
};

type ChromeRuntime = {
	lastError?: { message: string };
	getURL: (path: string) => string;
};

type ChromeTabs = {
	create: (properties: { url: string; active?: boolean }) => void;
};

type ChromeIdentity = {
	getRedirectURL: (path?: string) => string;
	launchWebAuthFlow: (
		details: { url: string; interactive: boolean },
		callback: (responseUrl?: string) => void,
	) => void;
};

declare const chrome: {
	storage: { local: ChromeStorageArea };
	identity: ChromeIdentity;
	runtime: ChromeRuntime;
	tabs: ChromeTabs;
};

interface ImportMetaEnv {
	readonly VITE_CAP_WEB_ORIGIN?: string;
	readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
