import { serverEnv } from "@cap/env";
import { HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import { requestMediaEditor } from "./editor-session";
import {
	editorWorkerIdFromSessionId,
	orderedEditorWorkers,
	parseEditorWorkerPool,
} from "./editor-worker-routing";

/**
 * Asks the video's editor workers, in routing order, to prepare a session
 * from signed sources. `busy` means every worker was at render capacity.
 */
export const requestEditorPreparation = Effect.fn("requestEditorPreparation")(
	function* (videoId: string, sources: unknown) {
		const env = serverEnv();
		const workers = yield* Effect.try({
			try: () =>
				orderedEditorWorkers(
					parseEditorWorkerPool(
						env.CAP_WEB_EDITOR_WORKER_POOL,
						env.CAP_WEB_EDITOR_WORKER_URL,
					),
					videoId,
				),
			catch: () => new HttpApiError.ServiceUnavailable(),
		});
		if (workers.length === 0) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		let occupiedWorkers = 0;
		for (const worker of workers) {
			const attempt = yield* requestMediaEditor(
				"/editor/preparations",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(sources),
				},
				15_000,
				worker.id,
			).pipe(Effect.either);
			if (attempt._tag === "Left") continue;
			const response = attempt.right;
			if (response.status >= 500) {
				if (response.status === 503) {
					const detail = yield* Effect.tryPromise({
						try: async (): Promise<unknown> => await response.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					}).pipe(Effect.either);
					if (
						detail._tag === "Right" &&
						typeof detail.right === "object" &&
						detail.right !== null &&
						"error" in detail.right &&
						detail.right.error === "Editor render capacity is busy"
					) {
						occupiedWorkers++;
					}
				}
				continue;
			}
			if (response.status !== 202) {
				return yield* new HttpApiError.ServiceUnavailable();
			}
			const data: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => new HttpApiError.ServiceUnavailable(),
			});
			if (
				typeof data === "object" &&
				data !== null &&
				"id" in data &&
				typeof data.id === "string" &&
				"status" in data &&
				data.status === "preparing" &&
				editorWorkerIdFromSessionId(data.id) === worker.id
			) {
				return { id: data.id } as const;
			}
			if (
				typeof data === "object" &&
				data !== null &&
				"id" in data &&
				typeof data.id === "string"
			) {
				yield* requestMediaEditor(
					`/editor/preparations/${encodeURIComponent(data.id)}`,
					{ method: "DELETE" },
					15_000,
					worker.id,
				).pipe(Effect.either);
			}
			return yield* new HttpApiError.ServiceUnavailable();
		}
		if (occupiedWorkers === workers.length) return { busy: true } as const;
		return yield* new HttpApiError.ServiceUnavailable();
	},
);
