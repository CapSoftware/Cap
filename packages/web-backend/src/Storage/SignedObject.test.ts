import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV = {
	DATABASE_URL: "mysql://user:password@localhost:3306/cap",
	WEB_URL: "http://localhost:3000",
	NEXTAUTH_SECRET: "test-nextauth-secret",
	NEXTAUTH_URL: "http://localhost:3000",
	CAP_AWS_BUCKET: "test-bucket",
	CAP_AWS_REGION: "us-east-1",
	NODE_ENV: "test",
};

function setRequiredEnv() {
	for (const [key, value] of Object.entries(REQUIRED_ENV)) {
		process.env[key] = value;
	}
}

function clearRequiredEnv() {
	for (const key of Object.keys(REQUIRED_ENV)) {
		delete process.env[key];
	}
}

async function importSignedObject() {
	vi.resetModules();
	setRequiredEnv();
	return import("./SignedObject.ts");
}

describe("storage object tokens", () => {
	beforeEach(() => {
		setRequiredEnv();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		clearRequiredEnv();
	});

	it("creates tokens that verify back to their storage payload", async () => {
		const { createStorageObjectToken, verifyStorageObjectToken } =
			await importSignedObject();

		const token = createStorageObjectToken(
			{ videoId: "video-1", key: "owner-1/video-1/source.mp4" },
			60,
		);

		expect(verifyStorageObjectToken(token)).toEqual({
			videoId: "video-1",
			key: "owner-1/video-1/source.mp4",
			expiresAt: Date.parse("2026-05-15T00:01:00.000Z"),
		});
	});

	it("rejects tokens when the signature is changed", async () => {
		const { createStorageObjectToken, verifyStorageObjectToken } =
			await importSignedObject();

		const token = createStorageObjectToken({
			videoId: "video-1",
			key: "owner-1/video-1/source.mp4",
		});
		const [payload, signature] = token.split(".");
		const changedSignature = `${signature?.slice(0, -1)}${
			signature?.endsWith("A") ? "B" : "A"
		}`;

		expect(
			verifyStorageObjectToken(`${payload}.${changedSignature}`),
		).toBeNull();
	});

	it("rejects tokens after their expiry time", async () => {
		const { createStorageObjectToken, verifyStorageObjectToken } =
			await importSignedObject();

		const token = createStorageObjectToken(
			{ videoId: "video-1", key: "owner-1/video-1/source.mp4" },
			60,
		);

		vi.advanceTimersByTime(60_001);

		expect(verifyStorageObjectToken(token)).toBeNull();
	});
});
