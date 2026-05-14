import { Cause, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { publicPolicy, withPublicPolicy } from "./Policy";

describe("publicPolicy", () => {
	it("allows an effect when the public predicate succeeds", async () => {
		const result = await Effect.runPromise(
			Effect.succeed("allowed").pipe(
				withPublicPolicy(
					publicPolicy((user) => Effect.succeed(Option.isNone(user))),
				),
			),
		);

		expect(result).toBe("allowed");
	});

	it("fails with PolicyDeniedError when the public predicate denies access", async () => {
		const exit = await Effect.runPromiseExit(
			publicPolicy(() => Effect.succeed(false)),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(Cause.pretty(exit.cause)).toContain("PolicyDenied");
		}
	});
});
