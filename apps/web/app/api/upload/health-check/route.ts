export interface UploadHealthCheckResponse {
	ok: boolean;
	status: "healthy" | "degraded";
	bytesReceived: number;
	serverTimestampMs: number;
	message: string;
}

const MIN_PROBE_BYTES = 16;
const MAX_PROBE_BYTES = 262_144;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(request: Request, nowMs: number): boolean {
	const forwarded = request.headers.get("x-forwarded-for") ?? "local";
	const clientIp = forwarded.split(",")[0]?.trim() || "local";
	const bucket = ipBuckets.get(clientIp);
	if (!bucket || nowMs >= bucket.resetAt) {
		ipBuckets.set(clientIp, { count: 1, resetAt: nowMs + RATE_WINDOW_MS });
		return false;
	}
	bucket.count += 1;
	return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

async function readBoundedBytes(request: Request): Promise<number | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
		return null;
	}
	if (!request.body) {
		return 0;
	}
	const reader = request.body.getReader();
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value?.byteLength ?? 0;
		if (total > MAX_PROBE_BYTES) {
			await reader.cancel();
			return null;
		}
	}
	return total;
}

function buildResponse(
	payload: Omit<UploadHealthCheckResponse, "serverTimestampMs">,
	status: number,
): Response {
	return Response.json(
		{ ...payload, serverTimestampMs: Date.now() },
		{ status },
	);
}

export async function POST(request: Request): Promise<Response> {
	if (isRateLimited(request, Date.now())) {
		return buildResponse(
			{
				ok: false,
				status: "degraded",
				bytesReceived: 0,
				message: "Rate limit exceeded for upload health probe.",
			},
			429,
		);
	}

	try {
		const bytesReceived = await readBoundedBytes(request);
		if (bytesReceived === null) {
			return buildResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived: MAX_PROBE_BYTES,
					message: "Upload probe payload exceeds maximum allowed size.",
				},
				413,
			);
		}

		if (bytesReceived < MIN_PROBE_BYTES) {
			return buildResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived,
					message: "Upload probe payload is too small — please contact support.",
				},
				400,
			);
		}

		return buildResponse(
			{
				ok: true,
				status: "healthy",
				bytesReceived,
				message: "Upload health check succeeded.",
			},
			200,
		);
	} catch {
		return buildResponse(
			{
				ok: false,
				status: "degraded",
				bytesReceived: 0,
				message:
					"Upload health check failed — please contact support if recording uploads fail.",
			},
			500,
		);
	}
}

export async function GET(): Promise<Response> {
	return buildResponse(
		{
			ok: true,
			status: "healthy",
			bytesReceived: 0,
			message: "Upload health-check endpoint ready.",
		},
		200,
	);
}
