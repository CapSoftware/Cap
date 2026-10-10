import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	type LoomImportJobStatus,
	loomImportJobItems,
	loomImportJobs,
	organizationMembers,
	spaceMembers,
	spaces,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import {
	type Organisation,
	Space,
	SpaceMemberId,
	User,
	type Video,
} from "@cap/web-domain";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { hasProSubscription } from "@/lib/pro-subscription";
import {
	decodeLoomImportRows,
	extractLoomVideoId,
	isValidImportEmail,
	LOOM_IMPORT_MAX_ROWS,
	LOOM_IMPORT_MAX_SPACE_NAME_LENGTH,
	LOOM_IMPORT_MAX_URL_LENGTH,
	normalizeImportEmail,
	normalizeImportSpaceName,
} from "./csv";
import { LOOM_IMPORT_JOB_STATUS_INDEX } from "./indexes";
import {
	type LoomVideoLookup,
	lookupLoomVideos,
	loomLookupError,
} from "./loom-api";

const INSERT_CHUNK = 500;
const LOOM_IMPORT_JOBS_PER_HOUR = 30;
const IN_CHUNK = 500;
const RESOLVE_HEARTBEAT_MS = 60_000;
const RESOLVE_BUDGET_MS = 90_000;

export class LoomImportError extends Error {}

export const LOOM_IMPORT_LIMIT_MESSAGE = `Each CSV can hold up to ${LOOM_IMPORT_MAX_ROWS.toLocaleString("en-US")} videos. Split your list into a few CSVs and start an import for each.`;

type ItemInsert = typeof loomImportJobItems.$inferInsert;

function chunk<T>(values: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function truncate(value: string, length: number) {
	return value.length > length ? value.slice(0, length) : value;
}

export async function getLoomImportAccess(
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
) {
	const access = await getOrganizationAccess(userId, orgId);
	if (!access) return null;
	return { ...access, isAdmin: canManageOrganizationSettings(access.role) };
}

export async function getLoomImportJobForUser(
	jobId: string,
	userId: User.UserId,
) {
	const [job] = await db()
		.select()
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId))
		.limit(1);
	if (!job) return null;
	const access = await getLoomImportAccess(userId, job.orgId);
	if (!access) return null;
	if (job.createdById !== userId && !access.isAdmin) return null;
	return { job, isAdmin: access.isAdmin };
}

type IncomingRow = {
	rowNumber?: unknown;
	loomUrl?: unknown;
	ownerEmail?: unknown;
	spaceName?: unknown;
};

export function planLoomImportItems(
	jobId: string,
	rows: unknown,
	{ isAdmin }: { isAdmin: boolean },
): ItemInsert[] {
	const list = Array.isArray(rows) ? rows : decodeLoomImportRows(rows);
	if (!list) throw new LoomImportError("No Loom links found.");
	const seen = new Map<string, number>();
	const usedRows = new Set<number>();
	const items: ItemInsert[] = [];
	const now = new Date();

	(list as IncomingRow[]).forEach((row, index) => {
		const candidateRow =
			typeof row?.rowNumber === "number" &&
			Number.isInteger(row.rowNumber) &&
			row.rowNumber > 0
				? row.rowNumber
				: index + 1;
		const rowNumber = usedRows.has(candidateRow)
			? Math.max(...usedRows) + 1
			: candidateRow;
		usedRows.add(rowNumber);

		const loomUrl = typeof row?.loomUrl === "string" ? row.loomUrl.trim() : "";
		const ownerEmail =
			isAdmin && typeof row?.ownerEmail === "string"
				? normalizeImportEmail(row.ownerEmail)
				: "";
		const spaceName =
			isAdmin && typeof row?.spaceName === "string"
				? normalizeImportSpaceName(row.spaceName)
				: "";

		const base: ItemInsert = {
			id: nanoId(),
			jobId,
			rowNumber,
			loomUrl: truncate(loomUrl || "(empty)", LOOM_IMPORT_MAX_URL_LENGTH),
			ownerEmail: ownerEmail ? truncate(ownerEmail, 255) : null,
			spaceName: spaceName
				? truncate(spaceName, LOOM_IMPORT_MAX_SPACE_NAME_LENGTH)
				: null,
			status: "pending",
			updatedAt: now,
		};

		const loomVideoId =
			loomUrl.length <= LOOM_IMPORT_MAX_URL_LENGTH
				? extractLoomVideoId(loomUrl)
				: null;
		if (!loomVideoId) {
			items.push({
				...base,
				status: "failed",
				error: "This isn't a Loom link.",
			});
			return;
		}
		if (ownerEmail && !isValidImportEmail(ownerEmail)) {
			items.push({
				...base,
				loomVideoId,
				status: "failed",
				error: "The owner email looks wrong.",
			});
			return;
		}
		if (spaceName.length > LOOM_IMPORT_MAX_SPACE_NAME_LENGTH) {
			items.push({
				...base,
				loomVideoId,
				status: "failed",
				error: `Space names can be up to ${LOOM_IMPORT_MAX_SPACE_NAME_LENGTH} characters.`,
			});
			return;
		}
		const duplicateOf = seen.get(loomVideoId);
		if (duplicateOf !== undefined) {
			items.push({
				...base,
				loomVideoId,
				status: "skipped",
				error: `Same video as row ${duplicateOf}.`,
			});
			return;
		}
		seen.set(loomVideoId, rowNumber);
		items.push({ ...base, loomVideoId });
	});

	if (items.length === 0) throw new LoomImportError("No Loom links found.");
	if (items.length > LOOM_IMPORT_MAX_ROWS)
		throw new LoomImportError(LOOM_IMPORT_LIMIT_MESSAGE);
	return items;
}

