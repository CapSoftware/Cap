import { rm } from "node:fs/promises";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	MAX_CAP_BUNDLE_BYTES,
} from "@cap/editor-cap-bundle";
import { Hono } from "hono";
import { z } from "zod";
import { hasEditorCaptionContent } from "../../../web/lib/editor-caption-access";
import { validWebEditorTitle } from "../../../web/lib/editor-recording-title";
import { validateMediaServerSecret } from "../lib/auth";
import { stageSignedEditorAudioAsset } from "../lib/editor-assets";
import { prepareEditorCapCaptionAudio } from "../lib/editor-cap-captions";
import {
	beginEditorCapImport,
	cancelEditorCapImport,
	EditorCapImportBusyError,
	getEditorCapImport,
} from "../lib/editor-cap-imports";
import {
	mapEditorConfigPaths,
	mapEditorInstanceConfigPaths,
} from "../lib/editor-config-paths";
import {
	beginEditorExport,
	cancelEditorExport,
	consumeEditorExportDownloadTicket,
	createEditorExportDownloadTicket,
	EditorExportBusyError,
	editorExportSettingsSchema,
	getEditorExport,
	getEditorExportFile,
	markEditorExportDownloadStarted,
} from "../lib/editor-exports";
import { stageSignedEditorImageAsset } from "../lib/editor-image-assets";
import {
	consumeEditorProjectBundleDownloadTicket,
	createEditorProjectBundleDownloadTicket,
	editorProjectBundleResponse,
} from "../lib/editor-project-bundles";
import {
	beginEditorPreparation,
	cancelEditorPreparation,
	closeEditorSession,
	EditorSessionBusyError,
	getEditorPreparation,
	getEditorSession,
	getEditorSessionVideoId,
} from "../lib/editor-sessions";
import { createEditorSocketTickets } from "../lib/editor-socket-tickets";
import {
	beginEditorVideoImport,
	cancelEditorVideoImport,
	EditorVideoImportBusyError,
	getEditorVideoImport,
} from "../lib/editor-video-imports";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const legacyEditSpecSchema = z.object({
	version: z.literal(1),
	sourceDuration: z.number().finite().positive().max(86_400),
	keepRanges: z
		.array(
			z.object({
				start: z.number().finite().nonnegative(),
				end: z.number().finite().positive(),
			}),
		)
		.min(1)
		.max(1_000),
});

const mediaSchema = z.object({
	url: z.string().url(),
	contentType: z.enum(["video/webm", "video/mp4"]),
	size: z
		.number()
		.int()
		.positive()
		.max(12 * 1024 * 1024 * 1024),
	fps: z.number().int().min(1).max(120).optional(),
	objectIdentity: z.string().min(1).max(256).nullable().optional(),
});

const audioAssetSchema = z.object({
	path: z
		.string()
		.regex(
			/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/,
		),
	name: z.string().min(1).max(100),
	url: z.string().url(),
	size: z
		.number()
		.int()
		.positive()
		.max(32 * 1024 * 1024),
	contentType: z.string().min(1).max(100),
	objectIdentity: z.string().min(1).max(256).nullable().optional(),
});

const imageAssetSchema = z.object({
	path: z
		.string()
		.regex(
			/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/,
		),
	name: z.string().min(1).max(100),
	url: z.string().url(),
	size: z
		.number()
		.int()
		.positive()
		.max(64 * 1024 * 1024),
	contentType: z.string().min(1).max(100),
	objectIdentity: z.string().min(1).max(256).nullable().optional(),
});

const videoAssetSchema = z.object({
	path: z
		.string()
		.regex(
			/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|avi|mkv|webm|wmv|m4v|flv)$/,
		),
	name: z.string().min(1).max(100),
	url: z.string().url(),
	size: z
		.number()
		.int()
		.positive()
		.max(12 * 1024 * 1024 * 1024),
	contentType: z.string().min(1).max(100),
	objectIdentity: z.string().min(1).max(256).nullable().optional(),
});

const capAssetSchema = z.object({
	path: z
		.string()
		.regex(
			/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/,
		),
	name: z.string().min(1).max(100),
	url: z.string().url(),
	size: z.number().int().positive().max(MAX_CAP_BUNDLE_BYTES),
	contentType: z.literal(CAP_BUNDLE_CONTENT_TYPE),
	objectIdentity: z.string().min(1).max(256).nullable().optional(),
});

