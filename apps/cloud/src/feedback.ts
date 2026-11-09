import { boundedBody, HttpError, response } from "./shared";

export interface FeedbackEnv {
	MEDIA: R2Bucket;
	FEEDBACK_SITES?: string;
	FEEDBACK_LIMIT?: RateLimit;
	FEEDBACK_SITE_LIMIT?: RateLimit;
}

interface Site {
	key: string;
	name: string;
	origins: string[];
	retentionDays: number;
}

interface Attachment {
	contentType: string;
	size: number;
	sha256: string;
}

export interface FeedbackReport {
	schemaVersion: 1;
	id: string;
	site: string;
	origin: string;
	createdAt: number;
	expiresAt: number;
	note: string;
	evidence: Record<string, unknown>;
	screenshot: Attachment | null;
	voice: Attachment | null;
}

export const LIMITS = {
	body: 12 * 1024 * 1024,
	note: 4000,
	evidence: 256 * 1024,
	screenshot: 4 * 1024 * 1024,
	voice: 6 * 1024 * 1024,
	events: 200,
};
const KEY = /^wf_pub_[A-Za-z0-9_-]{12,64}$/;
const ID = /^\d{13}-[a-f0-9]{16}$/;
const LIST = "feedback-index/v1/";
const prefix = (id: string) => `feedback/v1/${id}/`;
const tombstone = (id: string) => `feedback-tombstones/v1/${id}`;
const SCREENSHOT_TYPES: Record<string, (bytes: Uint8Array) => boolean> = {
	"image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/png": (b) =>
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
			(v, i) => b[i] === v,
		),
	"image/webp": (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
};
const VOICE_TYPES: Record<string, (bytes: Uint8Array) => boolean> = {
	"audio/webm": (b) => [0x1a, 0x45, 0xdf, 0xa3].every((v, i) => b[i] === v),
	"audio/mp4": (b) => ascii(b, 4, 8) === "ftyp",
	"audio/ogg": (b) => ascii(b, 0, 4) === "OggS",
	"audio/aac": (b) => b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0,
	"audio/mpeg": (b) =>
		ascii(b, 0, 3) === "ID3" ||
		(b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

async function digest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

function normalizeOrigin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
			return null;
		return url.origin === value.replace(/\/$/, "") ? url.origin : null;
	} catch {
		return null;
	}
}

export function parseSites(raw: string | undefined): Map<string, Site> {
	const sites = new Map<string, Site>();
	if (!raw) return sites;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new HttpError(503, "Feedback sites are misconfigured.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HttpError(503, "Feedback sites are misconfigured.");
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		const site = entry as Record<string, unknown> | null;
		const origins = Array.isArray(site?.origins)
			? site.origins.map(normalizeOrigin)
			: [];
		const days = site?.retentionDays ?? 30;
		if (
			!KEY.test(key) ||
			!origins.length ||
			origins.includes(null) ||
			!Number.isInteger(days) ||
			Number(days) < 1 ||
			Number(days) > 30
		)
			throw new HttpError(503, "Feedback sites are misconfigured.");
		sites.set(key, {
			key,
			name: typeof site?.name === "string" ? site.name.slice(0, 80) : key,
			origins: origins as string[],
			retentionDays: Number(days),
		});
	}
	return sites;
}

function corsHeaders(origin: string): Headers {
	return new Headers({
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	});
}

function withCors(result: Response, origin: string | null): Response {
	if (!origin) return result;
	const copy = new Response(result.body, result);
	for (const [name, value] of corsHeaders(origin))
		copy.headers.set(name, value);
	return copy;
}

