import { describe, expect, it, vi } from "vitest";
import { hashKey } from "@/lib/developer-key-hash";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-hmac-secret-for-unit-tests",
	}),
}));

describe("hashKey", () => {
	it("produces different hashes for different keys", async () => {
		const hash1 = await hashKey("key-one");
		const hash2 = await hashKey("key-two");
		expect(hash1).not.toBe(hash2);
	});

	it("is deterministic - same key always produces same hash", async () => {
		const first = await hashKey("deterministic-test");
		const second = await hashKey("deterministic-test");
		const third = await hashKey("deterministic-test");
		expect(first).toBe(second);
		expect(second).toBe(third);
	});

	it("returns exactly 64 hex characters (256 bits)", async () => {
		const result = await hashKey("length-check");
		expect(result).toHaveLength(64);
	});

	it("returns lowercase hex only", async () => {
		const result = await hashKey("case-check");
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces valid hash for empty string", async () => {
		const result = await hashKey("");
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes public key format (cpk_*) correctly", async () => {
		const result = await hashKey("cpk_live_abc123def456");
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes secret key format (csk_*) correctly", async () => {
		const result = await hashKey("csk_live_secret789xyz");
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes unicode characters correctly", async () => {
		const result = await hashKey("héllo wörld 🌍");
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});
});