const capCaptionRequestSchema = z.object({
	asset: capAssetSchema,
	segments: z
		.array(
			z
				.object({
					mediaDurationMs: z.number().int().positive().max(86_400_000),
					segmentDurationMs: z.number().int().positive().max(86_400_000),
					hasAudio: z.boolean(),
				})
				.refine(
					(segment) => segment.segmentDurationMs >= segment.mediaDurationMs,
				),
		)
		.min(1)
		.max(1000),
});

const clipSchema = z
	.object({
		displayPath: z
			.string()
			.regex(
				/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/,
			),
		duration: z.number().positive().max(86_400),
		fps: z.number().int().min(1).max(120),
		hasAudio: z.boolean(),
		cameraPath: z
			.string()
			.regex(
				/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/,
			)
			.optional(),
		cameraFps: z.number().int().min(1).max(120).optional(),
		cameraOffsetMs: z.number().int().min(-30_000).max(30_000).optional(),
	})
	.refine(
		(clip) =>
			(clip.cameraPath === undefined &&
				clip.cameraFps === undefined &&
				clip.cameraOffsetMs === undefined) ||
			(clip.cameraPath !== undefined &&
				clip.cameraPath !== clip.displayPath &&
				clip.cameraFps !== undefined &&
				clip.cameraOffsetMs !== undefined),
	);

const importSchema = z.union([
	z.object({ kind: z.literal("clip"), clip: clipSchema }),
	z.object({
		kind: z.literal("cap"),
		asset: capAssetSchema,
		clipCount: z.number().int().min(1).max(1000),
	}),
]);

const sessionSchema = z
	.object({
		videoId: z.string().min(1).max(100),
		title: z.string().min(1).max(255),
		captionsEnabled: z.boolean().default(false),
		display: mediaSchema,
		camera: mediaSchema
			.extend({ offsetMs: z.number().int().min(-30_000).max(30_000) })
			.optional(),
		projectConfig: z
			.record(z.unknown())
			.refine(
				(config) =>
					Buffer.byteLength(JSON.stringify(config), "utf8") <= MAX_CONFIG_BYTES,
			)
			.optional(),
		legacyEditSpec: legacyEditSpecSchema.optional(),
		audioAssets: z
			.array(audioAssetSchema)
			.max(100)
			.refine(
				(assets) =>
					assets.reduce((bytes, asset) => bytes + asset.size, 0) <=
					512 * 1024 * 1024,
			)
			.optional(),
		imageAssets: z
			.array(imageAssetSchema)
			.max(100)
			.refine(
				(assets) =>
					assets.reduce((bytes, asset) => bytes + asset.size, 0) <=
					512 * 1024 * 1024,
			)
			.optional(),
		videoAssets: z
			.array(videoAssetSchema)
			.max(100)
			.refine(
				(assets) =>
					assets.reduce((bytes, asset) => bytes + asset.size, 0) <=
					12 * 1024 * 1024 * 1024,
			)
			.optional(),
		clips: z.array(clipSchema).max(49).optional(),
		imports: z.array(importSchema).max(100).optional(),
	})
	.refine((input) => {
		if (input.clips && input.imports) return false;
		if (input.legacyEditSpec && input.camera) return false;
		const clips =
			input.imports?.flatMap((item) =>
				item.kind === "clip" ? [item.clip] : [],
			) ??
			input.clips ??
			[];
		const capCount =
			input.imports
				?.filter((item) => item.kind === "cap")
				.reduce((total, item) => total + item.clipCount, 0) ?? 0;
		return (
			clips.length <= 49 &&
			clips.length + capCount <= 1000 &&
			clips.every(
				(clip) =>
					input.videoAssets?.some((asset) => asset.path === clip.displayPath) &&
					(!clip.cameraPath ||
						input.videoAssets.some((asset) => asset.path === clip.cameraPath)),
			)
		);
	});

const previewSchema = z.object({
	frameNumber: z.number().int().nonnegative(),
	fps: z.number().int().min(1).max(60),
	resolutionBase: z.object({
		x: z.number().int().min(1).max(3840),
		y: z.number().int().min(1).max(2160),
	}),
});

const editor = new Hono();

editor.use("*", async (c, next) => {
	if (
		c.req.method === "GET" &&
		/^\/editor\/sessions\/(?:[a-z][a-z0-9-]{0,23}\.)?[0-9a-f-]{36}\/(?:exports\/[0-9a-f-]{36}|project-bundle)\/download$/.test(
			c.req.path,
		)
	) {
		await next();
		return;
	}
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
});

