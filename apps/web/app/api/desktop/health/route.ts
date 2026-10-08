import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOAD_CHARS = 600 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	if (rateLimitMap.size > 5_000) {
		for (const [k, v] of rateLimitMap) {
			if (now > v.resetAt) rateLimitMap.delete(k);
		}
	}
	const entry = rateLimitMap.get(ip);
	if (!entry || now > entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}
	entry.count++;
	return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

const HealthResponse = Schema.Struct({
	status: Schema.Literal("ok"),
	timestamp: Schema.Number,
});

const SpeedTestPayload = Schema.Struct({
	payload: Schema.String.pipe(
		Schema.minLength(1),
		Schema.maxLength(MAX_PAYLOAD_CHARS),
	),
});

const SpeedTestResponse = Schema.Struct({
	success: Schema.Boolean,
	bytesReceived: Schema.Number,
	timestamp: Schema.Number,
});

class DesktopHealthApi extends HttpApi.make("DesktopHealthApi").add(
	HttpApiGroup.make("health")
		.add(
			HttpApiEndpoint.get("checkHealth")`/api/desktop/health`
				.addSuccess(HealthResponse)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.post("speedTest")`/api/desktop/health`
				.setPayload(SpeedTestPayload)
				.addSuccess(SpeedTestResponse)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.InternalServerError),
		),
) {}

const ApiLive = HttpApiBuilder.api(DesktopHealthApi).pipe(
	Layer.provide(
		HttpApiBuilder.group(DesktopHealthApi, "health", (handlers) =>
			handlers
				.handle("checkHealth", () =>
					Effect.succeed({
						status: "ok" as const,
						timestamp: Date.now(),
					}),
				)
				.handle("speedTest", ({ payload }) => {
					const bytes = Buffer.byteLength(payload.payload, "utf8");
					return Effect.succeed({
						success: true,
						bytesReceived: bytes,
						timestamp: Date.now(),
					});
				}),
		),
	),
);

const baseHandler = apiToHandler(ApiLive);

export const GET = baseHandler;

export const POST = async (req: Request) => {
	const contentLengthHeader = req.headers.get("content-length");
	if (!contentLengthHeader) {
		return new Response(JSON.stringify({ error: "Length Required" }), {
			status: 411,
			headers: { "Content-Type": "application/json" },
		});
	}

	const contentLength = Number.parseInt(contentLengthHeader, 10);
	if (Number.isNaN(contentLength) || contentLength > MAX_PAYLOAD_BYTES) {
		return new Response(JSON.stringify({ error: "Payload too large" }), {
			status: 413,
			headers: { "Content-Type": "application/json" },
		});
	}

	const ip =
		req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		req.headers.get("x-real-ip") ||
		"unknown";
	if (isRateLimited(ip)) {
		return new Response(
			JSON.stringify({ error: "Too many speed test requests" }),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json",
					"Retry-After": "60",
				},
			},
		);
	}

	return baseHandler(req);
};
