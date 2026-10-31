import type { Connection, RowDataPacket } from "mysql2/promise";
import {
	activationQuery,
	batchActivationQuery,
	batchLegacyActivationQuery,
	legacyActivationQuery,
} from "./activation";
import { activationSignalsAfter, inFreeExperiment } from "./experiment";
import {
	type CapUser,
	isoDate,
	type License,
	type Membership,
	type ProfileInput,
} from "./profile";
import { placeholders } from "./sql";

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

const profileUserColumns = `
	SELECT u.id,u.email,u.name,u.lastName,u.emailVerified,u.stripeCustomerId,
		u.stripeSubscriptionStatus,u.thirdPartyStripeSubscriptionId,u.inviteQuota,u.created_at,
		u.defaultOrgId,u.marketingOrigin,
		EXISTS(SELECT 1 FROM accounts a WHERE a.userId = u.id LIMIT 1) AS hasAccount,
		EXISTS(SELECT 1 FROM accounts a WHERE a.userId = u.id AND BINARY a.provider = 'workos' LIMIT 1) AS hasWorkosAccount,
		EXISTS(SELECT 1 FROM organization_invites i WHERE i.invitedEmail = u.email AND i.status IN ('pending','accepted') LIMIT 1) AS hasInvite,
		EXISTS(SELECT 1 FROM organization_invites i WHERE i.invitedEmail = u.email AND BINARY i.status = 'pending' LIMIT 1) AS hasPendingInvite
	FROM users u`;

export const profileUserQuery = `${profileUserColumns}
	WHERE u.id = ?
`;

export const batchProfileUserQuery = (users: number) => `${profileUserColumns}
	WHERE u.id IN (${placeholders(users)})
`;

const membershipColumns =
	"SELECT m.userId,m.organizationId,m.hasProSeat,o.ownerId,o.tombstoneAt,o.workosConnectionId,o.createdAt FROM organization_members m JOIN organizations o ON o.id=m.organizationId";

export const batchMembershipQuery = (users: number) =>
	`${membershipColumns} WHERE m.userId IN (${placeholders(users)})`;

const licenseColumns = (kind: License["kind"], table: string, emails: string) =>
	`SELECT FIELD(u.email,${emails}) AS requestIndex,u.email,l.subscriptionActive,l.nextRenewalDate,'${kind}' AS kind FROM ${table} l JOIN user u ON u.id=l.userId WHERE u.email IN (${emails})`;

export const batchLicenseQuery = (emails: number) =>
	`${licenseColumns("desktop", "commercialLicenses", placeholders(emails))} UNION ALL ${licenseColumns("selfhosted", "selfHostedLicenses", placeholders(emails))}`;

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

type Activation = {
	hasVideo: number | boolean | null;
	hasSharedVideo: number | boolean | null;
	hasPendingUpload?: number | null;
	lastActivationNotificationAt?: string | null;
};

const noActivation: Activation = {
	hasPendingUpload: null,
	hasVideo: null,
	hasSharedVideo: null,
	lastActivationNotificationAt: null,
};

function profileSource(
	record: RuntimeUser & UserSignals,
	memberships: Membership[],
	activation: Activation | undefined,
	licenses: License[],
	now: Date,
): LoopsProfileSource {
	const { hasAccount, hasWorkosAccount, hasInvite, hasPendingInvite, ...user } =
		record;
	return {
		input: {
			source: { email: user.email },
			user,
			memberships,
			licenses,
			invited: Boolean(hasInvite),
			sso: Boolean(hasWorkosAccount),
			hasVideo: Boolean(activation?.hasVideo),
			hasSharedVideo: Boolean(activation?.hasSharedVideo),
			lastActivationNotificationAt: activation?.lastActivationNotificationAt,
			hasPendingUpload: Boolean(activation?.hasPendingUpload),
			now,
		},
		signedUp: Boolean(user.emailVerified || hasAccount),
		pendingInvite: Boolean(hasPendingInvite),
		stripeCustomerId: user.stripeCustomerId,
	};
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
	const memberships = await rows<Membership>(
		cap,
		`${membershipColumns} WHERE m.userId=?`,
		[userId],
	);
	const [activation] = inFreeExperiment(
		isoDate(record.created_at),
		activationSignalsAfter,
	)
		? await rows<Activation>(cap, activationQuery, [userId])
		: await rows<Activation>(cap, legacyActivationQuery, [userId, userId]);
	const entitlement = await rows<License>(
		licenses,
		"SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'desktop' AS kind FROM commercialLicenses l JOIN user u ON u.id=l.userId WHERE u.email=? UNION ALL SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'selfhosted' AS kind FROM selfHostedLicenses l JOIN user u ON u.id=l.userId WHERE u.email=?",
		[record.email, record.email],
	);
	return profileSource(
		record,
		memberships,
		activation,
		entitlement,
		new Date(),
	);
}

// Ids are matched case-insensitively, like the column collation the
// single-user reads compare with.
const idKey = (id: string) => id.toLowerCase();

function groupBy<T>(items: T[], key: (item: T) => string) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = groups.get(key(item));
		if (group) group.push(item);
		else groups.set(key(item), [item]);
	}
	return groups;
}

export async function readLoopsProfiles(
	cap: Connection,
	licenses: Connection,
	userIds: string[],
): Promise<Map<string, LoopsProfileSource>> {
	const profiles = new Map<string, LoopsProfileSource>();
	if (!userIds.length) return profiles;
	const records = await rows<RuntimeUser & UserSignals>(
		cap,
		batchProfileUserQuery(userIds.length),
		userIds,
	);
	if (!records.length) return profiles;
	const ids = records.map((record) => record.id);
	const recent = records
		.filter((record) =>
			inFreeExperiment(isoDate(record.created_at), activationSignalsAfter),
		)
		.map((record) => record.id);
	const legacy = records
		.filter(
			(record) =>
				!inFreeExperiment(isoDate(record.created_at), activationSignalsAfter),
		)
		.map((record) => record.id);
	const emails = records.map((record) => record.email);
	const [memberships, recentActivation, legacyActivation, entitlements] =
		await Promise.all([
			rows<Membership>(cap, batchMembershipQuery(ids.length), ids),
			recent.length
				? rows<Activation & { userId: string }>(
						cap,
						batchActivationQuery(recent.length),
						recent,
					)
				: [],
			legacy.length
				? rows<Activation & { userId: string }>(
						cap,
						batchLegacyActivationQuery(legacy.length),
						legacy,
					)
				: [],
			rows<License & { requestIndex: number }>(
				licenses,
				batchLicenseQuery(emails.length),
				[...emails, ...emails, ...emails, ...emails],
			),
		]);
	const membershipsByUser = groupBy(memberships, (row) => idKey(row.userId));
	const activationByUser = new Map(
		[...recentActivation, ...legacyActivation].map(
			({ userId, ...activation }) => [idKey(userId), activation],
		),
	);
	const licensesByEmail = groupBy(
		entitlements,
		(row) => emails[row.requestIndex - 1] ?? "",
	);
	const recordsById = new Map(
		records.map((record) => [idKey(record.id), record]),
	);
	const now = new Date();
	for (const userId of userIds) {
		const record = recordsById.get(idKey(userId));
		if (!record) continue;
		profiles.set(
			userId,
			profileSource(
				record,
				membershipsByUser.get(idKey(record.id)) ?? [],
				activationByUser.get(idKey(record.id)) ?? noActivation,
				(licensesByEmail.get(record.email) ?? []).map(
					({ requestIndex: _, ...license }) => license,
				),
				now,
			),
		);
	}
	return profiles;
}
