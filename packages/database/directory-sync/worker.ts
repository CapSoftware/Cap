import { randomUUID } from "node:crypto";
import type { Event, WorkOS } from "@workos-inc/node";
import { and, asc, eq, isNull, lt, lte, ne, or } from "drizzle-orm";
import { getWorkOS, normalizeSsoDomain } from "../auth/sso";
import { db } from "../index";
import {
	directoryUsers,
	organizationDirectorySync,
	organizations,
} from "../schema";
import {
	applyDirectoryUser,
	type DirectoryConfiguration,
	type DirectoryTransaction,
	revokeDirectoryMembership,
} from "./users";

type DirectoryDatabase = Pick<
	ReturnType<typeof db>,
	"select" | "update" | "transaction"
>;

const eventNames = [
	"dsync.activated",
	"dsync.deactivated",
	"dsync.deleted",
	"dsync.user.created",
	"dsync.user.updated",
	"dsync.user.deleted",
] satisfies Event["event"][];

export function directorySyncEntitled(organizationId: string) {
	return (
		process.env.WORKOS_DIRECTORY_SYNC_ENABLED === "true" &&
		(process.env.WORKOS_DIRECTORY_SYNC_ORGANIZATION_IDS ?? "")
			.split(",")
			.some((id) => id.trim() === organizationId)
	);
}

async function claimDirectory(database: DirectoryDatabase) {
	return database.transaction(async (tx) => {
		const now = new Date();
		const [configuration] = await tx
			.select()
			.from(organizationDirectorySync)
			.where(
				and(
					lte(organizationDirectorySync.nextAttemptAt, now),
					or(
						isNull(organizationDirectorySync.leaseUntil),
						lt(organizationDirectorySync.leaseUntil, now),
					),
				),
			)
			.orderBy(asc(organizationDirectorySync.nextAttemptAt))
			.limit(1)
			.for("update", { skipLocked: true });
		if (!configuration) return null;
		const leaseToken = randomUUID();
		await tx
			.update(organizationDirectorySync)
			.set({ leaseToken, leaseUntil: new Date(Date.now() + 90_000) })
			.where(
				eq(
					organizationDirectorySync.organizationId,
					configuration.organizationId,
				),
			);
		return { ...configuration, leaseToken };
	});
}

async function withDirectoryLease<T>(
	database: DirectoryDatabase,
	claimed: DirectoryConfiguration,
	operation: (
		tx: DirectoryTransaction,
		current: DirectoryConfiguration,
	) => Promise<T>,
) {
	return database.transaction(async (tx) => {
		const [organization] = await tx
			.select()
			.from(organizations)
			.where(eq(organizations.id, claimed.organizationId))
			.for("update");
		const [current] = await tx
			.select()
			.from(organizationDirectorySync)
			.where(
				eq(organizationDirectorySync.organizationId, claimed.organizationId),
			)
			.for("update");
		if (
			!current ||
			!claimed.leaseToken ||
			current.leaseToken !== claimed.leaseToken ||
			!current.leaseUntil ||
			current.leaseUntil.getTime() <= Date.now()
		)
			throw new Error("directory_lease_lost");
		if (
			!organization ||
			organization.tombstoneAt ||
			organization.workosOrganizationId !== current.workosOrganizationId
		)
			throw new Error("organization_mapping_changed");
		await tx
			.update(organizationDirectorySync)
			.set({ leaseUntil: new Date(Date.now() + 90_000) })
			.where(
				eq(organizationDirectorySync.organizationId, current.organizationId),
			);
		return operation(tx, current);
	});
}

const isNotFound = (error: unknown) =>
	Boolean(
		error &&
			typeof error === "object" &&
			"status" in error &&
			error.status === 404,
	);

async function updateConfiguration(
	database: DirectoryDatabase,
	configuration: DirectoryConfiguration,
	fields: Partial<typeof organizationDirectorySync.$inferInsert>,
) {
	await withDirectoryLease(database, configuration, async (tx) => {
		await tx
			.update(organizationDirectorySync)
			.set(fields)
			.where(
				eq(
					organizationDirectorySync.organizationId,
					configuration.organizationId,
				),
			);
	});
	Object.assign(configuration, fields);
}

async function retireDirectoryUsers(
	database: DirectoryDatabase,
	configuration: DirectoryConfiguration,
	deadline: number,
) {
	while (Date.now() < deadline) {
		const [user] = await database
			.select()
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.organizationId, configuration.organizationId),
					ne(directoryUsers.state, "inactive"),
				),
			)
			.limit(1);
		if (!user) return;
		await withDirectoryLease(database, configuration, async (tx, current) => {
			await tx
				.update(directoryUsers)
				.set({ state: "inactive" })
				.where(eq(directoryUsers.id, user.id));
			if (user.userId)
				await revokeDirectoryMembership(tx, current, user.userId);
		});
	}
}

