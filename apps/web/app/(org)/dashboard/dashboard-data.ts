import { db } from "@inflight/database";
import type { userSelectProps } from "@inflight/database/auth/session";
import {
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	users,
	videos,
} from "@inflight/database/schema";
import { Database, ImageUploads } from "@inflight/web-backend";
import type { ImageUpload } from "@inflight/web-domain";
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
		const organizationsWithMembers = await db()
			.select({
				organization: organizations,
				settings: organizations.settings,
				member: organizationMembers,
				iconUrl: organizations.iconUrl,
				user: {
					id: users.id,
					name: users.name,
					lastName: users.lastName,
					email: users.email,
					inviteQuota: users.inviteQuota,
					image: users.image,
					defaultOrgId: users.defaultOrgId,
				},
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.leftJoin(users, eq(organizationMembers.userId, users.id))
			.where(
				and(
					or(
						eq(organizations.ownerId, user.id),
						eq(organizationMembers.userId, user.id),
					),
					isNull(organizations.tombstoneAt),
				),
			);

		const organizationIds = organizationsWithMembers.map(
			(row) => row.organization.id,
		);

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
			const activeOrgInfo = organizationsWithMembers.find(
				(row) => row.organization.id === activeOrganizationId,
			);
			if (activeOrgInfo) {
				// Count all members in the organization
				const orgMemberCountResult = await db()
					.select({ value: sql<number>`COUNT(*)` })
					.from(organizationMembers)
					.where(
						eq(
							organizationMembers.organizationId,
							activeOrgInfo.organization.id,
						),
					);
				const orgMemberCount = orgMemberCountResult[0]?.value || 0;

				// Count all videos shared with the organization (via sharedVideos table)
				const orgVideoCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${sharedVideos.videoId})`,
					})
					.from(sharedVideos)
					.where(
						eq(sharedVideos.organizationId, activeOrgInfo.organization.id),
					);
				const orgVideoCount = orgVideoCountResult[0]?.value || 0;

				const userCapsCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${videos.id})`,
					})
					.from(videos)
					.where(
						and(
							eq(videos.orgId, activeOrgInfo.organization.id),
							eq(videos.ownerId, user.id),
						),
					);

				userCapsCount = userCapsCountResult[0]?.value || 0;

				const allSpacesEntry = await Effect.gen(function* () {
					const imageUploads = yield* ImageUploads;

					const iconUrl = activeOrgInfo.organization.iconUrl;

					return {
						id: activeOrgInfo.organization.id,
						primary: true,
						privacy: "Public",
						name: `All ${activeOrgInfo.organization.name}`,
						description: `View all content in ${activeOrgInfo.organization.name}`,
						organizationId: activeOrgInfo.organization.id,
						iconUrl: iconUrl
							? yield* imageUploads.resolveImageUrl(iconUrl)
							: null,
						memberCount: orgMemberCount,
						createdById: activeOrgInfo.organization.ownerId,
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
			organizationsWithMembers
				.reduce((acc: (typeof organizations.$inferSelect)[], row) => {
					const existingOrganization = acc.find(
						(o) => o.id === row.organization.id,
					);
					if (!existingOrganization) {
						acc.push(row.organization);
					}
					return acc;
				}, [])
				.map(
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

						const totalInvitesResult = yield* db.use((db) =>
							db
								.select({
									value: sql<number>`
                ${count(organizationMembers.id)} + ${count(
									organizationInvites.id,
								)}
              `,
								})
								.from(organizations)
								.leftJoin(
									organizationMembers,
									eq(organizations.id, organizationMembers.organizationId),
								)
								.leftJoin(
									organizationInvites,
									eq(organizations.id, organizationInvites.organizationId),
								)
								.where(
									and(
										eq(organizations.ownerId, organization.ownerId),
										isNull(organizations.tombstoneAt),
									),
								),
						);

						const totalInvites = totalInvitesResult[0]?.value || 0;

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