export async function createLoomImportJob({
	userId,
	orgId,
	fileName,
	rows,
}: {
	userId: User.UserId;
	orgId: Organisation.OrganisationId;
	fileName: string;
	rows: unknown;
}) {
	const access = await getLoomImportAccess(userId, orgId);
	if (!access)
		throw new LoomImportError("You don't have access to this organization.");

	const [recent] = await db()
		.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
		.from(loomImportJobs)
		.where(
			and(
				eq(loomImportJobs.orgId, orgId),
				eq(loomImportJobs.createdById, userId),
				gte(loomImportJobs.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
			),
		);
	if ((recent?.count ?? 0) >= LOOM_IMPORT_JOBS_PER_HOUR) {
		throw new LoomImportError(
			"You've started a lot of imports in the last hour. Try again in a little while.",
		);
	}

	const jobId = nanoId();
	const items = planLoomImportItems(jobId, rows, { isAdmin: access.isAdmin });
	const now = new Date();
	const name = truncate(fileName.trim() || "Loom links", 255);

	await db().transaction(async (tx) => {
		await tx.insert(loomImportJobs).values({
			id: jobId,
			orgId,
			createdById: userId,
			fileName: name,
			status: "checking",
			totalCount: items.length,
			createdAt: now,
			updatedAt: now,
		});
		for (const values of chunk(items, INSERT_CHUNK)) {
			await tx.insert(loomImportJobItems).values(values);
		}
	});

	return { jobId, totalCount: items.length };
}

type PendingItem = {
	id: string;
	jobId: string;
	rowNumber: number;
	loomUrl: string;
	loomVideoId: string | null;
};

// MySQL applies these assignments in column order, so `status` may already hold
// the new value when the other columns are evaluated. Accept either state.
const whilePending = (column: string) =>
	sql.raw(
		`IF(\`status\` IN ('pending', VALUES(\`status\`)), VALUES(\`${column}\`), \`${column}\`)`,
	);

async function writeItemUpdates(rows: ItemInsert[]) {
	if (rows.length === 0) return;
	for (const values of chunk(rows, INSERT_CHUNK)) {
		await db()
			.insert(loomImportJobItems)
			.values(values)
			.onDuplicateKeyUpdate({
				set: {
					title: whilePending("title"),
					loomCreatedAt: whilePending("loom_created_at"),
					durationSeconds: whilePending("duration_seconds"),
					width: whilePending("width"),
					height: whilePending("height"),
					thumbnailUrl: whilePending("thumbnail_url"),
					videoId: whilePending("video_id"),
					error: whilePending("error"),
					updatedAt: whilePending("updated_at"),
					status: sql.raw(
						"IF(`status` = 'pending', VALUES(`status`), `status`)",
					),
				},
			});
	}
}

function resolvedItem(
	item: PendingItem,
	lookup: LoomVideoLookup,
	now: Date,
): ItemInsert {
	const base: ItemInsert = {
		id: item.id,
		jobId: item.jobId,
		rowNumber: item.rowNumber,
		loomUrl: item.loomUrl,
		updatedAt: now,
	};
	if (lookup.status !== "ok") {
		return { ...base, status: "failed", error: loomLookupError(lookup) };
	}
	return {
		...base,
		status: "ready",
		title: lookup.title,
		loomCreatedAt: lookup.createdAt ? new Date(lookup.createdAt) : null,
		durationSeconds: lookup.durationSeconds,
		width: lookup.width ? Math.round(lookup.width) : null,
		height: lookup.height ? Math.round(lookup.height) : null,
		thumbnailUrl: lookup.thumbnailUrl
			? truncate(lookup.thumbnailUrl, 1024)
			: null,
		error: null,
	};
}

export async function resolveLoomImportJob(
	jobId: string,
	options: {
		fetchImpl?: typeof fetch;
		giveUp?: boolean;
		budgetMs?: number;
	} = {},
): Promise<{ waiting: number }> {
	const [job] = await db()
		.select({ orgId: loomImportJobs.orgId, status: loomImportJobs.status })
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId))
		.limit(1);
	if (!job || job.status === "cancelled" || job.status === "completed")
		return { waiting: 0 };

	if (options.giveUp) {
		const now = new Date();
		await db()
			.update(loomImportJobItems)
			.set({
				status: "failed",
				error: loomLookupError({ status: "error" }),
				updatedAt: now,
			})
			.where(
				and(
					eq(loomImportJobItems.jobId, jobId),
					eq(loomImportJobItems.status, "pending"),
				),
			);
		await db()
			.update(loomImportJobs)
			.set({ updatedAt: now })
			.where(eq(loomImportJobs.id, jobId));
		return { waiting: 0 };
	}

	const pending: PendingItem[] = await db()
		.select({
			id: loomImportJobItems.id,
			jobId: loomImportJobItems.jobId,
			rowNumber: loomImportJobItems.rowNumber,
			loomUrl: loomImportJobItems.loomUrl,
			loomVideoId: loomImportJobItems.loomVideoId,
		})
		.from(loomImportJobItems, { forceIndex: LOOM_IMPORT_JOB_STATUS_INDEX })
		.where(
			and(
				eq(loomImportJobItems.jobId, jobId),
				eq(loomImportJobItems.status, "pending"),
			),
		)
		.orderBy(asc(loomImportJobItems.rowNumber));
	if (pending.length === 0) return { waiting: 0 };

	const loomIds = Array.from(
		new Set(
			pending.flatMap((item) => (item.loomVideoId ? [item.loomVideoId] : [])),
		),
	);
	const liveImports = new Map<string, Video.VideoId>();
	const staleImportIds: string[] = [];
	for (const ids of chunk(loomIds, IN_CHUNK)) {
		const existing = await db()
			.select({
				importId: importedVideos.id,
				sourceId: importedVideos.sourceId,
				videoId: videos.id,
			})
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
					eq(importedVideos.orgId, job.orgId),
					eq(importedVideos.source, "loom"),
					inArray(importedVideos.sourceId, ids),
				),
			);
		for (const row of existing) {
			if (row.videoId) liveImports.set(row.sourceId, row.videoId);
			else staleImportIds.push(row.importId);
		}
	}

	for (const ids of chunk(staleImportIds, IN_CHUNK)) {
		await db()
			.delete(importedVideos)
			.where(
				and(
					eq(importedVideos.orgId, job.orgId),
					eq(importedVideos.source, "loom"),
					inArray(importedVideos.id, ids),
				),
			);
	}

	const now = new Date();
	const skipped: ItemInsert[] = [];
	const toLookup: PendingItem[] = [];
	for (const item of pending) {
		const existingVideo = item.loomVideoId
			? liveImports.get(item.loomVideoId)
			: undefined;
		if (existingVideo) {
			skipped.push({
				id: item.id,
				jobId: item.jobId,
				rowNumber: item.rowNumber,
				loomUrl: item.loomUrl,
				status: "skipped",
				videoId: existingVideo,
				error: "Already in Cap.",
				updatedAt: now,
			});
		} else {
			toLookup.push(item);
		}
	}
	await writeItemUpdates(skipped);

	const itemsByLoomId = new Map<string, PendingItem[]>();
	for (const item of toLookup) {
		if (!item.loomVideoId) continue;
		const list = itemsByLoomId.get(item.loomVideoId) ?? [];
		list.push(item);
		itemsByLoomId.set(item.loomVideoId, list);
	}

	let resolved = 0;
	let touchedAt = Date.now();
	const deadline = Date.now() + (options.budgetMs ?? RESOLVE_BUDGET_MS);
	await lookupLoomVideos(Array.from(itemsByLoomId.keys()), {
		fetchImpl: options.fetchImpl,
		shouldStop: () => Date.now() > deadline,
		onBatch: async (results) => {
			const updates: ItemInsert[] = [];
			const batchTime = new Date();
			if (batchTime.getTime() - touchedAt > RESOLVE_HEARTBEAT_MS) {
				touchedAt = batchTime.getTime();
				await db()
					.update(loomImportJobs)
					.set({ updatedAt: batchTime })
					.where(eq(loomImportJobs.id, jobId));
			}
			for (const [loomVideoId, lookup] of results) {
				if (lookup.status === "error") continue;
				for (const item of itemsByLoomId.get(loomVideoId) ?? []) {
					updates.push(resolvedItem(item, lookup, batchTime));
				}
			}
			resolved += updates.length;
			await writeItemUpdates(updates);
		},
	});

	await db()
		.update(loomImportJobs)
		.set({ updatedAt: new Date() })
		.where(eq(loomImportJobs.id, jobId));
	return { waiting: toLookup.length - resolved };
}

