import { InternalError, User } from "@cap/web-domain";
import { Effect, Layer } from "effect";

import { OnboardingService } from "../Onboarding/index.ts";

export const UsersRpcsLive = User.UserRpcs.toLayer(
	Effect.gen(function* () {
		const onboarding = yield* OnboardingService;

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
					}
				}).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
				),
		};
	}),
).pipe(Layer.provide(OnboardingService.Default));
