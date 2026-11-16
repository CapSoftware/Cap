import { db } from "@cap/database";
import {
	getSsoEmailDomain,
	getWorkOS,
	normalizeSsoDomain,
} from "@cap/database/auth/sso";
import { nanoId } from "@cap/database/helpers";
import { enqueueLoopsSync } from "@cap/database/loops/queue";
import {
	agentApiKeys,
	authApiKeys,
	directoryUsers,
	mcpOAuthTokens,
	organizationDirectorySync,
	organizationMembers,
	organizationSso,
	organizations,
	sessions,
	users,
} from "@cap/database/schema";
import { hasSsoAccess } from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { deleteOrganizationMembership } from "@/lib/organization-member-removal";
import { hasScimSubscription } from "@/lib/sso/scim-billing";

const LEASE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 2 * 60_000;
const SNAPSHOT_RETRY_DELAY_MS = 60 * 60_000;
const FULL_SNAPSHOT_BUDGET_MS = 200_000;
const MIN_ORGANIZATION_BUDGET_MS = 60_000;
const REFRESH_INTERVAL_MS = 15 * 60_000;
const REMOVAL_APPROVAL_MS = 60 * 60_000;
const MASS_REMOVAL_MIN = 10;
const MASS_REMOVAL_RATIO = 0.2;
const MAX_PAGES = 1000;
const PAGE_DELAY_MS = 250;

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

type DirectoryLink = typeof directoryUsers.$inferSelect;

type RemoteDirectoryUser = {
	id: string;
	directoryId: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	active: boolean;
};

export type DirectorySyncResult = {
	status: "busy" | "inactive" | "no_directory" | "synced" | "partial";
	added: number;
	removed: number;
	held: number;
	skipped: number;
};

class DeadlineReached extends Error {}

class SnapshotTooSlow extends Error {
	constructor() {
		super("The directory could not be read within one sync.");
	}
}

function emptyResult(status: DirectorySyncResult["status"]) {
	return { status, added: 0, removed: 0, held: 0, skipped: 0 };
}

async function collectPages<T>(
	fetchPage: (after: string | undefined) => Promise<{
		data: T[];
		listMetadata: { after?: string | null };
	}>,
	deadline: number,
) {
	const items: T[] = [];
	let after: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		if (Date.now() > deadline) throw new SnapshotTooSlow();
		const result = await fetchPage(after);
		items.push(...result.data);
		if (!result.listMetadata.after) return items;
		after = result.listMetadata.after;
		await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
	}
	throw new Error("The directory is too large to sync.");
}

function directoryUserEmail(user: {
	email: string | null;
	emails?: { value?: string; primary?: boolean }[];
}) {
	const email =
		user.email ??
		user.emails?.find((entry) => entry.primary)?.value ??
		user.emails?.[0]?.value ??
		null;
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length <= 255 ? normalized : null;
}

function displayName(value: string | null, email: string) {
	const name = value?.trim();
	if (name) return name.slice(0, 255);
	return (
		email
			.split("@")[0]
			?.replace(/[._-]+/g, " ")
			.trim() || email
	);
}

export async function requestDirectorySync(
	organizationId: Organisation.OrganisationId,
) {
	const now = new Date();
	await db()
		.insert(organizationDirectorySync)
		.values({ organizationId, requestedAt: now })
		.onDuplicateKeyUpdate({ set: { requestedAt: now } });
}

