import * as Db from "@cap/database/schema";
import {
	type Folder,
	type Organisation,
	Policy,
	type Space,
	type User,
	type Video,
} from "@cap/web-domain";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Database } from "./Database.ts";

type OrganizationRole = "owner" | "admin" | "member";

const normalizedRole = (role: string): OrganizationRole => {
	const value = role.toLowerCase();
	return value === "owner" || value === "admin" ? value : "member";
};

export class AgentManagement extends Effect.Service<AgentManagement>()(
	"AgentManagement",
	{
		effect: Effect.gen(function* () {
			const database = yield* Database;

			const getMembership = Effect.fn("AgentManagement.getMembership")(
				function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					const [membership] = yield* database.use((db) =>
						db
							.select({
								id: Db.organizationMembers.id,
								role: Db.organizationMembers.role,
								hasProSeat: Db.organizationMembers.hasProSeat,
							})
							.from(Db.organizationMembers)
							.innerJoin(
								Db.organizations,
								eq(Db.organizationMembers.organizationId, Db.organizations.id),
							)
							.where(
								and(
									eq(Db.organizationMembers.userId, userId),
									eq(Db.organizationMembers.organizationId, organizationId),
									isNull(Db.organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					if (!membership) return yield* new Policy.PolicyDeniedError();
					return {
						...membership,
						role: normalizedRole(membership.role),
					};
				},
			);

			const requireOrganizationManager = Effect.fn(
				"AgentManagement.requireOrganizationManager",
			)(function* (
				userId: User.UserId,
				organizationId: Organisation.OrganisationId,
			) {
				const membership = yield* getMembership(userId, organizationId);
				if (membership.role === "member") {
					return yield* new Policy.PolicyDeniedError();
				}
				return membership;
			});

			const getSpaceAccess = Effect.fn("AgentManagement.getSpaceAccess")(
				function* (
					userId: User.UserId,
					spaceId: Space.SpaceIdOrOrganisationId,
				) {
					const [row] = yield* database.use((db) =>
						db
							.select({
								organizationId: Db.spaces.organizationId,
								createdById: Db.spaces.createdById,
								privacy: Db.spaces.privacy,
								memberRole: Db.spaceMembers.role,
								organizationRole: Db.organizationMembers.role,
							})
							.from(Db.spaces)
							.innerJoin(
								Db.organizationMembers,
								and(
									eq(
										Db.organizationMembers.organizationId,
										Db.spaces.organizationId,
									),
									eq(Db.organizationMembers.userId, userId),
								),
							)
							.leftJoin(
								Db.spaceMembers,
								and(
									eq(Db.spaceMembers.spaceId, Db.spaces.id),
									eq(Db.spaceMembers.userId, userId),
								),
							)
							.where(eq(Db.spaces.id, spaceId))
							.limit(1),
					);
					if (!row) return yield* new Policy.PolicyDeniedError();
					const organizationRole = normalizedRole(row.organizationRole);
					const canView =
						row.privacy === "Public" ||
						row.createdById === userId ||
						row.memberRole !== null ||
						organizationRole !== "member";
					if (!canView) return yield* new Policy.PolicyDeniedError();
					return {
						...row,
						organizationRole,
						canManage:
							row.createdById === userId ||
							row.memberRole === "admin" ||
							organizationRole !== "member",
					};
				},
			);

			const listOrganizations = Effect.fn("AgentManagement.listOrganizations")(
				function* (userId: User.UserId) {
					return yield* database.use((db) =>
						db
							.select({
								id: Db.organizations.id,
								name: Db.organizations.name,
								ownerId: Db.organizations.ownerId,
								role: Db.organizationMembers.role,
								hasProSeat: Db.organizationMembers.hasProSeat,
								allowedEmailDomain: Db.organizations.allowedEmailDomain,
								customDomain: Db.organizations.customDomain,
								domainVerifiedAt: Db.organizations.domainVerified,
								settings: Db.organizations.settings,
								icon: Db.organizations.iconUrl,
								shareableLinkIcon: Db.organizations.shareableLinkIconUrl,
								ownerSubscriptionStatus: Db.users.stripeSubscriptionStatus,
								ownerThirdPartySubscriptionId:
									Db.users.thirdPartyStripeSubscriptionId,
								createdAt: Db.organizations.createdAt,
								updatedAt: Db.organizations.updatedAt,
							})
							.from(Db.organizationMembers)
							.innerJoin(
								Db.organizations,
								eq(Db.organizationMembers.organizationId, Db.organizations.id),
							)
							.innerJoin(Db.users, eq(Db.organizations.ownerId, Db.users.id))
							.where(
								and(
									eq(Db.organizationMembers.userId, userId),
									isNull(Db.organizations.tombstoneAt),
								),
							)
							.orderBy(Db.organizations.name, Db.organizations.id),
					);
				},
			);

			const getOrganization = Effect.fn("AgentManagement.getOrganization")(
				function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					yield* getMembership(userId, organizationId);
					const organizations = yield* listOrganizations(userId);
					const organization = organizations.find(
						(item) => item.id === organizationId,
					);
					if (!organization) return yield* new Policy.PolicyDeniedError();
					return organization;
				},
			);

			const getFolderAccess = Effect.fn("AgentManagement.getFolderAccess")(
				function* (userId: User.UserId, folderId: Folder.FolderId) {
					const [folder] = yield* database.use((db) =>
						db
							.select()
							.from(Db.folders)
							.where(eq(Db.folders.id, folderId))
							.limit(1),
					);
					if (!folder) return yield* new Policy.PolicyDeniedError();
					const membership = yield* getMembership(
						userId,
						folder.organizationId,
					);
					if (folder.spaceId === null) {
						if (folder.createdById !== userId) {
							return yield* new Policy.PolicyDeniedError();
						}
						return { folder, canManage: true };
					}
					if (folder.spaceId === folder.organizationId) {
						return { folder, canManage: membership.role !== "member" };
					}
					const access = yield* getSpaceAccess(userId, folder.spaceId);
					return { folder, canManage: access.canManage };
				},
			);

			return {
				getAccount: Effect.fn("AgentManagement.getAccount")(function* (
					userId: User.UserId,
				) {
					const [user] = yield* database.use((db) =>
						db
							.select({
								id: Db.users.id,
								email: Db.users.email,
								name: Db.users.name,
								lastName: Db.users.lastName,
								image: Db.users.image,
								activeOrganizationId: Db.users.activeOrganizationId,
								defaultOrganizationId: Db.users.defaultOrgId,
								createdAt: Db.users.created_at,
							})
							.from(Db.users)
							.where(eq(Db.users.id, userId))
							.limit(1),
					);
					if (!user) return yield* new Policy.PolicyDeniedError();
					return user;
				}),

				listOrganizations,
				getOrganization,
				getFolderAccess,

				listMembers: Effect.fn("AgentManagement.listMembers")(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					yield* getMembership(userId, organizationId);
					return yield* database.use((db) =>
						db
							.select({
								id: Db.organizationMembers.id,
								userId: Db.organizationMembers.userId,
								email: Db.users.email,
								name: Db.users.name,
								role: Db.organizationMembers.role,
								hasProSeat: Db.organizationMembers.hasProSeat,
								createdAt: Db.organizationMembers.createdAt,
								updatedAt: Db.organizationMembers.updatedAt,
							})
							.from(Db.organizationMembers)
							.innerJoin(
								Db.users,
								eq(Db.organizationMembers.userId, Db.users.id),
							)
							.where(eq(Db.organizationMembers.organizationId, organizationId))
							.orderBy(Db.users.email, Db.organizationMembers.id),
					);
				}),

				listInvites: Effect.fn("AgentManagement.listInvites")(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					yield* requireOrganizationManager(userId, organizationId);
					return yield* database.use((db) =>
						db
							.select()
							.from(Db.organizationInvites)
							.where(eq(Db.organizationInvites.organizationId, organizationId))
							.orderBy(
								desc(Db.organizationInvites.createdAt),
								Db.organizationInvites.id,
							),
					);
				}),

				listFolders: Effect.fn("AgentManagement.listFolders")(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
					spaceId: Space.SpaceIdOrOrganisationId | null,
					parentId: Folder.FolderId | null | undefined,
				) {
					yield* getMembership(userId, organizationId);
					if (spaceId && spaceId !== organizationId) {
						const access = yield* getSpaceAccess(userId, spaceId);
						if (access.organizationId !== organizationId) {
							return yield* new Policy.PolicyDeniedError();
						}
					}
					return yield* database.use((db) =>
						db
							.select()
							.from(Db.folders)
							.where(
								and(
									eq(Db.folders.organizationId, organizationId),
									spaceId
										? eq(Db.folders.spaceId, spaceId)
										: and(
												isNull(Db.folders.spaceId),
												eq(Db.folders.createdById, userId),
											),
									parentId === undefined
										? undefined
										: parentId === null
											? isNull(Db.folders.parentId)
											: eq(Db.folders.parentId, parentId),
								),
							)
							.orderBy(Db.folders.name, Db.folders.id),
					);
				}),

				listSpaces: Effect.fn("AgentManagement.listSpaces")(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					const membership = yield* getMembership(userId, organizationId);
					return yield* database.use((db) =>
						db
							.select({
								id: Db.spaces.id,
								name: Db.spaces.name,
								description: Db.spaces.description,
								organizationId: Db.spaces.organizationId,
								createdById: Db.spaces.createdById,
								primary: Db.spaces.primary,
								privacy: Db.spaces.privacy,
								public: Db.spaces.public,
								hasPassword:
									sql<boolean>`${Db.spaces.password} IS NOT NULL`.mapWith(
										Boolean,
									),
								icon: Db.spaces.iconUrl,
								settings: Db.spaces.settings,
								role: Db.spaceMembers.role,
								memberCount: sql<number>`(
									SELECT COUNT(*) FROM ${Db.spaceMembers}
									WHERE ${Db.spaceMembers.spaceId} = ${Db.spaces.id}
								)`.mapWith(Number),
								capCount: sql<number>`(
									SELECT COUNT(*) FROM ${Db.spaceVideos}
									WHERE ${Db.spaceVideos.spaceId} = ${Db.spaces.id}
								)`.mapWith(Number),
								folderCount: sql<number>`(
									SELECT COUNT(*) FROM ${Db.folders}
									WHERE ${Db.folders.spaceId} = ${Db.spaces.id}
								)`.mapWith(Number),
								createdAt: Db.spaces.createdAt,
								updatedAt: Db.spaces.updatedAt,
							})
							.from(Db.spaces)
							.leftJoin(
								Db.spaceMembers,
								and(
									eq(Db.spaceMembers.spaceId, Db.spaces.id),
									eq(Db.spaceMembers.userId, userId),
								),
							)
							.where(
								and(
									eq(Db.spaces.organizationId, organizationId),
									membership.role === "member"
										? or(
												eq(Db.spaces.privacy, "Public"),
												eq(Db.spaces.createdById, userId),
												eq(Db.spaceMembers.userId, userId),
											)
										: undefined,
								),
							)
							.orderBy(Db.spaces.name, Db.spaces.id),
					);
				}),

				listSpaceMembers: Effect.fn("AgentManagement.listSpaceMembers")(
					function* (
						userId: User.UserId,
						spaceId: Space.SpaceIdOrOrganisationId,
					) {
						yield* getSpaceAccess(userId, spaceId);
						return yield* database.use((db) =>
							db
								.select({
									id: Db.spaceMembers.id,
									userId: Db.spaceMembers.userId,
									email: Db.users.email,
									name: Db.users.name,
									role: Db.spaceMembers.role,
									createdAt: Db.spaceMembers.createdAt,
									updatedAt: Db.spaceMembers.updatedAt,
								})
								.from(Db.spaceMembers)
								.innerJoin(Db.users, eq(Db.spaceMembers.userId, Db.users.id))
								.where(eq(Db.spaceMembers.spaceId, spaceId))
								.orderBy(Db.users.email, Db.spaceMembers.id),
						);
					},
				),

				listNotifications: Effect.fn("AgentManagement.listNotifications")(
					function* (
						userId: User.UserId,
						limit: number,
						cursor: { createdAt: Date; id: string } | null,
						unread: boolean | null,
					) {
						const rows = yield* database.use((db) =>
							db
								.select()
								.from(Db.notifications)
								.where(
									and(
										eq(Db.notifications.recipientId, userId),
										unread === true
											? isNull(Db.notifications.readAt)
											: undefined,
										cursor
											? or(
													lt(Db.notifications.createdAt, cursor.createdAt),
													and(
														eq(Db.notifications.createdAt, cursor.createdAt),
														lt(Db.notifications.id, cursor.id),
													),
												)
											: undefined,
									),
								)
								.orderBy(
									desc(Db.notifications.createdAt),
									desc(Db.notifications.id),
								)
								.limit(limit + 1),
						);
						const [{ count }] = yield* database.use((db) =>
							db
								.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
								.from(Db.notifications)
								.where(
									and(
										eq(Db.notifications.recipientId, userId),
										isNull(Db.notifications.readAt),
									),
								),
						);
						return { rows, unreadCount: count ?? 0 };
					},
				),

				getNotificationPreferences: Effect.fn(
					"AgentManagement.getNotificationPreferences",
				)(function* (userId: User.UserId) {
					const [user] = yield* database.use((db) =>
						db
							.select({ preferences: Db.users.preferences })
							.from(Db.users)
							.where(eq(Db.users.id, userId))
							.limit(1),
					);
					if (!user) return yield* new Policy.PolicyDeniedError();
					return user.preferences?.notifications ?? null;
				}),

				listStorageIntegrations: Effect.fn(
					"AgentManagement.listStorageIntegrations",
				)(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					yield* getMembership(userId, organizationId);
					return yield* database.use((db) =>
						db
							.select({
								id: Db.storageIntegrations.id,
								provider: Db.storageIntegrations.provider,
								displayName: Db.storageIntegrations.displayName,
								status: Db.storageIntegrations.status,
								active: Db.storageIntegrations.active,
								createdAt: Db.storageIntegrations.createdAt,
								updatedAt: Db.storageIntegrations.updatedAt,
							})
							.from(Db.storageIntegrations)
							.where(eq(Db.storageIntegrations.organizationId, organizationId))
							.orderBy(
								desc(Db.storageIntegrations.active),
								Db.storageIntegrations.displayName,
							),
					);
				}),

				getBilling: Effect.fn("AgentManagement.getBilling")(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
				) {
					const membership = yield* requireOrganizationManager(
						userId,
						organizationId,
					);
					const organization = yield* getOrganization(userId, organizationId);
					const [{ total, assigned }] = yield* database.use((db) =>
						db
							.select({
								total: sql<number>`COUNT(*)`.mapWith(Number),
								assigned:
									sql<number>`SUM(CASE WHEN ${Db.organizationMembers.hasProSeat} THEN 1 ELSE 0 END)`.mapWith(
										Number,
									),
							})
							.from(Db.organizationMembers)
							.where(eq(Db.organizationMembers.organizationId, organizationId)),
					);
					return {
						membership,
						organization,
						totalSeats: total ?? 0,
						assignedSeats: assigned ?? 0,
					};
				}),

				listDeveloperApps: Effect.fn("AgentManagement.listDeveloperApps")(
					function* (userId: User.UserId) {
						return yield* database.use((db) =>
							db
								.select({
									id: Db.developerApps.id,
									name: Db.developerApps.name,
									environment: Db.developerApps.environment,
									logoUrl: Db.developerApps.logoUrl,
									createdAt: Db.developerApps.createdAt,
									updatedAt: Db.developerApps.updatedAt,
								})
								.from(Db.developerApps)
								.where(
									and(
										eq(Db.developerApps.ownerId, userId),
										isNull(Db.developerApps.deletedAt),
									),
								)
								.orderBy(Db.developerApps.name, Db.developerApps.id),
						);
					},
				),

				getDeveloperAppContext: Effect.fn(
					"AgentManagement.getDeveloperAppContext",
				)(function* (userId: User.UserId, appId: string) {
					const [app] = yield* database.use((db) =>
						db
							.select({
								id: Db.developerApps.id,
								name: Db.developerApps.name,
								environment: Db.developerApps.environment,
								logoUrl: Db.developerApps.logoUrl,
								createdAt: Db.developerApps.createdAt,
								updatedAt: Db.developerApps.updatedAt,
							})
							.from(Db.developerApps)
							.where(
								and(
									eq(Db.developerApps.id, appId),
									eq(Db.developerApps.ownerId, userId),
									isNull(Db.developerApps.deletedAt),
								),
							)
							.limit(1),
					);
					if (!app) return yield* new Policy.PolicyDeniedError();
					const [domains, keys, usageRows, creditsRows, snapshotRows] =
						yield* database.use((db) =>
							Promise.all([
								db
									.select({
										id: Db.developerAppDomains.id,
										domain: Db.developerAppDomains.domain,
										createdAt: Db.developerAppDomains.createdAt,
									})
									.from(Db.developerAppDomains)
									.where(eq(Db.developerAppDomains.appId, appId))
									.orderBy(Db.developerAppDomains.domain),
								db
									.select({
										id: Db.developerApiKeys.id,
										keyType: Db.developerApiKeys.keyType,
										keyPrefix: Db.developerApiKeys.keyPrefix,
										lastUsedAt: Db.developerApiKeys.lastUsedAt,
										revokedAt: Db.developerApiKeys.revokedAt,
										createdAt: Db.developerApiKeys.createdAt,
									})
									.from(Db.developerApiKeys)
									.where(eq(Db.developerApiKeys.appId, appId))
									.orderBy(desc(Db.developerApiKeys.createdAt)),
								db
									.select({
										videoCount: sql<number>`COUNT(*)`.mapWith(Number),
									})
									.from(Db.developerVideos)
									.where(
										and(
											eq(Db.developerVideos.appId, appId),
											isNull(Db.developerVideos.deletedAt),
										),
									),
								db
									.select({
										balanceMicroCredits:
											Db.developerCreditAccounts.balanceMicroCredits,
										autoTopUpEnabled:
											Db.developerCreditAccounts.autoTopUpEnabled,
										autoTopUpThresholdMicroCredits:
											Db.developerCreditAccounts.autoTopUpThresholdMicroCredits,
										autoTopUpAmountCents:
											Db.developerCreditAccounts.autoTopUpAmountCents,
									})
									.from(Db.developerCreditAccounts)
									.where(eq(Db.developerCreditAccounts.appId, appId))
									.limit(1),
								db
									.select({
										totalDurationMinutes:
											Db.developerDailyStorageSnapshots.totalDurationMinutes,
									})
									.from(Db.developerDailyStorageSnapshots)
									.where(eq(Db.developerDailyStorageSnapshots.appId, appId))
									.orderBy(desc(Db.developerDailyStorageSnapshots.snapshotDate))
									.limit(1),
							]),
						);
					return {
						app,
						domains,
						keys,
						videoCount: usageRows[0]?.videoCount ?? 0,
						storageMinutes: snapshotRows[0]?.totalDurationMinutes ?? 0,
						credits: creditsRows[0] ?? null,
					};
				}),

				listDeveloperVideos: Effect.fn("AgentManagement.listDeveloperVideos")(
					function* (
						userId: User.UserId,
						appId: string,
						limit: number,
						cursor: { createdAt: Date; id: string } | null,
						externalUserId: string | null,
					) {
						return yield* database.use((db) =>
							db
								.select({
									id: Db.developerVideos.id,
									appId: Db.developerVideos.appId,
									externalUserId: Db.developerVideos.externalUserId,
									name: Db.developerVideos.name,
									duration: Db.developerVideos.duration,
									width: Db.developerVideos.width,
									height: Db.developerVideos.height,
									fps: Db.developerVideos.fps,
									transcriptionStatus: Db.developerVideos.transcriptionStatus,
									createdAt: Db.developerVideos.createdAt,
									updatedAt: Db.developerVideos.updatedAt,
								})
								.from(Db.developerVideos)
								.innerJoin(
									Db.developerApps,
									eq(Db.developerVideos.appId, Db.developerApps.id),
								)
								.where(
									and(
										eq(Db.developerVideos.appId, appId),
										eq(Db.developerApps.ownerId, userId),
										isNull(Db.developerApps.deletedAt),
										isNull(Db.developerVideos.deletedAt),
										externalUserId
											? eq(Db.developerVideos.externalUserId, externalUserId)
											: undefined,
										cursor
											? or(
													lt(Db.developerVideos.createdAt, cursor.createdAt),
													and(
														eq(Db.developerVideos.createdAt, cursor.createdAt),
														lt(Db.developerVideos.id, cursor.id),
													),
												)
											: undefined,
									),
								)
								.orderBy(
									desc(Db.developerVideos.createdAt),
									desc(Db.developerVideos.id),
								)
								.limit(limit + 1),
						);
					},
				),

				listDeveloperTransactions: Effect.fn(
					"AgentManagement.listDeveloperTransactions",
				)(function* (
					userId: User.UserId,
					appId: string,
					limit: number,
					cursor: { createdAt: Date; id: string } | null,
				) {
					return yield* database.use((db) =>
						db
							.select({
								id: Db.developerCreditTransactions.id,
								type: Db.developerCreditTransactions.type,
								amountMicroCredits:
									Db.developerCreditTransactions.amountMicroCredits,
								balanceAfterMicroCredits:
									Db.developerCreditTransactions.balanceAfterMicroCredits,
								referenceId: Db.developerCreditTransactions.referenceId,
								referenceType: Db.developerCreditTransactions.referenceType,
								createdAt: Db.developerCreditTransactions.createdAt,
							})
							.from(Db.developerCreditTransactions)
							.innerJoin(
								Db.developerCreditAccounts,
								eq(
									Db.developerCreditTransactions.accountId,
									Db.developerCreditAccounts.id,
								),
							)
							.innerJoin(
								Db.developerApps,
								eq(Db.developerCreditAccounts.appId, Db.developerApps.id),
							)
							.where(
								and(
									eq(Db.developerApps.id, appId),
									eq(Db.developerApps.ownerId, userId),
									isNull(Db.developerApps.deletedAt),
									cursor
										? or(
												lt(
													Db.developerCreditTransactions.createdAt,
													cursor.createdAt,
												),
												and(
													eq(
														Db.developerCreditTransactions.createdAt,
														cursor.createdAt,
													),
													lt(Db.developerCreditTransactions.id, cursor.id),
												),
											)
										: undefined,
								),
							)
							.orderBy(
								desc(Db.developerCreditTransactions.createdAt),
								desc(Db.developerCreditTransactions.id),
							)
							.limit(limit + 1),
					);
				}),

				assertAnalyticsAccess: Effect.fn(
					"AgentManagement.assertAnalyticsAccess",
				)(function* (
					userId: User.UserId,
					organizationId: Organisation.OrganisationId,
					spaceId: Space.SpaceIdOrOrganisationId | null,
					capId: Video.VideoId | null,
				) {
					const organization = yield* getOrganization(userId, organizationId);
					const isPro =
						organization.ownerSubscriptionStatus === "active" ||
						organization.ownerSubscriptionStatus === "trialing" ||
						organization.ownerThirdPartySubscriptionId !== null;
					if (!isPro) {
						return yield* new Policy.PolicyDeniedError({
							reason: "Cap Pro is required for analytics",
						});
					}
					if (spaceId) {
						const access = yield* getSpaceAccess(userId, spaceId);
						if (access.organizationId !== organizationId) {
							return yield* new Policy.PolicyDeniedError();
						}
					}
					if (capId) {
						const [video] = yield* database.use((db) =>
							db
								.select({ id: Db.videos.id })
								.from(Db.videos)
								.where(
									and(
										eq(Db.videos.id, capId),
										eq(Db.videos.orgId, organizationId),
									),
								)
								.limit(1),
						);
						if (!video) return yield* new Policy.PolicyDeniedError();
					}
					return organization;
				}),

				getMembership,
				requireOrganizationManager,
				getSpaceAccess,
			};
		}),
		dependencies: [Database.Default],
	},
) {}
