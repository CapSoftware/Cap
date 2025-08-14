// shoutout https://lucas-barake.github.io/building-a-composable-policy-system/

import { Context, Data, Effect, type Option, Schema } from "effect";
import { CurrentUser } from "./Authentication";

export type Policy<E = never, R = never> = Effect.Effect<
	void,
	PolicyDeniedError | E,
	CurrentUser | R
>;

export type PublicPolicy<E = never, R = never> = Effect.Effect<
	void,
	PolicyDeniedError | E,
	R
>;

export class PolicyDeniedError extends Schema.TaggedError<PolicyDeniedError>()(
	"PolicyDenied",
	{},
) {}

/**
 * Creates a policy from a predicate function that evaluates the current user.
 */
export const policy = <E, R>(
	predicate: (
		user: CurrentUser["Type"],
	) => Effect.Effect<boolean, E | DenyAccess, R>,
): Policy<E, R> =>
	Effect.flatMap(CurrentUser, (user) =>
		Effect.flatMap(
			predicate(user).pipe(
				Effect.catchTag("DenyAccess", () => Effect.succeed(false)),
			),
			(result) => (result ? Effect.void : Effect.fail(new PolicyDeniedError())),
		),
	);

/**
 * Creates a policy from a predicate function that may evaluate the current user,
 * or None if there isn't one.
 */
export const publicPolicy = <E, R>(
	predicate: (
		user: Option.Option<CurrentUser["Type"]>,
	) => Effect.Effect<boolean, E, R>,
): PublicPolicy<E, R> =>
	Effect.gen(function* () {
		const context = yield* Effect.context<never>();
		const user = Context.getOption(context, CurrentUser);

		return yield* Effect.flatMap(predicate(user), (result) =>
			result ? Effect.void : Effect.fail(new PolicyDeniedError()),
		);
	});

export class DenyAccess extends Data.TaggedError("DenyAccess")<{}> {}

/**
 * Applies a policy as a pre-check to an effect.
 * If the policy fails, the effect will fail with Forbidden.
 */
export const withPolicy =
	<E, R>(policy: Policy<E, R>) =>
	<A, E2, R2>(self: Effect.Effect<A, E2, R2>) =>
		Effect.zipRight(policy, self);

/**
 * Applies a policy as a pre-check to an effect.
 * If the policy fails, the effect will fail with Forbidden.
 */
export const withPublicPolicy =
	<E, R>(policy: PublicPolicy<E, R>) =>
	<A, E2, R2>(self: Effect.Effect<A, E2, R2>) =>
		Effect.zipRight(policy, self);