async function lockOrganization(
	tx: Transaction,
	organizationId: Organisation.OrganisationId,
	workosOrganizationId: string,
) {
	const [organization] = await tx
		.select({
			ownerId: organizations.ownerId,
			tombstoneAt: organizations.tombstoneAt,
			workosOrganizationId: organizations.workosOrganizationId,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.for("update");
	if (
		!organization ||
		organization.tombstoneAt ||
		organization.workosOrganizationId !== workosOrganizationId
	) {
		throw new Error("The organization changed during directory sync.");
	}
	return organization;
}

async function provisionDirectoryUser(
	organizationId: Organisation.OrganisationId,
	workosOrganizationId: string,
	remote: RemoteDirectoryUser & { email: string },
	link: DirectoryLink | undefined,
) {
	return db().transaction(async (tx) => {
		const organization = await lockOrganization(
			tx,
			organizationId,
			workosOrganizationId,
		);
		let user = link
			? (
					await tx
						.select()
						.from(users)
						.where(eq(users.id, link.userId))
						.for("update")
				)[0]
			: undefined;
		if (!user) {
			[user] = await tx
				.select()
				.from(users)
				.where(eq(users.email, remote.email))
				.for("update");
		}
		if (user) {
			const update: Partial<typeof users.$inferInsert> = {};
			if (!user.name) update.name = displayName(remote.firstName, remote.email);
			if (!user.activeOrganizationId)
				update.activeOrganizationId = organizationId;
			if (!user.defaultOrgId) update.defaultOrgId = organizationId;
			if (Object.keys(update).length > 0) {
				await tx.update(users).set(update).where(eq(users.id, user.id));
			}
		} else {
			await tx
				.insert(users)
				.values({
					id: User.UserId.make(nanoId()),
					email: remote.email,
					name: displayName(remote.firstName, remote.email),
					lastName: remote.lastName?.trim().slice(0, 255) || null,
					marketingOrigin: "teammate",
					activeOrganizationId: organizationId,
					defaultOrgId: organizationId,
				})
				.onDuplicateKeyUpdate({ set: { email: remote.email } });
			[user] = await tx
				.select()
				.from(users)
				.where(eq(users.email, remote.email))
				.for("update");
			if (!user) throw new Error("The directory user could not be created.");
		}
		const userId = user.id;
		await tx
			.insert(directoryUsers)
			.values({
				id: remote.id,
				organizationId,
				directoryId: remote.directoryId,
				userId,
				email: remote.email,
				active: true,
			})
			.onDuplicateKeyUpdate({
				set: {
					directoryId: remote.directoryId,
					userId,
					email: remote.email,
					active: true,
				},
			});
		const [member] = await tx
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, organizationId),
					eq(organizationMembers.userId, userId),
				),
			)
			.limit(1)
			.for("update");
		if (!member) {
			await tx.insert(organizationMembers).values({
				id: nanoId(),
				userId,
				organizationId,
				role: organization.ownerId === userId ? "owner" : "member",
				hasProSeat: false,
			});
		}
		await enqueueLoopsSync(tx, userId, !member);
		return userId;
	});
}

async function revokeUserCredentials(tx: Transaction, userId: User.UserId) {
	const now = new Date();
	await tx
		.update(users)
		.set({ authSessionVersion: sql`${users.authSessionVersion} + 1` })
		.where(eq(users.id, userId));
	await tx.delete(sessions).where(eq(sessions.userId, userId));
	await tx.delete(authApiKeys).where(eq(authApiKeys.userId, userId));
	await tx
		.update(agentApiKeys)
		.set({ revokedAt: now })
		.where(
			and(eq(agentApiKeys.userId, userId), isNull(agentApiKeys.revokedAt)),
		);
	await tx
		.update(mcpOAuthTokens)
		.set({ revokedAt: now })
		.where(
			and(eq(mcpOAuthTokens.userId, userId), isNull(mcpOAuthTokens.revokedAt)),
		);
}

async function deprovisionDirectoryUser(
	organizationId: Organisation.OrganisationId,
	workosOrganizationId: string,
	directoryUserId: string,
	activeDirectoryIds: readonly string[],
	verifiedDomains: ReadonlySet<string>,
) {
	return db().transaction(async (tx) => {
		const organization = await lockOrganization(
			tx,
			organizationId,
			workosOrganizationId,
		);
		const [link] = await tx
			.select()
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.id, directoryUserId),
					eq(directoryUsers.organizationId, organizationId),
				),
			)
			.for("update");
		if (!link?.active) return false;
		const [user] = await tx
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(eq(users.id, link.userId))
			.for("update");
		const [otherLink] = await tx
			.select({ id: directoryUsers.id })
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.organizationId, organizationId),
					eq(directoryUsers.userId, link.userId),
					eq(directoryUsers.active, true),
					ne(directoryUsers.id, link.id),
					inArray(directoryUsers.directoryId, [...activeDirectoryIds]),
				),
			)
			.limit(1)
			.for("update");
		const [member] = await tx
			.select({
				id: organizationMembers.id,
				userId: organizationMembers.userId,
				role: organizationMembers.role,
				hasProSeat: organizationMembers.hasProSeat,
			})
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, organizationId),
					eq(organizationMembers.userId, link.userId),
				),
			)
			.limit(1)
			.for("update");
		await tx
			.update(directoryUsers)
			.set({ active: false })
			.where(eq(directoryUsers.id, link.id));
		if (
			otherLink ||
			!user ||
			organization.ownerId === link.userId ||
			member?.role === "owner"
		) {
			return true;
		}
		if (member) {
			await deleteOrganizationMembership(tx, organizationId, {
				...member,
				email: user.email,
			});
			const domain = getSsoEmailDomain(user.email);
			if (domain && verifiedDomains.has(domain)) {
				await revokeUserCredentials(tx, user.id);
			}
		}
		return true;
	});
}

