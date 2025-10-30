import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets } from "@cap/database/schema";
import { S3Bucket } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";

export const app = new Hono().use(withAuth);

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		try {
			// Encrypt the sensitive data
			const encryptedConfig = {
				id: S3Bucket.S3BucketId.make(nanoId()),
				provider: data.provider,
				accessKeyId: await encrypt(data.accessKeyId),
				secretAccessKey: await encrypt(data.secretAccessKey),
				endpoint: data.endpoint ? await encrypt(data.endpoint) : null,
				bucketName: await encrypt(data.bucketName),
				region: await encrypt(data.region),
				ownerId: user.id,
			};

			// Check if user already has a bucket config
			const [existingBucket] = await db()
				.select()
				.from(s3Buckets)
				.where(eq(s3Buckets.ownerId, user.id));

			if (existingBucket) {
				// Update existing config
				await db()
					.update(s3Buckets)
					.set(encryptedConfig)
					.where(eq(s3Buckets.id, existingBucket.id));
			} else {
				// Insert new config
				await db().insert(s3Buckets).values(encryptedConfig);
			}

			return c.json({ success: true });
		} catch (error) {
			console.error("Error in S3 config route:", error);
			return c.json(
				{
					error: "Failed to save S3 configuration",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.delete("/delete", async (c) => {
	const user = c.get("user");

	try {
		// Delete the S3 configuration for the user
		await db().delete(s3Buckets).where(eq(s3Buckets.ownerId, user.id));

		return c.json({ success: true });
	} catch (error) {
		console.error("Error in S3 config delete route:", error);
		return c.json(
			{
				error: "Failed to delete S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.get("/get", async (c) => {
	const user = c.get("user");

	try {
		const [bucket] = await db()
			.select()
			.from(s3Buckets)
			.where(eq(s3Buckets.ownerId, user.id));

		if (!bucket)
			return c.json({
				config: {
					provider: "aws",
					accessKeyId: "",
					secretAccessKey: "",
					endpoint: "https://s3.amazonaws.com",
					bucketName: "",
					region: "us-east-1",
				},
			});

		// Decrypt the values before sending
		const decryptedConfig = {
			provider: bucket.provider,
			accessKeyId: await decrypt(bucket.accessKeyId),
			secretAccessKey: await decrypt(bucket.secretAccessKey),
			endpoint: bucket.endpoint
				? await decrypt(bucket.endpoint)
				: "https://s3.amazonaws.com",
			bucketName: await decrypt(bucket.bucketName),
			region: await decrypt(bucket.region),
		};

		return c.json({ config: decryptedConfig });
	} catch (error) {
		console.error("Error in S3 config get route:", error);
		return c.json(
			{
				error: "Failed to fetch S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.post(
	"/test",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const TIMEOUT_MS = 5000; // 5 second timeout
		const data = c.req.valid("json");

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => {
				controller.abort();
			}, TIMEOUT_MS);

			const s3Client = new S3Client({
				endpoint: data.endpoint,
				region: data.region,
				credentials: {
					accessKeyId: data.accessKeyId,
					secretAccessKey: data.secretAccessKey,
				},
				requestHandler: { abortSignal: controller.signal },
			});

			try {
				await s3Client.send(new HeadBucketCommand({ Bucket: data.bucketName }));

				clearTimeout(timeoutId);
			} catch (error) {
				console.log(error);
				clearTimeout(timeoutId);
				let errorMessage = "Failed to connect to S3";

				if (error instanceof Error) {
					if (error.name === "AbortError" || error.name === "TimeoutError") {
						errorMessage =
							"Connection timed out after 5 seconds. Please check the endpoint URL and your network connection.";
					} else if (error.name === "NoSuchBucket") {
						errorMessage = `Bucket '${data.bucketName}' does not exist`;
					} else if (error.name === "NetworkingError") {
						errorMessage =
							"Network error. Please check the endpoint URL and your network connection.";
					} else if (error.name === "InvalidAccessKeyId") {
						errorMessage = "Invalid Access Key ID";
					} else if (error.name === "SignatureDoesNotMatch") {
						errorMessage = "Invalid Secret Access Key";
					} else if (error.name === "AccessDenied") {
						errorMessage =
							"Access denied. Please check your credentials and bucket permissions.";
					} else if ((error as any).$metadata?.httpStatusCode === 301) {
						errorMessage =
							"Received 301 redirect. This usually means the endpoint URL is incorrect or the bucket is in a different region.";
					}
				}

				return c.json(
					{
						error: errorMessage,
						details: error instanceof Error ? error.message : String(error),
						metadata: (error as any)?.$metadata,
					},
					{ status: 500 },
				);
			}

			return c.json({ success: true });
		} catch (error) {
			return c.json(
				{
					error: "Failed to connect to S3",
					details: error instanceof Error ? error.message : String(error),
					metadata: (error as any)?.$metadata,
				},
				{ status: 500 },
			);
		}
	},
);
