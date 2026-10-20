import type { ProbeResult, ServiceDefinition } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHealth(
	service: ServiceDefinition,
	body: unknown,
): boolean {
	if (!isRecord(body)) return false;
	if (service.validation === "media") return body.status === "ok";
	if (service.validation === "render")
		return (
			body.ok === true &&
			typeof body.workers === "number" &&
			body.workers > 0 &&
			typeof body.slots === "number" &&
			body.slots > 0
		);
	if (service.validation === "auth")
		return Object.values(body).some(
			(provider) =>
				isRecord(provider) &&
				typeof provider.id === "string" &&
				typeof provider.type === "string",
		);
	return true;
}

async function attempt(
	service: ServiceDefinition,
	url: string,
	fetcher: typeof fetch,
): Promise<ProbeResult> {
	const start = performance.now();
	try {
		const response = await fetcher(url, {
			method: service.method,
			redirect: "manual",
			cache: "no-store",
			signal: AbortSignal.timeout(8_000),
			headers: {
				"User-Agent": "Cap-Status/1.0",
				Accept: service.validation ? "application/json" : "*/*",
			},
		});
		let status: ProbeResult["status"] = response.ok ? "operational" : "outage";
		if (
			response.ok &&
			service.validation &&
			!validateHealth(service, await response.json())
		)
			status = "degraded";
		if (!response.bodyUsed) await response.body?.cancel();
		const latencyMs = Math.round(performance.now() - start);
		return {
			status:
				status === "operational" && latencyMs > 3_000 ? "degraded" : status,
			latencyMs,
		};
	} catch {
		return {
			status: "outage",
			latencyMs: Math.round(performance.now() - start),
		};
	}
}

export async function probe(
	service: ServiceDefinition,
	url: string,
	fetcher = fetch,
): Promise<ProbeResult> {
	const first = await attempt(service, url, fetcher);
	return first.status === "operational"
		? first
		: attempt(service, url, fetcher);
}
