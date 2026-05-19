import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./crypto";

describe("password hashing", () => {
	it("verifies matching passwords and rejects mismatches", async () => {
		const hash = await hashPassword("correct horse battery staple");

		await expect(
			verifyPassword(hash, "correct horse battery staple"),
		).resolves.toBe(true);
		await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
	});

	it("rejects empty stored hashes or password input", async () => {
		await expect(verifyPassword("", "password")).resolves.toBe(false);
		await expect(verifyPassword("stored", "")).resolves.toBe(false);
		await expect(hashPassword("")).rejects.toThrow(
			"Cannot hash empty or null password",
		);
	});
});
