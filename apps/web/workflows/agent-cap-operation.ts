import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Organisations } from "@cap/web-backend/src/Organisations/index";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	CurrentUser,
	Folder,
	Organisation,
	S3Bucket,
	Storage as StorageDomain,
	User,
	Video,
} from "@cap/web-domain";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import {
	addDomain,
	checkDomainStatus,
	getDomainResponse,
} from "@/actions/organization/domain-utils";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

type CapSnapshot = {
	id: string;
	ownerId: string;
	orgId: string;
	name: string;
	bucket: string | null;
	storageIntegrationId: string | null;
	duration: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	metadata: Record<string, unknown> | null;
	public: boolean;
	settings: Record<string, unknown> | null;
	transcriptionStatus: string | null;
	source: {
		type:
			| "MediaConvert"
			| "local"
			| "desktopMP4"
			| "desktopSegments"
			| "webMP4";
	};
	folderId: string | null;
	isScreenshot: boolean;
	skipProcessing: boolean;
};

type OperationPayload = {
	snapshot: CapSnapshot;
	destinationId: string | null;
};

type OrganizationOperationPayload = {
	organizationId: string;
	domain?: string;
};

const storageVideo = (snapshot: CapSnapshot) =>
	Video.Video.make({
		id: Video.VideoId.make(snapshot.id),
		ownerId: User.UserId.make(snapshot.ownerId),
		orgId: Organisation.OrganisationId.make(snapshot.orgId),
		name: snapshot.name,
		public: snapshot.public,
		source: snapshot.source,
		metadata: Option.fromNullable(snapshot.metadata),
		bucketId: Option.fromNullable(snapshot.bucket).pipe(
			Option.map(S3Bucket.S3BucketId.make),
		),
		storageIntegrationId: Option.fromNullable(
			snapshot.storageIntegrationId,
		).pipe(Option.map(StorageDomain.StorageIntegrationId.make)),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.fromNullable(snapshot.width),
		height: Option.fromNullable(snapshot.height),
		duration: Option.fromNullable(snapshot.duration),
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});

async function claimOperation(operationId: string) {
	"use step";

	return db().transaction(async (tx) => {
		const [operation] = await tx
			.select()
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (!operation) throw new FatalError("Agent operation not found");
		if (operation.state !== "queued") return null;
		await tx
			.update(Db.agentApiOperations)
			.set({ state: "running", updatedAt: new Date() })
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.state, "queued"),
				),
			);
		return {
			kind: operation.kind,
			payload: operation.payload,
		};
	});
}

async function listOperationObjects(snapshot: CapSnapshot) {
	const [bucket] = await Storage.getAccessForVideo(storageVideo(snapshot)).pipe(
		runWorkflowPromise,
	);
	const prefix = `${snapshot.ownerId}/${snapshot.id}/`;
	const keys: string[] = [];
	let continuationToken: string | undefined;
	do {
		const page = await bucket
			.listObjects({ prefix, maxKeys: 1_000, continuationToken })
			.pipe(runWorkflowPromise);
		for (const object of page.Contents ?? []) {
			if (object.Key) keys.push(object.Key);
		}
		continuationToken = page.IsTruncated
			? page.NextContinuationToken
			: undefined;
	} while (continuationToken);
	return { bucket, keys, prefix };
}

async function copyCapObjects(payload: OperationPayload) {
	"use step";

	if (!payload.destinationId)
		throw new FatalError("Duplicate destination missing");
	const { bucket, keys, prefix } = await listOperationObjects(payload.snapshot);
	const destinationPrefix = `${payload.snapshot.ownerId}/${payload.destinationId}/`;
	await Effect.forEach(
		keys,
		(key) =>
			bucket.copyObject(
				`${bucket.bucketName}/${key}`,
				key.replace(prefix, destinationPrefix),
			),
		{ concurrency: 4 },
	).pipe(runWorkflowPromise);
}