const stripQuery = (value: unknown) =>
	typeof value === "string"
		? value.split(/[?#]/, 1)[0]?.slice(0, 300)
		: undefined;

function evidenceOf(text: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, "Feedback evidence must be JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HttpError(400, "Feedback evidence must be a JSON object.");
	const evidence = value as Record<string, unknown>;
	if (evidence.schemaVersion !== 1)
		throw new HttpError(400, "Unsupported feedback evidence version.");
	const events = evidence.events ?? [];
	if (!Array.isArray(events) || events.length > LIMITS.events)
		throw new HttpError(400, "Too many feedback events.");
	evidence.route = stripQuery(evidence.route);
	evidence.events = events.map((event) => {
		if (!event || typeof event !== "object" || Array.isArray(event))
			throw new HttpError(400, "Invalid feedback event.");
		const copy = { ...(event as Record<string, unknown>) };
		for (const field of ["url", "request"])
			if (field in copy) copy[field] = stripQuery(copy[field]);
		return copy;
	});
	return evidence;
}

async function attachment(
	form: FormData,
	field: "screenshot" | "voice",
	types: Record<string, (bytes: Uint8Array) => boolean>,
	limit: number,
): Promise<{ bytes: Uint8Array; meta: Attachment } | null> {
	const value = form.get(field);
	if (value === null) return null;
	if (typeof value === "string")
		throw new HttpError(400, `The ${field} must be a file.`);
	const contentType = value.type.split(";")[0]?.trim().toLowerCase() ?? "";
	const check = types[contentType];
	if (!check) throw new HttpError(415, `Unsupported ${field} format.`);
	if (!value.size || value.size > limit)
		throw new HttpError(413, `The ${field} is too large.`);
	const bytes = new Uint8Array(await value.arrayBuffer());
	if (!check(bytes))
		throw new HttpError(415, `The ${field} does not match its format.`);
	return {
		bytes,
		meta: { contentType, size: bytes.byteLength, sha256: await digest(bytes) },
	};
}

function reportId(now: number): string {
	const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${String(9_999_999_999_999 - now).padStart(13, "0")}-${random}`;
}

async function limited(
	env: FeedbackEnv,
	origin: string,
	request: Request,
): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const [visitor, whole] = await Promise.all([
		env.FEEDBACK_LIMIT?.limit({ key: `${origin} ${ip}` }),
		env.FEEDBACK_SITE_LIMIT?.limit({ key: origin }),
	]);
	return visitor?.success === false || whole?.success === false;
}

async function submit(
	request: Request,
	env: FeedbackEnv,
	sites: Map<string, Site>,
	origin: string,
): Promise<Response> {
	if (
		!/^multipart\/form-data;/i.test(request.headers.get("Content-Type") ?? "")
	)
		throw new HttpError(415, "Feedback must be sent as multipart form data.");
	const declared = Number(request.headers.get("Content-Length") ?? 0);
	if (declared > LIMITS.body)
		throw new HttpError(413, "Feedback exceeds the allowed size.");
	const body = await boundedBody(request, LIMITS.body);
	let form: FormData;
	try {
		form = await new Response(body, {
			headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
		}).formData();
	} catch {
		throw new HttpError(400, "Feedback form could not be read.");
	}
	const key = form.get("key");
	const site = typeof key === "string" ? sites.get(key) : undefined;
	if (!site || !site.origins.includes(origin))
		throw new HttpError(403, "This site may not send feedback here.");
	const note = form.get("note") ?? "";
	const evidenceText = form.get("evidence");
	if (typeof note !== "string" || note.length > LIMITS.note)
		throw new HttpError(400, `Notes are limited to ${LIMITS.note} characters.`);
	if (typeof evidenceText !== "string" || evidenceText.length > LIMITS.evidence)
		throw new HttpError(400, "Feedback evidence is missing or too large.");
	const evidence = evidenceOf(evidenceText);
	const screenshot = await attachment(
		form,
		"screenshot",
		SCREENSHOT_TYPES,
		LIMITS.screenshot,
	);
	const voice = await attachment(form, "voice", VOICE_TYPES, LIMITS.voice);
	if (!note.trim() && !screenshot && !voice)
		throw new HttpError(400, "Add a note, screenshot or voice memo.");
	const now = Date.now();
	const id = reportId(now);
	const report: FeedbackReport = {
		schemaVersion: 1,
		id,
		site: site.name,
		origin,
		createdAt: now,
		expiresAt: now + site.retentionDays * 86_400_000,
		note: note.trim(),
		evidence,
		screenshot: screenshot?.meta ?? null,
		voice: voice?.meta ?? null,
	};
	for (const [name, part] of [
		["screenshot", screenshot],
		["voice", voice],
	] as const)
		if (part)
			await env.MEDIA.put(`${prefix(id)}${name}`, part.bytes, {
				httpMetadata: { contentType: part.meta.contentType },
				customMetadata: { sha256: part.meta.sha256 },
			});
	await env.MEDIA.put(`${prefix(id)}report.json`, JSON.stringify(report), {
		httpMetadata: { contentType: "application/json" },
	});
	await env.MEDIA.put(`${LIST}${id}`, "", {
		customMetadata: {
			site: site.name,
			createdAt: String(now),
			expiresAt: String(report.expiresAt),
			route: String(evidence.route ?? "").slice(0, 200),
			preview: report.note.slice(0, 160),
			screenshot: screenshot ? "1" : "0",
			voice: voice ? "1" : "0",
		},
	});
	return response({ id }, 201);
}

async function live(bucket: R2Bucket, id: string): Promise<FeedbackReport> {
	if (await bucket.head(tombstone(id)))
		throw new HttpError(404, "Feedback unavailable.");
	const object = await bucket.get(`${prefix(id)}report.json`);
	if (!object) throw new HttpError(404, "Feedback unavailable.");
	const report = await object.json<FeedbackReport>();
	if (report.expiresAt <= Date.now())
		throw new HttpError(404, "Feedback unavailable.");
	return report;
}

async function list(
	bucket: R2Bucket,
	cursor: string | undefined,
): Promise<Response> {
	const page = await bucket.list({
		prefix: LIST,
		cursor,
		limit: 50,
		include: ["customMetadata"],
	});
	const now = Date.now();
	const reports = page.objects
		.map((object) => {
			const meta = object.customMetadata ?? {};
			return {
				id: object.key.slice(LIST.length),
				site: meta.site ?? "",
				createdAt: Number(meta.createdAt),
				expiresAt: Number(meta.expiresAt),
				route: meta.route ?? "",
				preview: meta.preview ?? "",
				screenshot: meta.screenshot === "1",
				voice: meta.voice === "1",
			};
		})
		.filter((report) => report.expiresAt > now);
	return response({
		reports,
		...(page.truncated ? { cursor: page.cursor } : {}),
	});
}

async function remove(bucket: R2Bucket, id: string): Promise<Response> {
	await bucket.put(tombstone(id), "deleted");
	await bucket.delete([
		`${LIST}${id}`,
		`${prefix(id)}report.json`,
		`${prefix(id)}screenshot`,
		`${prefix(id)}voice`,
	]);
	return new Response(null, { status: 204 });
}

export async function feedback(
	request: Request,
	env: FeedbackEnv,
	authorizeOwner: () => Promise<string>,
): Promise<Response> {
	const url = new URL(request.url);
	const suffix = url.pathname.slice("/api/v1/feedback".length);
	const requestOrigin = request.headers.get("Origin");
	if (!suffix && (request.method === "POST" || request.method === "OPTIONS")) {
		const sites = parseSites(env.FEEDBACK_SITES);
		const allowed =
			requestOrigin !== null &&
			[...sites.values()].some((site) => site.origins.includes(requestOrigin));
		if (!allowed)
			throw new HttpError(403, "This site may not send feedback here.");
		if (request.method === "OPTIONS")
			return new Response(null, {
				status: 204,
				headers: corsHeaders(requestOrigin),
			});
		try {
			if (await limited(env, requestOrigin, request))
				throw new HttpError(
					429,
					"Too much feedback from this browser. Try again in a minute.",
				);
			return withCors(
				await submit(request, env, sites, requestOrigin),
				requestOrigin,
			);
		} catch (error) {
			if (error instanceof HttpError)
				return withCors(
					response({ error: error.message }, error.status),
					requestOrigin,
				);
			throw error;
		}
	}
	await authorizeOwner();
	if (!suffix || suffix === "/") {
		if (request.method !== "GET")
			throw new HttpError(405, "Method not allowed.");
		return list(env.MEDIA, url.searchParams.get("cursor") ?? undefined);
	}
	const match = /^\/([^/]+)(?:\/(screenshot|voice))?$/.exec(suffix);
	const id = match?.[1] ?? "";
	if (!match || !ID.test(id)) throw new HttpError(404, "Feedback unavailable.");
	const part = match[2] as "screenshot" | "voice" | undefined;
	if (request.method === "DELETE" && !part) return remove(env.MEDIA, id);
	if (request.method !== "GET") throw new HttpError(405, "Method not allowed.");
	const report = await live(env.MEDIA, id);
	if (!part) return response(report);
	const meta = report[part];
	const object = meta ? await env.MEDIA.get(`${prefix(id)}${part}`) : null;
	if (!meta || !object)
		throw new HttpError(404, "Feedback attachment unavailable.");
	return new Response(object.body, {
		headers: {
			"Content-Type": meta.contentType,
			"Content-Length": String(object.size),
			"Content-Disposition": "attachment",
			"X-Content-SHA256": meta.sha256,
		},
	});
}
