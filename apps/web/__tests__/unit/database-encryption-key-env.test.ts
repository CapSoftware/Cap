import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadServerEnv = async () => {
	vi.resetModules();
	const { serverEnv } = await import("@cap/env");
	return serverEnv();
};

const runRegister = async (key: string) => {
	vi.useFakeTimers();
	vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
	vi.stubEnv("DATABASE_ENCRYPTION_KEY", key);
	vi.spyOn(console, "log").mockImplementation(() => {});
	const exit = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);
	vi.resetModules();
	const { register } = await import("../../instrumentation.node");
	await register();
	return exit;
};

describe("DATABASE_ENCRYPTION_KEY validation", () => {
	beforeEach(() => {
		vi.stubEnv("DATABASE_URL", "mysql://localhost/cap");
		vi.stubEnv("WEB_URL", "http://localhost:3000");
		vi.stubEnv("NEXTAUTH_SECRET", "test");
		vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
		vi.stubEnv("CAP_AWS_BUCKET", "cap");
		vi.stubEnv("CAP_AWS_REGION", "us-east-1");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it.each([
		"ab".repeat(32),
		"ab".repeat(16),
		`${"ab".repeat(32)}\n`,
		"",
		undefined,
	])("accepts %j", async (key) => {
		vi.stubEnv("DATABASE_ENCRYPTION_KEY", key);
		expect((await loadServerEnv()).DATABASE_ENCRYPTION_KEY).toBe(key);
	});

	it.each(["x".repeat(32), "ab".repeat(24)])("rejects %j", async (key) => {
		vi.stubEnv("DATABASE_ENCRYPTION_KEY", key);
		await expect(loadServerEnv()).rejects.toThrow();
		expect(console.error).toHaveBeenCalledWith(expect.any(String), [
			expect.objectContaining({ path: ["DATABASE_ENCRYPTION_KEY"] }),
		]);
	});

	it("exits at boot with an invalid key", async () => {
		expect(await runRegister("x".repeat(32))).toHaveBeenCalledWith(1);
	});

	it("starts with a valid key", async () => {
		expect(await runRegister("ab".repeat(32))).not.toHaveBeenCalled();
	});
});