async function resolveImportOwners({
	orgId,
	creator,
	emails,
}: {
	orgId: Organisation.OrganisationId;
	creator: { id: User.UserId; email: string };
	emails: string[];
}) {
	const owners = new Map<string, User.UserId>();
	owners.set(creator.email.toLowerCase(), creator.id);
	const remaining = emails.filter((email) => !owners.has(email));

	for (const batch of chunk(remaining, IN_CHUNK)) {
		const members = await db()
			.select({ userId: organizationMembers.userId, email: users.email })
			.from(organizationMembers)
			.innerJoin(users, eq(organizationMembers.userId, users.id))
			.where(
				and(
					eq(organizationMembers.organizationId, orgId),
					inArray(users.email, batch),
				),
			);
		for (const member of members) {
			owners.set(member.email.toLowerCase(), member.userId);
		}
	}

	const failed = new Set<string>();
	for (const email of remaining) {
		if (owners.has(email)) continue;
		try {
			const provisioned = await provisionOrganizationInvitee({
				organizationId: orgId,
				email,
				invitedByUserId: creator.id,
				role: "member",
			});
			owners.set(email, User.UserId.make(provisioned.userId));
		} catch {
			failed.add(email);
		}
	}
	return { owners, failed };
}

async function resolveImportSpaces({
	orgId,
	creatorId,
	names,
}: {
	orgId: Organisation.OrganisationId;
	creatorId: User.UserId;
	names: string[];
}) {
	const byKey = new Map<string, Space.SpaceIdOrOrganisationId>();
	if (names.length === 0) return byKey;

	const existing = await db()
		.select({ id: spaces.id, name: spaces.name })
		.from(spaces)
		.where(eq(spaces.organizationId, orgId));
	for (const space of existing) {
		const key = normalizeImportSpaceName(space.name).toLowerCase();
		if (!byKey.has(key)) byKey.set(key, space.id);
	}

	for (const name of names) {
		const key = name.toLowerCase();
		if (byKey.has(key)) continue;
		const spaceId = Space.SpaceId.make(nanoId());
		await db().transaction(async (tx) => {
			await tx.insert(spaces).values({
				id: spaceId,
				name,
				organizationId: orgId,
				createdById: creatorId,
				iconUrl: null,
			});
			await tx.insert(spaceMembers).values({
				id: SpaceMemberId.make(nanoId()),
				spaceId,
				userId: creatorId,
				role: "admin",
			});
		});
		byKey.set(key, spaceId);
	}
	return byKey;
}