async function createDuplicate(operationId: string, payload: OperationPayload) {
	"use step";

	if (!payload.destinationId)
		throw new FatalError("Duplicate destination missing");
	const snapshot = payload.snapshot;
	const destinationId = Video.VideoId.make(payload.destinationId);
	await db().transaction(async (tx) => {
		const [existing] = await tx
			.select({ ownerId: Db.videos.ownerId })
			.from(Db.videos)
			.where(eq(Db.videos.id, destinationId))
			.limit(1)
			.for("update");
		if (existing && existing.ownerId !== snapshot.ownerId) {
			throw new FatalError("Duplicate destination conflicts with another Cap");
		}
		if (!existing) {
			await tx.insert(Db.videos).values({
				id: destinationId,
				ownerId: User.UserId.make(snapshot.ownerId),
				orgId: Organisation.OrganisationId.make(snapshot.orgId),
				name: snapshot.name,
				bucket: snapshot.bucket
					? S3Bucket.S3BucketId.make(snapshot.bucket)
					: null,
				storageIntegrationId: snapshot.storageIntegrationId
					? StorageDomain.StorageIntegrationId.make(
							snapshot.storageIntegrationId,
						)
					: null,
				duration: snapshot.duration,
				width: snapshot.width,
				height: snapshot.height,
				fps: snapshot.fps,
				metadata: snapshot.metadata,
				public: snapshot.public,
				settings: snapshot.settings,
				transcriptionStatus: snapshot.transcriptionStatus as
					| "PROCESSING"
					| "COMPLETE"
					| "ERROR"
					| "SKIPPED"
					| "NO_AUDIO"
					| null,
				source: snapshot.source,
				folderId: snapshot.folderId
					? Folder.FolderId.make(snapshot.folderId)
					: null,
				isScreenshot: snapshot.isScreenshot,
				skipProcessing: snapshot.skipProcessing,
			});
		}
		const now = new Date();
		await tx
			.update(Db.agentApiOperations)
			.set({
				state: "succeeded",
				result: { id: destinationId },
				updatedAt: now,
				completedAt: now,
			})
			.where(eq(Db.agentApiOperations.id, operationId));
	});
}

async function deleteCapObjects(payload: OperationPayload) {
	"use step";

	const { bucket, keys } = await listOperationObjects(payload.snapshot);
	for (let index = 0; index < keys.length; index += 1_000) {
		await bucket
			.deleteObjects(
				keys.slice(index, index + 1_000).map((key) => ({ Key: key })),
			)
			.pipe(runWorkflowPromise);
	}
}

async function deleteCapDatabase(
	operationId: string,
	payload: OperationPayload,
) {
	"use step";

	const videoId = Video.VideoId.make(payload.snapshot.id);
	await db().transaction(async (tx) => {
		await tx.delete(Db.comments).where(eq(Db.comments.videoId, videoId));
		await tx
			.delete(Db.notifications)
			.where(eq(Db.notifications.videoId, videoId));
		await tx
			.delete(Db.videoUploads)
			.where(eq(Db.videoUploads.videoId, videoId));
		await tx.delete(Db.importedVideos).where(eq(Db.importedVideos.id, videoId));
		await tx
			.delete(Db.sharedVideos)
			.where(eq(Db.sharedVideos.videoId, videoId));
		await tx.delete(Db.spaceVideos).where(eq(Db.spaceVideos.videoId, videoId));
		await tx.delete(Db.videoEdits).where(eq(Db.videoEdits.videoId, videoId));
		await tx.delete(Db.videos).where(eq(Db.videos.id, videoId));
		const now = new Date();
		await tx
			.update(Db.agentApiOperations)
			.set({
				state: "succeeded",
				result: { deleted: true },
				updatedAt: now,
				completedAt: now,
			})
			.where(eq(Db.agentApiOperations.id, operationId));
	});
}

