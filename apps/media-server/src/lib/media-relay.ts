import { randomUUID } from "node:crypto";
import {
	createGuardedMediaFetch,
	MediaAddressError,
} from "./media-address-guard";
import { MediaInputPolicyError } from "./media-input-policy";

// FFmpeg and ffprobe make their own HTTP requests, resolve names themselves
// and follow redirects on their own, so nothing this server checks would hold
// for them. A remote input is therefore read through this loopback relay,
// which makes every upstream request through the address guard and never
// hands a redirect back.
const sources = new Map<string, string>();
let server: ReturnType<typeof Bun.serve> | undefined;

// What FFmpeg sends is passed on, including headers a caller gave it to pin
// an object version, except the ones that describe its connection to here.
const CONNECTION_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-length",
	"host",
	"icy-metadata",
	"keep-alive",
	"te",
	"transfer-encoding",
	"upgrade",
]);
const FORWARDED_RESPONSE_HEADERS = [
	"accept-ranges",
	"content-length",
	"content-range",
	"content-type",
	"etag",
	"last-modified",
];

async function relay(request: Request): Promise<Response> {
	const token = new URL(request.url).pathname.split("/")[1] ?? "";
	const source = sources.get(token);
	if (!source || (request.method !== "GET" && request.method !== "HEAD")) {
		return new Response(null, { status: 404 });
	}
	const headers: Record<string, string> = { "accept-encoding": "identity" };
	for (const [name, value] of request.headers) {
		if (!CONNECTION_HEADERS.has(name) && !name.startsWith("proxy-"))
			headers[name] = value;
	}
	try {
		const upstream = await createGuardedMediaFetch(source)(source, {
			method: request.method,
			headers,
			signal: request.signal,
		});
		const forwarded = new Headers();
		for (const name of FORWARDED_RESPONSE_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) forwarded.set(name, value);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: forwarded,
		});
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		const refused =
			error instanceof MediaAddressError ||
			error instanceof MediaInputPolicyError;
		console.warn(
			"[media-relay] Upstream request failed:",
			error instanceof Error ? error.message : String(error),
		);
		return new Response(null, { status: refused ? 403 : 502 });
	}
}

function isPlaylistPath(pathname: string): boolean {
	const lower = pathname.toLowerCase();
	return [".m3u8", ".m3u", ".mpd"].some((extension) =>
		lower.endsWith(extension),
	);
}

// A playlist names other files relative to itself, which a relayed address
// cannot stand in for. Those are only read from trusted streaming hosts.
export function canRelayMediaInput(input: string): boolean {
	if (!/^https?:\/\//i.test(input)) return false;
	try {
		return !isPlaylistPath(new URL(input).pathname);
	} catch {
		return false;
	}
}

export function relayMediaInput(source: string): {
	url: string;
	release: () => void;
} {
	if (!server) {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: relay,
		});
		server.unref();
	}
	const token = randomUUID();
	sources.set(token, source);
	const name =
		new URL(source).pathname
			.split("/")
			.pop()
			?.replace(/[^A-Za-z0-9._-]/g, "_") || "media";
	return {
		url: `http://127.0.0.1:${server.port}/${token}/${name}`,
		release: () => {
			sources.delete(token);
		},
	};
}

export function getRelayedInputCount(): number {
	return sources.size;
}
