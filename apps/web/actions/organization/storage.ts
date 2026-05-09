"use server";

import { createHmac } from "node:crypto";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import {
	organizations,
	s3Buckets,
	storageIntegrations,
	storageObjects,
	videos,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	type GoogleDriveIntegrationConfig,
	getGoogleDriveAccessToken,
	getGoogleDriveAuthUrl,
	getGoogleDriveFolderLocation,
	getGoogleDriveUserEmail,
} from "@cap/web-backend";
import { type Organisation, S3Bucket, Storage } from "@cap/web-domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

const googleDriveProvider = "googleDrive";
const settingsPath = "/dashboard/settings/organization/integrations";
const proRequiredMessage =
	"Cap Pro is required to manage organization integrations";

type OrganizationStorageProvider = "s3" | "googleDrive";

export type OrganizationStorageSettings = {
	organization: {
		id: string;
		name: string;
	};
	activeProvider: OrganizationStorageProvider | null;
	googleOAuthClientId: string | null;
	googlePickerApiKey: string | null;
	s3: {
		configured: boolean;
		provider: string;
		accessKeyId: string;
		secretAccessKey: string;
		endpoint: string;
		bucketName: string;
		region: string;
	} | null;
	googleDrive: {
		id: string;
		connected: boolean;
		active: boolean;
		status: "active" | "disconnected" | "error";
		displayName: string | null;
		email: string | null;
		folderId: string | null;
		folderName: string | null;
		driveId: string | null;
		driveName: string | null;
	} | null;
};

type S3ConfigInput = {
	organizationId: Organisation.OrganisationId;
	provider: string;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint: string;
	bucketName: string;
	region: string;
};

export type OrganizationGoogleDriveFolder = {
	id: string;
	name: string;
	driveId: string | null;
	driveName: string | null;
};

const googleDriveFolderMimeType = "application/vnd.google-apps.folder";
const driveApiBase = "https://www.googleapis.com/drive/v3";

const requireOrganizationOwner = async (
	organizationId: Organisation.OrganisationId,
) => {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
		})
		.from(organizations)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);

	if (!organization) throw new Error("Organization not found");
	if (organization.ownerId !== user.id) {
		throw new Error("Only the owner can manage organization storage");
	}

	return { user, organization };
};

const requireOrganizationOwnerPro = async (
	organizationId: Organisation.OrganisationId,
) => {
	const result = await requireOrganizationOwner(organizationId);
	if (!userIsPro(result.user)) throw new Error(proRequiredMessage);
	return result;
};

const decryptS3Config = async (
	bucket: typeof s3Buckets.$inferSelect,
	exposeSecrets: boolean,
) => ({
	configured: true,
	provider: bucket.provider,
	accessKeyId: exposeSecrets ? await decrypt(bucket.accessKeyId) : "",
	secretAccessKey: exposeSecrets ? await decrypt(bucket.secretAccessKey) : "",
	endpoint: bucket.endpoint
		? await decrypt(bucket.endpoint)
		: "https://s3.amazonaws.com",
	bucketName: await decrypt(bucket.bucketName),
	region: await decrypt(bucket.region),
});

const parseDriveConfig = async (
	integration: typeof storageIntegrations.$inferSelect,
) =>
	JSON.parse(
		await decrypt(integration.encryptedConfig),
	) as GoogleDriveIntegrationConfig;

const hasDriveLocation = (config: GoogleDriveIntegrationConfig) =>
	config.folderId.trim().length > 0;

