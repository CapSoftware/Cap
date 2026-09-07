import {
	CurrentUser,
	HttpAuthMiddleware,
	Organisation,
	Video,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	authorizeExtensionLoomImport,
	ExtensionLoomAuthorizationError,
	type ExtensionLoomImportResponse,
	getExtensionLoomImportConfig,
	importExtensionLoomRow,
	MAX_EXTENSION_LOOM_EMAIL_LENGTH,
	MAX_EXTENSION_LOOM_ROW_NUMBER,
	MAX_EXTENSION_LOOM_ROWS,
	MAX_EXTENSION_LOOM_SPACE_LENGTH,
	MAX_EXTENSION_LOOM_URL_LENGTH,
	validateExtensionLoomRow,
} from "@/lib/extension-loom-import";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ImportRow = Schema.Struct({
	rowNumber: Schema.Int.pipe(
		Schema.greaterThanOrEqualTo(1),
		Schema.lessThanOrEqualTo(MAX_EXTENSION_LOOM_ROW_NUMBER),
	),
	loomUrl: Schema.String.pipe(Schema.maxLength(MAX_EXTENSION_LOOM_URL_LENGTH)),
	userEmail: Schema.String.pipe(
		Schema.maxLength(MAX_EXTENSION_LOOM_EMAIL_LENGTH),
	),
	spaceName: Schema.optional(
		Schema.String.pipe(Schema.maxLength(MAX_EXTENSION_LOOM_SPACE_LENGTH)),
	),
});

const ImportPayload = Schema.Struct({
	organizationId: Organisation.OrganisationId,
	row: ImportRow,
});

const Config = Schema.Struct({
	user: Schema.Struct({
		id: Schema.String,
		email: Schema.String,
	}),
	organizations: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			canImport: Schema.Boolean,
		}),
	),
	activeOrganizationId: Schema.String,
	isPro: Schema.Boolean,
	defaultPublic: Schema.Boolean,
	maxRows: Schema.Literal(MAX_EXTENSION_LOOM_ROWS),
});

const ImportResponse = Schema.Struct({
	success: Schema.Boolean,
	videoId: Schema.optional(Video.VideoId),
	error: Schema.optional(Schema.String),
	existing: Schema.optional(Schema.Boolean),
	uncertain: Schema.optional(Schema.Boolean),
});

class Api extends HttpApi.make("ExtensionLoomImportApi").add(
	HttpApiGroup.make("loomImport")
		.add(
			HttpApiEndpoint.get("getConfig")`/api/extension/import-loom`
				.middleware(HttpAuthMiddleware)
				.addSuccess(Config)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.post("importRow")`/api/extension/import-loom`
				.middleware(HttpAuthMiddleware)
				.setPayload(ImportPayload)
				.addSuccess(ImportResponse)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError),
		),
) {}

const internalError = (cause: unknown) =>
	Effect.logError(cause).pipe(
		Effect.andThen(Effect.fail(new HttpApiError.InternalServerError())),
	);

const importRowError = (
	cause: unknown,
): Effect.Effect<
	never,
	HttpApiError.Forbidden | HttpApiError.InternalServerError
> => {
	if (cause instanceof ExtensionLoomAuthorizationError) {
		return Effect.fail(new HttpApiError.Forbidden());
	}
	return internalError(cause);
};

const getConfig = () =>
	Effect.gen(function* () {
		const user = yield* CurrentUser;
		return yield* Effect.tryPromise({
			try: () =>
				getExtensionLoomImportConfig({
					userId: user.id,
					activeOrganizationId: user.activeOrganizationId,
				}),
			catch: (cause) => cause,
		});
	}).pipe(Effect.catchAll(internalError));

type ImportRowEffect = Effect.Effect<
	ExtensionLoomImportResponse,
	| HttpApiError.BadRequest
	| HttpApiError.Forbidden
	| HttpApiError.InternalServerError,
	CurrentUser
>;

const importRow = ({
	payload,
}: {
	payload: Schema.Schema.Type<typeof ImportPayload>;
}): ImportRowEffect => {
	const validationError = validateExtensionLoomRow(payload.row);
	if (validationError) return Effect.fail(new HttpApiError.BadRequest());

	return Effect.gen(function* () {
		const currentUser = yield* CurrentUser;
		const authorization = yield* Effect.tryPromise({
			try: () =>
				authorizeExtensionLoomImport({
					userId: currentUser.id,
					organizationId: payload.organizationId,
				}),
			catch: (cause) => cause,
		});

		return yield* Effect.tryPromise({
			try: () =>
				importExtensionLoomRow({
					organizationId: payload.organizationId,
					row: payload.row,
					user: authorization.user,
				}),
			catch: (cause) => cause,
		});
	}).pipe(Effect.catchAll(importRowError));
};

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "loomImport", (handlers) =>
			handlers.handle("getConfig", getConfig).handle("importRow", importRow),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
