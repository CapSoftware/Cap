import { describe, expect, it } from "vitest";
import { createSerializedStore } from "./serialized-store";

type Library = {
	presets: { id: string; name: string }[];
	lastUsed: { seed: number } | null;
	selected: boolean;
};

const defaults: Library = { presets: [], lastUsed: null, selected: false };

function createFakeStore(initial?: Library) {
	let value = initial;
	let activeWrites = 0;
	let maxActiveWrites = 0;
	let failNextWrite = false;
	const store = {
		get: async () => {
			await Promise.resolve();
			return value ? structuredClone(value) : undefined;
		},
		set: async (next: Library) => {
			activeWrites += 1;
			maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
			await Promise.resolve();
			activeWrites -= 1;
			if (failNextWrite) {
				failNextWrite = false;
				throw new Error("Write failed");
			}
			value = structuredClone(next);
		},
	};
	return {
		store,
		value: () => value,
		maxActiveWrites: () => maxActiveWrites,
		failNextWrite: () => {
			failNextWrite = true;
		},
	};
}

describe("createSerializedStore", () => {
	it("merges queued preferences without dropping saved presets", async () => {
		const fake = createFakeStore();
		const store = createSerializedStore(fake.store, defaults);
		const preset = { id: "first", name: "First" };

		await Promise.all([
			store.set({ selected: true }),
			store.update((current) => ({
				...current,
				presets: [...current.presets, preset],
			})),
			store.set({ lastUsed: { seed: 17 } }),
		]);

		expect(fake.value()).toEqual({
			presets: [preset],
			lastUsed: { seed: 17 },
			selected: true,
		});
		expect(fake.maxActiveWrites()).toBe(1);
	});

	it("applies preset additions and deletion to the latest queued state", async () => {
		const fake = createFakeStore({ ...defaults, selected: true });
		const store = createSerializedStore(fake.store, defaults);
		const add = (id: string) =>
			store.update((current) => ({
				...current,
				presets: [...current.presets, { id, name: id }],
			}));

		await Promise.all([
			add("first"),
			add("second"),
			store.update((current) => ({
				...current,
				presets: current.presets.filter((preset) => preset.id !== "first"),
			})),
			store.set({ lastUsed: { seed: 42 } }),
		]);

		expect(await store.get()).toEqual({
			presets: [{ id: "second", name: "second" }],
			lastUsed: { seed: 42 },
			selected: true,
		});
	});

	it("keeps the queue usable after a failed write", async () => {
		const fake = createFakeStore();
		const store = createSerializedStore(fake.store, defaults);
		fake.failNextWrite();

		const failed = store.set({ selected: true });
		const recovered = store.set({ lastUsed: { seed: 9 } });
		await expect(failed).rejects.toThrow("Write failed");
		await recovered;
		await store.flush();

		expect(fake.value()).toEqual({ ...defaults, lastUsed: { seed: 9 } });
	});

	it("does not write rejected updates and preserves ordering after rejection", async () => {
		const fake = createFakeStore();
		const store = createSerializedStore(fake.store, defaults);
		const rejected = store.update(() => {
			throw new Error("Preset limit reached");
		});
		const accepted = store.set({ selected: true });

		await expect(rejected).rejects.toThrow("Preset limit reached");
		await accepted;
		expect(await store.get()).toEqual({ ...defaults, selected: true });
	});

	it("waits for queued asynchronous updates before reading", async () => {
		const fake = createFakeStore();
		const store = createSerializedStore(fake.store, defaults);
		const written = store.update(async (current) => {
			await Promise.resolve();
			return { ...current, selected: true };
		});
		const read = store.get();

		await expect(read).resolves.toEqual({ ...defaults, selected: true });
		await written;
	});

	it("isolates defaults from an update that mutates then fails", async () => {
		const fake = createFakeStore();
		const initial: Library = { presets: [], lastUsed: null, selected: false };
		const store = createSerializedStore(fake.store, initial);
		await expect(
			store.update((current) => {
				current.presets.push({ id: "unsaved", name: "Unsaved" });
				throw new Error("Invalid preset");
			}),
		).rejects.toThrow("Invalid preset");

		expect(initial.presets).toEqual([]);
		expect(await store.get()).toEqual(defaults);
	});
});