async function reconcileDirectory(
	organizationId: Organisation.OrganisationId,
	approvedRemovals: number,
	deadline: number,
): Promise<DirectorySyncResult> {
	const [record] = await db()
		.select({ organization: organizations, billing: organizationSso })
		.from(organizations)
		.leftJoin(
			organizationSso,
			eq(organizationSso.organizationId, organizations.id),
		)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	const workosOrganizationId = record?.organization.workosOrganizationId;
	if (
		!record ||
		record.organization.tombstoneAt ||
		!workosOrganizationId ||
		!hasSsoAccess(record.billing)
	) {
		return emptyResult("inactive");
	}
	if (!(await hasScimSubscription(organizationId))) {
		return emptyResult("inactive");
	}

	const workos = getWorkOS();
	const [remoteOrganization, directories] = await Promise.all([
		workos.organizations.getOrganization(workosOrganizationId),
		collectPages(
			(after) =>
				workos.directorySync.listDirectories({
					organizationId: workosOrganizationId,
					limit: 100,
					after,
				}),
			deadline,
		),
	]);
	if (
		remoteOrganization.id !== workosOrganizationId ||
		directories.some(
			(directory) => directory.organizationId !== workosOrganizationId,
		)
	) {
		throw new Error("The directory organization could not be verified.");
	}
	const activeDirectories = directories.filter(
		(directory) => directory.state === "active",
	);
	if (activeDirectories.length === 0) return emptyResult("no_directory");

	const verifiedDomains = new Set(
		remoteOrganization.domains
			.filter((entry) => entry.state === "verified")
			.map((entry) => normalizeSsoDomain(entry.domain))
			.filter((domain): domain is string => Boolean(domain)),
	);
	const remoteUsers = new Map<string, RemoteDirectoryUser>();
	for (const directory of activeDirectories) {
		const directoryUsersPage = await collectPages(
			(after) =>
				workos.directorySync.listUsers({
					directory: directory.id,
					limit: 100,
					after,
				}),
			deadline,
		);
		for (const user of directoryUsersPage) {
			if (user.directoryId !== directory.id) {
				throw new Error("The directory user list could not be verified.");
			}
			remoteUsers.set(user.id, {
				id: user.id,
				directoryId: directory.id,
				email: directoryUserEmail(user),
				firstName: user.firstName,
				lastName: user.lastName,
				active: user.state === "active",
			});
		}
	}

	const links = await db()
		.select()
		.from(directoryUsers)
		.where(eq(directoryUsers.organizationId, organizationId));
	const linksById = new Map(links.map((link) => [link.id, link]));
	const result = emptyResult("synced");
	const provisionedUserIds = new Set<User.UserId>();

	for (const remote of remoteUsers.values()) {
		if (!remote.active) continue;
		const link = linksById.get(remote.id);
		const email = remote.email;
		if (link?.active) {
			if (email && link.email !== email) {
				await db()
					.update(directoryUsers)
					.set({ email })
					.where(eq(directoryUsers.id, link.id));
			}
			continue;
		}
		const domain = email ? getSsoEmailDomain(email) : null;
		if (!email || !domain || !verifiedDomains.has(domain)) {
			result.skipped++;
			continue;
		}
		if (Date.now() > deadline) throw new DeadlineReached();
		provisionedUserIds.add(
			await provisionDirectoryUser(
				organizationId,
				workosOrganizationId,
				{ ...remote, email },
				link,
			),
		);
		result.added++;
	}

	const activeDirectoryIds = new Set(
		activeDirectories.map((directory) => directory.id),
	);
	const managedLinks = links.filter(
		(link) => link.active && activeDirectoryIds.has(link.directoryId),
	);
	const removals = managedLinks.filter(
		(link) => !remoteUsers.get(link.id)?.active,
	);
	const ownerId = record.organization.ownerId;
	const removalIds = new Set(removals.map((link) => link.id));
	const retainedUserIds = new Set([
		...provisionedUserIds,
		...managedLinks
			.filter((link) => !removalIds.has(link.id))
			.map((link) => link.userId),
	]);
	const leavingUserIds = new Set(
		removals
			.map((link) => link.userId)
			.filter((userId) => userId !== ownerId && !retainedUserIds.has(userId)),
	);
	const managedUserIds = new Set(
		managedLinks
			.map((link) => link.userId)
			.filter((userId) => userId !== ownerId),
	);
	if (
		leavingUserIds.size >= MASS_REMOVAL_MIN &&
		leavingUserIds.size > managedUserIds.size * MASS_REMOVAL_RATIO &&
		leavingUserIds.size > approvedRemovals
	) {
		result.held = leavingUserIds.size;
		console.error("Directory sync held a large removal", {
			organizationId,
			removals: leavingUserIds.size,
			managed: managedUserIds.size,
		});
		return result;
	}
	for (const link of removals) {
		if (Date.now() > deadline) throw new DeadlineReached();
		if (
			await deprovisionDirectoryUser(
				organizationId,
				workosOrganizationId,
				link.id,
				[...activeDirectoryIds],
				verifiedDomains,
			)
		) {
			result.removed++;
		}
	}
	return result;
}