async function ensureSpaceMembers(
	pairs: Map<Space.SpaceIdOrOrganisationId, Set<User.UserId>>,
) {
	for (const [spaceId, userIds] of pairs) {
		const ids = Array.from(userIds);
		const existing = await db()
			.select({ userId: spaceMembers.userId })
			.from(spaceMembers)
			.where(
				and(
					eq(spaceMembers.spaceId, spaceId),
					inArray(spaceMembers.userId, ids),
				),
			);
		const present = new Set(existing.map((row) => row.userId));
		const missing = ids.filter((id) => !present.has(id));
		if (missing.length === 0) continue;
		await db()
			.insert(spaceMembers)
			.values(
				missing.map((userId) => ({
					id: SpaceMemberId.make(nanoId()),
					spaceId,
					userId,
					role: "member" as const,
				})),
			);
	}
}

export async function prepareLoomImportJob(
	jobId: string,
): Promise<LoomImportJobStatus | null> {
	const [job] = await db()
		.select()
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId))
		.limit(1);
	if (!job) return null;
	if (job.status === "cancelled" || job.status === "completed")
		return job.status;

	const [creator] = await db()
		.select()
		.from(users)
		.where(eq(users.id, job.createdById))
		.limit(1);

	if (!creator || !hasProSubscription(creator)) {
		await db()
			.update(loomImportJobs)
			.set({ status: "awaiting_upgrade", updatedAt: new Date() })
			.where(
				and(
					eq(loomImportJobs.id, jobId),
					inArray(loomImportJobs.status, ["checking", "importing"]),
				),
			);
		return "awaiting_upgrade";
	}

	const access = await getLoomImportAccess(creator.id, job.orgId);
	const unassigned = await db()
		.select({
			id: loomImportJobItems.id,
			ownerEmail: loomImportJobItems.ownerEmail,
			spaceName: loomImportJobItems.spaceName,
		})
		.from(loomImportJobItems)
		.where(
			and(
				eq(loomImportJobItems.jobId, jobId),
				eq(loomImportJobItems.status, "ready"),
				isNull(loomImportJobItems.ownerId),
			),
		);

	if (!access) {
		await db()
			.update(loomImportJobItems)
			.set({
				status: "failed",
				error: "You no longer have access to this organization.",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(loomImportJobItems.jobId, jobId),
					inArray(loomImportJobItems.status, ["pending", "ready"]),
				),
			);
		await db()
			.update(loomImportJobs)
			.set({
				status: "completed",
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(loomImportJobs.id, jobId));
		return "completed";
	}

	if (unassigned.length > 0) {
		const emails = access.isAdmin
			? Array.from(
					new Set(
						unassigned.flatMap((item) =>
							item.ownerEmail ? [item.ownerEmail.toLowerCase()] : [],
						),
					),
				)
			: [];
		const spaceNamesByKey = new Map<string, string>();
		if (access.isAdmin) {
			for (const item of unassigned) {
				const key = item.spaceName?.toLowerCase();
				if (key && item.spaceName && !spaceNamesByKey.has(key)) {
					spaceNamesByKey.set(key, item.spaceName);
				}
			}
		}
		const spaceNames = Array.from(spaceNamesByKey.values());

		const { owners, failed } = await resolveImportOwners({
			orgId: job.orgId,
			creator: { id: creator.id, email: creator.email },
			emails,
		});
		const spaceByKey = await resolveImportSpaces({
			orgId: job.orgId,
			creatorId: creator.id,
			names: spaceNames,
		});

		const groups = new Map<
			string,
			{
				ownerId: User.UserId;
				spaceId: Space.SpaceIdOrOrganisationId | null;
				ids: string[];
			}
		>();
		const failedByEmail = new Map<string, string[]>();
		const spacePairs = new Map<
			Space.SpaceIdOrOrganisationId,
			Set<User.UserId>
		>();

		for (const item of unassigned) {
			const email =
				access.isAdmin && item.ownerEmail
					? item.ownerEmail.toLowerCase()
					: null;
			if (email && failed.has(email)) {
				const list = failedByEmail.get(email) ?? [];
				list.push(item.id);
				failedByEmail.set(email, list);
				continue;
			}
			const ownerId = email ? owners.get(email) : creator.id;
			if (!ownerId) {
				const list = failedByEmail.get(email ?? "") ?? [];
				list.push(item.id);
				failedByEmail.set(email ?? "", list);
				continue;
			}
			const spaceId =
				access.isAdmin && item.spaceName
					? (spaceByKey.get(item.spaceName.toLowerCase()) ?? null)
					: null;
			if (spaceId && ownerId !== creator.id) {
				const members = spacePairs.get(spaceId) ?? new Set<User.UserId>();
				members.add(ownerId);
				spacePairs.set(spaceId, members);
			}
			const key = `${ownerId}|${spaceId ?? ""}`;
			const group = groups.get(key) ?? { ownerId, spaceId, ids: [] };
			group.ids.push(item.id);
			groups.set(key, group);
		}

		await ensureSpaceMembers(spacePairs);

		const now = new Date();
		for (const group of groups.values()) {
			for (const ids of chunk(group.ids, IN_CHUNK)) {
				await db()
					.update(loomImportJobItems)
					.set({
						ownerId: group.ownerId,
						spaceId: group.spaceId,
						updatedAt: now,
					})
					.where(
						and(
							inArray(loomImportJobItems.id, ids),
							eq(loomImportJobItems.status, "ready"),
						),
					);
			}
		}
		for (const [email, ids] of failedByEmail) {
			for (const batch of chunk(ids, IN_CHUNK)) {
				await db()
					.update(loomImportJobItems)
					.set({
						status: "failed",
						error: email
							? `We couldn't add ${email} to your organization.`
							: "We couldn't find an owner for this video.",
						updatedAt: now,
					})
					.where(inArray(loomImportJobItems.id, batch));
			}
		}
	}

	await db()
		.update(loomImportJobs)
		.set({
			status: "importing",
			startedAt: job.startedAt ?? new Date(),
			completedAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(loomImportJobs.id, jobId),
				inArray(loomImportJobs.status, [
					"checking",
					"awaiting_upgrade",
					"importing",
				]),
			),
		);
	return "importing";
}

