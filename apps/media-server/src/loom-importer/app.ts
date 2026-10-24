import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { validateMediaServerSecret } from "../lib/auth";
import {
	createJob,
	extendJobLifetime,
	generateJobId,
	getAllJobs,
	getJob,
	getJobProgress,
	type Job,
	sendWebhook,
	touchJob,
	updateJob,
} from "../lib/job-manager";
import { LOOM_IMPORT_MAX_BYTES } from "../lib/media-video";
import { parseAllowedHosts, Semaphore } from "./fetch";
import {
	type ImporterSettings,
	type ImportRequest,
	importRequestSchema,
	runLoomImport,
} from "./job";
import { previewRequestSchema, renderPreviewGif } from "./preview";

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadImporterSettings(
	env: Record<string, string | undefined> = process.env,
) {
	const settings: ImporterSettings = {
		workRoot: env.LOOM_IMPORTER_WORK_DIR ?? join(tmpdir(), "loom-importer"),
		allowedHosts: parseAllowedHosts(env.LOOM_IMPORTER_ALLOWED_HOSTS),
		globalSemaphore: new Semaphore(
			positiveInt(env.LOOM_IMPORTER_TOTAL_CONNECTIONS, 384),
		),
		jobConnections: positiveInt(env.LOOM_IMPORTER_JOB_CONNECTIONS, 48),
		rangedConnections: Math.min(
			32,
			positiveInt(env.LOOM_IMPORTER_RANGED_CONNECTIONS, 16),
		),
		segmentAttempts: positiveInt(env.LOOM_IMPORTER_SEGMENT_ATTEMPTS, 6),
		segmentTimeoutMs: positiveInt(env.LOOM_IMPORTER_SEGMENT_TIMEOUT_MS, 60_000),
		remuxTimeoutMs: positiveInt(env.LOOM_IMPORTER_REMUX_TIMEOUT_MS, 1_800_000),
		terminalWebhookAttempts: positiveInt(env.LOOM_IMPORTER_WEBHOOK_ATTEMPTS, 8),
		minFreeBytes:
			positiveInt(env.LOOM_IMPORTER_MIN_FREE_GB, 25) * 1024 * 1024 * 1024,
	};
	return {
		settings,
		maxActiveJobs: positiveInt(env.LOOM_IMPORTER_MAX_JOBS, 16),
		maxCustomerJobs: positiveInt(env.LOOM_IMPORTER_CUSTOMER_JOBS, 16),
		maxQueuedJobs: positiveInt(env.LOOM_IMPORTER_MAX_QUEUED, 400),
		maxPreviewJobs: positiveInt(env.LOOM_IMPORTER_PREVIEW_JOBS, 4),
	};
}

const JOB_LIFETIME_MS = 4 * 60 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 120_000;
const JOB_HEARTBEAT_MS = 60_000;

interface QueuedImport {
	jobId: string;
	request: ImportRequest;
}

type ImportLane = "customer" | "bulk";

const laneOf = (request: ImportRequest): ImportLane =>
	request.importPriority === "customer" ? "customer" : "bulk";

function isActive(job: Job) {
	return (
		job.phase !== "complete" &&
		job.phase !== "error" &&
		job.phase !== "cancelled"
	);
}

