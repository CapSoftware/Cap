export interface VisibilityDocument {
	readonly hidden: boolean;
	addEventListener(type: "visibilitychange", listener: () => void): void;
	removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function waitUntilVisible(
	document: VisibilityDocument,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	if (!document.hidden) return Promise.resolve(true);

	return new Promise((resolve) => {
		let settled = false;
		const finish = (visible: boolean) => {
			if (settled) return;
			settled = true;
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			signal?.removeEventListener("abort", handleAbort);
			resolve(visible);
		};
		const handleVisibilityChange = () => {
			if (!document.hidden) finish(true);
		};
		const handleAbort = () => finish(false);

		document.addEventListener("visibilitychange", handleVisibilityChange);
		signal?.addEventListener("abort", handleAbort, { once: true });

		if (signal?.aborted) finish(false);
		else if (!document.hidden) finish(true);
	});
}
