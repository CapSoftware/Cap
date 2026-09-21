"use server";

import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import {
	LoomMigrationRequestEmail,
	LoomMigrationStatusEmail,
} from "@cap/database/emails/loom-migration";
import { nanoId } from "@cap/database/helpers";
import {
	loomMigrationImports,
	loomMigrationRequests,
	organizations,
	users,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	getCustomerMigrationRequests,
	getOperatorMigrationQueue,
	requireCustomerMigrationAccess,
	requireMigrationOperator,
	requireProCustomerMigrationAccess,
} from "@/lib/loom-concierge";
import {
	LOOM_MIGRATION_STATUS_LABELS,
	type LoomMigrationStatus,
	normalizeMigrationText,
	validateOperatorMigrationUpdate,
} from "@/lib/loom-migration-state";
import { isOrganizationOwnerPro } from "@/lib/org-pro";

const SUPPORT_EMAIL = "hello@cap.so";

function affectedRows(result: unknown) {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function refreshMigrationPages() {
	revalidatePath("/dashboard/migrations/loom");
	revalidatePath("/dashboard/admin/loom-migrations");
}

async function findMigration(requestId: string) {
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId)) {
		throw new Error("Invalid migration request.");
	}
	const [request] = await db()
		.select()
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.id, requestId))
		.limit(1);
	if (!request) throw new Error("Migration request not found.");
	return request;
}

export async function getLoomMigrationDashboard(
	organizationId: Organisation.OrganisationId,
) {
	await requireCustomerMigrationAccess(organizationId);
	const [isPro, requests] = await Promise.all([
		isOrganizationOwnerPro(organizationId),
		getCustomerMigrationRequests(organizationId),
	]);
	return { isPro, requests };
}

