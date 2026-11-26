import { LocalError } from "./errors";

export const cancelled = () =>
	new LocalError(
		"cancelled",
		"The call was cancelled before it finished",
		null,
	);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(cancelled());
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelled());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function withinDeadline<T>(
	work: Promise<T>,
	deadlineAt: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new LocalError(
						"timeout",
						"The time allowed for this call ran out",
						"Run the tool again.",
					),
				),
			Math.max(0, deadlineAt - Date.now()),
		);
	});
	return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

export function timeLimit(ms: number, signal?: AbortSignal) {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	const timer = setTimeout(
		() => {
			timedOut = true;
			controller.abort();
		},
		Math.max(0, ms),
	);
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}
