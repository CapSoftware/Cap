import "server-only";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	loomMigrationRequests,
	organizations,
	users,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import type { Organisation, User } from "@cap/web-domain";
import {
	and,
	asc,
	desc,
	eq,
	isNotNull,
	isNull,
	lte,
	ne,
	or,
} from "drizzle-orm";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import type { LoomMigrationStatus } from "./loom-migration-state";

type MigrationRecord = typeof loomMigrationRequests.$inferSelect;
const IMPORT_LEASE_MS = 60 * 60 * 1000;

export type LoomMigrationView = {
	id: string;
	organizationId: Organisation.OrganisationId;
	status: LoomMigrationStatus;
	workspaceName: string | null;
	customerNote: string | null;
	customerReply: string | null;
	invitedAt: string | null;
	capMessage: string | null;
	expectedVideoCount: number | null;
	importedVideoCount: number;
	queuedVideoCount: number;
	activeImportCount: number;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type OperatorLoomMigrationView = LoomMigrationView & {
	organizationName: string;
	requestedByEmail: string;
};

export function migrationToView(record: MigrationRecord): LoomMigrationView {
	return {
		id: record.id,
		organizationId: record.organizationId,
		status: record.status,
		workspaceName: record.workspaceName,
		customerNote: record.customerNote,
		customerReply: record.customerReply,
		invitedAt: record.invitedAt?.toISOString() ?? null,
		capMessage: record.capMessage,
		expectedVideoCount: record.expectedVideoCount,
		importedVideoCount: record.importedVideoCount,
		queuedVideoCount: record.queuedVideoCount,
		activeImportCount:
			record.activeImportLeaseUntil &&
			record.activeImportLeaseUntil.getTime() <= Date.now()
				? 0
				: record.activeImportCount,
		completedAt: record.completedAt?.toISOString() ?? null,
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};
}

export async function requireCustomerMigrationAccess(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, organizationId);
	return user;
}

export async function requireProCustomerMigrationAccess(
	organizationId: Organisation.OrganisationId,
) {
	const user = await requireCustomerMigrationAccess(organizationId);
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) {
		throw new Error("Concierge migration is available on Cap Cloud.");
	}
	if (!(await isOrganizationOwnerPro(organizationId))) {
		throw new Error("Concierge Loom migration requires Cap Pro.");
	}
	return user;
}

export async function requireMigrationOperator() {
	const user = await getCurrentUser();
	if (
		!buildEnv.NEXT_PUBLIC_IS_CAP ||
		!user ||
		user.email.toLowerCase() !== MESSENGER_ADMIN_EMAIL
	) {
		throw new Error("Unauthorized");
	}
	return user;
}

function affectedRows(result: unknown) {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export async function reserveConciergeImport(
	requestId: string,
	operatorId: User.UserId,
) {
	const token = randomUUID();
	const now = new Date();
	const result = await db()
		.update(loomMigrationRequests)
		.set({
			activeImportCount: 1,
			activeImportLeaseToken: token,
			activeImportLeaseUntil: new Date(now.getTime() + IMPORT_LEASE_MS),
			status: "in_progress",
			lastOperatorUserId: operatorId,
			lastOperatorAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				isNotNull(loomMigrationRequests.activeOrganizationId),
				or(
					eq(loomMigrationRequests.activeImportCount, 0),
					lte(loomMigrationRequests.activeImportLeaseUntil, now),
				),
			),
		);
	if (affectedRows(result) === 0) {
		throw new Error(
			"The migration request changed or another import is starting. Refresh and try again.",
		);
	}
	return token;
}

export async function releaseConciergeImport(requestId: string, token: string) {
	await db()
		.update(loomMigrationRequests)
		.set({
			activeImportCount: 0,
			activeImportLeaseToken: null,
			activeImportLeaseUntil: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				eq(loomMigrationRequests.activeImportLeaseToken, token),
			),
		);
}

export async function getCustomerMigrationRequests(
	organizationId: Organisation.OrganisationId,
) {
	await requireCustomerMigrationAccess(organizationId);
	const requests = await db()
		.select()
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.organizationId, organizationId))
		.orderBy(desc(loomMigrationRequests.createdAt))
		.limit(20);
	return requests.map(migrationToView);
}

export async function getOperatorMigrationQueue() {
	await requireMigrationOperator();
	const queue = await db()
		.select({
			request: loomMigrationRequests,
			organizationName: organizations.name,
			requestedByEmail: users.email,
		})
		.from(loomMigrationRequests)
		.innerJoin(
			organizations,
			eq(organizations.id, loomMigrationRequests.organizationId),
		)
		.innerJoin(users, eq(users.id, loomMigrationRequests.requestedByUserId))
		.where(
			and(
				ne(loomMigrationRequests.status, "completed"),
				isNull(organizations.tombstoneAt),
			),
		)
		.orderBy(asc(loomMigrationRequests.createdAt));
	return queue.map((item) => ({
		...migrationToView(item.request),
		organizationName: item.organizationName,
		requestedByEmail: item.requestedByEmail,
	}));
}
