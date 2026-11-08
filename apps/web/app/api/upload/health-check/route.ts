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

const verifyUserStorage = (
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
		yield* writable.access
			.deleteObject(probeKey)
			.pipe(Effect.catchAll(() => Effect.void));
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("probeUploadHealth", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const request = yield* HttpServerRequest.HttpServerRequest;
						const limited = yield* Effect.tryPromise(() =>
							isRateLimited(HEALTH_CHECK_RULE_ID, {
								key: user.id,
								headers: new Headers(request.headers as Record<string, string>),
							}),
						).pipe(Effect.orElseSucceed(() => false));
						if (limited) {
							return jsonResponse(
								{
									ok: false,
									status: "degraded",
									bytesReceived: 0,
									message: "Rate limit exceeded for upload health probe.",
								},
								429,
							);
						}

						const declared = Number(request.headers["content-length"] ?? "0");
						if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
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

						const bodyBuffer = yield* request.arrayBuffer.pipe(
							HttpServerRequest.withMaxBodySize(Option.some(MAX_PROBE_BYTES)),
							Effect.map((buf) => new Uint8Array(buf)),
							Effect.catchAll(() => Effect.succeed(null)),
						);
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
									message:
										"Upload probe payload is too small — please contact support.",
								},
								400,
							);
						}

						const isThroughputOnly = new URL(
							request.url,
							"http://localhost",
						).searchParams.get("mode") === "throughput";

						if (!isThroughputOnly) {
							const storageOk = yield* verifyUserStorage(
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
											"Upload storage destination is unavailable — please contact support.",
									},
									503,
								);
							}
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
					}),
				)
				.handle("getUploadHealth", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const storageOk = yield* Storage.getWritableAccessForUser(
							user.id,
							user.activeOrganizationId,
						).pipe(
							Effect.as(true),
							Effect.catchAll(() => Effect.succeed(false)),
						);
						if (!storageOk) {
							return jsonResponse(
								{
									ok: false,
									status: "degraded",
									bytesReceived: 0,
									message:
										"Upload storage destination is unavailable — please contact support.",
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
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const GET = handler;
