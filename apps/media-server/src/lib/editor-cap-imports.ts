import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type EditorCapAsset,
	stageSignedEditorCapAsset,
	validateEditorCapAsset,
} from "./editor-cap-assets";
import { mapEditorConfigPaths } from "./editor-config-paths";
import { nativeEditorBinary } from "./editor-native";
import { runEditorFile as runFile } from "./editor-process";

const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

type ImportStatus = "staging" | "ready" | "error" | "canceled";
type ImportResult = {
	path: string;
	name: string;
	clipCount: number;
	projectConfig: Record<string, unknown>;
};
type CapImport = {
	id: string;
	sessionId: string;
	asset: EditorCapAsset;
	status: ImportStatus;
	result: ImportResult | null;
	error: string | null;
	controller: AbortController;
	task: Promise<void>;
};

const imports = new Map<string, CapImport>();
const activeBySession = new Map<string, string>();

export class EditorCapImportBusyError extends Error {}

function clipCount(stdout: string | Buffer) {
	let value: unknown;
	try {
		value = JSON.parse(stdout.toString());
	} catch {
		throw new Error("Cap project import returned invalid clip metadata");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("clipCount" in value) ||
		typeof value.clipCount !== "number" ||
		!Number.isSafeInteger(value.clipCount) ||
		value.clipCount < 1 ||
		value.clipCount > 1000
	) {
		throw new Error("Cap project import returned invalid clip count");
	}
	return value.clipCount;
}

export function beginEditorCapImport(
	sessionId: string,
	projectPath: string,
	asset: EditorCapAsset,
) {
	validateEditorCapAsset(asset);
	for (const job of imports.values()) {
		if (job.sessionId !== sessionId || job.asset.path !== asset.path) continue;
		if (
			job.asset.size !== asset.size ||
			job.asset.objectIdentity !== asset.objectIdentity ||
			job.asset.contentType !== asset.contentType
		) {
			throw new Error("Imported Cap project identity changed");
		}
		if (job.status === "ready" || job.status === "staging") return job.id;
		imports.delete(job.id);
	}
	if (activeBySession.has(sessionId)) {
		throw new EditorCapImportBusyError("A Cap project is still importing");
	}
	const job: CapImport = {
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
	job.task = (async () => {
		const staged = await stageSignedEditorCapAsset(
			projectPath,
			asset,
			job.controller.signal,
		);
		try {
			const { stdout } = await runFile(
				nativeEditorBinary("prepare"),
				["append-cap", projectPath, staged.path],
				{
					timeout: IMPORT_TIMEOUT_MS,
					maxBuffer: 64 * 1024,
					signal: job.controller.signal,
				},
			);
			const savedConfig = await readFile(
				join(projectPath, "project-config.json"),
				"utf8",
			);
			if (Buffer.byteLength(savedConfig, "utf8") > 8 * 1024 * 1024) {
				throw new Error("Imported Cap project settings are too large");
			}
			const nativeConfig: unknown = JSON.parse(savedConfig);
			if (
				typeof nativeConfig !== "object" ||
				nativeConfig === null ||
				Array.isArray(nativeConfig)
			) {
				throw new Error("Imported Cap project settings are invalid");
			}
			return {
				path: asset.path,
				name: asset.name,
				clipCount: clipCount(stdout),
				projectConfig: mapEditorConfigPaths(
					nativeConfig as Record<string, unknown>,
					"browser",
					projectPath,
				),
			};
		} finally {
			await staged.cleanup();
		}
	})()
		.then((result) => {
			job.result = result;
			job.status = "ready";
		})
		.catch((error) => {
			job.status = job.controller.signal.aborted ? "canceled" : "error";
			job.error =
				error instanceof Error
					? error.message
					: "Cap project could not be imported";
		})
		.finally(() => {
			if (activeBySession.get(sessionId) === job.id) {
				activeBySession.delete(sessionId);
			}
		});
	return job.id;
}

export function getEditorCapImport(sessionId: string, id: string) {
	const job = imports.get(id);
	if (!job || job.sessionId !== sessionId) return null;
	return {
		id: job.id,
		status: job.status,
		result: job.result,
		error: job.error,
	};
}

export async function cancelEditorCapImport(sessionId: string, id: string) {
	const job = imports.get(id);
	if (!job || job.sessionId !== sessionId) return false;
	job.controller.abort();
	await job.task;
	imports.delete(id);
	return true;
}

export async function closeEditorCapImports(sessionId: string) {
	const jobs = [...imports.values()].filter(
		(job) => job.sessionId === sessionId,
	);
	for (const job of jobs) job.controller.abort();
	await Promise.all(jobs.map((job) => job.task));
	for (const job of jobs) imports.delete(job.id);
	activeBySession.delete(sessionId);
}
