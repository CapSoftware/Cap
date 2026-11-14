import { Cause, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { rejectOnFailure } from "@/lib/effect-react-query";

describe("rejectOnFailure", () => {
	it("resolves with the value of a successful exit", async () => {
		await expect(rejectOnFailure(Exit.succeed("done"))).resolves.toBe("done");
	});

	it("rejects with the cause of a failed exit so toast.promise shows its error", async () => {
		const failure = Exit.fail("storage unavailable");

		const result = await rejectOnFailure(failure).then(
			() => "resolved",
			(cause) => cause,
		);

		expect(Cause.isCause(result)).toBe(true);
		expect(Cause.failureOption(result as Cause.Cause<string>)).toEqual(
			expect.objectContaining({ value: "storage unavailable" }),
		);
	});
});