const escapeDriveQueryValue = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const parseDriveResponse = async <T>(response: Response) => {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Google Drive request failed: ${response.status} ${text}`);
	}
	return text ? (JSON.parse(text) as T) : ({} as T);
};

const toReadableError = (error: unknown) => {
	if (error instanceof Error) return error;
	if (error && typeof error === "object" && "cause" in error) {
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error) return cause;
	}
	return new Error("Google Drive request failed");
};

const getS3ErrorMetadata = (error: unknown) => {
	if (!error || typeof error !== "object" || !("$metadata" in error)) {
		return undefined;
	}

	return error.$metadata as { httpStatusCode?: number } | undefined;
};

const getS3ConnectionErrorMessage = (error: unknown, bucketName: string) => {
	if (!(error instanceof Error)) return "Failed to connect to S3";

	if (error.name === "AbortError" || error.name === "TimeoutError") {
		return "Connection timed out after 5 seconds. Please check the endpoint URL and your network connection.";
	}

	if (error.name === "NoSuchBucket") {
		return `Bucket '${bucketName}' does not exist`;
	}

	if (error.name === "NetworkingError") {
		return "Network error. Please check the endpoint URL and your network connection.";
	}

	if (error.name === "InvalidAccessKeyId") {
		return "Invalid Access Key ID";
	}

	if (error.name === "SignatureDoesNotMatch") {
		return "Invalid Secret Access Key";
	}

	if (error.name === "AccessDenied") {
		return "Access denied. Please check your credentials and bucket permissions.";
	}

	if (getS3ErrorMetadata(error)?.httpStatusCode === 301) {
		return "Received 301 redirect. This usually means the endpoint URL is incorrect or the bucket is in a different region.";
	}

	return "Failed to connect to S3";
};

const driveHasStoredData = async (
	drive: typeof storageIntegrations.$inferSelect,
) => {
	const [object, video] = await Promise.all([
		db()
			.select({ id: storageObjects.id })
			.from(storageObjects)
			.where(eq(storageObjects.integrationId, drive.id))
			.limit(1),
		db()
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.storageIntegrationId, drive.id))
			.limit(1),
	]);

	return object.length > 0 || video.length > 0;
};

const getOrganizationDrive = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [drive] = await db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.organizationId, organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		)
		.orderBy(
			desc(storageIntegrations.active),
			desc(storageIntegrations.updatedAt),
		)
		.limit(1);

	return drive ?? null;
};

const getActiveOrganizationDrive = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [drive] = await db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.organizationId, organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
				eq(storageIntegrations.active, true),
				eq(storageIntegrations.status, "active"),
			),
		)
		.orderBy(desc(storageIntegrations.updatedAt))
		.limit(1);

	return drive ?? null;
};

const getOrganizationBucket = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [bucket] = await db()
		.select()
		.from(s3Buckets)
		.where(
			and(
				eq(s3Buckets.organizationId, organizationId),
				eq(s3Buckets.active, true),
			),
		)
		.orderBy(desc(s3Buckets.updatedAt))
		.limit(1);

	return bucket ?? null;
};

const getS3InputCredentials = async (input: S3ConfigInput) => {
	const hasAccessKeyId = input.accessKeyId.trim().length > 0;
	const hasSecretAccessKey = input.secretAccessKey.trim().length > 0;

	if (hasAccessKeyId && hasSecretAccessKey) {
		return {
			accessKeyId: input.accessKeyId,
			secretAccessKey: input.secretAccessKey,
		};
	}

	const existingBucket = await getOrganizationBucket(input.organizationId);
	if (!existingBucket) {
		throw new Error("Access key ID and secret access key are required");
	}

	if (hasAccessKeyId || hasSecretAccessKey) {
		throw new Error(
			"Enter both access key ID and secret access key to change credentials",
		);
	}

	return {
		accessKeyId: await decrypt(existingBucket.accessKeyId),
		secretAccessKey: await decrypt(existingBucket.secretAccessKey),
	};
};

const revalidateStorageSettings = () => {
	revalidatePath(settingsPath);
	revalidatePath("/dashboard/settings/organization");
};

const signStatePayload = (payload: string) => {
	return createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(payload)
		.digest("base64url");
};

const createGoogleDriveState = (
	userId: string,
	organizationId: Organisation.OrganisationId,
) => {
	const payload = Buffer.from(
		JSON.stringify({
			userId,
			expiresAt: Date.now() + 10 * 60 * 1000,
			scope: "organization",
			organizationId,
		}),
	).toString("base64url");
	return `${payload}.${signStatePayload(payload)}`;
};

export async function getOrganizationStorageSettings(
	organizationId: Organisation.OrganisationId,
): Promise<OrganizationStorageSettings> {
	const { organization } = await requireOrganizationOwner(organizationId);
	const [bucket, drive, activeDrive] = await Promise.all([
		getOrganizationBucket(organizationId),
		getOrganizationDrive(organizationId),
		getActiveOrganizationDrive(organizationId),
	]);
	const driveConfig = drive ? await parseDriveConfig(drive) : null;
	const activeProvider = activeDrive ? "googleDrive" : bucket ? "s3" : null;

	return {
		organization: {
			id: organization.id,
			name: organization.name,
		},
		activeProvider,
		googleOAuthClientId: process.env.GOOGLE_CLIENT_ID ?? null,
		googlePickerApiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
		s3: bucket ? await decryptS3Config(bucket, false) : null,
		googleDrive:
			drive && driveConfig
				? {
						id: drive.id,
						connected: drive.status === "active",
						active: drive.active,
						status: drive.status,
						displayName: drive.displayName,
						email: driveConfig.email ?? null,
						folderId: driveConfig.folderId || null,
						folderName: driveConfig.folderName ?? null,
						driveId: driveConfig.driveId ?? null,
						driveName: driveConfig.driveName ?? null,
					}
				: null,
	};
}

export async function saveOrganizationS3Config(input: S3ConfigInput) {
	const { user } = await requireOrganizationOwnerPro(input.organizationId);
	const credentials = await getS3InputCredentials(input);
	const encryptedConfig = {
		provider: input.provider,
		accessKeyId: await encrypt(credentials.accessKeyId),
		secretAccessKey: await encrypt(credentials.secretAccessKey),
		endpoint: input.endpoint ? await encrypt(input.endpoint) : null,
		bucketName: await encrypt(input.bucketName),
		region: await encrypt(input.region),
		ownerId: user.id,
		organizationId: input.organizationId,
	};

	await db().transaction(async (tx) => {
		await tx
			.update(s3Buckets)
			.set({ active: false })
			.where(eq(s3Buckets.organizationId, input.organizationId));
		await tx.insert(s3Buckets).values({
			id: S3Bucket.S3BucketId.make(nanoId()),
			...encryptedConfig,
			active: true,
		});
	});

	revalidateStorageSettings();
	return { success: true };
}

export async function removeOrganizationS3Config(
	organizationId: Organisation.OrganisationId,
) {
	await requireOrganizationOwnerPro(organizationId);
	await db()
		.update(s3Buckets)
		.set({ active: false })
		.where(eq(s3Buckets.organizationId, organizationId));
	revalidateStorageSettings();
	return { success: true };
}

export async function testOrganizationS3Config(input: S3ConfigInput) {
	await requireOrganizationOwnerPro(input.organizationId);
	const credentials = await getS3InputCredentials(input);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	const s3Client = new S3Client({
		endpoint: input.endpoint || undefined,
		region: input.region,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});

	try {
		await s3Client.send(new HeadBucketCommand({ Bucket: input.bucketName }), {
			abortSignal: controller.signal,
		});
		return { success: true };
	} catch (error) {
		throw new Error(getS3ConnectionErrorMessage(error, input.bucketName));
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function setOrganizationStorageProvider({
	organizationId,
	provider,
}: {
	organizationId: Organisation.OrganisationId;
	provider: OrganizationStorageProvider;
}) {
	await requireOrganizationOwnerPro(organizationId);

	if (provider === "s3") {
		const bucket = await getOrganizationBucket(organizationId);
		if (!bucket) throw new Error("S3 is not configured");
		await db()
			.update(storageIntegrations)
			.set({ active: false })
			.where(eq(storageIntegrations.organizationId, organizationId));
		revalidateStorageSettings();
		return { success: true };
	}

	const drive = await getOrganizationDrive(organizationId);
	if (!drive || drive.status !== "active") {
		throw new Error("Google Drive is not connected");
	}
	const config = await parseDriveConfig(drive);
	if (!hasDriveLocation(config)) {
		throw new Error("Choose a Google Drive location before enabling it");
	}

	await db().transaction(async (tx) => {
		await tx
			.update(storageIntegrations)
			.set({ active: false })
			.where(eq(storageIntegrations.organizationId, organizationId));
		await tx
			.update(storageIntegrations)
			.set({ active: true })
			.where(eq(storageIntegrations.id, drive.id));
	});

	revalidateStorageSettings();
	return { success: true };
}

export async function connectOrganizationGoogleDrive(
	organizationId: Organisation.OrganisationId,
) {
	const { user } = await requireOrganizationOwnerPro(organizationId);
	const state = createGoogleDriveState(user.id, organizationId);
	return { url: getGoogleDriveAuthUrl({ state }) };
}

export async function disconnectOrganizationGoogleDrive(
	organizationId: Organisation.OrganisationId,
) {
	await requireOrganizationOwnerPro(organizationId);
	await db()
		.update(storageIntegrations)
		.set({
			active: false,
			status: "disconnected",
			googleDriveAccessToken: null,
			googleDriveAccessTokenExpiresAt: null,
			googleDriveTokenRefreshLeaseId: null,
			googleDriveTokenRefreshLeaseExpiresAt: null,
			googleDriveStorageQuotaCache: null,
		})
		.where(
			and(
				eq(storageIntegrations.organizationId, organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		);

	revalidateStorageSettings();
	return { success: true };
}

export async function getOrganizationGoogleDrivePickerToken(
	organizationId: Organisation.OrganisationId,
) {
	await requireOrganizationOwnerPro(organizationId);
	const drive = await getOrganizationDrive(organizationId);
	if (!drive || drive.status !== "active") {
		throw new Error("Google Drive is not connected");
	}

	const config = await parseDriveConfig(drive);
	const accessToken = await getGoogleDriveAccessToken(config)
		.pipe(runPromise)
		.catch((error: unknown) => {
			throw toReadableError(error);
		});

	return {
		accessToken,
		clientId: process.env.GOOGLE_CLIENT_ID ?? null,
		apiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
	};
}

export async function listOrganizationGoogleDriveFolders({
	organizationId,
	parentId = "root",
}: {
	organizationId: Organisation.OrganisationId;
	parentId?: string;
}) {
	await requireOrganizationOwnerPro(organizationId);
	const drive = await getOrganizationDrive(organizationId);
	if (!drive || drive.status !== "active") {
		throw new Error("Google Drive is not connected");
	}

	try {
		const config = await parseDriveConfig(drive);
		const accessToken =
			await getGoogleDriveAccessToken(config).pipe(runPromise);
		const query = [
			`'${escapeDriveQueryValue(parentId)}' in parents`,
			`mimeType='${googleDriveFolderMimeType}'`,
			"trashed=false",
		].join(" and ");
		const url = new URL(`${driveApiBase}/files`);
		url.searchParams.set("q", query);
		url.searchParams.set("fields", "files(id,name,driveId)");
		url.searchParams.set("spaces", "drive");
		url.searchParams.set("supportsAllDrives", "true");
		url.searchParams.set("includeItemsFromAllDrives", "true");
		if (config.driveId) {
			url.searchParams.set("corpora", "drive");
			url.searchParams.set("driveId", config.driveId);
		}

		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const body = await parseDriveResponse<{
			files?: Array<{ id?: string; name?: string; driveId?: string | null }>;
		}>(response);

		return {
			folders:
				body.files
					?.filter((folder) => folder.id && folder.name)
					.map((folder) => ({
						id: folder.id as string,
						name: folder.name as string,
						driveId: folder.driveId ?? null,
						driveName: null,
					})) ?? [],
		};
	} catch (error) {
		throw toReadableError(error);
	}
}

export async function setOrganizationGoogleDriveLocation({
	organizationId,
	folderId,
	folderName,
	driveId,
	driveName,
}: {
	organizationId: Organisation.OrganisationId;
	folderId: string;
	folderName?: string | null;
	driveId?: string | null;
	driveName?: string | null;
}) {
	const { user } = await requireOrganizationOwnerPro(organizationId);
	const drive = await getOrganizationDrive(organizationId);
	if (!drive || drive.status !== "active") {
		throw new Error("Google Drive is not connected");
	}

	const config = await parseDriveConfig(drive);
	const location =
		folderId === "root"
			? { id: "root", name: "My Drive", driveId: null }
			: await getGoogleDriveFolderLocation(config, folderId)
					.pipe(runPromise)
					.catch((error: unknown) => {
						throw toReadableError(error);
					});
	const nextConfig: GoogleDriveIntegrationConfig = {
		...config,
		folderId: location.id,
		folderName: folderName ?? location.name,
		driveId: driveId ?? location.driveId ?? null,
		driveName: driveName ?? location.driveName ?? null,
		folderLayout: "userVideo",
	};
	const email = await getGoogleDriveUserEmail(nextConfig)
		.pipe(runPromise)
		.catch((error: unknown) => {
			throw toReadableError(error);
		});
	const displayName = email ? `Google Drive (${email})` : "Google Drive";
	const encryptedConfig = await encrypt(
		JSON.stringify({ ...nextConfig, email: email ?? undefined }),
	);

	if (await driveHasStoredData(drive)) {
		await db().transaction(async (tx) => {
			if (drive.active) {
				await tx
					.update(storageIntegrations)
					.set({ active: false })
					.where(eq(storageIntegrations.organizationId, organizationId));
			}
			await tx.insert(storageIntegrations).values({
				id: Storage.StorageIntegrationId.make(nanoId()),
				ownerId: user.id,
				organizationId,
				provider: googleDriveProvider,
				displayName,
				status: "active",
				active: drive.active,
				encryptedConfig,
				googleDriveStorageQuotaCache: null,
			});
		});
	} else {
		await db()
			.update(storageIntegrations)
			.set({
				active: drive.active,
				status: "active",
				displayName,
				encryptedConfig,
				googleDriveStorageQuotaCache: null,
			})
			.where(eq(storageIntegrations.id, drive.id));
	}

	revalidateStorageSettings();
	return { success: true };
}