async function deleteOrganization(
	operationId: string,
	payload: OrganizationOperationPayload,
) {
	"use step";

	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);
	const [user] = await db()
		.select({
			id: Db.users.id,
			email: Db.users.email,
			activeOrganizationId: Db.users.activeOrganizationId,
			image: Db.users.image,
		})
		.from(Db.agentApiOperations)
		.innerJoin(Db.users, eq(Db.agentApiOperations.userId, Db.users.id))
		.where(eq(Db.agentApiOperations.id, operationId))
		.limit(1);
	if (!user) throw new FatalError("Agent operation owner not found");
	await Organisations.pipe(
		Effect.flatMap((organizations) => organizations.softDelete(organizationId)),
		Effect.provideService(CurrentUser, {
			id: user.id,
			email: user.email,
			activeOrganizationId: Organisation.OrganisationId.make(
				user.activeOrganizationId ?? "",
			),
			iconUrlOrKey: Option.fromNullable(user.image),
		}),
	).pipe(runWorkflowPromise);
	const [remainingOrganization] = await db()
		.select({ id: Db.organizations.id })
		.from(Db.organizations)
		.where(eq(Db.organizations.id, organizationId))
		.limit(1);
	if (remainingOrganization) {
		throw new FatalError("Organization deletion did not complete");
	}
	const now = new Date();
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "succeeded",
			result: { deleted: true },
			updatedAt: now,
			completedAt: now,
		})
		.where(eq(Db.agentApiOperations.id, operationId));
}

async function getOrganizationDomainContext(
	operationId: string,
	payload: OrganizationOperationPayload,
) {
	"use step";
	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);

	const [row] = await db()
		.select({
			userId: Db.agentApiOperations.userId,
			ownerId: Db.organizations.ownerId,
			memberRole: Db.organizationMembers.role,
			customDomain: Db.organizations.customDomain,
			stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: Db.users.thirdPartyStripeSubscriptionId,
		})
		.from(Db.agentApiOperations)
		.innerJoin(
			Db.organizations,
			eq(Db.agentApiOperations.resourceId, Db.organizations.id),
		)
		.innerJoin(Db.users, eq(Db.agentApiOperations.userId, Db.users.id))
		.leftJoin(
			Db.organizationMembers,
			and(
				eq(Db.organizationMembers.organizationId, Db.organizations.id),
				eq(Db.organizationMembers.userId, Db.agentApiOperations.userId),
			),
		)
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				eq(Db.organizations.id, organizationId),
			),
		)
		.limit(1);
	if (!row) throw new FatalError("Organization domain target not found");
	if (
		row.userId !== row.ownerId &&
		row.memberRole !== "owner" &&
		row.memberRole !== "admin"
	) {
		throw new FatalError("Organization domain access was revoked");
	}
	return row;
}

async function addOrganizationDomain(domain: string) {
	"use step";

	const response = await addDomain(domain);
	if (response.error) {
		const existing = await getDomainResponse(domain);
		if (existing?.error) {
			throw new FatalError(response.error.message ?? "Could not add domain");
		}
	}
	return checkDomainStatus(domain);
}

