import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { ensurePersonalOrganization } from "@cap/database/organization-pointer";
import {
	organizationMembers,
	organizations,
	videoNotes,
	videos,
} from "@cap/database/schema";
import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import { type Organisation, type User, Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";
import type { MeetingShareRequest } from "./schemas";
import { noteExcerpt, noteTitle } from "./share-content";

type ShareUser = Parameters<typeof makeCurrentUserLayer>[0] & {
	id: User.UserId;
	defaultOrgId?: Organisation.OrganisationId | null;
};

export type SharedNote = {
	id: Video.VideoId;
	orgId: Organisation.OrganisationId;
	created: boolean;
};

export type ShareNoteResult = SharedNote | "no_organization" | "conflict";

const isDuplicateKey = (error: unknown): boolean => {
	const value = error as { code?: string; errno?: number; cause?: unknown };
	if (value?.code === "ER_DUP_ENTRY" || value?.errno === 1062) return true;
	return value?.cause !== undefined && isDuplicateKey(value.cause);
};

function noteContent(input: MeetingShareRequest) {
	const summaryMarkdown = input.summaryMarkdown.trim();
	const notesMarkdown = input.notesMarkdown.trim();
	const participants = Array.from(
		new Set(
			input.participants
				.map((name) => name.replace(/\s+/g, " ").trim())
				.filter((name) => name.length > 0),
		),
	);
	const transcript = (input.transcript ?? [])
		.map((turn) => ({
			speaker: turn.speaker.replace(/\s+/g, " ").trim(),
			startMs: turn.startMs,
			text: turn.text.trim(),
		}))
		.filter((turn) => turn.text.length > 0);
	return {
		excerpt: noteExcerpt(summaryMarkdown || notesMarkdown),
		summaryMarkdown: summaryMarkdown || null,
		notesMarkdown: notesMarkdown || null,
		transcript: transcript.length > 0 ? transcript : null,
		participants,
		meetingStartedAt: input.startedAt ? new Date(input.startedAt) : null,
	};
}

async function resolveShareOrganization(
	user: ShareUser,
	requested: string | undefined,
): Promise<Organisation.OrganisationId | null> {
	const columns = { id: organizations.id, createdAt: organizations.createdAt };
	const [owned, joined] = await Promise.all([
		db()
			.select(columns)
			.from(organizations)
			.where(
				and(
					eq(organizations.ownerId, user.id),
					isNull(organizations.tombstoneAt),
				),
			),
		db()
			.select(columns)
			.from(organizationMembers)
			.innerJoin(
				organizations,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.where(
				and(
					eq(organizationMembers.userId, user.id),
					isNull(organizations.tombstoneAt),
				),
			),
	]);
	const ids = Array.from(
		new Map([...owned, ...joined].map((row) => [row.id, row])).values(),
	)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.map((row) => row.id);
	if (ids.length === 0) {
		const created = await ensurePersonalOrganization(db(), user.id);
		if (created) ids.push(created.id);
	}

	const requestedId = ids.find((id) => id === requested);
	if (requestedId) return requestedId;
	if (user.defaultOrgId && ids.includes(user.defaultOrgId))
		return user.defaultOrgId;
	return ids[0] ?? null;
}

async function updateSharedNote(
	userId: User.UserId,
	input: MeetingShareRequest,
): Promise<Omit<SharedNote, "created"> | "conflict" | null> {
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select({
				videoId: videoNotes.videoId,
				capOwnerId: videos.ownerId,
				orgId: videos.orgId,
			})
			.from(videoNotes)
			.leftJoin(videos, eq(videos.id, videoNotes.videoId))
			.where(
				and(
					eq(videoNotes.ownerId, userId),
					eq(videoNotes.documentId, input.documentId),
				),
			)
			.for("update");
		if (!row) return null;
		if (!row.capOwnerId || !row.orgId) {
			await tx.delete(videoNotes).where(eq(videoNotes.videoId, row.videoId));
			return null;
		}
		if (row.capOwnerId !== userId) return "conflict";

		await tx
			.update(videos)
			.set({
				name: noteTitle(input.title),
				duration: input.durationSeconds ?? null,
			})
			.where(eq(videos.id, row.videoId));
		await tx
			.update(videoNotes)
			.set(noteContent(input))
			.where(eq(videoNotes.videoId, row.videoId));
		return { id: row.videoId, orgId: row.orgId };
	});
}

export async function upsertSharedNote(
	user: ShareUser,
	input: MeetingShareRequest,
): Promise<ShareNoteResult> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const existing = await updateSharedNote(user.id, input);
		if (existing === "conflict") return "conflict";
		if (existing) return { ...existing, created: false };

		const orgId = await resolveShareOrganization(user, input.orgId);
		if (!orgId) return "no_organization";
		const isPublic = await getNewVideoPublic(orgId);
		const id = Video.VideoId.make(nanoId());
		try {
			await db().transaction(async (tx) => {
				await tx.insert(videos).values({
					id,
					ownerId: user.id,
					orgId,
					name: noteTitle(input.title),
					isNote: true,
					source: { type: "local" },
					transcriptionStatus: "SKIPPED",
					public: isPublic,
					duration: input.durationSeconds ?? null,
				});
				await tx.insert(videoNotes).values({
					videoId: id,
					ownerId: user.id,
					documentId: input.documentId,
					...noteContent(input),
				});
			});
			return { id, orgId, created: true };
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
	}
	throw new Error("Note share could not be saved");
}

export async function deleteSharedNote(
	user: ShareUser,
	documentId: string,
): Promise<boolean> {
	const [row] = await db()
		.select({ videoId: videoNotes.videoId, capOwnerId: videos.ownerId })
		.from(videoNotes)
		.leftJoin(videos, eq(videos.id, videoNotes.videoId))
		.where(
			and(
				eq(videoNotes.ownerId, user.id),
				eq(videoNotes.documentId, documentId),
			),
		)
		.limit(1);
	if (!row) return false;
	if (!row.capOwnerId) {
		await db().delete(videoNotes).where(eq(videoNotes.videoId, row.videoId));
		return true;
	}
	if (row.capOwnerId !== user.id) return false;

	return Effect.gen(function* () {
		const service = yield* Videos;
		yield* service.delete(row.videoId);
		return true;
	}).pipe(
		Effect.provide(makeCurrentUserLayer(user)),
		Effect.catchTags({
			VideoNotFoundError: () => Effect.succeed(false),
			PolicyDenied: () => Effect.succeed(false),
		}),
		runPromise,
	);
}
