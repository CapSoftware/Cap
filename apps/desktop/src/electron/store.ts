import { native } from "./bridge";

export class Store {
	private data = new Map<string, unknown>();
	private loaded: Promise<void>;

	constructor(public path: string, _options?: { autoSave?: boolean }) {
		this.loaded = native<Record<string, unknown>>("store.load", { path }).then((values) => {
			this.data = new Map(Object.entries(values));
		});
	}

	static async load(path: string, options?: { autoSave?: boolean }) {
		const store = new Store(path, options);
		await store.loaded;
		return store;
	}

	async set(key: string, value: unknown) { await this.loaded; this.data.set(key, value); }
	async get<T>(key: string): Promise<T | undefined> { await this.loaded; return this.data.get(key) as T | undefined; }
	async has(key: string) { await this.loaded; return this.data.has(key); }
	async delete(key: string) { await this.loaded; return this.data.delete(key); }
	async clear() { await this.loaded; this.data.clear(); }
	async reset() { return this.clear(); }
	async keys() { await this.loaded; return [...this.data.keys()]; }
	async values() { await this.loaded; return [...this.data.values()]; }
	async entries() { await this.loaded; return [...this.data.entries()]; }
	async length() { await this.loaded; return this.data.size; }
	async save() { await this.loaded; return native<void>("store.save", { path: this.path, value: Object.fromEntries(this.data) }); }
	async reload() {
		const values = await native<Record<string, unknown>>("store.load", { path: this.path });
		this.data = new Map(Object.entries(values));
	}
	async onKeyChange<T>(_key: string, _callback: (value: T | undefined) => void) { return () => {}; }
	async onChange<T>(_callback: (key: string, value: T | undefined) => void) { return () => {}; }
}

export const load = Store.load;
