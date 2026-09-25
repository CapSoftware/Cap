import { User } from "@cap/web-domain";
import type { DirectoryUser } from "@workos-inc/node";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getSsoEmailDomain } from "../auth/sso";
import { nanoId } from "../helpers";
import type { db } from "../index";
import {
	directoryUsers,
	type organizationDirectorySync,
	organizationInvites,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	users,
} from "../schema";

export type DirectoryTransaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];
export type DirectoryConfiguration =
	typeof organizationDirectorySync.$inferSelect;
export type SyncedDirectoryUser = Pick<
	DirectoryUser,
	| "id"
	| "directoryId"
	| "organizationId"
	| "idpId"
	| "email"
	| "firstName"
	| "lastName"
	| "state"
	| "updatedAt"
>;

export function directoryUserIssue(
	user: SyncedDirectoryUser,
	verifiedDomains: readonly string[],
) {
	const email = user.email?.trim().toLowerCase();
	if (!email || email.length > 255) return "missing_or_invalid_email";
	const domain = getSsoEmailDomain(email);
	if (!domain || !verifiedDomains.includes(domain))
		return "unverified_email_domain";
	if (!user.idpId || user.idpId.length > 255) return "invalid_identity";
	return null;
}

export async function revokeDirectoryMembership(
	tx: DirectoryTransaction,
	configuration: DirectoryConfiguration,
	userId: User.UserId,
) {
	const organizationId = configuration.organizationId;
	const [user] = await tx
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.for("update");
	if (!user) return;
	const memberships = await tx
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, userId),
			),
		);
	const organizationSpaces = await tx
		.select({ id: spaces.id })
		.from(spaces)
		.where(eq(spaces.organizationId, organizationId));
	if (organizationSpaces.length) {
		await tx.delete(spaceMembers).where(
			and(
				eq(spaceMembers.userId, userId),
				inArray(
					spaceMembers.spaceId,
					organizationSpaces.map((space) => space.id),
				),
			),
		);
	}
	await tx
		.delete(organizationInvites)
		.where(
			and(
				eq(organizationInvites.organizationId, organizationId),
				eq(organizationInvites.invitedEmail, user.email),
			),
		);
	await tx
		.delete(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, userId),
			),
		);
	const remaining = await tx
		.select({
			organizationId: organizationMembers.organizationId,
			hasProSeat: organizationMembers.hasProSeat,
			subscriptionId: users.stripeSubscriptionId,
		})
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizations.id, organizationMembers.organizationId),
		)
		.innerJoin(users, eq(users.id, organizations.ownerId))
		.where(
			and(
				eq(organizationMembers.userId, userId),
				isNull(organizations.tombstoneAt),
			),
		);
	const replacementOrganizationId = remaining[0]?.organizationId ?? null;
	const remainingSeats = remaining.filter((member) => member.hasProSeat);
	const replacementSubscription =
		remainingSeats.find(
			(member) => member.subscriptionId === user.thirdPartyStripeSubscriptionId,
		)?.subscriptionId ??
		remainingSeats.find((member) => member.subscriptionId)?.subscriptionId ??
		(remainingSeats.length ? user.thirdPartyStripeSubscriptionId : null);
	const userChanges = {
		...(user.activeOrganizationId === organizationId
			? { activeOrganizationId: replacementOrganizationId }
			: {}),
		...(user.defaultOrgId === organizationId
			? { defaultOrgId: replacementOrganizationId }
			: {}),
		...(memberships.some((member) => member.hasProSeat)
			? { thirdPartyStripeSubscriptionId: replacementSubscription }
			: {}),
	};
	if (Object.keys(userChanges).length)
		await tx.update(users).set(userChanges).where(eq(users.id, userId));
}

