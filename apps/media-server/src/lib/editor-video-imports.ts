import { randomUUID } from "node:crypto";
import {
	type EditorVideoAsset,
	stageSignedEditorVideoAsset,
	validateEditorVideoAsset,
} from "./editor-video-assets";

type ImportedVideo = Awaited<ReturnType<typeof stageSignedEditorVideoAsset>>;
type ImportStatus = "staging" | "ready" | "error" | "canceled";

type VideoImport = {
	id: string;
	sessionId: string;
	asset: EditorVideoAsset;
	status: ImportStatus;
	result: ImportedVideo | null;
	error: string | null;
	controller: AbortController;
	task: Promise<void>;
};

const imports = new Map<string, VideoImport>();
const activeBySession = new Map<string, string>();

export class EditorVideoImportBusyError extends Error {}

export function beginEditorVideoImport(
	sessionId: string,
	projectPath: string,
	asset: EditorVideoAsset,
) {
	validateEditorVideoAsset(asset);
	for (const job of imports.values()) {
		if (job.sessionId !== sessionId || job.asset.path !== asset.path) continue;
		if (
			job.asset.size !== asset.size ||
			job.asset.objectIdentity !== asset.objectIdentity ||
			job.asset.contentType !== asset.contentType
		) {
			throw new Error("Imported video identity changed");
		}
		if (job.status === "ready" || job.status === "staging") return job.id;
		imports.delete(job.id);
	}
	if (activeBySession.has(sessionId)) {
		throw new EditorVideoImportBusyError("An imported video is still staging");
	}
	const job: VideoImport = {
		id: randomUUID(),
		sessionId,
		asset,
		status: "staging",
		result: null,
		error: null,
		controller: new AbortController(),
		task: Promise.resolve(),
	};
	imports.set(job.id, job);
	activeBySession.set(sessionId, job.id);
	job.task = stageSignedEditorVideoAsset(
		projectPath,
		asset,
		job.controller.signal,
	)
		.then((result) => {
			job.result = result;
			job.status = "ready";
		})
		.catch((error) => {
			job.status = job.controller.signal.aborted ? "canceled" : "error";
			job.error =
				error instanceof Error
					? error.message
					: "Imported video could not be staged";
		})
		.finally(() => {
			if (activeBySession.get(sessionId) === job.id) {
				activeBySession.delete(sessionId);
			}
		});
	return job.id;
}

export function getEditorVideoImport(sessionId: string, id: string) {
	const job = imports.get(id);
	if (!job || job.sessionId !== sessionId) return null;
	return {
		id: job.id,
		status: job.status,
		result: job.result,
		error: job.error,
	};
}

export async function cancelEditorVideoImport(sessionId: string, id: string) {
	const job = imports.get(id);
	if (!job || job.sessionId !== sessionId) return false;
	job.controller.abort();
	await job.task;
	imports.delete(id);
	return true;
}

export async function closeEditorVideoImports(sessionId: string) {
	const jobs = [...imports.values()].filter(
		(job) => job.sessionId === sessionId,
	);
	for (const job of jobs) job.controller.abort();
	await Promise.all(jobs.map((job) => job.task));
	for (const job of jobs) imports.delete(job.id);
	activeBySession.delete(sessionId);
}
