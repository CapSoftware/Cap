import {
	BucketAlreadyExists,
	BucketAlreadyOwnedByYou,
	CreateBucketCommand,
	DeleteBucketPolicyCommand,
	GetBucketPolicyCommand,
	PutBucketPolicyCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupLegacyBucketPolicy,
	createS3Bucket,
	isLegacyCapPublicPolicyStatement,
} from "../../instrumentation.node";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_AWS_BUCKET: "cap",
		S3_INTERNAL_ENDPOINT: "http://localhost:9000",
		CAP_AWS_REGION: "us-east-1",
		CAP_AWS_ACCESS_KEY: "minioadmin",
		CAP_AWS_SECRET_KEY: "minioadmin",
		S3_PATH_STYLE: "true",
	}),
	buildEnv: {
		NEXT_PUBLIC_DOCKER_BUILD: "false",
	},
}));

describe("isLegacyCapPublicPolicyStatement", () => {
	it("identifies the legacy Cap anonymous public-read statement", () => {
		const statement = {
			Effect: "Allow",
			Principal: "*",
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(true);
	});

	it("identifies legacy statement with string action and resource", () => {
		const statement = {
			Effect: "Allow",
			Principal: "*",
			Action: "s3:GetObject",
			Resource: "arn:aws:s3:::cap/*",
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(true);
	});

	it("identifies legacy statement with AWS wildcard principal object", () => {
		const statement = {
			Effect: "Allow",
			Principal: { AWS: "*" },
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(true);
	});

	it("rejects statements with Effect Deny", () => {
		const statement = {
			Effect: "Deny",
			Principal: "*",
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(false);
	});

	it("rejects statements with specific principal", () => {
		const statement = {
			Effect: "Allow",
			Principal: { AWS: "arn:aws:iam::123456789012:root" },
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(false);
	});

	it("rejects statements with broader or different actions", () => {
		const statement = {
			Effect: "Allow",
			Principal: "*",
			Action: ["s3:GetObject", "s3:PutObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(false);
	});

	it("rejects statements targeting a different bucket or prefix", () => {
		const statement = {
			Effect: "Allow",
			Principal: "*",
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::other-bucket/*"],
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(false);
	});

	it("rejects statements with Condition (custom access rule)", () => {
		const statement = {
			Effect: "Allow",
			Principal: "*",
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
			Condition: {
				StringEquals: { "aws:sourceVpce": "vpce-1a2b3c4d" },
			},
		};
		expect(isLegacyCapPublicPolicyStatement(statement, "cap")).toBe(false);
	});
});

describe("cleanupLegacyBucketPolicy", () => {
	const mockSend = vi.fn();
	const client = { send: mockSend } as unknown as S3Client;

	beforeEach(() => {
		mockSend.mockReset();
	});

	it("deletes the policy when the legacy statement is the only statement", async () => {
		mockSend.mockImplementation(async (command) => {
			if (command instanceof GetBucketPolicyCommand) {
				return {
					Policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: "*",
								Action: ["s3:GetObject"],
								Resource: ["arn:aws:s3:::cap/*"],
							},
						],
					}),
				};
			}
			if (command instanceof DeleteBucketPolicyCommand) {
				return {};
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await cleanupLegacyBucketPolicy(client, "cap");

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
		expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(
			DeleteBucketPolicyCommand,
		);
	});

	it("removes only the legacy statement and preserves custom statements", async () => {
		const customStatement = {
			Sid: "CustomBackupSync",
			Effect: "Allow",
			Principal: { AWS: "arn:aws:iam::123456789012:role/BackupRole" },
			Action: ["s3:GetObject", "s3:ListBucket"],
			Resource: ["arn:aws:s3:::cap", "arn:aws:s3:::cap/*"],
		};

		mockSend.mockImplementation(async (command) => {
			if (command instanceof GetBucketPolicyCommand) {
				return {
					Policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: "*",
								Action: ["s3:GetObject"],
								Resource: ["arn:aws:s3:::cap/*"],
							},
							customStatement,
						],
					}),
				};
			}
			if (command instanceof PutBucketPolicyCommand) {
				return {};
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await cleanupLegacyBucketPolicy(client, "cap");

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
		const putCommand = mockSend.mock.calls[1]?.[0] as PutBucketPolicyCommand;
		expect(putCommand).toBeInstanceOf(PutBucketPolicyCommand);
		const parsed = JSON.parse(putCommand.input.Policy as string);
		expect(parsed.Statement).toEqual([customStatement]);
	});

	it("does not modify policy when no legacy public statement is present", async () => {
		const customStatement = {
			Effect: "Allow",
			Principal: { AWS: "arn:aws:iam::123456789012:role/BackupRole" },
			Action: ["s3:GetObject"],
			Resource: ["arn:aws:s3:::cap/*"],
		};

		mockSend.mockImplementation(async (command) => {
			if (command instanceof GetBucketPolicyCommand) {
				return {
					Policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [customStatement],
					}),
				};
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await cleanupLegacyBucketPolicy(client, "cap");

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
	});

	it("ignores NoSuchBucketPolicy gracefully", async () => {
		mockSend.mockImplementation(async (command) => {
			if (command instanceof GetBucketPolicyCommand) {
				const error = new Error("The bucket policy does not exist");
				error.name = "NoSuchBucketPolicy";
				throw error;
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await expect(
			cleanupLegacyBucketPolicy(client, "cap"),
		).resolves.toBeUndefined();
		expect(mockSend).toHaveBeenCalledTimes(1);
	});
});

describe("createS3Bucket", () => {
	const mockSend = vi.fn();
	const client = { send: mockSend } as unknown as S3Client;

	beforeEach(() => {
		mockSend.mockReset();
	});

	it("creates bucket and checks for policy cleanup without applying public read policy", async () => {
		mockSend.mockImplementation(async (command) => {
			if (command instanceof CreateBucketCommand) {
				return {};
			}
			if (command instanceof GetBucketPolicyCommand) {
				const error = new Error("The bucket policy does not exist");
				error.name = "NoSuchBucketPolicy";
				throw error;
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await createS3Bucket(client);

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
	});

	it("handles existing bucket when CreateBucket throws BucketAlreadyOwnedByYou", async () => {
		mockSend.mockImplementation(async (command) => {
			if (command instanceof CreateBucketCommand) {
				throw new BucketAlreadyOwnedByYou({
					$metadata: {},
					message: "Bucket already owned by you",
				});
			}
			if (command instanceof GetBucketPolicyCommand) {
				const error = new Error("The bucket policy does not exist");
				error.name = "NoSuchBucketPolicy";
				throw error;
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await createS3Bucket(client);

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
	});

	it("handles existing bucket when CreateBucket throws BucketAlreadyExists", async () => {
		mockSend.mockImplementation(async (command) => {
			if (command instanceof CreateBucketCommand) {
				throw new BucketAlreadyExists({
					$metadata: {},
					message: "Bucket already exists",
				});
			}
			if (command instanceof GetBucketPolicyCommand) {
				const error = new Error("The bucket policy does not exist");
				error.name = "NoSuchBucketPolicy";
				throw error;
			}
			throw new Error(`Unexpected command: ${command.constructor.name}`);
		});

		await createS3Bucket(client);

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
	});
});
