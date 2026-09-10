import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import type { CapUser, License, Membership } from "./profile";

const rows = async <T>(db: Connection, sql: string): Promise<T[]> => {
	const [result] = await db.query<(RowDataPacket & T)[]>(sql);
	return result;
};

export async function readSources(capUrl: string, licenseUrl: string) {
	const cap = await mysql.createConnection({ uri: capUrl, dateStrings: true });
	try {
		const license = await mysql.createConnection({
			uri: licenseUrl,
			dateStrings: true,
		});
		try {
			const users = await rows<CapUser>(
				cap,
				"SELECT id,email,name,lastName,stripeSubscriptionStatus,thirdPartyStripeSubscriptionId,created_at,defaultOrgId,marketingOrigin FROM users",
			);
			const memberships = await rows<Membership>(
				cap,
				"SELECT m.userId,m.organizationId,m.hasProSeat,o.ownerId,o.tombstoneAt,o.workosConnectionId,o.createdAt FROM organization_members m JOIN organizations o ON o.id=m.organizationId",
			);
			const invites = await rows<{ invitedEmail: string }>(
				cap,
				"SELECT invitedEmail FROM organization_invites WHERE status IN ('pending','accepted')",
			);
			const sso = await rows<{ userId: string }>(
				cap,
				"SELECT DISTINCT userId FROM accounts WHERE provider='workos'",
			);
			const videos = await rows<{
				ownerId: string;
				total: number;
				hasPublicVideo: number;
			}>(
				cap,
				"SELECT ownerId,COUNT(*) AS total,MAX(CASE WHEN public=1 THEN 1 ELSE 0 END) AS hasPublicVideo FROM videos GROUP BY ownerId",
			);
			const licenses = await rows<License>(
				license,
				"SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'desktop' AS kind FROM commercialLicenses l JOIN user u ON u.id=l.userId UNION ALL SELECT u.email,l.subscriptionActive,l.nextRenewalDate,'selfhosted' AS kind FROM selfHostedLicenses l JOIN user u ON u.id=l.userId",
			);
			return {
				users,
				memberships,
				invites,
				sso,
				videos,
				licenses,
				verifiedAt: new Date(),
			};
		} finally {
			await license.end();
		}
	} finally {
		await cap.end();
	}
}
