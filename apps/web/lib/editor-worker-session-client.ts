import { startWebEditorPreparation } from "./editor-preparation-client";

const PREPARATION_TIMEOUT_MS = 5 * 60 * 1000;
const PREPARATION_POLL_MS = 500;

function wait(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Editor preparation was canceled"));
			return;
		}
		const timer = globalThis.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, ms);
		const canceled = () => {
			globalThis.clearTimeout(timer);
			reject(new Error("Editor preparation was canceled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

/**
 * Prepares an editor session on a worker, which renders the preview for a
 * browser that has no GPU path of its own, and returns its session ID.
 */
export async function openWorkerEditorSession(
	videoId: string,
	signal: AbortSignal,
	onCapacityWait: (waiting: boolean) => void,
	fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
	pollMs = PREPARATION_POLL_MS,
): Promise<string> {
	const created = await startWebEditorPreparation(
		videoId,
		signal,
		onCapacityWait,
		fetcher,
	);
	const statusUrl = `/api/editor/preparations/${encodeURIComponent(created.id)}?videoId=${encodeURIComponent(videoId)}`;
	try {
		const deadline = Date.now() + PREPARATION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (signal.aborted) throw new Error("Editor preparation was canceled");
			const response = await fetcher(statusUrl, {
				signal,
				cache: "no-store",
			});
			if (!response.ok)
				throw new Error("Editor preparation status is unavailable");
			const status: unknown = await response.json();
			if (
				typeof status !== "object" ||
				status === null ||
				!("status" in status)
			) {
				throw new Error("Editor preparation status was invalid");
			}
			if (status.status === "ready") {
				if (!("sessionId" in status) || typeof status.sessionId !== "string")
					throw new Error("Editor session was not returned");
				return status.sessionId;
			}
			if (status.status !== "preparing")
				throw new Error("Editor preparation failed");
			await wait(pollMs, signal);
		}
		throw new Error("Editor preparation timed out");
	} catch (error) {
		void fetcher(statusUrl, { method: "DELETE", keepalive: true }).catch(
			() => undefined,
		);
		throw error;
	}
}
