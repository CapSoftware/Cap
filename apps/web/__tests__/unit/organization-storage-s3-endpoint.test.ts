import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	NODE_ENV: "production",
	s3Configs: [] as Array<Record<string, unknown>>,
	send: vi.fn(async () => ({})),
	insert: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	get buildEnv() {
		return state.buildEnv;
	},
	get NODE_ENV() {
		return state.NODE_ENV;
	},
	serverEnv: () => ({ NEXTAUTH_SECRET: "synthetic-secret" }),
}));

vi.mock("@aws-sdk/client-s3", () => ({
	HeadBucketCommand: class {
		constructor(readonly input: unknown) {}
	},
	S3Client: class {
		constructor(config: Record<string, unknown>) {
			state.s3Configs.push(config);
		}
		send = state.send;
	},
}));

const query = (result: unknown): unknown =>
	new Proxy(() => undefined, {
		get: (_, property) =>
			property === "then"
				? (resolve: (value: unknown) => void) => resolve(result)
				: () => query(result),
	});

type FakeDatabase = {
	select: () => unknown;
	update: () => unknown;
	insert: (...args: unknown[]) => unknown;
	transaction: (
		callback: (tx: FakeDatabase) => Promise<unknown>,
	) => Promise<unknown>;
};

const database: FakeDatabase = {
	select: () => query([{ id: "org_synthetic", name: "Org", ownerId: "usr" }]),
	update: () => query(undefined),
	insert: (...args: unknown[]) => {
		state.insert(...args);
		return query(undefined);
	},
	transaction: async (callback) => callback(database),
};

vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "usr_synthetic" }),
}));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `enc:${value}`,
	decrypt: async (value: string) => value.replace(/^enc:/, ""),
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "synthetic_id" }));
vi.mock("@cap/database/schema", () => ({
	organizations: {},
	s3Buckets: {},
	storageIntegrations: {},
	storageObjects: {},
	videos: {},
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({}));
vi.mock("@cap/web-domain", () => ({
	S3Bucket: { S3BucketId: { make: (id: string) => id } },
	Storage: { StorageIntegrationId: { make: (id: string) => id } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: async () => undefined,
}));

import {
	saveOrganizationS3Config,
	testOrganizationS3Config,
} from "@/actions/organization/storage";
import { blockedS3EndpointMessage } from "@/lib/s3-endpoint-policy";

const input = (endpoint: string) => ({
	organizationId: "org_synthetic" as Organisation.OrganisationId,
	provider: "aws",
	accessKeyId: "AKIASYNTHETIC",
	secretAccessKey: "synthetic-secret",
	endpoint,
	bucketName: "synthetic-bucket",
	region: "us-east-1",
});

describe("organization storage S3 endpoint policy", () => {
	beforeEach(() => {
		state.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		state.NODE_ENV = "production";
		state.s3Configs.length = 0;
		state.send.mockClear();
		state.insert.mockClear();
	});

	it.each([
		"http://169.254.169.254",
		"http://127.0.0.1:9000",
		"http://localhost:9000",
		"http://[::1]:9000",
	])("refuses to save %s on Cap Cloud", async (endpoint) => {
		await expect(saveOrganizationS3Config(input(endpoint))).rejects.toThrow(
			blockedS3EndpointMessage,
		);
		expect(state.insert).not.toHaveBeenCalled();
	});

	it.each([
		"http://169.254.169.254",
		"http://10.0.0.5",
		"http://minio.localhost",
	])("refuses to test %s on Cap Cloud", async (endpoint) => {
		await expect(testOrganizationS3Config(input(endpoint))).rejects.toThrow(
			blockedS3EndpointMessage,
		);
		expect(state.s3Configs).toHaveLength(0);
		expect(state.send).not.toHaveBeenCalled();
	});

	it("saves public and default endpoints on Cap Cloud", async () => {
		await expect(
			saveOrganizationS3Config(input("https://8.8.8.8")),
		).resolves.toEqual({ success: true });
		await expect(saveOrganizationS3Config(input(""))).resolves.toEqual({
			success: true,
		});
		expect(state.insert).toHaveBeenCalledTimes(2);
	});

	it("tests public endpoints through public-only agents on Cap Cloud", async () => {
		await expect(
			testOrganizationS3Config(input("https://8.8.8.8")),
		).resolves.toEqual({ success: true });

		expect(state.s3Configs).toHaveLength(1);
		const requestHandler = state.s3Configs[0]?.requestHandler as {
			httpAgent?: unknown;
			httpsAgent?: unknown;
		};
		expect(requestHandler.httpAgent).toBeInstanceOf(HttpAgent);
		expect(requestHandler.httpsAgent).toBeInstanceOf(HttpsAgent);
		expect(state.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		["self-hosted", undefined, "production"],
		["development", "true", "development"],
	])("allows local endpoints on %s deployments", async (_, isCap, nodeEnv) => {
		state.buildEnv.NEXT_PUBLIC_IS_CAP = isCap;
		state.NODE_ENV = nodeEnv;

		await expect(
			saveOrganizationS3Config(input("http://localhost:9000")),
		).resolves.toEqual({ success: true });
		await expect(
			testOrganizationS3Config(input("http://192.168.1.10:9000")),
		).resolves.toEqual({ success: true });

		expect(state.insert).toHaveBeenCalledTimes(1);
		expect(state.s3Configs).toHaveLength(1);
		expect(state.s3Configs[0]?.endpoint).toBe("http://192.168.1.10:9000");
		expect(state.s3Configs[0]?.requestHandler).toBeUndefined();
	});
});