editor.post("/caption-cap-audio", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid Cap caption source" }, 400);
	}
	const parsed = capCaptionRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid Cap caption source" }, 400);
	}
	let prepared: Awaited<ReturnType<typeof prepareEditorCapCaptionAudio>>;
	try {
		prepared = await prepareEditorCapCaptionAudio(
			parsed.data.asset,
			parsed.data.segments,
			c.req.raw.signal,
		);
	} catch (error) {
		console.error("Editor Cap caption audio failed", error);
		return c.json({ error: "Cap caption audio is unavailable" }, 502);
	}
	const reader = Bun.file(prepared.path).stream().getReader();
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await prepared.cleanup();
	};
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					await cleanup();
				} else {
					controller.enqueue(value);
				}
			} catch (error) {
				controller.error(error);
				await cleanup();
			}
		},
		async cancel() {
			await reader.cancel();
			await cleanup();
		},
	});
	return c.body(stream, 200, {
		"Content-Type": "audio/mp4",
		"Content-Length": String(prepared.size),
		"Cache-Control": "no-store",
	});
});

editor.post("/preparations", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor session request" }, 400);
	}
	const parsed = sessionSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid editor session request" }, 400);
	}
	try {
		const id = beginEditorPreparation(parsed.data);
		return c.json({ id, status: "preparing" as const }, 202);
	} catch (error) {
		if (error instanceof EditorSessionBusyError) {
			return c.json({ error: error.message }, 503);
		}
		console.error("Editor session creation failed", error);
		return c.json({ error: "Editor session could not start" }, 502);
	}
});

editor.get("/preparations/:id", (c) => {
	const preparation = getEditorPreparation(c.req.param("id"));
	return preparation
		? c.json(preparation)
		: c.json({ error: "Not found" }, 404);
});

editor.delete("/preparations/:id", (c) => {
	const canceled = cancelEditorPreparation(c.req.param("id"));
	return canceled ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

editor.delete("/sessions/:id", async (c) => {
	const closed = await closeEditorSession(c.req.param("id"));
	return closed ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

editor.get("/sessions/:id", (c) => {
	const videoId = getEditorSessionVideoId(c.req.param("id"));
	return videoId ? c.json({ videoId }) : c.json({ error: "Not found" }, 404);
});

editor.post("/sessions/:id/sockets", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor socket request" }, 400);
	}
	const parsed = z.object({ origin: z.string().url() }).safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid editor socket request" }, 400);
	}
	try {
		const result = createEditorSocketTickets(
			c.req.param("id"),
			parsed.data.origin,
		);
		return result ? c.json(result) : c.json({ error: "Not found" }, 404);
	} catch (error) {
		console.error("Editor socket ticket creation failed", error);
		return c.json({ error: "Editor sockets unavailable" }, 503);
	}
});

editor.post("/sessions/:id/audio-assets", async (c) => {
	const session = getEditorSession(c.req.param("id"));
	if (!session) return c.json({ error: "Not found" }, 404);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor audio asset" }, 400);
	}
	const parsed = audioAssetSchema.safeParse(body);
	if (!parsed.success)
		return c.json({ error: "Invalid editor audio asset" }, 400);
	try {
		const imported = await stageSignedEditorAudioAsset(
			session.projectPath,
			parsed.data,
			c.req.raw.signal,
		);
		return c.json(imported);
	} catch (error) {
		console.error("Editor audio import failed", error);
		return c.json({ error: "Editor audio could not be imported" }, 502);
	}
});

editor.post("/sessions/:id/image-assets", async (c) => {
	const session = getEditorSession(c.req.param("id"));
	if (!session) return c.json({ error: "Not found" }, 404);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor image asset" }, 400);
	}
	const parsed = imageAssetSchema.safeParse(body);
	if (!parsed.success)
		return c.json({ error: "Invalid editor image asset" }, 400);
	try {
		const imported = await stageSignedEditorImageAsset(
			session.projectPath,
			parsed.data,
			c.req.raw.signal,
		);
		return c.json(imported);
	} catch (error) {
		console.error("Editor image import failed", error);
		return c.json({ error: "Editor image could not be imported" }, 502);
	}
});

