import brand from "../../../crates/fork-brand/brand.json";
import { feedback } from "./feedback";
import { recovery } from "./recovery";
import {
	bearer,
	boundedBody,
	equal,
	HttpError,
	hash,
	response,
} from "./shared";

type RuntimeEnv = Env & { UPLOAD_TOKEN?: string; FEEDBACK_SITES?: string };

interface Share {
	id: string;
	owner: string;
	readHash: string;
	title: string;
	contentType: string;
	size: number;
	uploadId: string;
	expiresAt: number;
	ready: boolean;
}

const PART_SIZE = 8 * 1024 * 1024;
const TYPES = new Set(["video/mp4", "image/png", "image/jpeg"]);

async function owner(request: Request, env: RuntimeEnv): Promise<string> {
	if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) {
		throw new HttpError(
			503,
			"Sharing has not been configured by the server owner.",
		);
	}
	const token = bearer(request);
	if (!(await equal(token, env.UPLOAD_TOKEN)))
		throw new HttpError(401, "Invalid upload credential.");
	return "self-hosted-owner";
}

async function json(request: Request): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(
			new TextDecoder().decode(await boundedBody(request, 256 * 1024)),
		);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error();
		return value as Record<string, unknown>;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "Invalid JSON request.");
	}
}

async function load(env: RuntimeEnv, id: string): Promise<Share> {
	if (await env.MEDIA.head(`revoked/${id}`))
		throw new HttpError(404, "Share unavailable.");
	const object = await env.MEDIA.get(`shares/${id}.json`);
	if (!object) throw new HttpError(404, "Share unavailable.");
	const share = await object.json<Share>();
	if (share.expiresAt <= Date.now())
		throw new HttpError(404, "Share unavailable.");
	return share;
}

async function readable(request: Request, share: Share): Promise<string> {
	const cookie = request.headers
		.get("Cookie")
		?.split(";")
		.map((value) => value.trim())
		.find((value) => value.startsWith("capux_read="))
		?.slice(11);
	const token = bearer(request) || cookie || "";
	if (!share.ready || !(await equal(await hash(token), share.readHash)))
		throw new HttpError(404, "Share unavailable.");
	return token;
}

async function create(request: Request, env: RuntimeEnv): Promise<Response> {
	const ownerId = await owner(request, env);
	const body = await json(request);
	const { title, size, contentType } = body;
	const days = body.expiresInDays ?? 7;
	if (
		typeof title !== "string" ||
		title.length > 240 ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > 20 * 1024 ** 3 ||
		typeof contentType !== "string" ||
		!TYPES.has(contentType) ||
		typeof days !== "number" ||
		!Number.isInteger(days) ||
		days < 1 ||
		days > 30
	) {
		throw new HttpError(
			400,
			"Choose a video or image, a valid size, and an expiry from 1 to 30 days.",
		);
	}
	const id = crypto.randomUUID();
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const upload = await env.MEDIA.createMultipartUpload(`media/${id}`, {
		httpMetadata: { contentType },
	});
	const share: Share = {
		id,
		owner: ownerId,
		readHash: await hash(token),
		title: title.trim() || `${brand.display_name} recording`,
		contentType,
		size,
		uploadId: upload.uploadId,
		expiresAt: Date.now() + days * 86400000,
		ready: false,
	};
	await env.MEDIA.put(`shares/${id}.json`, JSON.stringify(share));
	return response(
		{
			id,
			partSize: PART_SIZE,
			sharePath: `/s/${id}#${token}`,
			expiresAt: share.expiresAt,
		},
		201,
	);
}

function byteRange(
	header: string | null,
	size: number,
): { offset: number; length: number } | undefined {
	if (!header) return;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2]))
		throw new HttpError(416, "Invalid byte range.");
	let start: number;
	let end: number;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix < 1)
			throw new HttpError(416, "Invalid byte range.");
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	}
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	)
		throw new HttpError(416, "Invalid byte range.");
	return { offset: start, length: end - start + 1 };
}

