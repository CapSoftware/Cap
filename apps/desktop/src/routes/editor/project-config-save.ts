import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

// A save that fails for want of a connection goes again after each of these
// waits before the editor hears of it: a flaky link often recovers in seconds.
const NETWORK_RETRY_DELAYS_MS = [1000, 2000, 4000];

export const SAVE_UNREACHABLE =
	"Couldn't reach Cap. Check your connection and try again.";

/// Whether a save failed on the way to Cap rather than being refused by it.
export function networkSaveFailure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /failed to fetch|networkerror|load failed|network ?error|network connection was lost|err_network|err_internet_disconnected|timed out/i.test(
		message,
	);
}

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
	let failed = false;
	const [revision, setRevision] = createSignal(0);

	const clearSaveTimeout = () => {
		if (timeout === undefined) return;
		clearTimeout(timeout);
		timeout = undefined;
	};

	const saveWithRetry = async (config: T) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await options.save(config);
			} catch (error) {
				const delay = NETWORK_RETRY_DELAYS_MS[attempt];
				if (disposed || delay === undefined || !networkSaveFailure(error))
					throw error;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	};

	const flush = async () => {
		clearSaveTimeout();
		if (!disposed) latestConfig = snapshot();
		while (true) {
			if (!inFlight) {
				if (latestConfig === persistedConfig) return;
				const config = latestConfig;
				inFlight = Promise.resolve()
					.then(() => saveWithRetry(JSON.parse(config) as T))
					.then(() => {
						persistedConfig = config;
						failed = false;
					})
					.catch((error: unknown) => {
						failed = true;
						if (networkSaveFailure(error))
							throw new Error(SAVE_UNREACHABLE, { cause: error });
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

	// A save that failed while offline goes again once the browser is back
	// online, rather than waiting for the next edit.
	if (typeof window !== "undefined") {
		const retry = () => {
			if (failed && !disposed) void flush().catch(options.onError);
		};
		window.addEventListener("online", retry);
		onCleanup(() => window.removeEventListener("online", retry));
	}

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
