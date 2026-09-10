import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { type Consent, type ContactProfile, emailHash } from "./profile";
import { mergeConsent } from "./sync-policy";

type Entry = {
	emailHash: string;
	consent: Consent;
	teammate: boolean;
	userId: string | null;
	source: string;
	imported: boolean;
};
const { values } = parseArgs({
	options: {
		registry: { type: "string" },
		contacts: { type: "string" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.registry || !values.contacts)
	throw new Error(
		"Pass --registry and --contacts from the private prepared import",
	);
const registry: Entry[] = JSON.parse(await readFile(values.registry, "utf8"));
const profiles: ContactProfile[] = JSON.parse(
	await readFile(values.contacts, "utf8"),
);
const byHash = new Map(
	profiles.map((profile) => [emailHash(profile.email), profile]),
);
if (new Set(registry.map((entry) => entry.emailHash)).size !== registry.length)
	throw new Error("Duplicate consent entries");
for (const row of registry) {
	if (
		!/^[a-f0-9]{64}$/.test(row.emailHash) ||
		!["subscribed", "unsubscribed", "suppressed", "unknown"].includes(
			row.consent,
		)
	)
		throw new Error("Invalid consent registry");
	if (row.consent === "subscribed" && !byHash.has(row.emailHash))
		throw new Error("Missing positive contact");
}
console.log(
	JSON.stringify({
		mode: values.apply ? "apply" : "dry run",
		registry: registry.length,
		positive: profiles.length,
	}),
);
if (!values.apply) process.exit(0);
if (process.env.LOOPS_SYNC_ENABLED !== "true")
	throw new Error("LOOPS_SYNC_ENABLED=true is required for database writes");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = await mysql.createConnection(process.env.DATABASE_URL);
try {
	for (let offset = 0; offset < registry.length; offset += 500) {
		await db.beginTransaction();
		try {
			const batch = registry
				.slice(offset, offset + 500)
				.sort((a, b) => a.emailHash.localeCompare(b.emailHash));
			const [existing] = await db.query<
				(RowDataPacket & {
					emailHash: string;
					email: string | null;
					consent: Consent;
					teammate: number;
				})[]
			>(
				"SELECT emailHash,email,consent,teammate FROM marketing_contacts WHERE emailHash IN (?) ORDER BY emailHash FOR UPDATE",
				[batch.map((entry) => entry.emailHash)],
			);
			const current = new Map(
				existing.map((entry) => [entry.emailHash, entry]),
			);
			const inserts = batch.map((entry) => {
				const previous = current.get(entry.emailHash);
				const consent = mergeConsent(
					previous?.consent ?? "unknown",
					entry.consent,
				);
				const profile = byHash.get(entry.emailHash);
				const email =
					consent === "subscribed"
						? (profile?.email ?? null)
						: (previous?.email ?? null);
				const teammate = entry.teammate || Boolean(previous?.teammate);
				return [
					entry.emailHash,
					email,
					entry.userId,
					consent,
					entry.source,
					teammate,
					entry.imported,
					profile?.capAudience ?? null,
				];
			});
			await db.query(
				"INSERT INTO marketing_contacts (emailHash,email,userId,consent,source,teammate,imported,lastAudience) VALUES ? ON DUPLICATE KEY UPDATE email=COALESCE(email,VALUES(email)),consent=CASE WHEN consent='suppressed' OR VALUES(consent)='suppressed' THEN 'suppressed' WHEN consent='unsubscribed' OR VALUES(consent)='unsubscribed' THEN 'unsubscribed' WHEN consent='subscribed' OR VALUES(consent)='subscribed' THEN 'subscribed' ELSE 'unknown' END,teammate=teammate OR VALUES(teammate),imported=imported OR VALUES(imported),updatedAt=CURRENT_TIMESTAMP",
				[inserts],
			);
			await db.commit();
		} catch (error) {
			await db.rollback();
			throw error;
		}
		console.log(
			JSON.stringify({ seeded: Math.min(offset + 500, registry.length) }),
		);
	}
} finally {
	await db.end();
}