async function removeOrganizationDomainFromVercel(domain: string) {
	"use step";

	const response = await fetch(
		`https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${domain.toLowerCase()}?teamId=${process.env.VERCEL_TEAM_ID}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
			},
		},
	);
	if (!response.ok && response.status !== 404) {
		throw new Error(`Domain removal returned HTTP ${response.status}`);
	}
}

async function verifyOrganizationDomainStatus(domain: string) {
	"use step";

	return checkDomainStatus(domain);
}

async function finishOrganizationDomain(
	operationId: string,
	payload: OrganizationOperationPayload,
	result: { domain: string | null; verified: boolean },
) {
	"use step";
	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);

	await db().transaction(async (tx) => {
		const [organization] = await tx
			.select({ customDomain: Db.organizations.customDomain })
			.from(Db.organizations)
			.where(eq(Db.organizations.id, organizationId))
			.limit(1)
			.for("update");
		if (!organization) throw new FatalError("Organization not found");
		if (result.domain) {
			const [conflict] = await tx
				.select({ id: Db.organizations.id })
				.from(Db.organizations)
				.where(
					and(
						eq(Db.organizations.customDomain, result.domain),
						ne(Db.organizations.id, organizationId),
					),
				)
				.limit(1);
			if (conflict) throw new FatalError("Domain is already in use");
		} else if (
			payload.domain &&
			organization.customDomain &&
			organization.customDomain !== payload.domain
		) {
			throw new FatalError("Organization domain changed during removal");
		}
		const now = new Date();
		await tx
			.update(Db.organizations)
			.set({
				customDomain: result.domain,
				domainVerified: result.verified ? now : null,
				updatedAt: now,
			})
			.where(eq(Db.organizations.id, organizationId));
		await tx
			.update(Db.agentApiOperations)
			.set({
				state: "succeeded",
				result,
				updatedAt: now,
				completedAt: now,
			})
			.where(eq(Db.agentApiOperations.id, operationId));
	});
}

async function updateOrganizationDomain(
	operationId: string,
	kind:
		| "set_organization_domain"
		| "remove_organization_domain"
		| "verify_organization_domain",
	payload: OrganizationOperationPayload,
) {
	const context = await getOrganizationDomainContext(operationId, payload);
	if (kind === "set_organization_domain") {
		if (!payload.domain) throw new FatalError("Organization domain is missing");
		if (!isAiGenerationEnabledForUser(context)) {
			throw new FatalError("Cap Pro is required for custom domains");
		}
		const status = await addOrganizationDomain(payload.domain);
		await finishOrganizationDomain(operationId, payload, {
			domain: payload.domain,
			verified: status.verified,
		});
		return;
	}
	const domain = context.customDomain;
	if (!domain) {
		await finishOrganizationDomain(operationId, payload, {
			domain: null,
			verified: false,
		});
		return;
	}
	if (kind === "remove_organization_domain") {
		await removeOrganizationDomainFromVercel(domain);
		await finishOrganizationDomain(
			operationId,
			{ ...payload, domain },
			{ domain: null, verified: false },
		);
		return;
	}
	const status = await verifyOrganizationDomainStatus(domain);
	await finishOrganizationDomain(operationId, payload, {
		domain,
		verified: status.verified,
	});
}

async function failOperation(operationId: string, error: unknown) {
	"use step";

	const now = new Date();
	const message =
		error instanceof Error ? error.message : "Agent operation failed";
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "failed",
			errorCode: "OPERATION_FAILED",
			errorMessage: message.slice(0, 2_000),
			updatedAt: now,
			completedAt: now,
		})
		.where(eq(Db.agentApiOperations.id, operationId));
}

export async function agentCapOperationWorkflow(input: {
	operationId: string;
}) {
	"use workflow";

	try {
		const operation = await claimOperation(input.operationId);
		if (!operation) return;
		if (operation.kind === "duplicate_cap") {
			const payload = operation.payload as OperationPayload;
			await copyCapObjects(payload);
			await createDuplicate(input.operationId, payload);
			return;
		}
		if (operation.kind === "delete_cap") {
			const payload = operation.payload as OperationPayload;
			await deleteCapObjects(payload);
			await deleteCapDatabase(input.operationId, payload);
			return;
		}
		if (operation.kind === "import_loom") {
			throw new FatalError("Loom imports use the Loom import workflow");
		}
		if (operation.kind === "transfer_org_content") {
			throw new FatalError(
				"Content transfers use the content transfer workflow",
			);
		}
		const payload = operation.payload as OrganizationOperationPayload;
		if (operation.kind === "delete_organization") {
			await deleteOrganization(input.operationId, payload);
			return;
		}
		await updateOrganizationDomain(input.operationId, operation.kind, payload);
	} catch (error) {
		await failOperation(input.operationId, error);
		throw error;
	}
}
