type WebEditorPreparation = {
	id: string;
	status: "preparing";
};

type EditorCapacityBusy = {
	_tag: "EditorCapacityBusy";
	retryAfterMs: number;
};

const CAPACITY_WAIT_LIMIT_MS = 5 * 60 * 1000;

function isPreparation(value: unknown): value is WebEditorPreparation {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"status" in value &&
		value.status === "preparing"
	);
}

function isCapacityBusy(value: unknown): value is EditorCapacityBusy {
	return (
		typeof value === "object" &&
		value !== null &&
		"_tag" in value &&
		value._tag === "EditorCapacityBusy" &&
		"retryAfterMs" in value &&
		typeof value.retryAfterMs === "number" &&
		Number.isInteger(value.retryAfterMs) &&
		value.retryAfterMs >= 1_000 &&
		value.retryAfterMs <= 30_000
	);
}

function waitForCapacity(signal: AbortSignal, delayMs: number) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Editor preparation was canceled"));
			return;
		}
		const timer = globalThis.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, delayMs);
		const canceled = () => {
			globalThis.clearTimeout(timer);
			reject(new Error("Editor preparation was canceled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

export async function startWebEditorPreparation(
	videoId: string,
	signal: AbortSignal,
	onCapacityWait: (waiting: boolean) => void,
	fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
	capacityWaitMs = CAPACITY_WAIT_LIMIT_MS,
): Promise<WebEditorPreparation> {
	const deadline = Date.now() + capacityWaitMs;
	let busyRetries = 0;
	for (;;) {
		if (signal.aborted) throw new Error("Editor preparation was canceled");
		if (busyRetries > 0 && Date.now() >= deadline) {
			throw new Error(
				"Every editor server is busy right now. Try again in a minute.",
			);
		}
		const response = await fetcher("/api/editor/preparations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ videoId }),
		});
		if (response.status === 503) {
			const detail: unknown = await response.json().catch(() => null);
			if (isCapacityBusy(detail)) {
				if (signal.aborted) {
					throw new Error("Editor preparation was canceled");
				}
				onCapacityWait(true);
				const delayMs = Math.min(
					Math.min(
						20_000,
						detail.retryAfterMs * 2 ** Math.min(busyRetries, 5),
					) + Math.floor(Math.random() * 1_000),
					Math.max(0, deadline - Date.now()),
				);
				busyRetries++;
				await waitForCapacity(signal, delayMs);
				continue;
			}
		}
		if (!response.ok)
			throw new Error(
				response.status === 404
					? "This recording is no longer available"
					: response.status === 403
						? "You don't have access to edit this recording"
						: "The editor server is unavailable right now. Try again in a moment.",
			);
		const created: unknown = await response.json();
		if (!isPreparation(created)) {
			throw new Error("Editor preparation response was invalid");
		}
		if (!signal.aborted) onCapacityWait(false);
		return created;
	}
}
