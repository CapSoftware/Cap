import { randomUUID } from "node:crypto";
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
import { Effect, Layer, Schedule } from "effect";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import {
	checkUploadProbeRateLimit,
	readUploadProbeBody,
} from "@/lib/upload-health";
import { getAccessibleOrganization } from "../[...route]/organizationStorage";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("CapUploadHealthApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.get("status")`/api/desktop/upload-health`)
		.add(HttpApiEndpoint.post("probe")`/api/desktop/upload-health`)
		.middleware(HttpAuthMiddleware),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		contentType: "application/json; charset=utf-8",
		headers: {
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", () => Effect.succeed(jsonResponse({ ok: true })))
				.handle("probe", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const request = yield* HttpServerRequest.HttpServerRequest;
						const rawRequest =
							request.source instanceof Request ? request.source : null;

						const firewallLimited = yield* Effect.tryPromise(() =>
							isRateLimited(RATE_LIMIT_IDS.DESKTOP_UPLOAD_HEALTH, {
								key: user.id,
								headers: rawRequest?.headers,
							}),
						).pipe(Effect.catchAll(() => Effect.succeed(false)));
						if (firewallLimited || checkUploadProbeRateLimit(user.id)) {
							return jsonResponse({ error: "rate_limited" }, 429);
						}

						const body = rawRequest ? rawRequest.body : null;
						const probe = yield* Effect.tryPromise(() =>
							readUploadProbeBody(body),
						).pipe(Effect.catchAll(() => Effect.succeed(null)));
						if (!probe) {
							return jsonResponse({ error: "probe_read_failed" }, 400);
						}
						if (probe.truncated) {
							return jsonResponse({ error: "probe_too_large" }, 413);
						}

						const verifyStorageHeader =
							rawRequest?.headers.get("x-cap-upload-probe-verify-storage") ??
							request.headers["x-cap-upload-probe-verify-storage"];
						if (verifyStorageHeader === "0") {
							return jsonResponse({
								receivedBytes: probe.receivedBytes,
								receiveDurationMs: probe.receiveDurationMs,
							});
						}

						const activeOrganizationId = user.activeOrganizationId;
						const organizationId = activeOrganizationId
							? yield* Effect.tryPromise(() =>
									getAccessibleOrganization(user.id, activeOrganizationId),
								).pipe(
									Effect.map((organization) => organization?.id ?? null),
									Effect.catchAll(() => Effect.succeed(null)),
								)
							: null;
						const storage = yield* Storage;
						const key = `${user.id}/.cap-upload-health/${randomUUID()}`;
						const uploaded = yield* storage
							.getWritableAccessForUser(user.id, organizationId)
							.pipe(
								Effect.flatMap((writable) =>
									Effect.gen(function* () {
										const writeResult = yield* writable.access
											.putObject(key, probe.bytes, {
												contentType: "application/octet-stream",
												contentLength: probe.receivedBytes,
											})
											.pipe(
												Effect.match({
													onFailure: (error) => ({
														ok: false as const,
														error,
													}),
													onSuccess: () => ({ ok: true as const }),
												}),
											);
										if (!writeResult.ok) {
											yield* Effect.fail(writeResult.error);
										}
										yield* writable.access.deleteObject(key).pipe(
											Effect.retry({
												times: 3,
												schedule: Schedule.exponential("100 millis"),
											}),
											Effect.catchAll((cleanupError) =>
												Effect.sync(() => {
													console.warn(
														"Failed to clean up upload-health probe object after successful putObject:",
														{ key, userId: user.id, error: cleanupError },
													);
												}),
											),
										);
									}),
								),
								Effect.as(true),
								Effect.catchAll(() => Effect.succeed(false)),
							);
						if (!uploaded) {
							return jsonResponse({ error: "storage_probe_failed" }, 503);
						}
						return jsonResponse({
							receivedBytes: probe.receivedBytes,
							receiveDurationMs: probe.receiveDurationMs,
						});
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