export async function requestLoomMigration({
	organizationId,
	workspaceName,
	note,
}: {
	organizationId: Organisation.OrganisationId;
	workspaceName: string;
	note: string;
}) {
	const user = await requireProCustomerMigrationAccess(organizationId);
	const normalizedWorkspaceName = normalizeMigrationText(
		workspaceName,
		"Workspace name",
		255,
	);
	const normalizedNote = normalizeMigrationText(note, "Note", 2000);
	const [existing] = await db()
		.select({ id: loomMigrationRequests.id })
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.activeOrganizationId, organizationId))
		.limit(1);
	if (existing) return { id: existing.id, alreadyRequested: true };

	const id = nanoId();
	try {
		await db()
			.insert(loomMigrationRequests)
			.values({
				id,
				organizationId,
				activeOrganizationId: organizationId,
				requestedByUserId: user.id,
				workspaceName: normalizedWorkspaceName || null,
				customerNote: normalizedNote || null,
			});
	} catch (error) {
		const [racedRequest] = await db()
			.select({ id: loomMigrationRequests.id })
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.activeOrganizationId, organizationId))
			.limit(1);
		if (racedRequest) {
			return { id: racedRequest.id, alreadyRequested: true };
		}
		throw error;
	}

	const [organization] = await db()
		.select({ name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	try {
		const delivery = await sendEmail({
			email: SUPPORT_EMAIL,
			subject: `New Loom migration request: ${organization?.name ?? "Cap workspace"}`,
			react: (
				<LoomMigrationRequestEmail
					organizationName={organization?.name ?? "Cap workspace"}
					requesterEmail={user.email}
					workspaceName={normalizedWorkspaceName || null}
					queueUrl={`${serverEnv().WEB_URL}/dashboard/admin/loom-migrations`}
				/>
			),
			idempotencyKey: `loom-migration-request-${id}`,
		});
		if (delivery?.error) {
			console.error(
				"Failed to send Loom migration request notice",
				delivery.error,
			);
		}
	} catch (error) {
		console.error("Failed to send Loom migration request notice", error);
	}

	refreshMigrationPages();
	return { id, alreadyRequested: false };
}

export async function confirmLoomMigrationInvite(requestId: string) {
	const request = await findMigration(requestId);
	await requireCustomerMigrationAccess(request.organizationId);
	if (request.status === "completed") {
		throw new Error("This migration is already complete.");
	}
	if (request.invitedAt) return;
	const result = await db()
		.update(loomMigrationRequests)
		.set({ invitedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				isNotNull(loomMigrationRequests.activeOrganizationId),
			),
		);
	if (affectedRows(result) === 0) {
		throw new Error("The migration request changed. Refresh and try again.");
	}
	refreshMigrationPages();
}

export async function answerLoomMigrationQuestion({
	requestId,
	answer,
}: {
	requestId: string;
	answer: string;
}) {
	const request = await findMigration(requestId);
	await requireCustomerMigrationAccess(request.organizationId);
	const normalizedAnswer = normalizeMigrationText(answer, "Answer", 2000);
	if (!normalizedAnswer)
		throw new Error("Enter the information Cap asked for.");
	const result = await db()
		.update(loomMigrationRequests)
		.set({
			customerReply: normalizedAnswer,
			status: "pending",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				eq(loomMigrationRequests.status, "needs_information"),
			),
		);
	if (affectedRows(result) === 0) {
		throw new Error("The migration request changed. Refresh and try again.");
	}
	refreshMigrationPages();
}

export async function getLoomMigrationOperatorQueue() {
	return getOperatorMigrationQueue();
}

export async function updateLoomMigrationStatus({
	requestId,
	nextStatus,
	message,
	verified,
	expectedVideoCount,
	importedVideoCount,
}: {
	requestId: string;
	nextStatus: LoomMigrationStatus;
	message: string;
	verified: boolean;
	expectedVideoCount: number | null;
	importedVideoCount: number;
}) {
	const operator = await requireMigrationOperator();
	const request = await findMigration(requestId);
	const normalizedMessage = validateOperatorMigrationUpdate({
		currentStatus: request.status,
		nextStatus,
		message,
		verified,
		expectedVideoCount,
		importedVideoCount,
	});
	if (
		nextStatus === request.status &&
		(normalizedMessage || null) === request.capMessage &&
		expectedVideoCount === request.expectedVideoCount &&
		importedVideoCount === request.importedVideoCount
	) {
		return;
	}
	if (nextStatus === "completed") {
		const [unfinishedImport] = await db()
			.select({ videoId: videoUploads.videoId })
			.from(loomMigrationImports)
			.innerJoin(
				videoUploads,
				eq(videoUploads.videoId, loomMigrationImports.videoId),
			)
			.where(
				and(
					eq(loomMigrationImports.requestId, requestId),
					inArray(videoUploads.phase, [
						"uploading",
						"processing",
						"generating_thumbnail",
						"error",
					]),
				),
			)
			.limit(1);
		if (unfinishedImport) {
			throw new Error(
				"Loom imports are still processing or have errors. Resolve them before completion.",
			);
		}
	}
	const [organization] = await db()
		.select({ name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, request.organizationId))
		.limit(1);
	const result = await db()
		.update(loomMigrationRequests)
		.set({
			status: nextStatus,
			capMessage: normalizedMessage || null,
			expectedVideoCount,
			importedVideoCount,
			activeOrganizationId:
				nextStatus === "completed" ? null : request.organizationId,
			completedAt: nextStatus === "completed" ? new Date() : null,
			lastOperatorUserId: operator.id,
			lastOperatorAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				eq(loomMigrationRequests.status, request.status),
				isNotNull(loomMigrationRequests.activeOrganizationId),
				nextStatus === "completed"
					? eq(loomMigrationRequests.activeImportCount, 0)
					: undefined,
			),
		);
	if (affectedRows(result) === 0) {
		throw new Error(
			"The migration request changed or imports are starting. Refresh and try again.",
		);
	}

	const [requester] = await db()
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, request.requestedByUserId))
		.limit(1);
	if (requester) {
		try {
			const delivery = await sendEmail({
				email: requester.email,
				subject: `Loom migration: ${LOOM_MIGRATION_STATUS_LABELS[nextStatus]}`,
				react: (
					<LoomMigrationStatusEmail
						organizationName={organization?.name ?? "your Cap workspace"}
						statusLabel={LOOM_MIGRATION_STATUS_LABELS[nextStatus]}
						message={normalizedMessage || null}
						dashboardUrl={`${serverEnv().WEB_URL}/dashboard/migrations/loom`}
					/>
				),
				replyTo: SUPPORT_EMAIL,
				idempotencyKey: `loom-migration-status-${requestId}-${Date.now()}`,
			});
			if (delivery?.error) {
				console.error(
					"Failed to send Loom migration status notice",
					delivery.error,
				);
			}
		} catch (error) {
			console.error("Failed to send Loom migration status notice", error);
		}
	}
	refreshMigrationPages();
}
