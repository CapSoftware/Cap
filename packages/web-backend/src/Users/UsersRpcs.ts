import { InternalError, User } from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";
import { S3Buckets } from "../S3Buckets";
import { UsersOnboarding } from "./UsersOnboarding";

export const UsersRpcsLive = User.UserRpcs.toLayer(
	Effect.gen(function* () {
		const onboarding = yield* UsersOnboarding;
		const s3Buckets = yield* S3Buckets;
		return {
			UserCompleteOnboardingStep: (payload) =>
				Effect.gen(function* () {
					switch (payload.step) {
						case "welcome":
							yield* onboarding.welcome(payload.data);
							return { step: "welcome" as const, data: undefined };

						case "organizationSetup": {
							const result = yield* onboarding.organizationSetup(payload.data);
							return {
								step: "organizationSetup" as const,
								data: result,
							};
						}
						case "customDomain":
							yield* onboarding.customDomain();
							return { step: "customDomain" as const, data: undefined };

						case "inviteTeam":
							yield* onboarding.inviteTeam();
							return { step: "inviteTeam" as const, data: undefined };
						case "skipToDashboard":
							yield* onboarding.skipToDashboard();
							return { step: "skipToDashboard" as const, data: undefined };
					}
				}).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
				),
			GetSignedImageUrl: (payload) =>
				Effect.gen(function* () {
					const [bucket] = yield* s3Buckets.getBucketAccess(Option.none());
					const url = yield* bucket.getSignedObjectUrl(payload.key);

					return { url };
				}).pipe(
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchAll(() => new InternalError({ type: "unknown" })),
				),
		};
	}),
).pipe(Layer.provide(UsersOnboarding.Default));