export function createLoomImporter(
	config: ReturnType<typeof loadImporterSettings> = loadImporterSettings(),
) {
	const queues: Record<ImportLane, QueuedImport[]> = {
		customer: [],
		bulk: [],
	};
	const queuedCount = () => queues.customer.length + queues.bulk.length;
	const queuedEntries = () => [...queues.customer, ...queues.bulk];
	const running = new Map<string, AbortController>();
	let runningCustomer = 0;
	let draining = false;
	const previewSemaphore = new Semaphore(config.maxPreviewJobs);
	const previews = new Set<AbortController>();

	const startJob = ({ jobId, request }: QueuedImport) =>
		createJob(
			jobId,
			request.videoId,
			request.userId,
			request.webhookUrl,
			request.webhookSecret,
		);

	const canStart = (lane: ImportLane) =>
		running.size <
		config.maxActiveJobs +
			(lane === "customer"
				? config.maxCustomerJobs
				: Math.min(runningCustomer, config.maxCustomerJobs));

	const nextImport = () => {
		if (queues.customer.length > 0 && canStart("customer"))
			return queues.customer.shift();
		if (queues.bulk.length > 0 && canStart("bulk")) return queues.bulk.shift();
		return undefined;
	};

	const pump = () => {
		for (let next = nextImport(); next; next = nextImport()) {
			const customer = laneOf(next.request) === "customer";
			if (customer) runningCustomer++;
			const job = startJob(next);
			const controller = new AbortController();
			updateJob(job.jobId, { abortController: controller });
			extendJobLifetime(job.jobId, JOB_LIFETIME_MS);
			const heartbeat = setInterval(
				() => touchJob(job.jobId),
				JOB_HEARTBEAT_MS,
			);
			running.set(job.jobId, controller);
			void runLoomImport(
				job,
				next.request,
				config.settings,
				new Semaphore(config.settings.jobConnections),
				controller.signal,
			).finally(() => {
				clearInterval(heartbeat);
				if (customer) runningCustomer--;
				running.delete(job.jobId);
				pump();
			});
		}
	};

	const app = new Hono().basePath("/loom-importer");

	app.get("/health", (c) =>
		c.json({
			status: draining ? "draining" : "ok",
			running: running.size,
			queued: queuedCount(),
		}),
	);

	app.get("/video/status", (c) => {
		if (!validateMediaServerSecret(c))
			return c.json({ error: "Unauthorized" }, 401);
		return c.json({
			loomImporter: true,
			loomImportMaxBytes: LOOM_IMPORT_MAX_BYTES,
			loomMultipartUploads: true,
			loomDeferredOriginals: true,
			draining,
			running: running.size,
			queued: queuedCount(),
			runningCustomer,
			queuedCustomer: queues.customer.length,
			maxActiveJobs: config.maxActiveJobs,
			maxCustomerJobs: config.maxCustomerJobs,
			maxQueuedJobs: config.maxQueuedJobs,
			jobs: getAllJobs()
				.filter(isActive)
				.map((job) => ({
					jobId: job.jobId,
					videoId: job.videoId,
					phase: job.phase,
					progress: job.progress,
					ageSeconds: Math.round((Date.now() - job.createdAt) / 1000),
				}))
				.concat(
					queuedEntries().map((entry) => ({
						jobId: entry.jobId,
						videoId: entry.request.videoId,
						phase: "queued" as Job["phase"],
						progress: 0,
						ageSeconds: 0,
					})),
				),
		});
	});

	app.post("/video/import", async (c) => {
		if (!validateMediaServerSecret(c))
			return c.json({ error: "Unauthorized" }, 401);
		const parsed = importRequestSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success)
			return c.json(
				{
					error: "Invalid request",
					code: "INVALID_REQUEST",
					details: parsed.error.message,
				},
				400,
			);
		const lane = laneOf(parsed.data);
		if (draining || queues[lane].length >= config.maxQueuedJobs) {
			c.header("Retry-After", "30");
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: draining
						? "Loom importer is draining"
						: "Loom import queue is full",
				},
				503,
			);
		}
		const jobId = generateJobId();
		queues[lane].push({ jobId, request: parsed.data });
		pump();
		return c.json({
			jobId,
			status: "queued",
			message: "Loom import queued",
		});
	});

	app.post("/video/preview-gif", async (c) => {
		if (!validateMediaServerSecret(c))
			return c.json({ error: "Unauthorized" }, 401);
		if (draining)
			return c.json(
				{ error: "Importer is draining", code: "SERVER_BUSY" },
				503,
			);
		const parsed = previewRequestSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success)
			return c.json({ error: "Invalid request", code: "INVALID_REQUEST" }, 400);
		if (previews.size >= config.maxPreviewJobs * 2)
			return c.json(
				{ error: "Preview queue is full", code: "SERVER_BUSY" },
				503,
			);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
		previews.add(controller);
		try {
			await previewSemaphore.run(() =>
				renderPreviewGif(parsed.data, controller.signal),
			);
			return c.json({ ok: true });
		} catch (error) {
			console.warn("[loom-importer] Preview GIF failed", error);
			return c.json(
				{ error: "Preview GIF failed", code: "PREVIEW_FAILED" },
				502,
			);
		} finally {
			clearTimeout(timeout);
			previews.delete(controller);
		}
	});

	app.get("/video/process/:jobId/status", (c) => {
		if (!validateMediaServerSecret(c))
			return c.json({ error: "Unauthorized" }, 401);
		const jobId = c.req.param("jobId");
		const job = getJob(jobId);
		if (job) return c.json(getJobProgress(job));
		const queued = queuedEntries().find((entry) => entry.jobId === jobId);
		if (queued)
			return c.json({
				jobId,
				videoId: queued.request.videoId,
				phase: "queued",
				progress: 0,
				message: "Waiting for a Loom import slot",
			});
		return c.json({ error: "Job not found", code: "NOT_FOUND" }, 404);
	});

	const cancelJob = async (job: Job) => {
		const cancelled = updateJob(job.jobId, {
			phase: "cancelled",
			progress: 0,
			message: "Server shutting down",
		});
		if (cancelled) await sendWebhook(cancelled);
	};

	const drain = async (timeoutMs: number) => {
		draining = true;
		const deadline = Date.now() + timeoutMs;
		while (
			(queuedCount() > 0 || running.size > 0 || previews.size > 0) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 500));
		for (const controller of previews) controller.abort();
		await Promise.all(
			[...queues.customer.splice(0), ...queues.bulk.splice(0)].map((entry) =>
				cancelJob(startJob(entry)),
			),
		);
		for (const controller of running.values()) controller.abort();
		while (running.size > 0 || previews.size > 0)
			await new Promise((resolve) => setTimeout(resolve, 250));
	};

	return {
		app,
		drain,
		stats: () => ({ running: running.size, queued: queuedCount() }),
	};
}
