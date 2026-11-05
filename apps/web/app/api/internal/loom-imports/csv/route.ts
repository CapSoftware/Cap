import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { processLoomCsvRows } from "@/lib/loom-csv-import";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { apiToHandler } from "@/lib/server";

const MAX_ROWS_PER_REQUEST = 25;

class Api extends HttpApi.make("LoomOperatorCsvImportApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("import")`/api/internal/loom-imports/csv`
			.setPayload(
				Schema.Struct({
					organizationId: Schema.String.pipe(
						Schema.pattern(/^[A-Za-z0-9_-]{15}$/),
					),
					rows: Schema.Array(
						Schema.Struct({
							rowNumber: Schema.Number,
							loomUrl: Schema.String.pipe(Schema.maxLength(2048)),
							userEmail: Schema.String.pipe(Schema.maxLength(255)),
							spaceName: Schema.optional(
								Schema.String.pipe(Schema.maxLength(255)),
							),
							folderName: Schema.optional(
								Schema.String.pipe(Schema.maxLength(255)),
							),
						}),
					).pipe(Schema.minItems(1), Schema.maxItems(MAX_ROWS_PER_REQUEST)),
				}),
			)
			.addSuccess(
				Schema.Struct({
					importedCount: Schema.Number,
					failedCount: Schema.Number,
					results: Schema.Array(
						Schema.Struct({
							rowNumber: Schema.Number,
							userEmail: Schema.String,
							spaceName: Schema.optional(Schema.String),
							success: Schema.Boolean,
							videoId: Schema.optional(Schema.String),
							error: Schema.optional(Schema.String),
						}),
					),
				}),
			)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden),
	),
) {}

function digest(value: string) {
	return createHash("sha256").update(value, "utf8").digest();
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("import", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
					const header = request.headers["x-media-server-secret"];
					if (
						!secret ||
						!header ||
						!timingSafeEqual(digest(header), digest(secret))
					)
						return yield* new HttpApiError.Unauthorized();
					const organizationId =
						payload.organizationId as Organisation.OrganisationId;
					const [organization] = yield* Effect.promise(() =>
						db()
							.select({ ownerId: organizations.ownerId })
							.from(organizations)
							.where(
								and(
									eq(organizations.id, organizationId),
									isNull(organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					if (!organization) return yield* new HttpApiError.NotFound();
					if (
						!(yield* Effect.promise(() =>
							isOrganizationOwnerPro(organizationId),
						))
					)
						return yield* new HttpApiError.Forbidden();
					const result = yield* Effect.promise(() =>
						processLoomCsvRows({
							rows: payload.rows.map((row) => ({
								rowNumber: row.rowNumber,
								loomUrl: row.loomUrl,
								userEmail: row.userEmail,
								spaceName: row.spaceName ?? "",
								folderName: row.folderName,
							})),
							orgId: organizationId,
							actorId: organization.ownerId,
							allowFolders: true,
							importPriority: "bulk",
						}),
					);
					return {
						importedCount: result.importedCount,
						failedCount: result.failedCount,
						results: result.results.map((row) => ({
							rowNumber: row.rowNumber,
							userEmail: row.userEmail,
							spaceName: row.spaceName,
							success: row.success,
							videoId: row.videoId,
							error: row.error,
						})),
					};
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
export const maxDuration = 300;
export const dynamic = "force-dynamic";
