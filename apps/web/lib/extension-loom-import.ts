import "server-only";

import { db } from "@cap/database";
import {
	importedVideos,
	organizationMembers,
	organizations,
	users,
	videos,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull, or } from "drizzle-orm";
import { importLoomCsvForUser } from "@/lib/loom-import";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";

export const MAX_EXTENSION_LOOM_ROWS = 500;
export const MAX_EXTENSION_LOOM_ROW_NUMBER = 50_000;
export const MAX_EXTENSION_LOOM_URL_LENGTH = 2048;
export const MAX_EXTENSION_LOOM_EMAIL_LENGTH = 254;
export const MAX_EXTENSION_LOOM_SPACE_LENGTH = 255;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHARE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const EMBED_ID_PATTERN = /^[0-9a-f]{32}$/i;

const hasControlCharacter = (value: string) =>
	[...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159);
	});

export class ExtensionLoomAuthorizationError extends Error {}

export type ExtensionLoomImportRow = {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName?: string;
};

export type ExtensionLoomOrganization = {
	id: Organisation.OrganisationId;
	name: string;
	canImport: boolean;
};

export type ExtensionLoomImportConfig = {
	user: { id: User.UserId; email: string };
	organizations: ExtensionLoomOrganization[];
	activeOrganizationId: Organisation.OrganisationId | "";
	isPro: boolean;
	defaultPublic: boolean;
	maxRows: typeof MAX_EXTENSION_LOOM_ROWS;
};

export type ExtensionLoomImportResponse = {
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
	existing?: boolean;
	uncertain?: boolean;
};

export const canonicalizeExtensionLoomUrl = (
	loomUrl: string,
): string | undefined => {
	if (
		typeof loomUrl !== "string" ||
		loomUrl.length === 0 ||
		loomUrl.length > MAX_EXTENSION_LOOM_URL_LENGTH ||
		hasControlCharacter(loomUrl)
	) {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(loomUrl.trim());
	} catch {
		return undefined;
	}

	const hostname = url.hostname.toLowerCase();
	const hostAllowed = hostname === "loom.com" || hostname === "www.loom.com";
	const path = url.pathname.split("/");
	const trailingSlash = path.at(-1) === "";
	const validPath =
		(path.length === 3 || (path.length === 4 && trailingSlash)) &&
		path[0] === "" &&
		path[1] !== undefined &&
		path[2] !== undefined;
	const kind = validPath ? path[1]?.toLowerCase() : undefined;
	const id = validPath ? path[2] : undefined;
	const validShare =
		kind === "share" && id !== undefined && SHARE_ID_PATTERN.test(id);
	const validEmbed =
		kind === "embed" && id !== undefined && EMBED_ID_PATTERN.test(id);

	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		!hostAllowed ||
		(!validShare && !validEmbed) ||
		id === undefined
	) {
		return undefined;
	}

	return `https://www.loom.com/share/${id.toLowerCase()}`;
};

export const validateExtensionLoomRow = (
	row: ExtensionLoomImportRow,
): string | undefined => {
	if (
		!Number.isInteger(row.rowNumber) ||
		row.rowNumber < 1 ||
		row.rowNumber > MAX_EXTENSION_LOOM_ROW_NUMBER
	) {
		return "Row number must be between 1 and 50000.";
	}

	if (
		typeof row.loomUrl !== "string" ||
		row.loomUrl.length === 0 ||
		row.loomUrl.length > MAX_EXTENSION_LOOM_URL_LENGTH
	) {
		return "Loom URL is missing or too long.";
	}

	if (!canonicalizeExtensionLoomUrl(row.loomUrl)) {
		return "Loom URL must be a valid Loom share or embed URL.";
	}

	if (
		typeof row.userEmail !== "string" ||
		row.userEmail.length === 0 ||
		row.userEmail.length > MAX_EXTENSION_LOOM_EMAIL_LENGTH ||
		hasControlCharacter(row.userEmail) ||
		!EMAIL_PATTERN.test(row.userEmail)
	) {
		return "User email is missing or invalid.";
	}

	if (
		row.spaceName !== undefined &&
		(typeof row.spaceName !== "string" ||
			row.spaceName.length > MAX_EXTENSION_LOOM_SPACE_LENGTH ||
			hasControlCharacter(row.spaceName))
	) {
		return "Space name is too long.";
	}

	return undefined;
};

