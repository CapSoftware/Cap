import { db } from "@cap/database";
import type { userSelectProps } from "@cap/database/auth/session";
import {
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	users,
	videos,
} from "@cap/database/schema";
import { Database, ImageUploads } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

export type Organization = {
	organization: Omit<typeof organizations.$inferSelect, "iconUrl"> & {
		iconUrl: ImageUpload.ImageUrl | null;
	};
	members: (typeof organizationMembers.$inferSelect & {
		user: Pick<
			typeof users.$inferSelect,
			"id" | "name" | "email" | "lastName"
		> & { image?: ImageUpload.ImageUrl | null };
	})[];
	invites: (typeof organizationInvites.$inferSelect)[];
	inviteQuota: number;
	totalInvites: number;
};

export type OrganizationSettings = NonNullable<
	(typeof organizations.$inferSelect)["settings"]
>;

export type Spaces = Omit<
	typeof spaces.$inferSelect,
	"createdAt" | "updatedAt" | "iconUrl"
> & {
	memberCount: number;
	videoCount: number;
	iconUrl: ImageUpload.ImageUrl | null;
};

export type UserPreferences = (typeof users.$inferSelect)["preferences"];

export async function getDashboardData(user: typeof userSelectProps) {
	try {
		const memberOrgIds = db()
			.select({ id: organizationMembers.organizationId })
			.from(organizationMembers)
			.where(eq(organizationMembers.userId, user.id));

		const userOrganizations = await db()
			.select()
			.from(organizations)
			.where(
				and(
					isNull(organizations.tombstoneAt),
					or(
						eq(organizations.ownerId, user.id),
						inArray(organizations.id, memberOrgIds),
					),
				),
			);

		const organizationIds = userOrganizations.map((org) => org.id);

		let organizationInvitesData: (typeof organizationInvites.$inferSelect)[] =
			[];
		if (organizationIds.length > 0) {
			organizationInvitesData = await db()
				.select()
				.from(organizationInvites)
				.where(inArray(organizationInvites.organizationId, organizationIds));
		}

		let anyNewNotifications = false;
		let spacesData: Spaces[] = [];
		let organizationSettings: OrganizationSettings | null = null;
		let userCapsCount = 0;
		// Find active organization ID

		let activeOrganizationId = organizationIds.find(
			(orgId) => orgId === user.activeOrganizationId,
		);

		if (!activeOrganizationId && organizationIds.length > 0) {
			activeOrganizationId = organizationIds[0];
		}

		// Only fetch spaces for the active organization

		if (activeOrganizationId) {
			const [notification] = await db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.recipientId, user.id),
						eq(notifications.orgId, activeOrganizationId),
						isNull(notifications.readAt),
					),
				)
				.limit(1);

			anyNewNotifications = !!notification;

			const [organizationSetting] = await db()
				.select({ settings: organizations.settings })
				.from(organizations)
				.where(eq(organizations.id, activeOrganizationId));
			organizationSettings = organizationSetting?.settings || null;

			spacesData = await Effect.gen(function* () {
				const db = yield* Database;
				const imageUploads = yield* ImageUploads;

				return yield* db
					.use((db) =>
						db
							.select({
								id: spaces.id,
								primary: spaces.primary,
								privacy: spaces.privacy,
								name: spaces.name,
								description: spaces.description,
								organizationId: spaces.organizationId,
								createdById: spaces.createdById,
								iconUrl: spaces.iconUrl,
								memberCount: sql<number>`(
          SELECT COUNT(*) FROM space_members WHERE space_members.spaceId = spaces.id
        )`,
								videoCount: sql<number>`(
          SELECT COUNT(*) FROM space_videos WHERE space_videos.spaceId = spaces.id
        )`,
							})
							.from(spaces)
							.where(
								and(
									eq(spaces.organizationId, activeOrganizationId),
									or(
										// User is the space creator
										eq(spaces.createdById, user.id),
										// Space is public within the organization
										eq(spaces.privacy, "Public"),
										// User is a member of the space
										sql`EXISTS (
          SELECT 1 FROM space_members 
          WHERE space_members.spaceId = spaces.id 
          AND space_members.userId = ${user.id}
        )`,
									),
								),
							),
					)
					.pipe(
						Effect.map((rows) =>
							rows.map(
								Effect.fn(function* (row) {
									return {
										...row,
										iconUrl: row.iconUrl
											? yield* imageUploads.resolveImageUrl(row.iconUrl)
											: null,
									};
								}),
							),
						),
						Effect.flatMap(Effect.all),
					);
			}).pipe(runPromise);

			// Add a single 'All spaces' entry for the active organization
			const activeOrgInfo = userOrganizations.find(
				(org) => org.id === activeOrganizationId,
			);
			if (activeOrgInfo) {
				const orgMemberCountResult = await db()
					.select({ value: sql<number>`COUNT(*)` })
					.from(organizationMembers)
					.where(eq(organizationMembers.organizationId, activeOrgInfo.id));
				const orgMemberCount = orgMemberCountResult[0]?.value || 0;

				const orgVideoCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${sharedVideos.videoId})`,
					})
					.from(sharedVideos)
					.where(eq(sharedVideos.organizationId, activeOrgInfo.id));
				const orgVideoCount = orgVideoCountResult[0]?.value || 0;

				const userCapsCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${videos.id})`,
					})
					.from(videos)
					.where(
						and(
							eq(videos.orgId, activeOrgInfo.id),
							eq(videos.ownerId, user.id),
						),
					);

				userCapsCount = userCapsCountResult[0]?.value || 0;

				const allSpacesEntry = await Effect.gen(function* () {
					const imageUploads = yield* ImageUploads;

					const iconUrl = activeOrgInfo.iconUrl;

					return {
						id: activeOrgInfo.id,
						primary: true,
						privacy: "Public",
						name: `All ${activeOrgInfo.name}`,
						description: `View all content in ${activeOrgInfo.name}`,
						organizationId: activeOrgInfo.id,
						iconUrl: iconUrl
							? yield* imageUploads.resolveImageUrl(iconUrl)
							: null,
						memberCount: orgMemberCount,
						createdById: activeOrgInfo.ownerId,
						videoCount: orgVideoCount,
					} as const;
				}).pipe(runPromise);

				spacesData = [allSpacesEntry, ...spacesData];
			}
		}

		const [userPreferences] = await db()
			.select({
				preferences: users.preferences,
			})
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);

		const organizationSelect: Organization[] = await Effect.all(
			userOrganizations.map(
				Effect.fn(function* (organization) {
					const db = yield* Database;
					const iconImages = yield* ImageUploads;

					const allMembers = yield* db.use((db) =>
						db
							.select({
								member: organizationMembers,
								user: {
									id: users.id,
									name: users.name,
									lastName: users.lastName,
									email: users.email,
									image: users.image,
								},
							})
							.from(organizationMembers)
							.leftJoin(users, eq(organizationMembers.userId, users.id))
							.where(eq(organizationMembers.organizationId, organization.id)),
					);

					const owner = yield* db.use((db) =>
						db
							.select({
								inviteQuota: users.inviteQuota,
							})
							.from(users)
							.where(eq(users.id, organization.ownerId))
							.then((result) => result[0]),
					);

					const ownedOrgIds = db.use((db) =>
						db
							.select({ id: organizations.id })
							.from(organizations)
							.where(
								and(
									eq(organizations.ownerId, organization.ownerId),
									isNull(organizations.tombstoneAt),
								),
							)
							.then((rows) => rows.map((r) => r.id)),
					);

					const ownedIds = yield* ownedOrgIds;

					const memberCountResult = yield* db.use((db) =>
						ownedIds.length > 0
							? db
									.select({ value: count() })
									.from(organizationMembers)
									.where(inArray(organizationMembers.organizationId, ownedIds))
							: Promise.resolve([{ value: 0 }]),
					);

					const inviteCountResult = yield* db.use((db) =>
						ownedIds.length > 0
							? db
									.select({ value: count() })
									.from(organizationInvites)
									.where(inArray(organizationInvites.organizationId, ownedIds))
							: Promise.resolve([{ value: 0 }]),
					);

					const totalInvites =
						(memberCountResult[0]?.value || 0) +
						(inviteCountResult[0]?.value || 0);

					return {
						organization: {
							...organization,
							iconUrl: organization.iconUrl
								? yield* iconImages.resolveImageUrl(organization.iconUrl)
								: null,
						},
						members: yield* Effect.all(
							allMembers.map(
								Effect.fn(function* (m) {
									const imageUploads = yield* ImageUploads;
									return {
										...m.member,
										user: {
											...m.user!,
											image: m.user?.image
												? yield* imageUploads.resolveImageUrl(m.user?.image)
												: null,
										},
									};
								}),
							),
						),
						invites: organizationInvitesData.filter(
							(invite) => invite.organizationId === organization.id,
						),
						inviteQuota: owner?.inviteQuota || 1,
						totalInvites,
					};
				}),
			),
			{ concurrency: 3 },
		).pipe(runPromise);

		return {
			organizationSelect,
			organizationSettings,
			spacesData,
			anyNewNotifications,
			userPreferences,
			userCapsCount,
		};
	} catch (error) {
		console.error("Failed to fetch dashboard data", error);
		return {
			organizationSelect: [],
			spacesData: [],
			userCapsCount: null,
			anyNewNotifications: false,
			userPreferences: null,
			organizationSettings: null,
		};
	}
}
