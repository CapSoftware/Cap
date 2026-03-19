// shoutout https://lucas-barake.github.io/building-a-composable-policy-system/

import { HttpApiSchema } from "@effect/platform";
import { Context, Data, Effect, type Option, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { CurrentUser } from "./Authentication.ts";

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
	{ reason: Schema.optional(Schema.String) },
	HttpApiSchema.annotations({ status: 403 }),
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
	) as Policy<E, R>;

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
	}) as PublicPolicy<E, R>;

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

/**
 * Composes multiple policies with AND semantics - all policies must pass.
 * Returns a new policy that succeeds only if all the given policies succeed.
 */
export const all = <E, R>(
	...policies: NonEmptyReadonlyArray<Policy<E, R>>
): Policy<E, R> =>
	Effect.all(policies, {
		concurrency: 1,
		discard: true,
	});

/**
 * Composes multiple policies with OR semantics - at least one policy must pass.
 * Returns a new policy that succeeds if any of the given policies succeed.
 */
export const any = <E, R>(
	...policies: NonEmptyReadonlyArray<Policy<E, R>>
): Policy<E, R> => Effect.firstSuccessOf(policies);