export async function applyDirectoryUser(
	tx: DirectoryTransaction,
	configuration: DirectoryConfiguration,
	remote: SyncedDirectoryUser,
	verifiedDomains: readonly string[],
	version: Date = new Date(remote.updatedAt),
) {
	if (
		remote.organizationId !== configuration.workosOrganizationId ||
		remote.directoryId !== configuration.directoryId ||
		!remote.id ||
		remote.id.length > 255 ||
		!remote.idpId ||
		remote.idpId.length > 255 ||
		!Number.isFinite(version.getTime())
	)
		throw new Error("directory_identity_mismatch");
	const existing = await tx
		.select()
		.from(directoryUsers)
		.where(
			or(
				eq(directoryUsers.directoryUserId, remote.id),
				and(
					eq(directoryUsers.directoryId, remote.directoryId),
					eq(directoryUsers.idpId, remote.idpId),
				),
			),
		)
		.for("update");
	if (
		existing.length > 1 ||
		existing.some(
			(record) =>
				record.organizationId !== configuration.organizationId ||
				record.directoryId !== remote.directoryId ||
				record.idpId !== remote.idpId,
		)
	)
		throw new Error("directory_identity_conflict");
	const previous = existing[0];
	const now = new Date();
	if (
		previous &&
		(previous.remoteUpdatedAt.getTime() > version.getTime() ||
			(previous.remoteUpdatedAt.getTime() === version.getTime() &&
				previous.state === "inactive" &&
				remote.state === "active"))
	) {
		await tx
			.update(directoryUsers)
			.set({ lastSeenAt: now })
			.where(eq(directoryUsers.id, previous.id));
		return;
	}
	const email = remote.email?.trim().toLowerCase() || null;
	let issue = directoryUserIssue(remote, verifiedDomains);
	let userId = previous?.userId ?? null;
	const [linked] = userId
		? await tx.select().from(users).where(eq(users.id, userId)).for("update")
		: [];
	if (userId && (!linked || linked.email.toLowerCase() !== email))
		issue = "email_change_requires_review";
	if (!userId && email && !issue) {
		const [existingUser] = await tx
			.select()
			.from(users)
			.where(eq(users.email, email))
			.for("update");
		const [otherIdentity] = existingUser
			? await tx
					.select({ id: directoryUsers.id })
					.from(directoryUsers)
					.where(
						and(
							eq(directoryUsers.organizationId, configuration.organizationId),
							eq(directoryUsers.userId, existingUser.id),
						),
					)
					.limit(1)
			: [];
		if (otherIdentity && otherIdentity.id !== previous?.id) {
			issue = "account_identity_conflict";
		} else {
			userId =
				existingUser?.id ??
				(remote.state === "active" ? User.UserId.make(nanoId()) : null);
			if (!existingUser && userId && remote.state === "active") {
				await tx.insert(users).values({
					id: userId,
					email,
					name: remote.firstName?.slice(0, 255) || email.split("@")[0],
					lastName: remote.lastName?.slice(0, 255) ?? null,
					activeOrganizationId: configuration.organizationId,
					defaultOrgId: configuration.organizationId,
					marketingOrigin: "teammate",
				});
			}
		}
	}
	const state =
		remote.state === "inactive" ? "inactive" : issue ? "conflict" : "active";
	const fields = {
		directoryUserId: remote.id,
		userId,
		email: email?.slice(0, 255) ?? null,
		firstName: remote.firstName?.slice(0, 255) ?? null,
		lastName: remote.lastName?.slice(0, 255) ?? null,
		state,
		lastError: issue,
		remoteUpdatedAt: version,
		lastSeenAt: now,
	};
	if (previous) {
		await tx
			.update(directoryUsers)
			.set(fields)
			.where(eq(directoryUsers.id, previous.id));
	} else {
		await tx.insert(directoryUsers).values({
			id: nanoId(),
			organizationId: configuration.organizationId,
			directoryId: remote.directoryId,
			idpId: remote.idpId,
			...fields,
		});
	}
	if (!userId) return;
	if (state !== "active") {
		await revokeDirectoryMembership(tx, configuration, userId);
		return;
	}
	const [member] = await tx
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, configuration.organizationId),
				eq(organizationMembers.userId, userId),
			),
		)
		.limit(1);
	if (!member) {
		const [organization] = await tx
			.select({ ownerId: organizations.ownerId })
			.from(organizations)
			.where(eq(organizations.id, configuration.organizationId))
			.limit(1);
		await tx.insert(organizationMembers).values({
			id: nanoId(),
			organizationId: configuration.organizationId,
			userId,
			role: organization?.ownerId === userId ? "owner" : "member",
			hasProSeat: false,
		});
	}
	await tx
		.update(organizationInvites)
		.set({ status: "accepted" })
		.where(
			and(
				eq(organizationInvites.organizationId, configuration.organizationId),
				eq(organizationInvites.invitedEmail, email ?? ""),
				eq(organizationInvites.status, "pending"),
			),
		);
}