editor.post("/sessions/:id/video-assets", async (c) => {
	const sessionId = c.req.param("id");
	const session = getEditorSession(sessionId);
	if (!session) return c.json({ error: "Not found" }, 404);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor video asset" }, 400);
	}
	const parsed = videoAssetSchema.safeParse(body);
	if (!parsed.success)
		return c.json({ error: "Invalid editor video asset" }, 400);
	try {
		const id = beginEditorVideoImport(
			sessionId,
			session.projectPath,
			parsed.data,
		);
		return c.json({ id, status: "staging" as const }, 202);
	} catch (error) {
		if (error instanceof EditorVideoImportBusyError) {
			return c.json({ error: error.message }, 503);
		}
		console.error("Editor video import failed", error);
		return c.json({ error: "Editor video could not be imported" }, 502);
	}
});

editor.get("/sessions/:id/video-assets/:jobId", (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const job = getEditorVideoImport(sessionId, c.req.param("jobId"));
	return job ? c.json(job) : c.json({ error: "Not found" }, 404);
});

editor.delete("/sessions/:id/video-assets/:jobId", async (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const canceled = await cancelEditorVideoImport(
		sessionId,
		c.req.param("jobId"),
	);
	return canceled ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

editor.post("/sessions/:id/cap-assets", async (c) => {
	const sessionId = c.req.param("id");
	const session = getEditorSession(sessionId);
	if (!session) return c.json({ error: "Not found" }, 404);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor Cap project asset" }, 400);
	}
	const parsed = capAssetSchema.safeParse(body);
	if (!parsed.success)
		return c.json({ error: "Invalid editor Cap project asset" }, 400);
	try {
		const id = beginEditorCapImport(
			sessionId,
			session.projectPath,
			parsed.data,
		);
		return c.json({ id, status: "staging" as const }, 202);
	} catch (error) {
		if (error instanceof EditorCapImportBusyError) {
			return c.json({ error: error.message }, 503);
		}
		console.error("Editor Cap project import failed", error);
		return c.json({ error: "Cap project could not be imported" }, 502);
	}
});

editor.get("/sessions/:id/cap-assets/:jobId", (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const job = getEditorCapImport(sessionId, c.req.param("jobId"));
	return job ? c.json(job) : c.json({ error: "Not found" }, 404);
});

editor.delete("/sessions/:id/cap-assets/:jobId", async (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const canceled = await cancelEditorCapImport(sessionId, c.req.param("jobId"));
	return canceled ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

function nativeSession(id: string) {
	return getEditorSession(id);
}

async function forward(
	id: string,
	path: string,
	method: "GET" | "PUT" | "POST" | "DELETE",
	body?: unknown,
) {
	const session = nativeSession(id);
	if (!session) return new Response("Not found", { status: 404 });
	if (
		(path === "/config" || path === "/config/memory") &&
		method === "PUT" &&
		!session.captionsEnabled &&
		hasEditorCaptionContent(body)
	) {
		return new Response("Cap Pro is required for captions", { status: 403 });
	}
	try {
		const nativeBody =
			(path === "/config" || path === "/config/memory") && method === "PUT"
				? mapEditorConfigPaths(body, "native", session.projectPath)
				: body;
		const response = await session.request(path, {
			method,
			...(nativeBody !== undefined
				? {
						body: JSON.stringify(nativeBody),
						headers: { "Content-Type": "application/json" },
					}
				: {}),
			signal: AbortSignal.timeout(10_000),
		});
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "private, no-store");
		if (
			response.ok &&
			method === "GET" &&
			(path === "/instance" || path === "/config")
		) {
			const value: unknown = await response.json();
			const browserValue =
				path === "/instance"
					? mapEditorInstanceConfigPaths(value, "browser", session.projectPath)
					: mapEditorConfigPaths(value, "browser", session.projectPath);
			headers.delete("Content-Length");
			return new Response(JSON.stringify(browserValue), {
				status: response.status,
				headers,
			});
		}
		return new Response(response.body, { status: response.status, headers });
	} catch (error) {
		console.error("Editor session request failed", error);
		return new Response("Editor session unavailable", { status: 502 });
	}
}

editor.get("/sessions/:id/instance", (c) =>
	forward(c.req.param("id"), "/instance", "GET"),
);
editor.get("/sessions/:id/meta", (c) =>
	forward(c.req.param("id"), "/meta", "GET"),
);
editor.put("/sessions/:id/meta", async (c) => {
	const text = await c.req.text();
	if (Buffer.byteLength(text, "utf8") > 1024)
		return c.json({ error: "Recording title is too large" }, 413);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return c.json({ error: "Invalid recording title" }, 400);
	}
	const parsed = z.object({ prettyName: z.string() }).safeParse(body);
	if (!parsed.success || !validWebEditorTitle(parsed.data.prettyName))
		return c.json({ error: "Invalid recording title" }, 400);
	return forward(c.req.param("id"), "/meta", "PUT", parsed.data);
});
editor.get("/sessions/:id/config", (c) =>
	forward(c.req.param("id"), "/config", "GET"),
);
editor.get("/sessions/:id/animated-gradients", (c) =>
	forward(c.req.param("id"), "/animated-gradients", "GET"),
);
async function configBody(c: { req: { text: () => Promise<string> } }) {
	const text = await c.req.text();
	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
		return new Response("Editor config is too large", { status: 413 });
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return new Response("Invalid editor config", { status: 400 });
	}
}

