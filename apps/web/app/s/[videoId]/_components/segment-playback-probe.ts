export type SegmentPlaybackProbeResult = "ready" | "incomplete" | "unavailable";

export async function waitForSegmentPlayback({
	url,
	signal,
	fetchImpl = fetch,
	onComplete,
}: {
	url: string;
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
	onComplete?: () => void;
}): Promise<SegmentPlaybackProbeResult> {
	const startedAt = Date.now();
	while (!signal.aborted && Date.now() - startedAt < 5 * 60_000) {
		const request = new AbortController();
		const abort = () => request.abort();
		signal.addEventListener("abort", abort, { once: true });
		const requestTimeout = setTimeout(abort, 10_000);
		try {
			const response = await fetchImpl(url, {
				cache: "no-store",
				credentials: "same-origin",
				signal: request.signal,
			});
			void response.body?.cancel().catch(() => {});
			if (response.status === 204) {
				if (response.headers.get("X-Cap-Recording-Complete") === "1")
					onComplete?.();
				return "ready";
			}
			if (response.status === 409) return "incomplete";
			if (response.status === 401 || response.status === 403)
				return "unavailable";
		} catch {
			if (signal.aborted) return "unavailable";
		} finally {
			clearTimeout(requestTimeout);
			signal.removeEventListener("abort", abort);
		}
		if (signal.aborted) return "unavailable";
		const elapsed = Date.now() - startedAt;
		const delay = elapsed < 15_000 ? 500 : elapsed < 60_000 ? 2_000 : 5_000;
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, delay);
			signal.addEventListener("abort", finish, { once: true });
		});
	}
	return "unavailable";
}
