// shoutout https://lucas-barake.github.io/building-a-composable-policy-system/

import { Context, Effect, Option, Schema } from "effect";
import { CurrentUser } from "./Authentication";

export type Policy<E = never, R = never> = Effect.Effect<
  void,
  PolicyDenied | E,
  CurrentUser | R
>;

export type PublicPolicy<E = never, R = never> = Effect.Effect<
  void,
  PolicyDenied | E,
  R
>;

export class PolicyDenied extends Schema.TaggedError<PolicyDenied>(
  "PolicyDenied"
)("PolicyDenied", {}) {}

/**
 * Creates a policy from a predicate function that evaluates the current user.
 */
export const policy = <E, R>(
  predicate: (user: CurrentUser["Type"]) => Effect.Effect<boolean, E, R>
): Policy<E, R> =>
  Effect.flatMap(CurrentUser, (user) =>
    Effect.flatMap(predicate(user), (result) =>
      result ? Effect.void : Effect.fail(new PolicyDenied())
    )
  );

/**
 * Creates a policy from a predicate function that may evaluate the current user,
 * or None if there isn't one.
 */
export const publicPolicy = <E, R>(
  predicate: (
    user: Option.Option<CurrentUser["Type"]>
  ) => Effect.Effect<boolean, E, R>
): PublicPolicy<E, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const user = Context.getOption(context, CurrentUser);

    return yield* Effect.flatMap(predicate(user), (result) =>
      result ? Effect.void : Effect.fail(new PolicyDenied())
    );
  });

/**
 * Applies a policy as a pre-check to an effect.
 * If the policy fails, the effect will fail with Forbidden.
 */
export const withPolicy =
  <E, R>(policy: PublicPolicy<E, R>) =>
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