export async function markLoomImportJobStarting(jobId: string) {
	const result = await db()
		.update(loomImportJobs)
		.set({ status: "checking", updatedAt: new Date() })
		.where(
			and(
				eq(loomImportJobs.id, jobId),
				eq(loomImportJobs.status, "awaiting_upgrade"),
			),
		);
	return affectedRows(result) > 0;
}

export async function revertLoomImportJobStart(jobId: string) {
	await db()
		.update(loomImportJobs)
		.set({ status: "awaiting_upgrade", updatedAt: new Date() })
		.where(
			and(eq(loomImportJobs.id, jobId), eq(loomImportJobs.status, "checking")),
		);
}

export async function cancelLoomImportJob(jobId: string) {
	await db().transaction(async (tx) => {
		const [job] = await tx
			.select({ status: loomImportJobs.status })
			.from(loomImportJobs)
			.where(eq(loomImportJobs.id, jobId))
			.for("update");
		if (!job || job.status === "completed" || job.status === "cancelled")
			return;
		const now = new Date();
		await tx
			.update(loomImportJobItems)
			.set({ status: "cancelled", updatedAt: now })
			.where(
				and(
					eq(loomImportJobItems.jobId, jobId),
					inArray(loomImportJobItems.status, ["pending", "ready"]),
				),
			);
		await tx
			.update(loomImportJobs)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(eq(loomImportJobs.id, jobId));
	});
}

