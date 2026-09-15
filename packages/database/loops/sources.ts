import type { Connection, RowDataPacket } from "mysql2/promise";
import { activationQuery, legacyActivationQuery } from "./activation";
import { activationSignalsAfter, inFreeExperiment } from "./experiment";
import {
	type CapUser,
	isoDate,
	type License,
	type Membership,
	type ProfileInput,
} from "./profile";

type RuntimeUser = CapUser & {
	emailVerified: string | null;
	stripeCustomerId: string | null;
};

type UserSignals = {
	hasAccount: number;
	hasWorkosAccount: number;
	hasInvite: number;
	hasPendingInvite: number;
};

export const profileUserQuery = `
	SELECT u.id,u.email,u.name,u.lastName,u.emailVerified,u.stripeCustomerId,
		u.stripeSubscriptionStatus,u.thirdPartyStripeSubscriptionId,u.created_at,
		u.defaultOrgId,u.marketingOrigin,
		EXISTS(SELECT 1 FROM accounts a WHERE a.userId = u.id LIMIT 1) AS hasAccount,
		EXISTS(SELECT 1 FROM accounts a WHERE a.userId = u.id AND BINARY a.provider = 'workos' LIMIT 1) AS hasWorkosAccount,
		EXISTS(SELECT 1 FROM organization_invites i WHERE i.invitedEmail = u.email AND i.status IN ('pending','accepted') LIMIT 1) AS hasInvite,
		EXISTS(SELECT 1 FROM organization_invites i WHERE i.invitedEmail = u.email AND BINARY i.status = 'pending' LIMIT 1) AS hasPendingInvite
	FROM users u
	WHERE u.id = ?
`;

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
	const [record] = await rows<RuntimeUser & UserSignals>(
		cap,
		profileUserQuery,
		[userId],
	);
	if (!record) return null;
	const { hasAccount, hasWorkosAccount, hasInvite, hasPendingInvite, ...user } =
		record;
	const memberships = await rows<Membership>(
		cap,
		"SELECT m.userId,m.organizationId,m.hasProSeat,o.ownerId,o.tombstoneAt,o.workosConnectionId,o.createdAt FROM organization_members m JOIN organizations o ON o.id=m.organizationId WHERE m.userId=?",
		[userId],
	);
	let activation: {
		hasVideo: number | boolean | null;
		hasSharedVideo: number | boolean | null;
		hasPendingUpload?: number | null;
		lastActivationNotificationAt?: string | null;
	};
	if (inFreeExperiment(isoDate(user.created_at), activationSignalsAfter)) {
		const [result] = await rows<typeof activation>(cap, activationQuery, [
			userId,
		]);
		activation = result;
	} else {
		const [result] = await rows<typeof activation>(cap, legacyActivationQuery, [
			userId,
			userId,
		]);
		activation = result;
	}
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
			invited: Boolean(hasInvite),
			sso: Boolean(hasWorkosAccount),
			hasVideo: Boolean(activation?.hasVideo),
			hasSharedVideo: Boolean(activation?.hasSharedVideo),
			lastActivationNotificationAt: activation?.lastActivationNotificationAt,
			hasPendingUpload: Boolean(activation?.hasPendingUpload),
			now: new Date(),
		},
		signedUp: Boolean(user.emailVerified || hasAccount),
		pendingInvite: Boolean(hasPendingInvite),
		stripeCustomerId: user.stripeCustomerId,
	};
}
