import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@cap/database";
import {
	authApiKeys,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videos,
	videoViewerGrants,
} from "@cap/database/schema";
import {
	getVideoOrganizationAccess,
	videoEmailAccessCondition,
} from "@cap/database/video-organization-access";
import { isEmailAllowedByRestriction } from "@cap/utils";
import { Organisation, Space, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { encode } from "next-auth/jwt";
import { directory, ids } from "./paths.mjs";

const organizationId = Organisation.OrganisationId.make(ids.organization);
const ownerId = User.UserId.make(ids.owner);
const memberId = User.UserId.make(ids.member);
const outsiderId = User.UserId.make(ids.outsider);
const outsideOrganizationId = Organisation.OrganisationId.make(
	ids.outsideOrganization,
);
const database = db();

await database
	.update(organizations)
	.set({ name: "Example Studio", videoSharingRestrictedToOrg: false })
	.where(eq(organizations.id, organizationId));
await database
	.update(users)
	.set({ name: "Example Owner" })
	.where(eq(users.id, ownerId));
for (const [id, name, email, activeOrganizationId] of [
	[memberId, "Example Member", "member@example.invalid", organizationId],
	[outsiderId, "Example Guest", "guest@example.invalid", outsideOrganizationId],
] as const) {
	await database
		.insert(users)
		.values({
			id,
			name,
			email,
			emailVerified: new Date(),
			activeOrganizationId,
			defaultOrgId: activeOrganizationId,
			onboarding_completed_at: new Date(),
			stripeSubscriptionStatus: "active",
		})
		.onDuplicateKeyUpdate({ set: { activeOrganizationId } });
}
await database
	.insert(organizations)
	.values({
		id: outsideOrganizationId,
		name: "Guest Organization",
		ownerId: outsiderId,
	})
	.onDuplicateKeyUpdate({ set: { name: "Guest Organization" } });
await database
	.insert(organizationMembers)
	.values({ id: ids.member, userId: memberId, organizationId, role: "member" })
	.onDuplicateKeyUpdate({ set: { role: "member" } });
for (const [id, name, isPublic] of [
	[ids.publicVideo, "Existing project walkthrough", true],
	[ids.privateVideo, "Private team update", false],
] as const) {
	const videoId = Video.VideoId.make(id);
	await database
		.insert(videos)
		.values({
			id: videoId,
			ownerId,
			orgId: organizationId,
			name,
			public: isPublic,
			source: { type: "desktopMP4" },
			duration: 12,
			width: 1280,
			height: 720,
			createdAt: new Date("2024-01-01T00:00:00Z"),
			transcriptionStatus: "COMPLETE",
			settings: {
				disableSummary: true,
				disableChapters: true,
				disableTranscript: true,
				disableCaptions: true,
			},
		})
		.onDuplicateKeyUpdate({ set: { name, public: isPublic } });
}
await database
	.insert(videoViewerGrants)
	.values({
		id: ids.privateVideo,
		videoId: Video.VideoId.make(ids.privateVideo),
		email: "guest@example.invalid",
		invitedByUserId: ownerId,
	})
	.onDuplicateKeyUpdate({ set: { revokedAt: null } });
await database
	.insert(sharedVideos)
	.values({
		id: ids.publicVideo,
		videoId: Video.VideoId.make(ids.publicVideo),
		organizationId: outsideOrganizationId,
		sharedByUserId: ownerId,
	})
	.onDuplicateKeyUpdate({ set: { organizationId: outsideOrganizationId } });
const spaceId = Space.SpaceId.make(ids.publicSpace);
await database
	.insert(spaces)
	.values({
		id: spaceId,
		organizationId: outsideOrganizationId,
		createdById: outsiderId,
		name: "Public project library",
		public: true,
	})
	.onDuplicateKeyUpdate({ set: { public: true } });
await database
	.insert(spaceVideos)
	.values({
		id: ids.publicSpace,
		spaceId,
		videoId: Video.VideoId.make(ids.publicVideo),
		addedById: ownerId,
	})
	.onDuplicateKeyUpdate({ set: { spaceId } });

const protectedSpaceId = Space.SpaceId.make(ids.protectedSpace);
await database
	.insert(spaces)
	.values({
		id: protectedSpaceId,
		organizationId,
		createdById: ownerId,
		name: "Protected team library",
		public: true,
		privacy: "Public",
		password: "synthetic-unverified-space-password",
	})
	.onDuplicateKeyUpdate({ set: { public: true, privacy: "Public" } });
await database
	.insert(spaceVideos)
	.values({
		id: ids.protectedSpace,
		spaceId: protectedSpaceId,
		videoId: Video.VideoId.make(ids.privateVideo),
		addedById: ownerId,
	})
	.onDuplicateKeyUpdate({ set: { spaceId: protectedSpaceId } });

const domainOrganizationId = Organisation.OrganisationId.make(
	ids.domainOrganization,
);
const domainSpaceId = Space.SpaceId.make(ids.domainSpace);
await database
	.insert(organizations)
	.values({
		id: domainOrganizationId,
		name: "Restricted project library",
		ownerId,
		allowedEmailDomain: "different.example.invalid",
		videoSharingRestrictedToOrg: true,
	})
	.onDuplicateKeyUpdate({ set: { videoSharingRestrictedToOrg: true } });
await database
	.insert(organizationMembers)
	.values({
		id: ids.domainMembership,
		organizationId: domainOrganizationId,
		userId: memberId,
		role: "member",
	})
	.onDuplicateKeyUpdate({ set: { role: "member" } });
await database
	.insert(spaces)
	.values({
		id: domainSpaceId,
		organizationId: domainOrganizationId,
		createdById: ownerId,
		name: "Shared project library",
		public: true,
		privacy: "Public",
	})
	.onDuplicateKeyUpdate({ set: { public: true } });
for (const [id, name, isPublic, password] of [
	[ids.externalVideo, "Shared public project update", true, null],
	[ids.externalPrivateVideo, "Private external project update", false, null],
	[
		ids.externalPasswordVideo,
		"Password-protected external update",
		true,
		"synthetic-external-password",
	],
] as const) {
	await database
		.insert(videos)
		.values({
			id: Video.VideoId.make(id),
			ownerId: outsiderId,
			orgId: outsideOrganizationId,
			name,
			public: isPublic,
			password,
			source: { type: "desktopMP4" },
			duration: 12,
		})
		.onDuplicateKeyUpdate({ set: { public: isPublic, password } });
	await database
		.insert(spaceVideos)
		.values({
			id,
			spaceId: domainSpaceId,
			videoId: Video.VideoId.make(id),
			addedById: ownerId,
		})
		.onDuplicateKeyUpdate({ set: { spaceId: domainSpaceId } });
}

for (const [email, restriction] of [
	["member@example.invalid", "example.invalid"],
	["member@example.invalid", "different.example.invalid"],
	[
		"MEMBER@EXAMPLE.INVALID",
		"  other.example.invalid , Member@Example.Invalid  ",
	],
	["member+tag@example.invalid", "member+tag@example.invalid"],
	["memberXtag@example.invalid", "member+tag@example.invalid"],
	["member@exampleXinvalid", "example.invalid"],
	["member@éxample.invalid", "example.invalid"],
	["member@straße.invalid", "strasse.invalid"],
	["member,team@example.invalid", "member,team@example.invalid"],
	["member,team@example.invalid", "example.invalid"],
	["member@", ",example.invalid"],
	[" member@example.invalid", " member@example.invalid"],
	["member@example.invalid", " ,  , "],
	["member@example.invalid", ""],
] as const) {
	await database
		.update(organizations)
		.set({ allowedEmailDomain: restriction })
		.where(eq(organizations.id, outsideOrganizationId));
	const [result] = await database
		.select({
			allowed: videoEmailAccessCondition({ id: memberId, email })?.mapWith(
				Boolean,
			),
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, Video.VideoId.make(ids.externalVideo)));
	if (result?.allowed !== isEmailAllowedByRestriction(email, restriction))
		throw new Error("Email restriction SQL parity assertion failed");
}
await database
	.update(organizations)
	.set({ allowedEmailDomain: null })
	.where(eq(organizations.id, outsideOrganizationId));
const emailOrganizationId = Organisation.OrganisationId.make(
	ids.emailOrganization,
);
await database
	.insert(organizations)
	.values({
		id: emailOrganizationId,
		name: "External restricted studio",
		ownerId: outsiderId,
		allowedEmailDomain: "trusted.example.invalid",
	})
	.onDuplicateKeyUpdate({
		set: { allowedEmailDomain: "trusted.example.invalid" },
	});
for (const [id, name] of [
	[ids.emailRestrictedVideo, "Email-restricted external update"],
	[ids.emailGrantedVideo, "Invited external update"],
] as const) {
	await database
		.insert(videos)
		.values({
			id: Video.VideoId.make(id),
			ownerId: outsiderId,
			orgId: emailOrganizationId,
			name,
			public: true,
			source: { type: "desktopMP4" },
			duration: 12,
		})
		.onDuplicateKeyUpdate({ set: { public: true } });
	await database
		.insert(spaceVideos)
		.values({
			id,
			spaceId: domainSpaceId,
			videoId: Video.VideoId.make(id),
			addedById: ownerId,
		})
		.onDuplicateKeyUpdate({ set: { spaceId: domainSpaceId } });
}
await database
	.insert(videoViewerGrants)
	.values({
		id: ids.emailGrantedVideo,
		videoId: Video.VideoId.make(ids.emailGrantedVideo),
		email: "member@example.invalid",
		invitedByUserId: outsiderId,
	})
	.onDuplicateKeyUpdate({ set: { revokedAt: null } });

await database
	.update(organizations)
	.set({ videoSharingRestrictedToOrg: true })
	.where(eq(organizations.id, organizationId));
try {
	for (const [userId, allowed] of [
		[ownerId, true],
		[memberId, true],
		[outsiderId, false],
	] as const) {
		const access = await getVideoOrganizationAccess(
			Video.VideoId.make(ids.publicVideo),
			userId,
		);
		if (access?.allowed !== allowed || !access.restricted)
			throw new Error("Organization access SQL assertion failed");
	}
} finally {
	await database
		.update(organizations)
		.set({ videoSharingRestrictedToOrg: false })
		.where(eq(organizations.id, organizationId));
}

const secret = process.env.NEXTAUTH_SECRET;
if (!secret) throw new Error("Missing isolated auth configuration");
const states: Record<string, unknown> = {};
const desktopToken = randomUUID();
await database
	.insert(authApiKeys)
	.values({ id: desktopToken, userId: ownerId, source: "unknown" });
states.desktopToken = desktopToken;
for (const [key, id, email] of [
	["owner", ownerId, `${process.env.CAP_BUILDING_SESSION}@example.invalid`],
	["member", memberId, "member@example.invalid"],
	["outsider", outsiderId, "guest@example.invalid"],
] as const) {
	const apiToken = randomUUID();
	await database
		.insert(authApiKeys)
		.values({ id: apiToken, userId: id, source: "unknown" });
	states[`${key}Token`] = apiToken;
	const value = await encode({
		secret,
		maxAge: 3600,
		token: { id, email, name: `Example ${key}`, sessionVersion: 0 },
	});
	states[key] = {
		cookies: [
			{
				name: "next-auth.session-token",
				value,
				domain: "127.0.0.1",
				path: "/",
				httpOnly: true,
				secure: false,
				sameSite: "Lax",
				expires: Math.floor(Date.now() / 1000) + 3600,
			},
		],
		origins: [],
	};
}
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
	join(directory, "browser-states.json"),
	JSON.stringify(states),
	{ mode: 0o600 },
);
console.log("Synthetic access fixtures and database assertions passed");
process.exit(0);
