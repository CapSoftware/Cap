import { app as developerSdk } from "@/app/api/developer/sdk/v1/[...route]/app";
import { app as developerApi } from "@/app/api/developer/v1/[...route]/app";
import { apiNotFoundBody } from "@/lib/api-errors";
import { firewallRequestHeaders } from "@/lib/rate-limit";

const SDK_PREFIX = "/api/developer/sdk/v1/";
const API_PREFIX = "/api/developer/v1/";

const aborted = (signal: AbortSignal) =>
	signal.reason instanceof Error
		? signal.reason
		: new DOMException("The request was aborted", "AbortError");

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null) {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(aborted(signal));
	let onAbort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => reject(aborted(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([work, stopped]).finally(() =>
		signal.removeEventListener("abort", onAbort),
	);
}

// Serves the developer REST API from this process instead of over the
// network, so a tool call runs the same handlers, key checks and per-key rate
// limit as a direct REST request. The caller's address headers ride along so
// the shared firewall limit sees the same client.
export function inProcessDeveloperFetch(incoming: Headers): typeof fetch {
	const forwarded = firewallRequestHeaders(incoming);
	return async (input, init) => {
		const headers = new Headers(init?.headers);
		for (const [name, value] of forwarded) headers.set(name, value);
		const request = new Request(input, { ...init, headers });
		const path = new URL(request.url).pathname;
		const target = path.startsWith(SDK_PREFIX)
			? developerSdk
			: path.startsWith(API_PREFIX)
				? developerApi
				: null;
		if (!target) return Response.json(apiNotFoundBody(path), { status: 404 });
		return untilAborted(
			Promise.resolve(target.fetch(request)),
			init?.signal ?? null,
		);
	};
}
