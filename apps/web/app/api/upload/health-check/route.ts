import { Storage } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { isRateLimited } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";

export interface UploadHealthCheckResponse {
	ok: boolean;
	status: "healthy" | "degraded";
	bytesReceived: number;
	serverTimestampMs: number;
	message: string;
}

const MIN_PROBE_BYTES = 16;
const MAX_PROBE_BYTES = 262_144;
const HEALTH_CHECK_RULE_ID = "rl_upload_health_check";

class Api extends HttpApi.make("UploadHealthCheckApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.post("probeUploadHealth")`/api/upload/health-check`.middleware(
				HttpAuthMiddleware,
			),
		)
		.add(
			HttpApiEndpoint.get("getUploadHealth")`/api/upload/health-check`.middleware(
				HttpAuthMiddleware,
			),
		),
) {}

const jsonResponse = (
	payload: Omit<UploadHealthCheckResponse, "serverTimestampMs">,
	status: number,
) =>
	HttpServerResponse.text(
		JSON.stringify({ ...payload, serverTimestampMs: Date.now() }),
		{
			status,
			contentType: "application/json; charset=utf-8",
			headers: { "Cache-Control": "private, no-store" },
		},
	);

const isCrossSiteRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
	const headers = request.headers as Record<string, string | undefined>;
	const fetchSite = (headers["sec-fetch-site"] ?? "").toLowerCase();
	if (fetchSite === "cross-site") {
		return true;
	}
	const origin = headers.origin;
	const host = headers.host;
	if (!origin || !host) {
		return false;
	}
	try {
		return new URL(origin).host !== host;
	} catch {
		return true;
	}
};

const verifyUserStorageWrite = (
	userId: CurrentUser["Type"]["id"],
	organizationId: CurrentUser["Type"]["activeOrganizationId"],
	probeSlice: Uint8Array,
) =>
	Effect.gen(function* () {
		const writable = yield* Storage.getWritableAccessForUser(
			userId,
			organizationId,
		);
		const probeKey = `${userId}/.health-check/probe.bin`;
		yield* writable.access.putObject(probeKey, probeSlice, {
			contentType: "application/octet-stream",
			contentLength: probeSlice.byteLength,
		});
		yield* writable.access.deleteObject(probeKey);
	});

const verifyUserStorageReadyReadOnly = (
	userId: CurrentUser["Type"]["id"],
	organizationId: CurrentUser["Type"]["activeOrganizationId"],
) =>
	Effect.gen(function* () {
		yield* Storage.getWritableAccessForUser(userId, organizationId);
	});

const checkProbeRateLimit = (
	userId: CurrentUser["Type"]["id"],
	request: HttpServerRequest.HttpServerRequest,
) =>
	Effect.tryPromise(() =>
		isRateLimited(HEALTH_CHECK_RULE_ID, {
			key: userId,
			headers: new Headers(request.headers as Record<string, string>),
		}),
	).pipe(Effect.orElseSucceed(() => false));

const rateLimitedResponse = () =>
	jsonResponse(
		{
			ok: false,
			status: "degraded",
			bytesReceived: 0,
			message: "Rate limit exceeded for upload health probe.",
		},
		429,
	);

const crossSiteForbiddenResponse = () =>
	jsonResponse(
		{
			ok: false,
			status: "degraded",
			bytesReceived: 0,
			message: "Cross-site upload health probe requests are not permitted.",
		},
		403,
	);

const readBoundedProbeBody = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const declared = Number(request.headers["content-length"] ?? "0");
		if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
			return null;
		}
		return yield* request.arrayBuffer.pipe(
			HttpServerRequest.withMaxBodySize(Option.some(MAX_PROBE_BYTES)),
			Effect.map((buf) => new Uint8Array(buf)),
			Effect.catchAll(() => Effect.succeed(null)),
		);
	});

const handleProbePost = () =>
	Effect.gen(function* () {
		const user = yield* CurrentUser;
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (isCrossSiteRequest(request)) {
			return crossSiteForbiddenResponse();
		}
		if (yield* checkProbeRateLimit(user.id, request)) {
			return rateLimitedResponse();
		}

		const bodyBuffer = yield* readBoundedProbeBody(request);
		if (bodyBuffer === null) {
			return jsonResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived: MAX_PROBE_BYTES,
					message: "Upload probe payload exceeds maximum allowed size.",
				},
				413,
			);
		}

		if (bodyBuffer.byteLength < MIN_PROBE_BYTES) {
			return jsonResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived: bodyBuffer.byteLength,
					message: "Upload probe payload is too small, please contact support.",
				},
				400,
			);
		}

		const storageOk = yield* verifyUserStorageWrite(
			user.id,
			user.activeOrganizationId,
			bodyBuffer.subarray(0, MIN_PROBE_BYTES),
		).pipe(
			Effect.as(true),
			Effect.catchAll(() => Effect.succeed(false)),
		);
		if (!storageOk) {
			return jsonResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived: bodyBuffer.byteLength,
					message:
						"Upload storage destination is unavailable, please contact support.",
				},
				503,
			);
		}

		return jsonResponse(
			{
				ok: true,
				status: "healthy",
				bytesReceived: bodyBuffer.byteLength,
				message: "Upload health check succeeded.",
			},
			200,
		);
	});

const handleHealthGet = () =>
	Effect.gen(function* () {
		const user = yield* CurrentUser;
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (isCrossSiteRequest(request)) {
			return crossSiteForbiddenResponse();
		}
		if (yield* checkProbeRateLimit(user.id, request)) {
			return rateLimitedResponse();
		}

		const storageReady = yield* verifyUserStorageReadyReadOnly(
			user.id,
			user.activeOrganizationId,
		).pipe(
			Effect.as(true),
			Effect.catchAll(() => Effect.succeed(false)),
		);
		if (!storageReady) {
			return jsonResponse(
				{
					ok: false,
					status: "degraded",
					bytesReceived: 0,
					message:
						"Upload storage destination is unavailable, please contact support.",
				},
				503,
			);
		}

		return jsonResponse(
			{
				ok: true,
				status: "healthy",
				bytesReceived: 0,
				message: "Upload health-check endpoint ready.",
			},
			200,
		);
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("probeUploadHealth", handleProbePost)
				.handle("getUploadHealth", handleHealthGet),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const GET = handler;
