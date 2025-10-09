import { Effect, Schema } from "effect";

export type AppStatePayload<AppSlug extends string> = {
	app: AppSlug;
	orgId: string;
	nonce: string;
	data?: unknown;
};

export class AppStateError extends Schema.TaggedError<AppStateError>()(
	"AppStateError",
	{ message: Schema.String },
) {}

export const createAppStateHandlers = <AppSlug extends string>(
	isAppSlug: (value: string) => value is AppSlug,
) => {
	const encodeAppState = (payload: AppStatePayload<AppSlug>) => {
		if (!isAppSlug(payload.app)) {
			throw new AppStateError({ message: `Invalid app slug: ${payload.app}` });
		}

		return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	};

	const decodeAppState = (value: string) =>
		Effect.try({
			try: () => Buffer.from(value, "base64url").toString("utf8"),
			catch: () => new AppStateError({ message: "Invalid state encoding" }),
		}).pipe(
			Effect.flatMap((json) =>
				Effect.try({
					try: () => JSON.parse(json) as Partial<AppStatePayload<AppSlug>>,
					catch: () => new AppStateError({ message: "Invalid state payload" }),
				}),
			),
			Effect.flatMap((payload) => {
				if (
					!payload ||
					typeof payload !== "object" ||
					typeof payload.app !== "string" ||
					typeof payload.orgId !== "string" ||
					typeof payload.nonce !== "string" ||
					!isAppSlug(payload.app)
				) {
					return Effect.fail(
						new AppStateError({ message: "Invalid state payload" }),
					);
				}

				return Effect.succeed(payload as AppStatePayload<AppSlug>);
			}),
		);

	return { encodeAppState, decodeAppState } as const;
};
