type ChromeStorageArea = {
	get: (
		keys: string[],
		callback: (items: Record<string, unknown>) => void,
	) => void;
	set: (items: Record<string, unknown>, callback?: () => void) => void;
	remove: (keys: string[], callback?: () => void) => void;
};

type ChromeMessageSender = {
	tab?: ChromeTab;
	frameId?: number;
	id?: string;
	url?: string;
};

type ChromeMessageResponse = (response: unknown) => void;

type ChromeRuntime = {
	lastError?: { message: string };
	getURL: (path: string) => string;
	sendMessage: (
		message: unknown,
		callback?: (response: unknown) => void,
	) => void;
	onMessage: {
		addListener: (
			callback: (
				message: unknown,
				sender: ChromeMessageSender,
				sendResponse: ChromeMessageResponse,
			) => boolean | undefined,
		) => void;
	};
};

type ChromeTab = {
	id?: number;
	url?: string;
	active?: boolean;
	windowId?: number;
};

type ChromeTabs = {
	create: (properties: { url: string; active?: boolean }) => void;
	query: (
		queryInfo: { active?: boolean; currentWindow?: boolean },
		callback: (tabs: ChromeTab[]) => void,
	) => void;
	sendMessage: (
		tabId: number,
		message: unknown,
		callback?: (response: unknown) => void,
	) => void;
	onRemoved: {
		addListener: (
			callback: (tabId: number, removeInfo: { windowId: number }) => void,
		) => void;
	};
};

type ChromeScripting = {
	executeScript: (
		injection: {
			target: { tabId: number };
			files?: string[];
			func?: () => void;
		},
		callback?: (results: unknown[]) => void,
	) => void;
};

type ChromeIdentity = {
	getRedirectURL: (path?: string) => string;
	launchWebAuthFlow: (
		details: { url: string; interactive: boolean },
		callback: (responseUrl?: string) => void,
	) => void;
};

declare const chrome: {
	storage: {
		local: ChromeStorageArea;
		session: ChromeStorageArea;
	};
	identity: ChromeIdentity;
	runtime: ChromeRuntime;
	tabs: ChromeTabs;
	scripting: ChromeScripting;
};

interface ImportMetaEnv {
	readonly VITE_CAP_WEB_ORIGIN?: string;
	readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
