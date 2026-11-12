import type { developerVideos } from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";

export type DeveloperVideoFixture = typeof developerVideos.$inferSelect;

export function processingState(
	overrides: Partial<DeveloperVideoProcessingState> = {},
): DeveloperVideoProcessingState {
	return {
		encodeId: "encode-1",
		startedAt: 1_000,
		probe: { duration: 12, width: 1920, height: 1080, fps: 30 },
		hls: { state: "pending" },
		mp4: { state: "pending" },
		attempts: { hls: 0, mp4: 0 },
		unavailableChecks: 0,
		poster: null,
		bytes: { source: 1_000, hls: 0, mp4: 0, poster: 0 },
		...overrides,
	};
}

export function developerVideo(
	overrides: Partial<DeveloperVideoFixture> = {},
): DeveloperVideoFixture {
	return {
		id: "video-1",
		appId: "app-1",
		externalUserId: null,
		name: "Untitled",
		duration: 12,
		width: 1920,
		height: 1080,
		fps: 30,
		s3Key: "developer/app-1/video-1/video",
		transcriptionStatus: null,
		metadata: null,
		status: "processing",
		playbackId: "playback-id-0123456789ab",
		maxResolutionTier: "1080p",
		renditions: null,
		storedBytes: null,
		errorReason: null,
		processing: processingState(),
		deletedAt: null,
		filesDeletedAt: null,
		createdAt: new Date("2026-11-01T00:00:00Z"),
		updatedAt: new Date("2026-11-01T00:00:00Z"),
		...overrides,
	};
}

export interface DeveloperVideoStore {
	video: DeveloperVideoFixture | null;
	more?: DeveloperVideoFixture[];
	appDeleted: boolean;
	updates: Partial<DeveloperVideoFixture>[];
}

// MySQL compares the externalUserId column with utf8mb4_0900_ai_ci, which
// treats case and accent variants as equal. The fake does the same so a query
// that relies on plain equality behaves here as it does in the database.
const equalInColumnCollation = (left: string, right: string) =>
	left.localeCompare(right, "en", { sensitivity: "base" }) === 0;

export async function createDeveloperVideoDatabase(store: DeveloperVideoStore) {
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const dialect = new MySqlDialect();
	type Condition = Parameters<typeof dialect.sqlToQuery>[0];

	const sortKey = (video: DeveloperVideoFixture, column: string) => {
		const value = (video as Record<string, unknown>)[column];
		return value instanceof Date ? value.getTime() : String(value);
	};

	let listings = 0;
	// MySQL promises no order between rows the ORDER BY leaves tied, so every
	// other listing starts from the reverse order and only the listed columns
	// decide where a row lands.
	const ordered = (videos: DeveloperVideoFixture[], order: Condition[]) => {
		const terms = order.map((term) => {
			const [, column, direction] =
				dialect.sqlToQuery(term).sql.match(/`(\w+)` (asc|desc)$/) ?? [];
			if (!column) throw new Error("The fake cannot order by this term");
			return { column, sign: direction === "desc" ? -1 : 1 };
		});
		const start = listings++ % 2 === 0 ? [...videos] : [...videos].reverse();
		return start.sort((left, right) => {
			for (const { column, sign } of terms) {
				const a = sortKey(left, column);
				const b = sortKey(right, column);
				if (a !== b) return (a < b ? -1 : 1) * sign;
			}
			return 0;
		});
	};

	const select = (fields?: Record<string, unknown>) => {
		let joined = false;
		const matches = (video: DeveloperVideoFixture, condition: Condition) => {
			const query = dialect.sqlToQuery(condition);
			const identified =
				(!query.sql.includes("`id` = ?") || query.params.includes(video.id)) &&
				(!query.sql.includes("`playbackId` = ?") ||
					(video.playbackId !== null &&
						query.params.includes(video.playbackId)));
			const scoped =
				!query.sql.includes("`appId` = ?") ||
				query.params.includes(video.appId);
			const live =
				!query.sql.includes("`deletedAt` is null") || video.deletedAt === null;
			const externalUserId = video.externalUserId;
			const owned =
				!query.sql.includes("`externalUserId` = ?") ||
				(externalUserId !== null &&
					query.params.some(
						(param) =>
							typeof param === "string" &&
							(query.sql.includes(
								"`externalUserId` AS BINARY) = CAST(? AS BINARY)",
							)
								? param === externalUserId
								: equalInColumnCollation(param, externalUserId)),
					));
			return identified && scoped && live && owned;
		};
		const found = (condition: Condition) =>
			!store.video || (joined && store.appDeleted)
				? []
				: [store.video, ...(store.more ?? [])].filter((video) =>
						matches(video, condition),
					);
		const chain = {
			from: () => chain,
			innerJoin: () => {
				joined = true;
				return chain;
			},
			where: (condition: Condition) => {
				const videos = found(condition);
				const result =
					fields && "video" in fields
						? videos.map((video) => ({ video }))
						: videos;
				return Object.assign(Promise.resolve(result), {
					limit: async () => result,
					for: async () => result,
					orderBy: (...order: Condition[]) => ({
						limit: (limit: number) => ({
							offset: async (offset: number) =>
								ordered(videos, order).slice(offset, offset + limit),
						}),
					}),
				});
			},
		};
		return chain;
	};

	const database = {
		select,
		update: () => ({
			set: (updates: Partial<DeveloperVideoFixture>) => ({
				where: async () => {
					store.updates.push(updates);
					if (store.video) store.video = { ...store.video, ...updates };
				},
			}),
		}),
		transaction: async (run: (tx: unknown) => Promise<unknown>) =>
			run(database),
	};
	return database;
}