async function media(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	await readable(request, share);
	const range =
		request.method === "HEAD"
			? undefined
			: byteRange(request.headers.get("Range"), share.size);
	const object =
		request.method === "HEAD"
			? await env.MEDIA.head(`media/${share.id}`)
			: await env.MEDIA.get(`media/${share.id}`, { range });
	if (!object) throw new HttpError(404, "Share unavailable.");
	const headers = new Headers({
		"Content-Type": share.contentType,
		"Content-Length": `${range?.length ?? object.size}`,
		"Accept-Ranges": "bytes",
		ETag: object.httpEtag,
	});
	if (range)
		headers.set(
			"Content-Range",
			`bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
		);
	return new Response(
		"body" in object && object.body instanceof ReadableStream
			? object.body
			: null,
		{ status: range ? 206 : 200, headers },
	);
}

async function route(request: Request, env: RuntimeEnv): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.pathname === "/api/v1/recovery" ||
		url.pathname.startsWith("/api/v1/recovery/")
	)
		return recovery(request, env.MEDIA, await owner(request, env));
	if (
		url.pathname === "/api/v1/feedback" ||
		url.pathname.startsWith("/api/v1/feedback/")
	)
		return feedback(request, env, () => owner(request, env));
	if (url.pathname === "/healthz")
		return response({ product: "capux", protocol: 1 });
	if (url.pathname === "/api/v1/shares" && request.method === "POST")
		return create(request, env);
	const match =
		/^\/api\/v1\/shares\/([a-f0-9-]{36})(?:\/(access|media|metadata|complete|parts\/(\d+)))?$/.exec(
			url.pathname,
		);
	if (match) {
		const [, id, action, part] = match;
		const writing =
			request.method === "DELETE" ||
			action === "complete" ||
			part !== undefined;
		const ownerId = writing ? await owner(request, env) : undefined;
		const share = await load(env, id);
		if (ownerId && !(await equal(ownerId, share.owner)))
			throw new HttpError(404, "Share unavailable.");
		if (request.method === "DELETE" && !action) {
			await env.MEDIA.put(`revoked/${id}`, "revoked");
			if (!share.ready)
				await env.MEDIA.resumeMultipartUpload(
					`media/${id}`,
					share.uploadId,
				).abort();
			await env.MEDIA.delete(`media/${id}`);
			return new Response(null, { status: 204 });
		}
		if (request.method === "PUT" && part) {
			if (share.ready) throw new HttpError(409, "Share already published.");
			const number = Number(part);
			const count = Math.ceil(share.size / PART_SIZE);
			if (!Number.isInteger(number) || number < 1 || number > count)
				throw new HttpError(400, "Invalid part number.");
			const expected =
				number === count ? share.size - PART_SIZE * (count - 1) : PART_SIZE;
			const bytes = await boundedBody(request, PART_SIZE);
			if (bytes.length !== expected)
				throw new HttpError(400, "Incorrect part size.");
			return response(
				await env.MEDIA.resumeMultipartUpload(
					`media/${id}`,
					share.uploadId,
				).uploadPart(number, bytes),
			);
		}
		if (request.method === "POST" && action === "complete") {
			if (share.ready) return response({ id, ready: true });
			const { parts } = await json(request);
			if (
				!Array.isArray(parts) ||
				parts.length !== Math.ceil(share.size / PART_SIZE) ||
				!parts.every(
					(item, index) =>
						item &&
						item.partNumber === index + 1 &&
						typeof item.etag === "string" &&
						item.etag.length < 256,
				)
			)
				throw new HttpError(
					400,
					"A complete ordered list of uploaded parts is required.",
				);
			const object = await env.MEDIA.resumeMultipartUpload(
				`media/${id}`,
				share.uploadId,
			).complete(parts);
			if (object.size !== share.size)
				throw new HttpError(409, "Uploaded size does not match.");
			await load(env, id);
			share.ready = true;
			await env.MEDIA.put(`shares/${id}.json`, JSON.stringify(share));
			return response({ id, ready: true });
		}
		if (request.method === "POST" && action === "access") {
			const token = await readable(request, share);
			const secure = url.protocol === "https:" ? "; Secure" : "";
			return new Response(null, {
				status: 204,
				headers: {
					"Set-Cookie": `capux_read=${token}; Path=/api/v1/shares/${id}/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.floor((share.expiresAt - Date.now()) / 1000)}`,
				},
			});
		}
		if (["GET", "HEAD"].includes(request.method) && action === "media")
			return media(request, env, share);
		if (request.method === "GET" && action === "metadata") {
			await readable(request, share);
			return response({
				id,
				title: share.title,
				contentType: share.contentType,
				size: share.size,
				expiresAt: share.expiresAt,
			});
		}
		throw new HttpError(405, "Method not allowed.");
	}
	if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
	if (/^\/s\/[a-f0-9-]{36}$/.test(url.pathname)) url.pathname = "/viewer.html";
	if (url.pathname === "/") url.pathname = "/index.html";
	const asset = await env.ASSETS.fetch(new Request(url, request));
	if (!url.pathname.endsWith(".html") || !asset.ok) return asset;
	const headers = new Headers(asset.headers);
	headers.delete("content-length");
	headers.delete("etag");
	return new Response(
		(await asset.text()).replaceAll("%app%", brand.display_name),
		{ status: asset.status, headers },
	);
}

export default {
	async fetch(request, env) {
		let result: Response;
		try {
			result = await route(request, env);
		} catch (error) {
			if (error instanceof HttpError)
				result = response({ error: error.message }, error.status);
			else {
				console.error(
					JSON.stringify({
						event: "sharing_failed",
						type: error instanceof Error ? error.name : "unknown",
					}),
				);
				result = response(
					{ error: "Sharing request failed. Your local recording is safe." },
					500,
				);
			}
		}
		const secured = new Response(result.body, result);
		secured.headers.set("Cache-Control", "private, no-store");
		secured.headers.set("Referrer-Policy", "no-referrer");
		secured.headers.set("X-Content-Type-Options", "nosniff");
		secured.headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		return secured;
	},
} satisfies ExportedHandler<RuntimeEnv>;
