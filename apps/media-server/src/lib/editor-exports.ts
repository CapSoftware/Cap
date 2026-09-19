import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
	nativeEditorBinary,
	type startNativeEditorSession,
} from "./editor-native";
import { publicEditorOrigin } from "./editor-socket-tickets";
import { probeVideo } from "./editor-video-assets";

const resolutionSchema = z.object({
	x: z.number().int().min(1).max(3840),
	y: z.number().int().min(1).max(2160),
});
const baseSettings = z.object({
	fps: z.number().int().min(1).max(60),
	resolution_base: resolutionSchema,
});

export const editorExportSettingsSchema = z.discriminatedUnion("format", [
	baseSettings.extend({
		format: z.literal("Mp4"),
		compression: z.enum(["Maximum", "Social", "Web", "Potato"]),
		custom_bpp: z.number().positive().max(1).nullable(),
		force_ffmpeg_decoder: z.boolean().optional(),
		optimize_filesize: z.boolean().optional(),
	}),
	baseSettings.extend({
		format: z.literal("Gif"),
		quality: z
			.object({
				quality: z.number().int().min(1).max(100).nullable().optional(),
				fast: z.boolean().nullable().optional(),
			})
			.nullable(),
	}),
	baseSettings.extend({
		format: z.literal("Mov"),
		cursor_only: z.boolean().optional(),
	}),
]);

export type EditorExportSettings = z.infer<typeof editorExportSettingsSchema>;
type NativeSession = Awaited<ReturnType<typeof startNativeEditorSession>>;
type ExportStatus = "running" | "ready" | "error" | "canceled";
type ExportProgress = { rendered_count: number; total_frames: number };

type ExportJob = {
	id: string;
	sessionId: string;
	status: ExportStatus;
	format: EditorExportSettings["format"];
	settingsPath: string;
	outputPath: string;
	progress: ExportProgress | null;
	error: string | null;
	downloadStartedAt: number | null;
	size: number | null;
	mediaMetadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	} | null;
	child: ChildProcessWithoutNullStreams;
	task: Promise<void>;
	startedAt: number;
	finishedAt: number | null;
};

const jobs = new Map<string, ExportJob>();
const starting = new Map<string, Promise<void>>();
const closingSessions = new Set<string>();
const EXPORT_TIMEOUT_MS = 20 * 60 * 1000;
const DOWNLOAD_TICKET_TTL_MS = 60_000;
const MAX_DOWNLOAD_TICKETS = 100;
const downloadTickets = new Map<
	string,
	{
		sessionId: string;
		exportId: string;
		fileName: string;
		format: EditorExportSettings["format"];
		path: string;
		root: string;
		expiresAt: number;
	}
>();

export class EditorExportBusyError extends Error {}

function extension(format: EditorExportSettings["format"]) {
	return format === "Mp4" ? "mp4" : format === "Gif" ? "gif" : "mov";
}

function parseProgress(line: string): ExportProgress | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("rendered_count" in value) ||
		!("total_frames" in value) ||
		typeof value.rendered_count !== "number" ||
		typeof value.total_frames !== "number" ||
		!Number.isSafeInteger(value.rendered_count) ||
		!Number.isSafeInteger(value.total_frames) ||
		value.rendered_count < 0 ||
		value.total_frames < 0 ||
		value.rendered_count > value.total_frames
	) {
		return null;
	}
	return {
		rendered_count: value.rendered_count,
		total_frames: value.total_frames,
	};
}

