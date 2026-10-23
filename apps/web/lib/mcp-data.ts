import "server-only";

import { db } from "@cap/database";
import {
	organizations,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import {
	resolveEffectiveVideoRules,
	Storage,
	VideosRepo,
} from "@cap/web-backend";
import type { User } from "@cap/web-domain";
import { Video } from "@cap/web-domain";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import {
	decodeAgentCursor,
	encodeAgentCursor,
	escapeAgentLikePattern,
	normalizeAgentMetadata,
	parseAgentVtt,
} from "./agent-api";
import { mcpIssuer } from "./mcp-auth";
import { runPromise } from "./server";

const maxList = 20;
const maxCues = 30;

export const listMcpCaps = async (
	userId: User.UserId,
	input: { search?: string; cursor?: string },
) => {
	const search = input.search?.trim();
	if (search && search.length > 80)
		throw new Error("Search must be 80 characters or less");
	const cursor = decodeAgentCursor(input.cursor);
	if (cursor === undefined) throw new Error("Invalid cursor");
	const rows = await db()
		.select({
			id: videos.id,
			name: videos.name,
			duration: videos.duration,
			createdAt: videos.createdAt,
			updatedAt: videos.updatedAt,
			transcriptionStatus: videos.transcriptionStatus,
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.ownerId, userId),
				isNull(organizations.tombstoneAt),
				search
					? sql`${videos.name} LIKE ${`%${escapeAgentLikePattern(search)}%`} ESCAPE '!'`
					: undefined,
				cursor
					? or(
							lt(videos.updatedAt, new Date(cursor.updatedAt)),
							and(
								eq(videos.updatedAt, new Date(cursor.updatedAt)),
								lt(videos.id, Video.VideoId.make(cursor.id)),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(videos.updatedAt), desc(videos.id))
		.limit(maxList + 1);
	const page = rows.slice(0, maxList);
	const last = page.at(-1);
	return {
		caps: page.map((row) => ({
			id: row.id,
			title: row.name,
			durationSeconds: row.duration,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			transcriptionStatus: row.transcriptionStatus,
			url: `${mcpIssuer()}/s/${row.id}`,
		})),
		nextCursor:
			rows.length > maxList && last
				? encodeAgentCursor({
						updatedAt: last.updatedAt.toISOString(),
						id: last.id,
					})
				: null,
	};
};

const getOwnedCap = async (userId: User.UserId, id: string) => {
	if (!/^[A-Za-z0-9_-]{5,128}$/.test(id)) return null;
	const [row] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			duration: videos.duration,
			createdAt: videos.createdAt,
			updatedAt: videos.updatedAt,
			metadata: videos.metadata,
			videoSettings: videos.settings,
			organizationSettings: organizations.settings,
			transcriptionStatus: videos.transcriptionStatus,
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.id, Video.VideoId.make(id)),
				eq(videos.ownerId, userId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	return row ?? null;
};

export const getMcpCap = async (userId: User.UserId, id: string) => {
	const row = await getOwnedCap(userId, id);
	if (!row) return null;
	return {
		id: row.id,
		title: row.name,
		durationSeconds: row.duration,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		transcriptionStatus: row.transcriptionStatus,
		url: `${mcpIssuer()}/s/${row.id}`,
	};
};

export const getMcpCapContext = async (
	userId: User.UserId,
	id: string,
	query?: string,
) => {
	const row = await getOwnedCap(userId, id);
	if (!row) return null;
	const search = query?.trim().toLowerCase();
	if (search && search.length > 80)
		throw new Error("Query must be 80 characters or less");
	const spaceRows = await db()
		.select({ id: spaces.id, name: spaces.name, settings: spaces.settings })
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.where(eq(spaceVideos.videoId, row.id));
	const rules = resolveEffectiveVideoRules({
		videoSettings: row.videoSettings,
		organizationSettings: row.organizationSettings,
		spaces: spaceRows,
	});
	const metadata = normalizeAgentMetadata(row.metadata);
	const summary =
		!rules.settings.disableSummary && typeof metadata.summary === "string"
			? metadata.summary.slice(0, 5_000)
			: null;
	let transcript: ReturnType<typeof parseAgentVtt> = [];
	let transcriptStatus: "available" | "disabled" | "not_ready" | "too_large" =
		rules.settings.disableTranscript ? "disabled" : "not_ready";
	if (
		!rules.settings.disableTranscript &&
		row.transcriptionStatus === "COMPLETE"
	) {
		const vtt = await runPromise(
			Effect.gen(function* () {
				const repo = yield* VideosRepo;
				const loaded = yield* repo.getById(row.id);
				if (Option.isNone(loaded)) return null;
				const storage = yield* Storage;
				const [bucket] = yield* storage.getAccessForVideo(loaded.value[0]);
				const object = yield* bucket.getObject(
					`${row.ownerId}/${row.id}/transcription.vtt`,
				);
				return Option.getOrNull(object);
			}),
		);
		if (vtt && vtt.length > 2_000_000) transcriptStatus = "too_large";
		else if (vtt) {
			transcript = parseAgentVtt(vtt);
			transcriptStatus = "available";
		}
	}
	const matching = search
		? transcript.filter((cue) => cue.text.toLowerCase().includes(search))
		: transcript;
	return {
		id: row.id,
		title: row.name,
		url: `${mcpIssuer()}/s/${row.id}`,
		summary,
		transcriptStatus,
		cues: matching.slice(0, maxCues).map((cue) => ({
			startMs: cue.startMs,
			endMs: cue.endMs,
			text: cue.text.slice(0, 1_000),
			url: `${mcpIssuer()}/s/${row.id}?t=${Math.floor(cue.startMs / 1_000)}`,
		})),
		hasMoreCues: matching.length > maxCues,
	};
};
