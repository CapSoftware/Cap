export function createSerializedStore<T extends object>(
	store: {
		get(): Promise<T | undefined>;
		set(value: T): Promise<void>;
	},
	defaults: T,
) {
	let pending = Promise.resolve();

	const enqueue = <Result>(action: () => Promise<Result>) => {
		const result = pending.then(action);
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const read = async () =>
		structuredClone({ ...defaults, ...(await store.get()) });
	const update = (change: (current: T) => T | Promise<T>) =>
		enqueue(async () => {
			const current = await read();
			const next = await change(current);
			await store.set(next);
			return next;
		});

	return {
		get: () => enqueue(read),
		set: (value: Partial<T>) => update((current) => ({ ...current, ...value })),
		update,
		flush: () => pending,
	};
}