export async function beginEditorExport(
	sessionId: string,
	native: NativeSession,
	settings: EditorExportSettings,
) {
	if (
		closingSessions.has(sessionId) ||
		starting.has(sessionId) ||
		[...jobs.values()].some((job) => job.sessionId === sessionId)
	) {
		throw new EditorExportBusyError(
			"Finish or cancel the current editor export first",
		);
	}
	let settleStart = () => {};
	starting.set(
		sessionId,
		new Promise<void>((resolve) => {
			settleStart = resolve;
		}),
	);
	const id = randomUUID();
	const root = dirname(native.projectPath);
	const settingsPath = join(root, `export-${id}.json`);
	const outputPath = join(root, `export-${id}.${extension(settings.format)}`);
	let child: ChildProcessWithoutNullStreams;
	try {
		await writeFile(settingsPath, JSON.stringify(settings), {
			flag: "wx",
			mode: 0o600,
		});
		if (closingSessions.has(sessionId)) {
			throw new Error("Editor session is closing");
		}
		child = spawn(
			nativeEditorBinary("prepare"),
			[
				"export",
				native.projectPath,
				join(native.projectPath, "project-config.json"),
				settingsPath,
				outputPath,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (cause) {
		starting.delete(sessionId);
		settleStart();
		await rm(settingsPath, { force: true });
		throw cause;
	}
	const job: ExportJob = {
		id,
		sessionId,
		status: "running",
		format: settings.format,
		settingsPath,
		outputPath,
		progress: null,
		error: null,
		downloadStartedAt: null,
		size: null,
		mediaMetadata: null,
		child,
		task: Promise.resolve(),
		startedAt: Date.now(),
		finishedAt: null,
	};
	jobs.set(id, job);
	child.stdin.end();
	const stdout = createInterface({ input: child.stdout });
	stdout.on("line", (line) => {
		const progress = parseProgress(line);
		if (progress) job.progress = progress;
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
	});
	job.task = new Promise<void>((resolve) => {
		let failure: Error | null = null;
		const timer = setTimeout(() => {
			failure = new Error("Editor export timed out");
			child.kill("SIGKILL");
		}, EXPORT_TIMEOUT_MS);
		timer.unref();
		child.once("error", (cause) => {
			failure = cause;
		});
		child.once("close", async (code) => {
			clearTimeout(timer);
			stdout.close();
			if (job.status === "canceled") {
				job.finishedAt = Date.now();
				resolve();
				return;
			}
			if (failure || code !== 0) {
				job.status = "error";
				job.error = failure?.message || stderr || "Editor export failed";
				await rm(job.outputPath, { force: true });
				job.finishedAt = Date.now();
				resolve();
				return;
			}
			try {
				const output = await lstat(job.outputPath);
				if (!output.isFile() || output.size === 0) {
					throw new Error("Editor export did not produce a video file");
				}
				if (output.size > 12 * 1024 * 1024 * 1024) {
					throw new Error("Editor export exceeds the maximum recording size");
				}
				job.size = output.size;
				if (job.format === "Mp4") {
					const video = await probeVideo(job.outputPath);
					job.mediaMetadata = {
						duration: video.duration,
						width: video.width,
						height: video.height,
						fps: video.fps,
					};
				}
				job.status = "ready";
			} catch (cause) {
				job.status = "error";
				job.error =
					cause instanceof Error ? cause.message : "Editor export failed";
				await rm(job.outputPath, { force: true });
			}
			job.finishedAt = Date.now();
			resolve();
		});
	});
	starting.delete(sessionId);
	settleStart();
	return id;
}

export function getEditorExport(sessionId: string, id: string) {
	const job = jobs.get(id);
	if (!job || job.sessionId !== sessionId) return null;
	return {
		id: job.id,
		status: job.status,
		format: job.format,
		progress: job.progress,
		error: job.error,
		downloadStartedAt: job.downloadStartedAt,
		size: job.size,
		mediaMetadata: job.mediaMetadata,
		startedAt: job.startedAt,
	};
}

export function editorExportActivityAt(sessionId: string, now: number) {
	const job = [...jobs.values()].find(
		(candidate) => candidate.sessionId === sessionId,
	);
	if (!job) return null;
	return job.status === "running" || job.finishedAt === null
		? now
		: job.finishedAt;
}

export function getEditorExportFile(sessionId: string, id: string) {
	const job = jobs.get(id);
	return job?.sessionId === sessionId && job.status === "ready"
		? job.outputPath
		: null;
}

export function markEditorExportDownloadStarted(sessionId: string, id: string) {
	const job = jobs.get(id);
	if (job?.sessionId === sessionId && job.status === "ready") {
		job.downloadStartedAt = Date.now();
	}
}

export async function createEditorExportDownloadTicket(
	sessionId: string,
	id: string,
	requestedName?: string,
) {
	const job = jobs.get(id);
	if (!job || job.sessionId !== sessionId || job.status !== "ready")
		return null;
	if (downloadTickets.size >= MAX_DOWNLOAD_TICKETS) {
		throw new Error("Editor download capacity is busy");
	}
	const origin = publicEditorOrigin();
	const suffix = extension(job.format);
	const requestedStem = requestedName?.endsWith(`.${suffix}`)
		? requestedName.slice(0, -suffix.length - 1)
		: null;
	const fileName =
		requestedStem &&
		requestedStem.length <= 180 &&
		!requestedStem.includes("/") &&
		!requestedStem.includes("\\") &&
		[...requestedStem].every(
			(character) =>
				character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
		)
			? `${requestedStem}.${suffix}`
			: `cap-export-${id}.${suffix}`;
	const root = await mkdtemp(join(tmpdir(), "cap-web-editor-download-"));
	try {
		await chmod(root, 0o700);
		const path = join(root, fileName);
		try {
			await link(job.outputPath, path);
		} catch (cause) {
			if (
				typeof cause !== "object" ||
				cause === null ||
				!("code" in cause) ||
				cause.code !== "EXDEV"
			) {
				throw cause;
			}
			await copyFile(job.outputPath, path);
		}
		if (jobs.get(id) !== job || job.status !== "ready") {
			await rm(root, { recursive: true, force: true });
			return null;
		}
		const ticket = randomBytes(32).toString("base64url");
		downloadTickets.set(ticket, {
			sessionId,
			exportId: id,
			fileName,
			format: job.format,
			path,
			root,
			expiresAt: Date.now() + DOWNLOAD_TICKET_TTL_MS,
		});
		return {
			url: `${origin}/editor/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(id)}/download?ticket=${ticket}`,
		};
	} catch (cause) {
		await rm(root, { recursive: true, force: true });
		throw cause;
	}
}

export function consumeEditorExportDownloadTicket(
	sessionId: string,
	id: string,
	token: string | null,
) {
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const ticket = downloadTickets.get(token);
	downloadTickets.delete(token);
	if (
		!ticket ||
		ticket.sessionId !== sessionId ||
		ticket.exportId !== id ||
		ticket.expiresAt < Date.now()
	) {
		return null;
	}
	return ticket;
}

export async function cancelEditorExport(
	sessionId: string,
	id: string,
	preserveDownloadTickets = false,
) {
	const job = jobs.get(id);
	if (!job || job.sessionId !== sessionId) return false;
	jobs.delete(id);
	const ticketRoots: string[] = [];
	for (const [token, ticket] of downloadTickets) {
		if (
			!preserveDownloadTickets &&
			ticket.sessionId === sessionId &&
			ticket.exportId === id
		) {
			downloadTickets.delete(token);
			ticketRoots.push(ticket.root);
		}
	}
	if (job.status === "running") {
		job.status = "canceled";
		job.child.kill("SIGTERM");
		const stopped = await Promise.race([
			job.task.then(() => true),
			Bun.sleep(5000).then(() => false),
		]);
		if (!stopped) {
			job.child.kill("SIGKILL");
			await job.task;
		}
	}
	await Promise.all([
		rm(job.settingsPath, { force: true }),
		rm(job.outputPath, { force: true }),
		...ticketRoots.map((root) => rm(root, { recursive: true, force: true })),
	]);
	return true;
}

const ticketSweep = setInterval(() => {
	for (const [token, ticket] of downloadTickets) {
		if (ticket.expiresAt < Date.now()) {
			downloadTickets.delete(token);
			void rm(ticket.root, { recursive: true, force: true }).catch((cause) => {
				console.error("Expired editor download cleanup failed", cause);
			});
		}
	}
}, 30_000);
ticketSweep.unref();

export async function closeEditorExports(sessionId: string) {
	closingSessions.add(sessionId);
	try {
		await starting.get(sessionId);
		await Promise.all(
			[...jobs.values()]
				.filter((job) => job.sessionId === sessionId)
				.map((job) => cancelEditorExport(sessionId, job.id, true)),
		);
	} finally {
		const release = setTimeout(() => closingSessions.delete(sessionId), 60_000);
		release.unref();
	}
}
