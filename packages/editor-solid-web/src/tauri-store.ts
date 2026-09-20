const PERSISTED_EDITOR_KEYS = new Set([
	"presets",
	"animated_gradients",
	"general_settings",
	"hotkeys",
	"recording_settings",
]);
const STUDIO_SOUND_KEY = "audio_enhancement";
const STUDIO_SOUND_URL = "/api/editor/preferences/studio-sound";
const DEFAULT_STUDIO_SOUND = {
	enabledByDefault: true,
	isolation: "balanced",
} as const;

function isStudioSoundPreference(value: unknown): value is {
	enabledByDefault: boolean;
	isolation: "light" | "balanced" | "strong";
} {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.enabledByDefault === "boolean" &&
		(record.isolation === "light" ||
			record.isolation === "balanced" ||
			record.isolation === "strong")
	);
}

async function requestStudioSound(method: "GET" | "PUT", value?: unknown) {
	if (method === "PUT" && !isStudioSoundPreference(value))
		throw new Error("Studio Sound preference is invalid");
	const response = await fetch(STUDIO_SOUND_URL, {
		method,
		credentials: "same-origin",
		cache: "no-store",
		...(method === "PUT"
			? {
					body: JSON.stringify(value),
					headers: { "Content-Type": "application/json" },
				}
			: {}),
	});
	if (!response.ok) throw new Error("Could not save or load Studio Sound");
	const stored: unknown = await response.json();
	if (!isStudioSoundPreference(stored))
		throw new Error("Studio Sound response is invalid");
	return stored;
}

let namespace = "anonymous";
const stores = new Map<string, Store>();

export function setEditorStoreNamespace(userId: string) {
	namespace = userId.trim() || "anonymous";
}

function storageKey(scope: string, path: string, key: string) {
	return `cap-web-editor:${scope}:${path}:${key}`;
}

export class Store {
	private readonly state = new Map<string, unknown>();
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private readonly allListeners = new Set<
		(key: string, value: unknown) => void
	>();

	private constructor(
		private readonly scope: string,
		private readonly path: string,
	) {}

	static async load(path: string) {
		const id = `${namespace}:${path}`;
		let store = stores.get(id);
		if (!store) {
			store = new Store(namespace, path);
			stores.set(id, store);
		}
		return store;
	}

	static async get(path: string) {
		return stores.get(`${namespace}:${path}`) ?? null;
	}

	async get<T>(key: string): Promise<T | undefined> {
		if (this.state.has(key)) return this.state.get(key) as T;
		if (key === STUDIO_SOUND_KEY) {
			const value = await requestStudioSound("GET");
			this.state.set(key, value);
			return value as T;
		}
		if (!PERSISTED_EDITOR_KEYS.has(key)) return undefined;
		let stored: string | null;
		try {
			stored = localStorage.getItem(storageKey(this.scope, this.path, key));
		} catch {
			return undefined;
		}
		if (stored === null) return undefined;
		try {
			const value: unknown = JSON.parse(stored);
			this.state.set(key, value);
			return value as T;
		} catch {
			return undefined;
		}
	}

	async set(key: string, value: unknown) {
		if (key === STUDIO_SOUND_KEY) {
			const stored = await requestStudioSound("PUT", value);
			this.state.set(key, stored);
			this.emit(key, stored);
			return;
		}
		if (PERSISTED_EDITOR_KEYS.has(key)) {
			localStorage.setItem(
				storageKey(this.scope, this.path, key),
				JSON.stringify(value),
			);
		}
		this.state.set(key, value);
		this.emit(key, value);
	}

	async has(key: string) {
		return (await this.get(key)) !== undefined;
	}

	async delete(key: string) {
		const existed = await this.has(key);
		if (key === STUDIO_SOUND_KEY) {
			await requestStudioSound("PUT", DEFAULT_STUDIO_SOUND);
			this.state.delete(key);
			this.emit(key, undefined);
			return existed;
		}
		if (PERSISTED_EDITOR_KEYS.has(key)) {
			localStorage.removeItem(storageKey(this.scope, this.path, key));
		}
		this.state.delete(key);
		this.emit(key, undefined);
		return existed;
	}

	async clear() {
		for (const key of await this.keys()) await this.delete(key);
	}

	async reset() {
		await this.clear();
	}

	async keys() {
		const keys = new Set(this.state.keys());
		try {
			for (const key of PERSISTED_EDITOR_KEYS) {
				if (
					localStorage.getItem(storageKey(this.scope, this.path, key)) !== null
				)
					keys.add(key);
			}
		} catch {
			return [...keys];
		}
		return [...keys];
	}

	async values<T>() {
		return Promise.all((await this.keys()).map((key) => this.get<T>(key)));
	}

	async entries<T>() {
		return Promise.all(
			(await this.keys()).map(
				async (key) => [key, await this.get<T>(key)] as const,
			),
		);
	}

	async length() {
		return (await this.keys()).length;
	}

	async reload() {
		this.state.clear();
	}

	async save() {}

	async onKeyChange<T>(key: string, callback: (value: T | undefined) => void) {
		let listeners = this.listeners.get(key);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(key, listeners);
		}
		const listener = (value: unknown) => callback(value as T | undefined);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	}

	async onChange<T>(callback: (key: string, value: T | undefined) => void) {
		const listener = (key: string, value: unknown) =>
			callback(key, value as T | undefined);
		this.allListeners.add(listener);
		return () => {
			this.allListeners.delete(listener);
		};
	}

	private emit(key: string, value: unknown) {
		for (const listener of this.listeners.get(key) ?? []) listener(value);
		for (const listener of this.allListeners) listener(key, value);
	}
}

export const load = Store.load;
export const getStore = Store.get;
