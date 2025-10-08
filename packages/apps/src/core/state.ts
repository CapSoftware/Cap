import { Effect, Schema } from "effect";

export type AppStatePayload<AppType extends string> = {
  app: AppType;
  orgId: string;
  nonce: string;
  data?: unknown;
};

export class AppStateError extends Schema.TaggedError<AppStateError>()(
  "AppStateError",
  { message: Schema.String },
) {}

export const createAppStateHandlers = <AppType extends string>(
  isAppType: (value: string) => value is AppType,
) => {
  const encodeAppState = (payload: AppStatePayload<AppType>) => {
    if (!isAppType(payload.app)) {
      throw new AppStateError({ message: `Invalid app type: ${payload.app}` });
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
          try: () => JSON.parse(json) as Partial<AppStatePayload<AppType>>,
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
          !isAppType(payload.app)
        ) {
          return Effect.fail(
            new AppStateError({ message: "Invalid state payload" }),
          );
        }

        return Effect.succeed(payload as AppStatePayload<AppType>);
      }),
    );

  return { encodeAppState, decodeAppState } as const;
};