editor.put("/sessions/:id/config", async (c) => {
	const body = await configBody(c);
	return body instanceof Response
		? body
		: forward(c.req.param("id"), "/config", "PUT", body);
});
editor.put("/sessions/:id/config/memory", async (c) => {
	const body = await configBody(c);
	return body instanceof Response
		? body
		: forward(c.req.param("id"), "/config/memory", "PUT", body);
});

async function previewBody(c: {
	req: { json: () => Promise<unknown>; param: (name: string) => string };
}) {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return new Response("Invalid preview request", { status: 400 });
	}
	const parsed = previewSchema.safeParse(body);
	if (!parsed.success) {
		return new Response("Invalid preview request", { status: 400 });
	}
	return parsed.data;
}

editor.post("/sessions/:id/preview", async (c) => {
	const body = await previewBody(c);
	return body instanceof Response
		? body
		: forward(c.req.param("id"), "/preview", "POST", body);
});
editor.post("/sessions/:id/playback", async (c) => {
	const body = await previewBody(c);
	return body instanceof Response
		? body
		: forward(c.req.param("id"), "/playback", "POST", body);
});
editor.delete("/sessions/:id/playback", (c) =>
	forward(c.req.param("id"), "/playback", "DELETE"),
);
editor.put("/sessions/:id/seek", async (c) => {
	const body = await previewBody(c);
	return body instanceof Response
		? body
		: forward(c.req.param("id"), "/seek", "PUT", body);
});

editor.post("/sessions/:id/exports", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid editor export request" }, 400);
	}
	const settings = editorExportSettingsSchema.safeParse(body);
	if (!settings.success)
		return c.json({ error: "Invalid editor export settings" }, 400);
	const sessionId = c.req.param("id");
	const native = getEditorSession(sessionId);
	if (!native) return c.json({ error: "Not found" }, 404);
	try {
		const id = await beginEditorExport(sessionId, native, settings.data);
		return c.json({ id, status: "running" as const }, 202);
	} catch (cause) {
		if (cause instanceof EditorExportBusyError) {
			return c.json({ error: cause.message }, 503);
		}
		console.error("Editor export could not start", cause);
		return c.json({ error: "Editor export unavailable" }, 503);
	}
});

editor.get("/sessions/:id/exports/:exportId", (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const job = getEditorExport(sessionId, c.req.param("exportId"));
	return job ? c.json(job) : c.json({ error: "Not found" }, 404);
});

editor.get("/sessions/:id/exports/:exportId/file", (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const exportId = c.req.param("exportId");
	const job = getEditorExport(sessionId, exportId);
	const path = getEditorExportFile(sessionId, exportId);
	if (!job || !path) return c.json({ error: "Not found" }, 404);
	const extension =
		job.format === "Mp4" ? "mp4" : job.format === "Gif" ? "gif" : "mov";
	const contentType =
		job.format === "Mp4"
			? "video/mp4"
			: job.format === "Gif"
				? "image/gif"
				: "video/quicktime";
	return new Response(Bun.file(path), {
		headers: {
			"Content-Type": contentType,
			"Content-Disposition": `attachment; filename="cap-export-${exportId}.${extension}"`,
			"Cache-Control": "private, no-store",
		},
	});
});

