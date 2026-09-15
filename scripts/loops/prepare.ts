import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	type CapUser,
	classifyProfile,
	emailHash,
	type License,
	type Membership,
	normalizeEmail,
	type SourceContact,
} from "./profile";

const { values } = parseArgs({
	options: { sources: { type: "string" }, output: { type: "string" } },
});
if (!values.sources || !values.output)
	throw new Error("Pass private --sources and --output directories");
const sourceDirectory = values.sources;
const read = async <T>(name: string): Promise<T[]> => {
	const filename = path.join(sourceDirectory, `${name}.json`);
	if (Date.now() - (await stat(filename)).mtimeMs > 24 * 60 * 60_000)
		throw new Error(`Refresh stale source ${name}`);
	return JSON.parse(await readFile(filename, "utf8"));
};
const [source, users, members, licenses, invites, sso, videos] =
	await Promise.all([
		read<SourceContact>("bento-contacts"),
		read<CapUser>("cap-users"),
		read<Membership>("cap-memberships"),
		read<License>("license-licenses"),
		read<{ invitedEmail: string; status: string; expiresAt: string }>(
			"cap-invites",
		),
		read<{ userId: string }>("cap-sso"),
		read<{ ownerId: string; total: number; hasPublicVideo: number }>(
			"cap-videos",
		),
	]);
const group = <T>(rows: T[], key: (row: T) => string) => {
	const result = new Map<string, T[]>();
	for (const row of rows) {
		const id = key(row);
		result.set(id, [...(result.get(id) ?? []), row]);
	}
	return result;
};
const byEmail = group(users, (user) => normalizeEmail(user.email));
const memberMap = group(members, (member) => member.userId);
const licenseMap = group(licenses, (license) => normalizeEmail(license.email));
const invited = new Set(
	invites.map((invite) => normalizeEmail(invite.invitedEmail)),
);
const ssoUsers = new Set(sso.map((account) => account.userId));
const videoMap = new Map(videos.map((video) => [video.ownerId, video]));
const seen = new Set<string>();
const now = new Date();
const profiles = source.map((contact) => {
	if (
		!["unsubscribed_at", "unsubscribed_reason", "flag"].every(
			(key) => typeof contact[key] === "string",
		)
	)
		throw new Error("Source is missing Bento subscription/suppression columns");
	const email = normalizeEmail(contact.email);
	if (!email || seen.has(email))
		throw new Error("Source contains an empty or duplicate normalized email");
	seen.add(email);
	const matchingUsers = byEmail.get(email) ?? [];
	if (matchingUsers.length > 1)
		throw new Error(
			"Multiple Cap identities match an email; resolve before importing",
		);
	const user = matchingUsers[0];
	const video = user ? videoMap.get(user.id) : undefined;
	return classifyProfile({
		source: contact,
		user,
		memberships: user ? (memberMap.get(user.id) ?? []) : [],
		licenses: licenseMap.get(email) ?? [],
		invited: invited.has(email),
		sso: user ? ssoUsers.has(user.id) : false,
		hasVideo: Boolean(video?.total),
		hasSharedVideo: Boolean(video?.hasPublicVideo),
		now,
	});
});
const positive = profiles.filter((profile) => profile.subscribed);
const registry = profiles.map((profile) => ({
	emailHash: emailHash(profile.email),
	consent: profile.capConsent,
	teammate: profile.capTeammate,
	userId: profile.userId.startsWith("bento:") ? null : profile.userId,
	source: "bento-migration",
	imported: true,
}));
await mkdir(values.output, { recursive: true, mode: 0o700 });
await chmod(values.output, 0o700);
const write = async (name: string, content: string) => {
	const filename = path.join(values.output ?? "", name);
	await writeFile(filename, content, { mode: 0o600 });
	await chmod(filename, 0o600);
};
await write("contacts.json", JSON.stringify(positive));
await write("consent-registry.json", JSON.stringify(registry));
const keys = Object.keys(
	positive[0] ?? {},
) as (keyof (typeof positive)[number])[];
const csvCell = (value: unknown) =>
	`"${String(value ?? "").replaceAll('"', '""')}"`;
await write(
	"contacts.csv",
	[
		keys.map(csvCell).join(","),
		...positive.map((profile) =>
			keys.map((key) => csvCell(profile[key])).join(","),
		),
	].join("\r\n"),
);
const counts = (key: "capAudience" | "capConsent") =>
	profiles.reduce<Record<string, number>>((result, row) => {
		result[row[key]] = (result[row[key]] ?? 0) + 1;
		return result;
	}, {});
const summary = {
	preparedAt: now.toISOString(),
	source: profiles.length,
	import: positive.length,
	excluded: profiles.length - positive.length,
	consent: counts("capConsent"),
	audiences: counts("capAudience"),
	importAudiences: positive.reduce<Record<string, number>>((result, row) => {
		result[row.capAudience] = (result[row.capAudience] ?? 0) + 1;
		return result;
	}, {}),
	allImportsHeld: positive.every(
		(row) => !row.capLifecycleEnabled && row.capLifecycleStage === "idle",
	),
};
await write("summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
