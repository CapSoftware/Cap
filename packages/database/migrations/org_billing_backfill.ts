import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";

const CHUNK_SIZE = 100;

interface UserWithBilling {
	id: User.UserId;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
	stripeSubscriptionStatus: string | null;
	stripeSubscriptionPriceId: string | null;
	inviteQuota: number;
}

interface OrgWithStats {
	id: Organisation.OrganisationId;
	ownerId: User.UserId;
	memberCount: number;
	sharedVideoCount: number;
}

async function findBestOrgForUser(userId: User.UserId): Promise<Organisation.OrganisationId | null> {
	const orgsOwned = await db()
		.select({
			id: organizations.id,
			ownerId: organizations.ownerId,
		})
		.from(organizations)
		.where(
			and(eq(organizations.ownerId, userId), isNull(organizations.tombstoneAt)),
		);

	if (orgsOwned.length === 0) {
		return null;
	}

	const orgStats: OrgWithStats[] = [];

	for (const org of orgsOwned) {
		const memberCountResult = await db()
			.select({ value: count(organizationMembers.id) })
			.from(organizationMembers)
			.where(eq(organizationMembers.organizationId, org.id));

		const sharedVideoCountResult = await db()
			.select({ value: count(sharedVideos.id) })
			.from(sharedVideos)
			.where(eq(sharedVideos.organizationId, org.id));

		orgStats.push({
			id: org.id,
			ownerId: org.ownerId,
			memberCount: memberCountResult[0]?.value || 0,
			sharedVideoCount: sharedVideoCountResult[0]?.value || 0,
		});
	}

	orgStats.sort((a, b) => {
		if (a.memberCount !== b.memberCount) {
			return b.memberCount - a.memberCount;
		}
		return b.sharedVideoCount - a.sharedVideoCount;
	});

	return orgStats[0]?.id || null;
}

async function migrateUserBillingToOrg(user: UserWithBilling): Promise<void> {
	const targetOrgId = await findBestOrgForUser(user.id);

	if (!targetOrgId) {
		console.log(`  ⚠️ No organizations found for user ${user.id}, skipping`);
		return;
	}

	const paidSeats = user.inviteQuota || 0;

	await db()
		.update(organizations)
		.set({
			stripeCustomerId: user.stripeCustomerId,
			stripeSubscriptionId: user.stripeSubscriptionId,
			stripeSubscriptionStatus: user.stripeSubscriptionStatus,
			stripeSubscriptionPriceId: user.stripeSubscriptionPriceId,
			paidSeats: paidSeats,
		})
		.where(eq(organizations.id, targetOrgId));

	console.log(
		`  ✅ Migrated billing to org ${targetOrgId} with ${paidSeats} paid seats`,
	);

	const membersInOrg = await db()
		.select({
			id: organizationMembers.id,
			userId: organizationMembers.userId,
		})
		.from(organizationMembers)
		.where(eq(organizationMembers.organizationId, targetOrgId))
		.limit(paidSeats > 0 ? paidSeats : 1);

	if (membersInOrg.length > 0 && paidSeats > 0) {
		const memberIdsToUpgrade = membersInOrg
			.slice(0, paidSeats)
			.map((m) => m.id);

		await db()
			.update(organizationMembers)
			.set({ seatType: "paid" })
			.where(
				sql`${organizationMembers.id} IN (${sql.join(
					memberIdsToUpgrade.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			);

		console.log(
			`  ✅ Upgraded ${memberIdsToUpgrade.length} members to paid seats`,
		);
	}
}

async function getInitialStats(): Promise<void> {
	console.log("📈 Getting initial stats...");

	const usersWithBilling = await db()
		.select({ count: sql<number>`count(*)` })
		.from(users)
		.where(isNotNull(users.stripeSubscriptionId));

	const orgsWithBilling = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizations)
		.where(isNotNull(organizations.stripeSubscriptionId));

	const totalOrgs = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizations)
		.where(isNull(organizations.tombstoneAt));

	console.log("📊 Initial stats:");
	console.log(`  Users with billing: ${usersWithBilling[0]?.count || 0}`);
	console.log(`  Orgs with billing: ${orgsWithBilling[0]?.count || 0}`);
	console.log(`  Total active orgs: ${totalOrgs[0]?.count || 0}`);
	console.log("");
}

async function backfillOrgBilling(): Promise<void> {
	console.log("💳 Starting org billing backfill...");

	let processed = 0;
	let offset = 0;

	while (true) {
		const usersWithBilling = await db()
			.select({
				id: users.id,
				stripeCustomerId: users.stripeCustomerId,
				stripeSubscriptionId: users.stripeSubscriptionId,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				stripeSubscriptionPriceId: users.stripeSubscriptionPriceId,
				inviteQuota: users.inviteQuota,
			})
			.from(users)
			.where(isNotNull(users.stripeSubscriptionId))
			.limit(CHUNK_SIZE)
			.offset(offset);

		if (usersWithBilling.length === 0) break;

		for (const user of usersWithBilling) {
			console.log(`\n👤 Processing user ${user.id}...`);
			await migrateUserBillingToOrg(user);
			processed++;
		}

		offset += CHUNK_SIZE;
		console.log(`\n📝 Processed ${processed} users so far...`);
	}

	console.log(
		`\n✅ Org billing backfill complete. Processed ${processed} users.`,
	);
}

async function validateBackfill(): Promise<void> {
	console.log("\n🔍 Validating backfill results...");

	const orgsWithBilling = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizations)
		.where(isNotNull(organizations.stripeSubscriptionId));

	const paidMembers = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizationMembers)
		.where(eq(organizationMembers.seatType, "paid"));

	const freeMembers = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizationMembers)
		.where(eq(organizationMembers.seatType, "free"));

	console.log("📊 Validation results:");
	console.log(`  Orgs with billing: ${orgsWithBilling[0]?.count || 0}`);
	console.log(`  Paid seat members: ${paidMembers[0]?.count || 0}`);
	console.log(`  Free seat members: ${freeMembers[0]?.count || 0}`);
}

export async function runOrgBillingBackfill(): Promise<void> {
	console.log("🚀 Starting org billing backfill script");
	console.log(`📦 Processing in chunks of ${CHUNK_SIZE} users\n`);

	await getInitialStats();
	await backfillOrgBilling();
	await validateBackfill();

	console.log("\n🎉 Migration complete!");
}
