import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
  AppInstallationsRepo,
  OrganisationsPolicy,
} from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
  AppStateError,
  decodeAppState,
  getAppModule,
  getAppModuleByName,
} from "@cap/apps";

import { apiToHandler } from "@/lib/server";

const authorizeRequestSchema = Schema.Struct({
  app: Schema.String,
});

const refreshRequestSchema = Schema.Struct({
  app: Schema.String,
});

const callbackQuerySchema = Schema.Record({
  key: Schema.String,
  value: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("AppsConnectApi").add(
  HttpApiGroup.make("connect").add(
    HttpApiEndpoint.post("authorize")`/api/apps/connect/authorize`
      .middleware(HttpAuthMiddleware)
      .setRequestBody(authorizeRequestSchema)
      .setResponseBody(Schema.Struct({
        authorizationUrl: Schema.String,
      }))
      .addError(HttpApiError.BadRequest)
      .addError(HttpApiError.Forbidden)
      .addError(HttpApiError.InternalServerError),
    HttpApiEndpoint.get("callback")`/api/apps/connect/callback`
      .middleware(HttpAuthMiddleware)
      .setQueryParams(callbackQuerySchema)
      .addError(HttpApiError.BadRequest)
      .addError(HttpApiError.Forbidden)
      .addError(HttpApiError.InternalServerError),
    HttpApiEndpoint.post("refresh")`/api/apps/connect/refresh`
      .middleware(HttpAuthMiddleware)
      .setRequestBody(refreshRequestSchema)
      .setResponseBody(
        Schema.Struct({
          refreshed: Schema.Boolean,
          expiresAt: Schema.String,
        }),
      )
      .addError(HttpApiError.BadRequest)
      .addError(HttpApiError.Forbidden)
      .addError(HttpApiError.NotFound)
      .addError(HttpApiError.InternalServerError),
  ),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(
    HttpApiBuilder.group(Api, "connect", (handlers) =>
      Effect.gen(function* () {
        const repo = yield* AppInstallationsRepo;
        const organisationsPolicy = yield* OrganisationsPolicy;

        yield* handlers.handle("authorize", ({ requestBody }) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const module = getAppModuleByName(requestBody.app);

            if (!module) {
              throw new HttpApiError.BadRequest();
            }

            return yield* module.oauth.authorize({
              user,
              organisationsPolicy,
            });
          }),
        );

        yield* handlers.handle("callback", ({ queryParams }) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const stateValue = queryParams.state;

            if (typeof stateValue !== "string" || stateValue.length === 0) {
              throw new HttpApiError.BadRequest();
            }

            const decodedState = yield* decodeAppState(stateValue).pipe(
              Effect.catchTag("AppStateError", (error: AppStateError) =>
                Effect.logError(error).pipe(
                  Effect.andThen(new HttpApiError.BadRequest()),
                ),
              ),
            );

            const module = getAppModule(decodedState.app);

            if (!module) {
              throw new HttpApiError.BadRequest();
            }

            return yield* module.oauth.callback({
              user,
              organisationsPolicy,
              repo,
              query: queryParams,
              rawState: stateValue,
              state: decodedState,
            });
          }),
        );

        yield* handlers.handle("refresh", ({ requestBody }) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            const module = getAppModuleByName(requestBody.app);

            if (!module) {
              throw new HttpApiError.BadRequest();
            }

            return yield* module.oauth.refresh({
              user,
              organisationsPolicy,
              repo,
            });
          }),
        );
      }),
    ),
  ),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const GET = handler;
