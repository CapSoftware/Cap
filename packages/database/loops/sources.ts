import type { Connection, RowDataPacket } from "mysql2/promise";
import type { CapUser, License, Membership, ProfileInput } from "./profile";

type RuntimeUser = CapUser & {
	emailVerified: string | null;
	stripeCustomerId: string | null;
};

export type LoopsProfileSource = {
	input: ProfileInput & { user: CapUser };
	signedUp: boolean;
	pendingInvite: boolean;
	stripeCustomerId: string | null;
};

async function rows<T>(database: Connection, query: string, values: string[]) {
	const [result] = await database.execute<(RowDataPacket & T)[]>(query, values);
	return result;
}

export async function readLoopsProfile(
	cap: Connection,
	licenses: Connection,
	userId: string,
): Promise<LoopsProfileSource | null> {
	const [user] = await rows<RuntimeUser>(
		cap,
		"SELECT id,email,name,lastName,emailVerified,stripeCustomerId,stripeSubscriptionStatus,thirdPartyStripeSubscriptionId,created_at,defaultOrgId,marketingOrigin FROM users WHERE id=?",
		[userId],
	);
	if (!user) return null;
	const memberships = await rows<Membership>(
		cap,
		"SELECT m.userId,m.organizationId,m.hasProSeat,o.ownerId,o.tombstoneAt,o.workosConnectionId,o.createdAt FROM organization_members m JOIN organizations o ON o.id=m.organizationId WHERE m.userId=?",
		[userId],
	);
	const accounts = await rows<{ provider: string }>(
		cap,
		"SELECT provider FROM accounts WHERE userId=?",
		[userId],
	);
	const invites = await rows<{ status: string }>(
		cap,
		"SELECT status FROM organization_invites WHERE invitedEmail=? AND status IN ('pending','accepted')",
		[user.email],
	);
	const [video] = await rows<{ id: string }>(
		cap,
		"SELECT id FROM videos WHERE ownerId=? LIMIT 1",
		[userId],
	);
	const [shared] = await rows<{ id: string }>(
		cap,
		"SELECT id FROM videos WHERE ownerId=? AND public=1 LIMIT 1",
		[userId],
	);
	const entitlement = await rows<License>(
		licenses,
		"SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'desktop' AS kind FROM commercialLicenses l JOIN user u ON u.id=l.userId WHERE u.email=? UNION ALL SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'selfhosted' AS kind FROM selfHostedLicenses l JOIN user u ON u.id=l.userId WHERE u.email=?",
		[user.email, user.email],
	);
	return {
		input: {
			source: { email: user.email },
			user,
			memberships,
			licenses: entitlement,
			invited: invites.length > 0,
			sso: accounts.some((account) => account.provider === "workos"),
			hasVideo: Boolean(video),
			hasSharedVideo: Boolean(shared),
			now: new Date(),
		},
		signedUp: Boolean(user.emailVerified || accounts.length),
		pendingInvite: invites.some((invite) => invite.status === "pending"),
		stripeCustomerId: user.stripeCustomerId,
	};
}
