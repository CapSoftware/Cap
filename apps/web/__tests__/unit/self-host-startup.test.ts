import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const placeholder =
	"c7a1e98e1e5e4cec5a3fbf5eaf502d262fb99807ae2be8ee70537409e29cb6f9";

async function register() {
	vi.resetModules();
	const instrumentation = await import("../../instrumentation.node");
	await instrumentation.register();
}

describe("self-host startup secrets", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
		vi.stubEnv("DATABASE_URL", "mysql://localhost/cap");
		vi.stubEnv("WEB_URL", "http://localhost:3000");
		vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
		vi.stubEnv("NEXTAUTH_SECRET", "ab".repeat(32));
		vi.stubEnv("DATABASE_ENCRYPTION_KEY", placeholder);
		vi.stubEnv("CAP_AWS_BUCKET", "cap");
		vi.stubEnv("CAP_AWS_REGION", "us-east-1");
		vi.stubEnv("MEDIA_SERVER_URL", "http://media-server:3456");
		vi.stubEnv("MEDIA_SERVER_WEBHOOK_SECRET", "cd".repeat(32));
		vi.stubEnv("CAP_ALLOW_INSECURE_SECRETS", "false");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("refuses a placeholder by default", async () => {
		await expect(register()).rejects.toThrow("exit");
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it("keeps the old encryption key with an explicit override and warns on every start", async () => {
		vi.stubEnv("CAP_ALLOW_INSECURE_SECRETS", "true");
		await register();
		await register();
		expect(process.exit).not.toHaveBeenCalled();
		expect(process.env.DATABASE_ENCRYPTION_KEY).toBe(placeholder);
		expect(console.warn).toHaveBeenCalledTimes(2);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("DATABASE_ENCRYPTION_KEY"),
		);
		expect(console.warn).not.toHaveBeenCalledWith(
			expect.stringContaining(placeholder),
		);
	});

	it("can decrypt existing data after upgrading with the old encryption key", async () => {
		vi.resetModules();
		const { encrypt } = await import("@cap/database/crypto");
		const storedCredentials = await encrypt("existing-storage-credentials");
		vi.stubEnv("CAP_ALLOW_INSECURE_SECRETS", "true");

		await register();

		const { decrypt } = await import("@cap/database/crypto");
		expect(await decrypt(storedCredentials)).toBe(
			"existing-storage-credentials",
		);
	});

	it.each(["NEXTAUTH_SECRET", "MEDIA_SERVER_WEBHOOK_SECRET"])(
		"does not bypass a missing %s with the upgrade override",
		async (name) => {
			vi.stubEnv("CAP_ALLOW_INSECURE_SECRETS", "true");
			vi.stubEnv(name, "");
			await expect(register()).rejects.toThrow("exit");
			expect(process.exit).toHaveBeenCalledWith(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["", "invalid"])(
		"does not bypass missing or invalid encryption keys (%j)",
		async (key) => {
			vi.stubEnv("CAP_ALLOW_INSECURE_SECRETS", "true");
			vi.stubEnv("DATABASE_ENCRYPTION_KEY", key);
			await expect(register()).rejects.toThrow("exit");
			expect(process.exit).toHaveBeenCalledWith(1);
		},
	);

	it("starts normally with unique secrets", async () => {
		vi.stubEnv("DATABASE_ENCRYPTION_KEY", "ef".repeat(32));
		await register();
		expect(process.exit).not.toHaveBeenCalled();
		expect(console.warn).not.toHaveBeenCalled();
	});
});
