import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ key: "11".repeat(32) }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ DATABASE_ENCRYPTION_KEY: env.key }),
}));

import { decrypt, encrypt } from "@cap/database/crypto";

afterEach(() => {
	vi.restoreAllMocks();
	env.key = "11".repeat(32);
});

describe("database encryption", () => {
	it("derives a stored value's key once and decrypts it again from the cached key", async () => {
		const stored = await encrypt("drive-config");
		const derive = vi.spyOn(crypto.subtle, "deriveKey");
		await expect(
			Promise.all([decrypt(stored), decrypt(stored)]),
		).resolves.toEqual(["drive-config", "drive-config"]);
		await expect(decrypt(stored)).resolves.toBe("drive-config");
		await expect(decrypt(stored)).resolves.toBe("drive-config");
		expect(derive).toHaveBeenCalledTimes(1);
	});

	it("derives a separate key for each salt", async () => {
		const first = await encrypt("first");
		const second = await encrypt("second");
		const derive = vi.spyOn(crypto.subtle, "deriveKey");
		await expect(decrypt(first)).resolves.toBe("first");
		await expect(decrypt(second)).resolves.toBe("second");
		expect(derive).toHaveBeenCalledTimes(2);
	});

	it("still rejects a tampered value after its key is cached", async () => {
		const stored = await encrypt("drive-config");
		await decrypt(stored);
		const bytes = Buffer.from(stored, "base64");
		bytes.writeUInt8(
			bytes.readUInt8(bytes.length - 1) ^ 0xff,
			bytes.length - 1,
		);
		await expect(decrypt(bytes.toString("base64"))).rejects.toThrow(
			"Decryption failed",
		);
	});

	it("does not reuse a cached key after the encryption key changes", async () => {
		const stored = await encrypt("drive-config");
		await decrypt(stored);
		env.key = "22".repeat(32);
		await expect(decrypt(stored)).rejects.toThrow("Decryption failed");
	});
});
