import { parseArgs } from "node:util";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { LoopsApi, LoopsApiError } from "./api";
import { type Consent, classifyProfile, normalizeEmail } from "./profile";
import { readSources } from "./sources";
import {
	contactUpdate,
	profileFingerprint,
	type RemoteContact,
} from "./sync-policy";

type Record = RowDataPacket & {
	emailHash: string;
	email: string;
	userId: string | null;
	consent: Consent;
	teammate: number;
	imported: number;
	lastAudience: string | null;
	lastProfileHash: string | null;
	lastSyncedAt: string | null;
	createdAt: string;
};
const { values } = parseArgs({
	options: {
		apply: { type: "boolean", default: false },
		team: { type: "string" },
		"mailing-list": { type: "string" },
		limit: { type: "string", default: "100" },
	},
});
const limit = Number(values.limit);
if (
	!values.team ||
	!values["mailing-list"] ||
	!Number.isSafeInteger(limit) ||
	limit < 1 ||
	limit > 1000
)
	throw new Error("Pass --team, --mailing-list and --limit 1..1000");
const listId = values["mailing-list"];
const capUrl = process.env.DATABASE_URL;
const licenseUrl = process.env.LOOPS_LICENSE_DATABASE_URL;
if (!capUrl || !licenseUrl)
	throw new Error(
		"DATABASE_URL and read-only LOOPS_LICENSE_DATABASE_URL are required",
	);
if (values.apply && process.env.LOOPS_SYNC_ENABLED !== "true")
	throw new Error("LOOPS_SYNC_ENABLED=true is required to apply");
const api = new LoopsApi(process.env.LOOPS_API_KEY ?? "");
const identity = await api.request<{ success: boolean; teamName: string }>(
	"api-key",
);
if (!identity.success || identity.teamName !== values.team)
	throw new Error("Wrong Loops team");
const lists = await api.request<{ id: string }[]>("lists");
if (!lists.some((list) => list.id === listId))
	throw new Error("Unknown mailing list");
const source = await readSources(capUrl, licenseUrl);
const group = <T>(items: T[], key: (item: T) => string) => {
	const grouped = new Map<string, T[]>();
	for (const item of items) {
		const id = key(item);
		grouped.set(id, [...(grouped.get(id) ?? []), item]);
	}
	return grouped;
};
const users = new Map(source.users.map((user) => [user.id, user]));
const members = group(source.memberships, (member) => member.userId);
const licenses = group(source.licenses, (license) =>
	normalizeEmail(license.email),
);
const invited = new Set(
	source.invites.map((invite) => normalizeEmail(invite.invitedEmail)),
);
const sso = new Set(source.sso.map((account) => account.userId));
const videos = new Map(source.videos.map((video) => [video.ownerId, video]));
const db = await mysql.createConnection({ uri: capUrl, dateStrings: true });
let updated = 0;
let changed = 0;
try {
	const [records] = await db.query<Record[]>(
		"SELECT * FROM marketing_contacts WHERE email IS NOT NULL ORDER BY lastSyncedAt,emailHash",
	);
	for (const row of records) {
		const user = row.userId ? users.get(row.userId) : undefined;
		const identityMissing =
			Boolean(row.userId) &&
			(!user || normalizeEmail(user.email) !== normalizeEmail(row.email));
		const consent = identityMissing ? "unknown" : row.consent;
		const video = user ? videos.get(user.id) : undefined;
		const profile = classifyProfile({
			source: {
				email: row.email,
				created_at: row.createdAt,
				subscribed: consent === "subscribed" ? "true" : "false",
				tags:
					row.lastAudience === "customer" || row.lastAudience === "unknown"
						? "customer"
						: "",
			},
			user,
			memberships: user ? (members.get(user.id) ?? []) : [],
			licenses: licenses.get(normalizeEmail(row.email)) ?? [],
			invited: invited.has(normalizeEmail(row.email)),
			sso: user ? sso.has(user.id) : false,
			teammateLatch: Boolean(row.teammate),
			hasVideo: Boolean(video?.total),
			hasSharedVideo: Boolean(video?.hasPublicVideo),
			now: source.verifiedAt,
		});
		profile.capConsent = consent;
		profile.subscribed = consent === "subscribed";
		if (row.userId) profile.userId = row.userId;
		const fingerprint = profileFingerprint(profile);
		const recheckConsent =
			!row.lastSyncedAt ||
			Date.now() - Date.parse(`${row.lastSyncedAt.replace(" ", "T")}Z`) >
				24 * 60 * 60_000;
		if (row.lastProfileHash === fingerprint && !recheckConsent) continue;
		changed++;
		if (updated >= limit) continue;
		if (!values.apply) {
			updated++;
			continue;
		}
		if (Date.now() - source.verifiedAt.getTime() > 10 * 60_000)
			throw new Error(
				"Source snapshot expired; rerun to refresh remaining contacts",
			);
		const remote = await api.request<RemoteContact[]>(
			`contacts/find?email=${encodeURIComponent(row.email)}`,
		);
		if (remote.length > 1) throw new Error("Ambiguous Loops contact");
		const contact = remote[0];
		if (!contact) {
			if (!row.imported && !row.lastSyncedAt && consent === "subscribed") {
				try {
					await api.request("contacts/create", "POST", {
						...profile,
						mailingLists: { [listId]: true },
					});
				} catch (error) {
					if (error instanceof LoopsApiError && error.status === 409) continue;
					throw error;
				}
			} else {
				await db.execute(
					"UPDATE marketing_contacts SET consent=CASE WHEN consent IN ('unsubscribed','suppressed') THEN consent ELSE 'unknown' END,lastSyncedAt=CURRENT_TIMESTAMP,lastProfileHash=?,updatedAt=CURRENT_TIMESTAMP WHERE emailHash=?",
					[fingerprint, row.emailHash],
				);
				updated++;
				continue;
			}
		} else {
			await api.request(
				"contacts/update",
				"PUT",
				contactUpdate(profile, contact, listId),
			);
			if (!contact.subscribed) {
				profile.capConsent = "unsubscribed";
			}
			profile.capTeammate ||= contact.capTeammate === true;
		}
		await db.execute(
			"UPDATE marketing_contacts SET consent=CASE WHEN consent IN ('unsubscribed','suppressed') THEN consent ELSE ? END,teammate=teammate OR ?,lastAudience=?,lastProfileHash=?,lastSyncedAt=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP WHERE emailHash=?",
			[
				profile.capConsent,
				profile.capTeammate,
				profile.capTeammate ? "teammate" : profile.capAudience,
				fingerprint,
				row.emailHash,
			],
		);
		updated++;
	}
	console.log(
		JSON.stringify({
			mode: values.apply ? "apply held contacts" : "dry run",
			changed,
			processed: updated,
			remaining: Math.max(0, changed - updated),
			lifecycleEnabled: false,
		}),
	);
} finally {
	await db.end();
}