export async function resetFailedLoomImportItems(jobId: string) {
	const failed = await db()
		.select({
			id: loomImportJobItems.id,
			status: loomImportJobItems.status,
			videoId: loomImportJobItems.videoId,
			loomVideoId: loomImportJobItems.loomVideoId,
			videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
			uploadPhase: videoUploads.phase,
			uploadVideoId: videoUploads.videoId,
		})
		.from(loomImportJobItems)
		.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
		.leftJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(
			and(
				eq(loomImportJobItems.jobId, jobId),
				inArray(loomImportJobItems.status, ["failed", "importing", "complete"]),
			),
		);

	const toPending: string[] = [];
	const toReady: string[] = [];
	const toComplete: string[] = [];
	for (const item of failed) {
		if (!item.loomVideoId) continue;
		if (!item.videoId || !item.videoExists) {
			toPending.push(item.id);
		} else if (item.status === "complete") {
		} else if (item.uploadPhase === "error") {
			toReady.push(item.id);
		} else if (item.status === "failed" && !item.uploadVideoId) {
			toComplete.push(item.id);
		}
	}

	const now = new Date();
	for (const ids of chunk(toComplete, IN_CHUNK)) {
		await db()
			.update(loomImportJobItems)
			.set({ status: "complete", error: null, updatedAt: now })
			.where(
				and(
					inArray(loomImportJobItems.id, ids),
					eq(loomImportJobItems.status, "failed"),
				),
			);
	}
	for (const ids of chunk(toPending, IN_CHUNK)) {
		await db()
			.update(loomImportJobItems)
			.set({
				status: "pending",
				videoId: null,
				ownerId: null,
				spaceId: null,
				error: null,
				updatedAt: now,
			})
			.where(inArray(loomImportJobItems.id, ids));
	}
	for (const ids of chunk(toReady, IN_CHUNK)) {
		await db()
			.update(loomImportJobItems)
			.set({ status: "ready", error: null, updatedAt: now })
			.where(inArray(loomImportJobItems.id, ids));
	}

	const retried = toPending.length + toReady.length;
	if (retried > 0) {
		await db()
			.update(loomImportJobs)
			.set({
				status: "checking",
				completedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(loomImportJobs.id, jobId),
					inArray(loomImportJobs.status, ["importing", "completed"]),
				),
			);
	}
	return retried;
}

