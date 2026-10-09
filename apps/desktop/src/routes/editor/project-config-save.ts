import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

export function createProjectConfigSave<T extends object>(options: {
	trackChanges: () => void;
	getConfig: () => T;
	save: (config: T) => Promise<void>;
	onError: (error: unknown) => void;
}) {
	const snapshot = () => untrack(() => JSON.stringify(options.getConfig()));
	const initialConfig = snapshot();
	let persistedConfig: string | undefined;
	let latestConfig = initialConfig;
	let inFlight: Promise<void> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const [revision, setRevision] = createSignal(0);

	const clearSaveTimeout = () => {
		if (timeout === undefined) return;
		clearTimeout(timeout);
		timeout = undefined;
	};

	const flush = async () => {
		clearSaveTimeout();
		if (!disposed) latestConfig = snapshot();
		while (true) {
			if (!inFlight) {
				if (latestConfig === persistedConfig) return;
				const config = latestConfig;
				inFlight = Promise.resolve()
					.then(() => options.save(JSON.parse(config) as T))
					.then(() => {
						persistedConfig = config;
					})
					.catch((error: unknown) => {
						const detail =
							error instanceof Error ? error.message : String(error);
						throw new Error(`Could not save the latest edits: ${detail}`, {
							cause: error,
						});
					})
					.finally(() => {
						inFlight = undefined;
					});
			}
			await inFlight;
			if (!disposed) latestConfig = snapshot();
			clearSaveTimeout();
		}
	};

	createEffect(
		on(
			options.trackChanges,
			() => {
				setRevision((value) => value + 1);
				clearSaveTimeout();
				timeout = setTimeout(() => {
					timeout = undefined;
					void flush().catch(options.onError);
				}, 250);
			},
			{ defer: true },
		),
	);

	onCleanup(() => {
		clearSaveTimeout();
		try {
			latestConfig = snapshot();
		} catch (error) {
			options.onError(error);
		}
		disposed = true;
		if (
			persistedConfig === undefined &&
			!inFlight &&
			latestConfig === initialConfig
		)
			return;
		void flush().catch(options.onError);
	});

	return { flush, revision };
}
