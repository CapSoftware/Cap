import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { CurrentUser, HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { userOrganizations } from "@/lib/app-store/access";
import { catalogForClient } from "@/lib/app-store/catalog";
import {
	listCapActions,
	runCapAction,
	sendUninstalled,
} from "@/lib/app-store/delivery";
import {
	announceInBackground,
	announceLifecycle,
} from "@/lib/app-store/events";
import {
	AppStoreError,
	installApp,
	listInstallations,
	uninstallApp,
	updateInstallation,
} from "@/lib/app-store/installations";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { apiToHandler } from "@/lib/server";

const SettingsPayload = Schema.Record({
	key: Schema.String.pipe(Schema.maxLength(64)),
	value: Schema.Union(
		Schema.String.pipe(Schema.maxLength(4_000)),
		Schema.Boolean,
		Schema.Null,
	),
});

const InstallPayload = Schema.Struct({
	appId: Schema.String.pipe(Schema.maxLength(64)),
	scope: Schema.Literal("user", "organization"),
	organizationId: Schema.optional(
		Schema.NullOr(Schema.String.pipe(Schema.maxLength(64))),
	),
	settings: Schema.optional(SettingsPayload),
});

const UpdatePayload = Schema.Struct({
	settings: Schema.optional(SettingsPayload),
	acceptUpdate: Schema.optional(Schema.Boolean),
	resume: Schema.optional(Schema.Boolean),
});

const InstallationPath = Schema.Struct({
	installationId: Schema.String.pipe(Schema.maxLength(64)),
});

const CapPath = Schema.Struct({ videoId: Video.VideoId });

const RunActionPayload = Schema.Struct({
	installationId: Schema.String.pipe(Schema.maxLength(64)),
	actionId: Schema.String.pipe(Schema.maxLength(64)),
});

class Api extends HttpApi.make("AppStoreApi")
	.add(
		HttpApiGroup.make("public").add(
			HttpApiEndpoint.get("catalog", "/api/app-store/catalog").setUrlParams(
				Schema.Struct({ apiVersion: Schema.optional(Schema.NumberFromString) }),
			),
		),
	)
	.add(
		HttpApiGroup.make("account")
			.add(HttpApiEndpoint.get("installations", "/api/app-store/installations"))
			.add(
				HttpApiEndpoint.post(
					"install",
					"/api/app-store/installations",
				).setPayload(InstallPayload),
			)
			.add(
				HttpApiEndpoint.post(
					"update",
					"/api/app-store/installations/:installationId",
				)
					.setPath(InstallationPath)
					.setPayload(UpdatePayload),
			)
			.add(
				HttpApiEndpoint.del(
					"uninstall",
					"/api/app-store/installations/:installationId",
				).setPath(InstallationPath),
			)
			.add(
				HttpApiEndpoint.get(
					"capActions",
					"/api/app-store/caps/:videoId/actions",
				).setPath(CapPath),
			)
			.add(
				HttpApiEndpoint.post(
					"runCapAction",
					"/api/app-store/caps/:videoId/actions",
				)
					.setPath(CapPath)
					.setPayload(RunActionPayload),
			)
			.middleware(HttpAuthMiddleware),
	) {}

const noStore = { "cache-control": "private, no-store" };

const json = (body: unknown, status = 200) =>
	HttpServerResponse.unsafeJson(body, { status, headers: noStore });

const STATUS: Record<AppStoreError["code"], number> = {
	not_found: 404,
	forbidden: 403,
	invalid: 422,
	conflict: 409,
	unavailable: 502,
};

const respond = <A>(
	work: () => Promise<A>,
	toBody: (value: A) => unknown = (value) => value,
	status = 200,
) =>
	Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
		Effect.map((value) => json(toBody(value), status)),
		Effect.catchAll((error) => {
			if (error instanceof AppStoreError) {
				return Effect.succeed(
					json(
						{
							error: error.message,
							code: error.code,
							fieldErrors: error.fieldErrors,
						},
						STATUS[error.code],
					),
				);
			}
			console.error("[app-store] Request failed", error);
			return Effect.succeed(
				json({ error: "Something went wrong", code: "internal" }, 500),
			);
		}),
	);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "public", (handlers) =>
			handlers.handle("catalog", ({ urlParams }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const catalog = catalogForClient(urlParams.apiVersion ?? null);
					const etag = `"${catalog.revision}-${urlParams.apiVersion ?? "all"}"`;
					const headers = {
						etag,
						"cache-control": "public, max-age=60, stale-while-revalidate=600",
					};
					if (request.headers["if-none-match"] === etag) {
						return HttpServerResponse.empty({ status: 304, headers });
					}
					return HttpServerResponse.unsafeJson(catalog, { headers });
				}),
			),
		),
	),
	Layer.provide(
		HttpApiBuilder.group(Api, "account", (handlers) =>
			handlers
				.handle("installations", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(async () => {
							const [installations, organizations] = await Promise.all([
								listInstallations(user.id),
								userOrganizations(user.id),
							]);
							return {
								installations,
								activeOrganizationId: user.activeOrganizationId,
								organizations: organizations.map((organization) => ({
									id: organization.id,
									name: organization.name,
									canManage: canManageOrganizationSettings(organization.role),
									adminsOnly: organization.adminsOnly,
								})),
							};
						});
					}),
				)
				.handle("install", ({ payload }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(
							async () => {
								const result = await installApp(user.id, {
									appId: payload.appId,
									scope: payload.scope,
									organizationId: payload.organizationId ?? null,
									settings: payload.settings,
									activeOrganizationId: user.activeOrganizationId,
								});
								announceLifecycle(result.row.id, "installed");
								return result.view;
							},
							(view) => ({ installation: view }),
							201,
						);
					}),
				)
				.handle("update", ({ path, payload }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(
							async () => {
								const result = await updateInstallation(
									user.id,
									path.installationId,
									payload,
								);
								if (result.settingsChanged) {
									announceLifecycle(result.row.id, "settings.updated");
								}
								return result.view;
							},
							(view) => ({ installation: view }),
						);
					}),
				)
				.handle("uninstall", ({ path }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(
							async () => {
								const { row, settings } = await uninstallApp(
									user.id,
									path.installationId,
								);
								announceInBackground(
									`uninstalled for ${row.id}`,
									sendUninstalled(row, settings),
								);
								return null;
							},
							() => ({ ok: true }),
						);
					}),
				)
				.handle("capActions", ({ path }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(
							() => listCapActions(user.id, path.videoId),
							(actions) => ({ actions }),
						);
					}),
				)
				.handle("runCapAction", ({ path, payload }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						return yield* respond(
							async () => {
								const [profile] = await db()
									.select({ name: users.name })
									.from(users)
									.where(eq(users.id, user.id))
									.limit(1);
								return runCapAction({
									userId: user.id,
									userName: profile?.name ?? null,
									installationId: payload.installationId,
									actionId: payload.actionId,
									videoId: path.videoId,
								});
							},
							(result) => ({ result }),
						);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