editor.get("/sessions/:id/exports/:exportId/chunk", (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const exportId = c.req.param("exportId");
	const job = getEditorExport(sessionId, exportId);
	const path = getEditorExportFile(sessionId, exportId);
	if (
		!job ||
		!path ||
		job.format !== "Mp4" ||
		!job.size ||
		!job.mediaMetadata
	) {
		return c.json({ error: "Not found" }, 404);
	}
	const offsetText = c.req.query("offset") ?? "";
	const lengthText = c.req.query("length") ?? "";
	if (
		!/^(0|[1-9][0-9]*)$/.test(offsetText) ||
		!/^[1-9][0-9]*$/.test(lengthText)
	)
		return c.json({ error: "Invalid export range" }, 400);
	const offset = Number(offsetText);
	const length = Number(lengthText);
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		length > 16 * 1024 * 1024 ||
		offset + length > job.size
	) {
		return c.json({ error: "Invalid export range" }, 400);
	}
	const file = Bun.file(path);
	if (file.size !== job.size)
		return c.json({ error: "Editor export changed" }, 503);
	return new Response(file.slice(offset, offset + length), {
		status: 206,
		headers: {
			"Content-Type": "video/mp4",
			"Content-Length": String(length),
			"Content-Range": `bytes ${offset}-${offset + length - 1}/${job.size}`,
			"Cache-Control": "private, no-store",
		},
	});
});

editor.post("/sessions/:id/exports/:exportId/download-ticket", async (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	let fileName: string | undefined;
	try {
		const body: unknown = await c.req.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"fileName" in body &&
			typeof body.fileName === "string" &&
			body.fileName.length <= 200
		) {
			fileName = body.fileName;
		}
	} catch {
		fileName = undefined;
	}
	try {
		const result = await createEditorExportDownloadTicket(
			sessionId,
			c.req.param("exportId"),
			fileName,
		);
		return result ? c.json(result) : c.json({ error: "Not found" }, 404);
	} catch (cause) {
		console.error("Editor download ticket unavailable", cause);
		return c.json({ error: "Editor download unavailable" }, 503);
	}
});

editor.get("/sessions/:id/exports/:exportId/download", (c) => {
	const sessionId = c.req.param("id");
	const exportId = c.req.param("exportId");
	const ticket = consumeEditorExportDownloadTicket(
		sessionId,
		exportId,
		c.req.query("ticket") ?? null,
	);
	if (!ticket) return c.json({ error: "Not found" }, 404);
	markEditorExportDownloadStarted(sessionId, exportId);
	const contentType =
		ticket.format === "Mp4"
			? "video/mp4"
			: ticket.format === "Gif"
				? "image/gif"
				: "video/quicktime";
	const file = Bun.file(ticket.path);
	const asciiName = ticket.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encodedName = encodeURIComponent(ticket.fileName).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	const reader = file.stream().getReader();
	let finished = false;
	const finish = async () => {
		if (finished) return;
		finished = true;
		await Promise.allSettled([
			rm(ticket.root, { recursive: true, force: true }),
			cancelEditorExport(sessionId, exportId),
		]);
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const packet = await reader.read();
				if (packet.done) {
					controller.close();
					await finish();
				} else {
					controller.enqueue(packet.value);
				}
			} catch (cause) {
				await finish();
				controller.error(cause);
			}
		},
		async cancel() {
			await reader.cancel();
			await finish();
		},
	});
	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Content-Length": String(file.size),
			"Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
});

editor.post("/sessions/:id/project-bundle/download-ticket", async (c) => {
	const sessionId = c.req.param("id");
	const session = getEditorSession(sessionId);
	if (!session) return c.json({ error: "Not found" }, 404);
	let fileName: string | undefined;
	try {
		const body: unknown = await c.req.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"fileName" in body &&
			typeof body.fileName === "string" &&
			body.fileName.length <= 200
		) {
			fileName = body.fileName;
		}
	} catch {
		fileName = undefined;
	}
	try {
		return c.json(
			await createEditorProjectBundleDownloadTicket(
				sessionId,
				session.projectPath,
				fileName,
			),
		);
	} catch (cause) {
		console.error("Editor project bundle unavailable", cause);
		return c.json({ error: "Editor project bundle is unavailable" }, 503);
	}
});

editor.get("/sessions/:id/project-bundle/download", (c) => {
	const ticket = consumeEditorProjectBundleDownloadTicket(
		c.req.param("id"),
		c.req.query("ticket") ?? null,
	);
	return ticket
		? editorProjectBundleResponse(ticket)
		: c.json({ error: "Not found" }, 404);
});

editor.delete("/sessions/:id/exports/:exportId", async (c) => {
	const sessionId = c.req.param("id");
	if (!getEditorSession(sessionId)) return c.json({ error: "Not found" }, 404);
	const canceled = await cancelEditorExport(sessionId, c.req.param("exportId"));
	return canceled ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

export default editor;