async function reconcileDirectory(
	database: DirectoryDatabase,
	workos: WorkOS,
	configuration: DirectoryConfiguration,
	domains: string[],
	deadline: number,
) {
	if (!configuration.directoryId) return;
	if (!configuration.reconcileStartedAt) {
		await updateConfiguration(database, configuration, {
			reconcileStartedAt: new Date(),
			reconcileCursor: null,
			reconcileListingComplete: false,
		});
	}
	while (!configuration.reconcileListingComplete && Date.now() < deadline) {
		const page = await workos.directorySync.listUsers({
			directory: configuration.directoryId,
			limit: 25,
			after: configuration.reconcileCursor ?? undefined,
		});
		for (const user of page.data) {
			await withDirectoryLease(database, configuration, async (tx, current) => {
				await applyDirectoryUser(tx, current, user, domains);
				await tx
					.update(organizationDirectorySync)
					.set({ reconcileCursor: user.id })
					.where(
						eq(
							organizationDirectorySync.organizationId,
							current.organizationId,
						),
					);
			});
			configuration.reconcileCursor = user.id;
			if (Date.now() >= deadline) return;
		}
		await updateConfiguration(database, configuration, {
			reconcileCursor: page.listMetadata.after,
			reconcileListingComplete: !page.listMetadata.after,
		});
	}
	while (
		configuration.reconcileListingComplete &&
		configuration.reconcileStartedAt &&
		Date.now() < deadline
	) {
		const [missing] = await database
			.select()
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.directoryId, configuration.directoryId),
					ne(directoryUsers.state, "inactive"),
					lt(directoryUsers.lastSeenAt, configuration.reconcileStartedAt),
				),
			)
			.limit(1);
		if (!missing) {
			await updateConfiguration(database, configuration, {
				lastReconciledAt: new Date(),
				reconcileStartedAt: null,
				reconcileCursor: null,
				reconcileListingComplete: false,
			});
			return;
		}
		try {
			const remote = await workos.directorySync.getUser(
				missing.directoryUserId,
			);
			await withDirectoryLease(database, configuration, (tx, current) =>
				applyDirectoryUser(tx, current, remote, domains),
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			await withDirectoryLease(database, configuration, async (tx, current) => {
				await tx
					.update(directoryUsers)
					.set({
						state: "inactive",
						lastSeenAt: new Date(),
					})
					.where(eq(directoryUsers.id, missing.id));
				if (missing.userId)
					await revokeDirectoryMembership(tx, current, missing.userId);
			});
		}
	}
}

async function consumeDirectoryEvents(
	database: DirectoryDatabase,
	workos: WorkOS,
	configuration: DirectoryConfiguration,
	domains: string[],
	deadline: number,
) {
	if (
		configuration.eventCursor &&
		configuration.eventStartedAt.getTime() < Date.now() - 29 * 86_400_000
	) {
		await updateConfiguration(database, configuration, {
			eventCursor: null,
			eventStartedAt: new Date(Date.now() - 29 * 86_400_000),
			lastReconciledAt: null,
		});
	}
	while (Date.now() < deadline) {
		const page = await workos.events.listEvents({
			events: eventNames,
			organizationId: configuration.workosOrganizationId,
			after: configuration.eventCursor ?? undefined,
			rangeStart: configuration.eventCursor
				? undefined
				: new Date(
						Math.max(
							configuration.eventStartedAt.getTime(),
							Date.now() - 29 * 86_400_000,
						),
					).toISOString(),
			limit: 25,
		});
		if (!page.data.length) return;
		for (const event of page.data) {
			await withDirectoryLease(database, configuration, async (tx, current) => {
				if (
					event.event === "dsync.user.created" ||
					event.event === "dsync.user.updated" ||
					event.event === "dsync.user.deleted"
				) {
					if (event.data.organizationId !== current.workosOrganizationId)
						throw new Error("directory_event_tenant_mismatch");
					if (event.data.directoryId === current.directoryId) {
						await applyDirectoryUser(
							tx,
							current,
							{
								...event.data,
								state:
									event.event === "dsync.user.deleted"
										? "inactive"
										: event.data.state,
							},
							domains,
							new Date(
								event.event === "dsync.user.deleted"
									? Math.max(
											Date.parse(event.createdAt),
											Date.parse(event.data.updatedAt),
										)
									: Date.parse(event.data.updatedAt),
							),
						);
					}
				}
				await tx
					.update(organizationDirectorySync)
					.set({
						eventCursor: event.id,
						eventStartedAt: new Date(event.createdAt),
					})
					.where(
						eq(
							organizationDirectorySync.organizationId,
							current.organizationId,
						),
					);
			});
			configuration.eventCursor = event.id;
			configuration.eventStartedAt = new Date(event.createdAt);
			if (Date.now() >= deadline) return;
		}
		if (page.data.length < 25) return;
	}
}