export async function getExtensionLoomImportConfig({
	userId,
	activeOrganizationId,
}: {
	userId: User.UserId;
	activeOrganizationId: Organisation.OrganisationId;
}): Promise<ExtensionLoomImportConfig> {
	const database = db();
	const [user] = await database
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) throw new Error("Authenticated user was not found.");

	const organizationRows = await database
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, userId),
			),
		)
		.where(
			and(
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, userId),
					eq(organizationMembers.userId, userId),
				),
			),
		)
		.orderBy(organizations.name);

	const isPro = userIsPro(user);
	const organizationsForUser = organizationRows.map((organization) => {
		const role = getEffectiveOrganizationRole({
			userId,
			ownerId: organization.ownerId,
			memberRole: organization.memberRole,
		});

		return {
			id: organization.id,
			name: organization.name,
			canImport: isPro && canManageOrganizationSettings(role),
		};
	});
	const active = organizationsForUser.some(
		(organization) => organization.id === activeOrganizationId,
	)
		? activeOrganizationId
		: (organizationsForUser[0]?.id ?? "");

	return {
		user: { id: user.id, email: user.email },
		organizations: organizationsForUser,
		activeOrganizationId: active,
		isPro,
		defaultPublic: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
		maxRows: MAX_EXTENSION_LOOM_ROWS,
	};
}

export async function findExistingExtensionLoomVideo({
	organizationId,
	loomUrl,
}: {
	organizationId: Organisation.OrganisationId;
	loomUrl: string;
}): Promise<Video.VideoId | undefined> {
	const path = new URL(loomUrl).pathname.replace(/\/$/, "").split("/");
	const loomVideoId = path[path.length - 1];
	if (!loomVideoId) return undefined;

	const [existing] = await db()
		.select({ videoId: videos.id })
		.from(importedVideos)
		.leftJoin(
			videos,
			and(
				eq(videos.id, importedVideos.id),
				eq(videos.orgId, importedVideos.orgId),
			),
		)
		.where(
			and(
				eq(importedVideos.orgId, organizationId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		)
		.limit(1);

	return existing?.videoId ?? undefined;
}

export async function authorizeExtensionLoomImport({
	userId,
	organizationId,
}: {
	userId: User.UserId;
	organizationId: Organisation.OrganisationId;
}): Promise<{ user: typeof users.$inferSelect; isPro: boolean }> {
	const [result] = await db()
		.select({
			user: users,
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(users)
		.innerJoin(organizations, eq(organizations.id, organizationId))
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, userId),
			),
		)
		.where(
			and(
				eq(users.id, userId),
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);

	if (!result) {
		throw new ExtensionLoomAuthorizationError();
	}

	const isPro = userIsPro(result.user);
	const role = getEffectiveOrganizationRole({
		userId,
		ownerId: result.ownerId,
		memberRole: result.memberRole,
	});
	if (!isPro || !canManageOrganizationSettings(role)) {
		throw new ExtensionLoomAuthorizationError();
	}

	return { user: result.user, isPro };
}

export async function importExtensionLoomRow({
	organizationId,
	row,
	user,
}: {
	organizationId: Organisation.OrganisationId;
	row: ExtensionLoomImportRow;
	user: typeof users.$inferSelect;
}): Promise<ExtensionLoomImportResponse> {
	const canonicalLoomUrl = canonicalizeExtensionLoomUrl(row.loomUrl);
	if (!canonicalLoomUrl) {
		return {
			success: false,
			error: "Loom URL must be a valid Loom share or embed URL.",
		};
	}

	const existing = await findExistingExtensionLoomVideo({
		organizationId,
		loomUrl: canonicalLoomUrl,
	});
	if (existing) {
		return {
			success: true,
			videoId: existing,
			error: "Already imported; owner and Space membership are unchanged.",
			existing: true,
		};
	}

	const result = await importLoomCsvForUser({
		rows: [{ ...row, loomUrl: canonicalLoomUrl }],
		orgId: organizationId,
		user,
	});
	const rowResult = result.results[0];

	if (rowResult?.success && rowResult.videoId) {
		return {
			success: true,
			videoId: rowResult.videoId,
			error: rowResult.error,
		};
	}

	if (rowResult?.error === "Failed to start this import.") {
		const persistedVideo = await findExistingExtensionLoomVideo({
			organizationId,
			loomUrl: canonicalLoomUrl,
		});
		return {
			success: false,
			error:
				"Import status is unknown. Check your Cap library before retrying.",
			...(persistedVideo ? { videoId: persistedVideo } : {}),
			uncertain: true,
		};
	}

	const raceWinner = await findExistingExtensionLoomVideo({
		organizationId,
		loomUrl: canonicalLoomUrl,
	});
	if (raceWinner) {
		if (rowResult?.error === "This Loom video has already been imported.") {
			return {
				success: true,
				videoId: raceWinner,
				error: "Already imported; owner and Space membership are unchanged.",
				existing: true,
			};
		}
		return {
			success: false,
			videoId: raceWinner,
			error:
				"Import status is unknown. Check your Cap library before retrying.",
			uncertain: true,
		};
	}

	if (rowResult?.error === "This Loom video has already been imported.") {
		return {
			success: false,
			error: "Already imported; owner and Space membership are unchanged.",
			existing: true,
		};
	}

	return {
		success: false,
		error: rowResult?.error ?? "Could not start this Loom import.",
	};
}
