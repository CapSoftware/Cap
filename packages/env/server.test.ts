import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function resetEnv() {
	for (const key of Object.keys(process.env)) {
		delete process.env[key];
	}
	Object.assign(process.env, originalEnv);
}

function setRequiredServerEnv() {
	process.env.DATABASE_URL = "mysql://user:password@localhost:3306/cap";
	process.env.WEB_URL = "https://cap.example";
	process.env.NEXTAUTH_SECRET = "test-secret";
	process.env.NEXTAUTH_URL = "https://cap.example";
	process.env.CAP_AWS_BUCKET = "cap-test-bucket";
	process.env.CAP_AWS_REGION = "us-east-1";
	process.env.NODE_ENV = "test";
}

afterEach(() => {
	resetEnv();
	vi.resetModules();
});

describe("serverEnv", () => {
	it("maps CAP_AWS_ENDPOINT to both S3 endpoint aliases", async () => {
		setRequiredServerEnv();
		process.env.CAP_AWS_ENDPOINT = "https://s3.example";

		const { serverEnv } = await import("./server");

		const env = serverEnv();
		expect(env.S3_PUBLIC_ENDPOINT).toBe("https://s3.example");
		expect(env.S3_INTERNAL_ENDPOINT).toBe("https://s3.example");
	});

	it("parses boolean string defaults for server settings", async () => {
		setRequiredServerEnv();

		const { serverEnv } = await import("./server");

		const env = serverEnv();
		expect(env.S3_PATH_STYLE).toBe(true);
		expect(env.CAP_VIDEOS_DEFAULT_PUBLIC).toBe(true);
	});
});