export async function syncOrganizationDirectory(
	organizationId: Organisation.OrganisationId,
	deadline: number,
): Promise<DirectorySyncResult> {
	const startedAt = new Date();
	const [claim] = await db()
		.update(organizationDirectorySync)
		.set({ leaseExpiresAt: new Date(startedAt.getTime() + LEASE_MS) })
		.where(
			and(
				eq(organizationDirectorySync.organizationId, organizationId),
				or(
					isNull(organizationDirectorySync.leaseExpiresAt),
					lt(organizationDirectorySync.leaseExpiresAt, startedAt),
				),
			),
		);
	if (claim.affectedRows === 0) return emptyResult("busy");

	const [state] = await db()
		.select({
			removalsApprovedAt: organizationDirectorySync.removalsApprovedAt,
			heldRemovals: organizationDirectorySync.heldRemovals,
		})
		.from(organizationDirectorySync)
		.where(eq(organizationDirectorySync.organizationId, organizationId))
		.limit(1);
	const approvedRemovals =
		state?.removalsApprovedAt &&
		state.removalsApprovedAt.getTime() >
			startedAt.getTime() - REMOVAL_APPROVAL_MS
			? state.heldRemovals
			: 0;

	try {
		const result = await reconcileDirectory(
			organizationId,
			approvedRemovals,
			deadline,
		);
		await db()
			.update(organizationDirectorySync)
			.set({
				syncedAt: startedAt,
				leaseExpiresAt: null,
				lastError: null,
				heldRemovals: sql`CASE WHEN ${organizationDirectorySync.removalsApprovedAt} IS NOT NULL AND ${
					state?.removalsApprovedAt
						? sql`${organizationDirectorySync.removalsApprovedAt} <> ${sql.param(state.removalsApprovedAt, organizationDirectorySync.removalsApprovedAt)}`
						: sql`TRUE`
				} THEN ${organizationDirectorySync.heldRemovals} ELSE ${result.held} END`,
				...(state?.removalsApprovedAt
					? {
							removalsApprovedAt: sql`CASE WHEN ${organizationDirectorySync.removalsApprovedAt} = ${sql.param(state.removalsApprovedAt, organizationDirectorySync.removalsApprovedAt)} THEN NULL ELSE ${organizationDirectorySync.removalsApprovedAt} END`,
						}
					: {}),
			})
			.where(eq(organizationDirectorySync.organizationId, organizationId));
		return result;
	} catch (error) {
		const snapshotTooSlow =
			error instanceof SnapshotTooSlow &&
			deadline - startedAt.getTime() >= FULL_SNAPSHOT_BUDGET_MS;
		if (
			error instanceof DeadlineReached ||
			(error instanceof SnapshotTooSlow && !snapshotTooSlow)
		) {
			await db()
				.update(organizationDirectorySync)
				.set({ leaseExpiresAt: null, requestedAt: new Date() })
				.where(eq(organizationDirectorySync.organizationId, organizationId));
			return emptyResult("partial");
		}
		console.error("Directory sync failed", { organizationId, error });
		await db()
			.update(organizationDirectorySync)
			.set({
				leaseExpiresAt: new Date(
					Date.now() +
						(snapshotTooSlow ? SNAPSHOT_RETRY_DELAY_MS : RETRY_DELAY_MS),
				),
				lastError: (error instanceof Error
					? error.message
					: "Directory sync failed."
				).slice(0, 255),
			})
			.where(eq(organizationDirectorySync.organizationId, organizationId));
		throw error;
	}
}

export async function runDueDirectorySyncs(deadline: number) {
	const now = new Date();
	const due = await db()
		.select({ organizationId: organizationDirectorySync.organizationId })
		.from(organizationDirectorySync)
		.where(
			and(
				or(
					isNull(organizationDirectorySync.leaseExpiresAt),
					lt(organizationDirectorySync.leaseExpiresAt, now),
				),
				or(
					isNull(organizationDirectorySync.syncedAt),
					gte(
						organizationDirectorySync.requestedAt,
						organizationDirectorySync.syncedAt,
					),
					lt(
						organizationDirectorySync.syncedAt,
						new Date(now.getTime() - REFRESH_INTERVAL_MS),
					),
				),
			),
		)
		.orderBy(organizationDirectorySync.requestedAt)
		.limit(50);
	let processed = 0;
	let failed = 0;
	for (const { organizationId } of due) {
		if (deadline - Date.now() < MIN_ORGANIZATION_BUDGET_MS) break;
		try {
			const result = await syncOrganizationDirectory(
				Organisation.OrganisationId.make(organizationId),
				deadline,
			);
			if (result.status !== "busy") processed++;
		} catch {
			failed++;
		}
	}
	return { processed, failed };
}