export async function syncClaimedDirectory(
	database: DirectoryDatabase,
	workos: WorkOS,
	configuration: DirectoryConfiguration,
	deadline: number,
) {
	if (!configuration.directoryId) {
		const directories = await workos.directorySync.listDirectories({
			organizationId: configuration.workosOrganizationId,
			limit: 2,
		});
		if (!directories.data.length) return;
		if (directories.data.length !== 1 || directories.listMetadata.after)
			throw new Error("multiple_directories_require_review");
		const directory = directories.data[0];
		if (
			!directory ||
			directory.organizationId !== configuration.workosOrganizationId
		)
			throw new Error("directory_identity_mismatch");
		await updateConfiguration(database, configuration, {
			directoryId: directory.id,
		});
	}
	let directory: Awaited<ReturnType<WorkOS["directorySync"]["getDirectory"]>>;
	if (!configuration.directoryId) throw new Error("directory_not_connected");
	try {
		directory = await workos.directorySync.getDirectory(
			configuration.directoryId,
		);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		await updateConfiguration(database, configuration, { state: "deleted" });
		await retireDirectoryUsers(database, configuration, deadline);
		return;
	}
	if (
		directory.organizationId !== configuration.workosOrganizationId ||
		directory.id !== configuration.directoryId
	)
		throw new Error("directory_identity_mismatch");
	if (directory.state !== "active") {
		await updateConfiguration(database, configuration, { state: "inactive" });
		return;
	}
	const organization = await workos.organizations.getOrganization(
		configuration.workosOrganizationId,
	);
	if (organization.id !== configuration.workosOrganizationId)
		throw new Error("directory_identity_mismatch");
	const domains = organization.domains
		.filter((domain) => domain.state === "verified")
		.map((domain) => normalizeSsoDomain(domain.domain))
		.filter((domain): domain is string => Boolean(domain));
	await updateConfiguration(database, configuration, { state: "active" });
	const needsReconciliation = Boolean(
		configuration.reconcileStartedAt ||
			!configuration.lastReconciledAt ||
			configuration.lastReconciledAt.getTime() < Date.now() - 3_600_000,
	);
	await consumeDirectoryEvents(
		database,
		workos,
		configuration,
		domains,
		needsReconciliation
			? Date.now() + Math.max(0, (deadline - Date.now()) / 2)
			: deadline,
	);
	if (
		configuration.reconcileStartedAt ||
		!configuration.lastReconciledAt ||
		configuration.lastReconciledAt.getTime() < Date.now() - 3_600_000
	) {
		await reconcileDirectory(
			database,
			workos,
			configuration,
			domains,
			deadline,
		);
	}
}

export async function runDirectorySync() {
	if (process.env.WORKOS_DIRECTORY_SYNC_ENABLED !== "true")
		return { enabled: false, processed: 0, failed: 0 };
	const database = db();
	const workos = getWorkOS();
	const deadline = Date.now() + 45_000;
	let processed = 0;
	let failed = 0;
	while (Date.now() < deadline) {
		const configuration = await claimDirectory(database);
		if (!configuration) break;
		let lastError: string | null = null;
		try {
			await syncClaimedDirectory(
				database,
				workos,
				configuration,
				Math.min(deadline, Date.now() + 15_000),
			);
			processed++;
		} catch (error) {
			lastError =
				error instanceof Error && /^[a-z_]+$/.test(error.message)
					? error.message
					: "directory_sync_failed";
			failed++;
		}
		await database
			.update(organizationDirectorySync)
			.set({
				leaseToken: null,
				leaseUntil: null,
				lastError,
				...(lastError === "organization_mapping_changed"
					? { state: "inactive" }
					: {}),
				nextAttemptAt: new Date(Date.now() + 60_000),
				...(lastError ? {} : { lastSyncedAt: new Date() }),
			})
			.where(
				and(
					eq(
						organizationDirectorySync.organizationId,
						configuration.organizationId,
					),
					eq(organizationDirectorySync.leaseToken, configuration.leaseToken),
				),
			);
	}
	return { enabled: true, processed, failed };
}
