"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	importedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireOrganizationSettingsAccess } from "@/actions/organization/authorization";
import {
	addLoomImportCounts,
	emptyLoomImportCounts,
	type LoomImportCounts,
	type LoomImportState,
	loomImportState,
} from "@/lib/loom-import-status";

const ATTENTION_LIMIT = 50;

export type LoomImportMemberRow = LoomImportCounts & {
	userId: string;
	name: string | null;
	email: string;
	lastImportedAt: Date | null;
};

export type LoomImportAttentionRow = {
	videoId: string;
	name: string;
	ownerName: string | null;
	state: LoomImportState;
	updatedAt: Date | null;
};

export type LoomImportOverview = {
	totals: LoomImportCounts;
	members: LoomImportMemberRow[];
	attention: LoomImportAttentionRow[];
};

const phaseCount = (phases: string[]) =>
	sql<number>`COALESCE(SUM(${videoUploads.phase} IN (${sql.join(
		phases.map((phase) => sql`${phase}`),
		sql`, `,
	)})), 0)`.mapWith(Number);

// Read-only, admins and owners only: every Loom import in the organization
// grouped by the member who owns it. imported_videos is keyed by org first, so
// this reads the org's own rows; deleted videos drop out through the join.
export async function getLoomImportOverview(
	organizationId: string,
): Promise<LoomImportOverview> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const access = await requireOrganizationSettingsAccess(
		user.id,
		organizationId as Organisation.OrganisationId,
	);

	const importScope = and(
		eq(importedVideos.orgId, access.id),
		eq(importedVideos.source, "loom"),
	);

	const [memberRows, attentionRows] = await Promise.all([
		db()
			.select({
				userId: videos.ownerId,
				name: users.name,
				email: users.email,
				total: sql<number>`COUNT(*)`.mapWith(Number),
				queued: phaseCount(["uploading"]),
				importing: phaseCount(["processing", "generating_thumbnail"]),
				failed: phaseCount(["error"]),
				lastImportedAt: sql<Date | null>`MAX(${videos.createdAt})`.mapWith(
					(value) => (value ? new Date(value) : null),
				),
			})
			.from(importedVideos)
			.innerJoin(
				videos,
				and(eq(videos.id, importedVideos.id), eq(videos.orgId, access.id)),
			)
			.innerJoin(users, eq(users.id, videos.ownerId))
			.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
			.where(importScope)
			.groupBy(videos.ownerId, users.name, users.email),
		db()
			.select({
				videoId: videos.id,
				name: videos.name,
				ownerName: users.name,
				phase: videoUploads.phase,
				updatedAt: videoUploads.updatedAt,
			})
			.from(importedVideos)
			.innerJoin(
				videos,
				and(eq(videos.id, importedVideos.id), eq(videos.orgId, access.id)),
			)
			.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
			.leftJoin(users, eq(users.id, videos.ownerId))
			.where(
				and(
					importScope,
					inArray(videoUploads.phase, [
						"error",
						"uploading",
						"processing",
						"generating_thumbnail",
					]),
				),
			)
			.orderBy(
				sql`${videoUploads.phase} = 'error' DESC`,
				desc(videoUploads.updatedAt),
			)
			.limit(ATTENTION_LIMIT),
	]);

	const totals = emptyLoomImportCounts();
	const members = memberRows
		.map((row) => {
			const done = Math.max(
				0,
				row.total - row.queued - row.importing - row.failed,
			);
			const counts = addLoomImportCounts(emptyLoomImportCounts(), {
				queued: row.queued,
				importing: row.importing,
				failed: row.failed,
				done,
			});
			addLoomImportCounts(totals, counts);
			return {
				...counts,
				userId: row.userId,
				name: row.name,
				email: row.email,
				lastImportedAt: row.lastImportedAt,
			};
		})
		.sort(
			(a, b) =>
				b.failed - a.failed ||
				b.queued + b.importing - (a.queued + a.importing) ||
				b.total - a.total,
		);

	return {
		totals,
		members,
		attention: attentionRows.map((row) => ({
			videoId: row.videoId,
			name: row.name,
			ownerName: row.ownerName,
			state: loomImportState(row.phase),
			updatedAt: row.updatedAt,
		})),
	};
}
