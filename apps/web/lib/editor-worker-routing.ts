import { createHash } from "node:crypto";

export type EditorWorker = { id: string; origin: string };

const WORKER_ID = /^[a-z][a-z0-9-]{0,23}$/;
const UUID =
	"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_ID = new RegExp(`^(?:([a-z][a-z0-9-]{0,23})\\.)?${UUID}$`);

function validOrigin(value: string) {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			(url.protocol !== "http:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.username ||
		url.password
	) {
		throw new Error("Invalid editor worker origin");
	}
	return url.origin;
}

export function parseEditorWorkerPool(
	configuration: string | undefined,
	fallbackUrl: string | undefined,
): EditorWorker[] {
	if (!configuration) {
		return fallbackUrl ? [{ id: "", origin: validOrigin(fallbackUrl) }] : [];
	}
	const parsed: unknown = JSON.parse(configuration);
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
		throw new Error("Invalid editor worker pool");
	}
	const workers: EditorWorker[] = [];
	const ids = new Set<string>();
	const origins = new Set<string>();
	for (const worker of parsed) {
		if (
			typeof worker !== "object" ||
			worker === null ||
			!("id" in worker) ||
			typeof worker.id !== "string" ||
			!WORKER_ID.test(worker.id) ||
			!("url" in worker) ||
			typeof worker.url !== "string"
		) {
			throw new Error("Invalid editor worker pool entry");
		}
		const origin = validOrigin(worker.url);
		if (ids.has(worker.id) || origins.has(origin)) {
			throw new Error("Duplicate editor worker pool entry");
		}
		ids.add(worker.id);
		origins.add(origin);
		workers.push({ id: worker.id, origin });
	}
	return workers;
}

export function editorWorkerIdFromSessionId(sessionId: string): string | null {
	const match = SESSION_ID.exec(sessionId);
	return match ? (match[1] ?? "") : null;
}

export function editorWorkerForRequest(
	workers: readonly EditorWorker[],
	path: string,
	selectedWorkerId?: string,
): EditorWorker | null {
	if (selectedWorkerId !== undefined) {
		return workers.find((worker) => worker.id === selectedWorkerId) ?? null;
	}
	const match =
		/^\/editor\/(?:preparations|sessions)\/([^/?#]+)(?:[/?#]|$)/.exec(path);
	if (match) {
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(match[1] ?? "");
		} catch {
			return null;
		}
		const id = editorWorkerIdFromSessionId(sessionId);
		return id === null
			? null
			: (workers.find((worker) => worker.id === id) ?? null);
	}
	return workers.length === 1 ? (workers[0] ?? null) : null;
}

export function orderedEditorWorkers(
	workers: readonly EditorWorker[],
	videoId: string,
): EditorWorker[] {
	return [...workers].sort((left, right) => {
		const score = (worker: EditorWorker) =>
			createHash("sha256")
				.update(`${videoId}:${worker.id}`)
				.digest()
				.readUInt32BE(0);
		return score(right) - score(left);
	});
}
