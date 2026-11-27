export const LOAD_RETRY_DELAYS_MS = [500, 1500, 4000];

function isAbort(error: unknown) {
	return error instanceof DOMException && error.name === "AbortError";
}

function wait(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function withLoadRetries<T>(
	task: () => Promise<T>,
	options: {
		signal?: AbortSignal;
		delays?: readonly number[];
		beforeRetry?: () => void;
	} = {},
): Promise<T> {
	const { signal, delays = LOAD_RETRY_DELAYS_MS, beforeRetry } = options;
	for (let attempt = 0; ; attempt++) {
		try {
			return await task();
		} catch (error) {
			const delay = delays[attempt];
			if (delay === undefined || signal?.aborted || isAbort(error)) throw error;
			await wait(delay, signal);
			beforeRetry?.();
		}
	}
}

const NETWORK_FAILURE =
	/failed to fetch|load failed|networkerror|network error|network connection was lost|importing a module script failed|failed to fetch dynamically imported module/i;

export function isNetworkFailure(error: unknown) {
	return error instanceof Error && NETWORK_FAILURE.test(error.message);
}

export function loadFailureMessage(error: unknown) {
	if (isNetworkFailure(error))
		return "Cap couldn't download this recording. Check your connection and try again.";
	return error instanceof Error && error.message
		? error.message
		: "The editor couldn't open this recording. Try again.";
}

export function reportEditorLoadFailure(error: unknown) {
	if (window.parent === window) return false;
	window.parent.postMessage(
		{
			kind: "cap-editor-preview-failed",
			version: 1,
			message: loadFailureMessage(error),
		},
		window.location.origin,
	);
	return true;
}
