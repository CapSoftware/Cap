import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./crypto";

describe("password hashing", () => {
	it("verifies the original password and rejects a different one", async () => {
		const hash = await hashPassword("correct horse battery staple");

		expect(hash).not.toBe("correct horse battery staple");
		expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
			true,
		);
		expect(await verifyPassword(hash, "wrong password")).toBe(false);
	});

	it("rejects empty hash and password inputs", async () => {
		const hash = await hashPassword("non-empty password");

		expect(await verifyPassword("", "non-empty password")).toBe(false);
		expect(await verifyPassword(hash, "")).toBe(false);
		await expect(hashPassword("")).rejects.toThrow(
			"Cannot hash empty or null password",
		);
	});
});