export type LoomImportJobSummary = {
	id: string;
	fileName: string;
	status: LoomImportJobStatus;
	totalCount: number;
	createdAt: string;
	completedAt: string | null;
	imported: number;
	failed: number;
	settled: number;
};

export async function listLoomImportJobs({
	userId,
	orgId,
	limit = 8,
}: {
	userId: User.UserId;
	orgId: Organisation.OrganisationId;
	limit?: number;
}): Promise<LoomImportJobSummary[]> {
	const jobs = await db()
		.select()
		.from(loomImportJobs)
		.where(
			and(
				eq(loomImportJobs.orgId, orgId),
				eq(loomImportJobs.createdById, userId),
			),
		)
		.orderBy(desc(loomImportJobs.createdAt))
		.limit(limit);
	if (jobs.length === 0) return [];

	const counts = await db()
		.select({
			jobId: loomImportJobItems.jobId,
			status: loomImportJobItems.status,
			count: sql<number>`COUNT(*)`.mapWith(Number),
		})
		.from(loomImportJobItems)
		.where(
			inArray(
				loomImportJobItems.jobId,
				jobs.map((job) => job.id),
			),
		)
		.groupBy(loomImportJobItems.jobId, loomImportJobItems.status);

	return jobs.map((job) => {
		const byStatus = new Map(
			counts
				.filter((row) => row.jobId === job.id)
				.map((row) => [row.status, row.count] as const),
		);
		const imported = byStatus.get("complete") ?? 0;
		const failed = byStatus.get("failed") ?? 0;
		const settled =
			imported +
			failed +
			(byStatus.get("skipped") ?? 0) +
			(byStatus.get("cancelled") ?? 0);
		return {
			id: job.id,
			fileName: job.fileName,
			status: job.status,
			totalCount: job.totalCount,
			createdAt: job.createdAt.toISOString(),
			completedAt: job.completedAt?.toISOString() ?? null,
			imported,
			failed,
			settled,
		};
	});
}

export function affectedRows(result: unknown) {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}
