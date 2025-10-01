import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

const CHUNK_SIZE = 500;

interface BackfillStats {
	videosProcessed: number;
	videosUpdated: number;
	usersProcessed: number;
	usersUpdated: number;
}

async function backfillVideoOrgIds(): Promise<{
	processed: number;
	updated: number;
}> {
	console.log("🎬 Starting video orgId backfill...");

	let updated = 0;

	while (true) {
		// Find videos that need orgId backfilled
		const videosToUpdate = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				orgId: videos.orgId,
			})
			.from(videos)
			.innerJoin(users, eq(videos.ownerId, users.id))
			.where(and(isNull(videos.orgId), isNotNull(users.activeOrganizationId)))
			.limit(CHUNK_SIZE);

		if (videosToUpdate.length === 0) break;

		// Update videos in batch using subquery
		const videoIds = videosToUpdate.map((v) => v.id);

		const updateResult = await db()
			.update(videos)
			.set({
				orgId: sql`(
          SELECT u.activeOrganizationId
          FROM users u
          WHERE u.id = videos.ownerId
          AND u.activeOrganizationId IS NOT NULL
        )`,
			})
			.where(
				and(
					sql`videos.id IN (${sql.join(
						videoIds.map((id) => sql`${id}`),
						sql`, `,
					)})`,
					isNull(videos.orgId),
				),
			);

		const rowsUpdated = updateResult.rowsAffected || 0;
		updated += rowsUpdated;

		console.log(`📹 Assigned orgId to ${updated} videos`);
	}

	return { updated };
}

async function backfillUserDefaultOrgIds(): Promise<{
	processed: number;
	updated: number;
}> {
	console.log("👤 Starting user defaultOrgId backfill...");

	let updated = 0;

	const updateResult = await db()
		.update(users)
		.set({
			defaultOrgId: users.activeOrganizationId,
		})
		.where(
			and(isNull(users.defaultOrgId), isNotNull(users.activeOrganizationId)),
		);
	const rowsUpdated = updateResult.rowsAffected || 0;
	updated += rowsUpdated;

	console.log(`👥 Assigned defaultOrgId to ${updated} users`);
}

async function validateBackfill(): Promise<void> {
	console.log("🔍 Validating backfill results...");

	// Count videos still missing orgId where owner has activeOrganizationId
	const videosWithoutOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(and(isNull(videos.orgId), isNotNull(users.activeOrganizationId)));

	// Count users still missing defaultOrgId where they have activeOrganizationId
	const usersWithoutDefaultOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users)
		.where(
			and(isNull(users.defaultOrgId), isNotNull(users.activeOrganizationId)),
		);

	// Count videos with mismatched orgId (different from owner's activeOrganizationId)
	const videosWithMismatchedOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(
			and(
				isNotNull(videos.orgId),
				isNotNull(users.activeOrganizationId),
				sql`videos.orgId != users.activeOrganizationId`,
			),
		);

	// Count users with mismatched defaultOrgId (different from activeOrganizationId)
	const usersWithMismatchedDefaultOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users)
		.where(
			and(
				isNotNull(users.defaultOrgId),
				isNotNull(users.activeOrganizationId),
				sql`users.defaultOrgId != users.activeOrganizationId`,
			),
		);

	console.log("📊 Validation results:");
	console.log(
		`  Videos still missing orgId: ${videosWithoutOrgId[0]?.count || 0}`,
	);
	console.log(
		`  Users still missing defaultOrgId: ${usersWithoutDefaultOrgId[0]?.count || 0}`,
	);
	console.log(
		`  Videos with mismatched orgId: ${videosWithMismatchedOrgId[0]?.count || 0}`,
	);
	console.log(
		`  Users with mismatched defaultOrgId: ${usersWithMismatchedDefaultOrgId[0]?.count || 0}`,
	);
}

async function getInitialStats(): Promise<void> {
	console.log("📈 Getting initial stats...");

	const totalVideos = await db()
		.select({ count: sql<number>`count(*)` })
		.from(videos);

	const videosWithOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(videos)
		.where(isNotNull(videos.orgId));

	const videosNeedingOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(and(isNull(videos.orgId), isNotNull(users.activeOrganizationId)));

	const totalUsers = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users);

	const usersWithDefaultOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users)
		.where(isNotNull(users.defaultOrgId));

	const usersNeedingDefaultOrgId = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users)
		.where(
			and(isNull(users.defaultOrgId), isNotNull(users.activeOrganizationId)),
		);

	console.log("📊 Initial stats:");
	console.log(`  Total videos: ${totalVideos[0]?.count || 0}`);
	console.log(`  Videos with orgId: ${videosWithOrgId[0]?.count || 0}`);
	console.log(`  Videos needing orgId: ${videosNeedingOrgId[0]?.count || 0}`);
	console.log(`  Total users: ${totalUsers[0]?.count || 0}`);
	console.log(
		`  Users with defaultOrgId: ${usersWithDefaultOrgId[0]?.count || 0}`,
	);
	console.log(
		`  Users needing defaultOrgId: ${usersNeedingDefaultOrgId[0]?.count || 0}`,
	);
	console.log("");
}

async function main(): Promise<void> {
	console.log("🚀 Starting orgId backfill script");
	console.log(`📦 Processing in chunks of ${CHUNK_SIZE} rows\n`);

	try {
		await getInitialStats();

		await backfillVideoOrgIds();
		console.log(`✅ Video backfill complete\n`);

		await backfillUserDefaultOrgIds();
		console.log(`✅ User backfill complete\n`);

		await validateBackfill();
		process.exit(0);
	} catch (error) {
		console.error("❌ Error during backfill:", error);
		process.exit(1);
	}
}

// Run the script
main().catch((error) => {
	console.error("❌ Unhandled error:", error);
	process.exit(1);
});
